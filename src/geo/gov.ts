import type { GeoCoord } from "../gedcom/types";
import { foldToken, jaroWinkler } from "../match/text";
import { decomposePlace } from "../gedcom/place";

// GOV — the Genealogisches Ortsverzeichnis (gov.genealogy.net) — is the
// genealogy-specific gazetteer: time-valid jurisdictions and multilingual
// historical place names, each object carrying a stable GOV id. Its SOAP
// SimpleService serves CORS `*`, so the browser can query it directly (no
// relay). Opt-in (the query text leaves the device), gated behind the same
// online-lookups setting as the Nominatim search, and throttled to be polite.
//
// The parse functions are pure and regex-based (no DOMParser) so they run in
// the node test environment as well as the browser; the SOAP responses have a
// fixed, shallow shape that makes this safe.

const ENDPOINT = "https://gov.genealogy.net/services/SimpleService";
const NS = "http://gov.genealogy.net/ws";

/** Minimum spacing between GOV request starts (a search fans out to several). */
const INTERVAL_MS = 400;
/** How many of searchByName's ids to resolve to full objects per search. */
const MAX_LOOKUPS = 7;
/** How many scored candidates to return. */
const MAX_RESULTS = 6;
/** Below this name similarity a GOV object isn't a plausible match — the
 *  service's phonetic search returns broadly, so this prunes the noise. */
const MIN_SIMILARITY = 0.84;

/** One GOV place resolved to what the review UI needs. */
export interface GovResult {
  coord: GeoCoord;
  /** Best display name for the current language (localized, else the primary). */
  name: string;
  /** Full pick line, e.g. "Kranj · Krainburg" (primary + other-language names). */
  label: string;
  /** Canonical GOV id — written back as the GEDCOM-L `PLAC._GOV`. */
  govId: string;
  /** GOV numeric type code, informational. */
  kind?: string;
}

/** A GOV name entry: a value in one language. */
export interface GovName {
  lang: string;
  value: string;
}

/** A parsed GOV object, reduced to what geocoding reads. */
export interface GovObject {
  id: string;
  coord?: GeoCoord;
  names: GovName[];
  typeCode?: string;
}

/** ISO-639-1 UI language → the 3-letter code GOV tags names with. GOV follows
 *  ISO-639-2 but with its own quirks (Slovenian is `slo`, seen in responses). */
const LANG_MAP: Record<string, string> = {
  en: "eng",
  sl: "slo",
  de: "deu",
  hr: "hrv",
  it: "ita",
  hu: "hun",
};

/** Read one attribute off an XML start tag (returns "" when absent). */
function attr(tag: string, name: string): string {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : "";
}

/** XML-escape a text value for the SOAP request body. */
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Extract the object ids from a `searchByName` response envelope (exported
 *  for tests). GOV returns them best-match first as `<item>` elements. */
export function parseSearchIds(xml: string): string[] {
  const out: string[] = [];
  const re = /<(?:\w+:)?item>([^<]+)<\/(?:\w+:)?item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const id = m[1].trim();
    if (id) out.push(id);
  }
  return out;
}

/** Parse a `getObject` response envelope into a {@link GovObject} (exported for
 *  tests). Returns undefined when the body carries no object (e.g. a
 *  NoSuchObject fault). */
export function parseObject(xml: string): GovObject | undefined {
  const outTag = /<(?:\w+:)?out\b([^>]*)>/.exec(xml);
  if (!outTag) return undefined;
  const id = attr(outTag[1], "id");
  if (!id) return undefined;

  const obj: GovObject = { id, names: [] };

  const posTag = /<(?:\w+:)?position\b([^>]*)\/?>/.exec(xml);
  if (posTag) {
    const lat = Number(attr(posTag[1], "lat"));
    const lon = Number(attr(posTag[1], "lon"));
    if (Number.isFinite(lat) && Number.isFinite(lon)) obj.coord = { lat, lon };
  }

  const nameRe = /<(?:\w+:)?name\b([^>]*?)\/?>/g;
  let nm: RegExpExecArray | null;
  while ((nm = nameRe.exec(xml))) {
    const value = attr(nm[1], "value").trim();
    if (!value) continue;
    obj.names.push({ lang: attr(nm[1], "lang").trim(), value });
  }

  const typeTag = /<(?:\w+:)?type\b([^>]*)>/.exec(xml);
  if (typeTag) {
    const code = attr(typeTag[1], "value").trim();
    if (code) obj.typeCode = code;
  }
  return obj;
}

/**
 * Turn a resolved GOV object into a display result for a given UI language:
 * the localized name (falling back to the primary), the score against the
 * searched locality, and the pick label. Exported for tests. Returns undefined
 * when the object has no coordinate or no name.
 */
export function scoreObject(obj: GovObject, foldedLocality: string, language: string): (GovResult & { score: number }) | undefined {
  if (!obj.coord || !obj.names.length) return undefined;
  const wantLang = LANG_MAP[language] ?? language;

  // Best name-similarity across all languages prunes GOV's broad phonetic hits.
  let score = 0;
  for (const n of obj.names) score = Math.max(score, jaroWinkler(foldedLocality, foldToken(n.value)));
  if (score < MIN_SIMILARITY) return undefined;

  // Prefer a name in the UI language; else the one that matched best; else the
  // first. Distinct other-language names trail it in the label.
  const localized = obj.names.find((n) => n.lang === wantLang);
  const primary =
    localized ??
    [...obj.names].sort((a, b) => jaroWinkler(foldedLocality, foldToken(b.value)) - jaroWinkler(foldedLocality, foldToken(a.value)))[0];
  const others: string[] = [];
  for (const n of obj.names) {
    if (n.value === primary.value || others.includes(n.value)) continue;
    others.push(n.value);
  }
  const label = [primary.value, ...others.slice(0, 2)].join(" · ");
  const result: GovResult & { score: number } = { coord: obj.coord, name: primary.value, label, govId: obj.id, score };
  if (obj.typeCode) result.kind = obj.typeCode;
  return result;
}

// One shared queue so a search's own fan-out — and concurrent rows — respect
// the spacing. Each POST starts ≥ INTERVAL_MS after the previous one.
let queueTail: Promise<unknown> = Promise.resolve();
let lastStart = 0;

/** Send one SOAP call through the shared throttle; returns the response text. */
function govCall(operation: string, inner: string): Promise<string> {
  const run = async (): Promise<string> => {
    const wait = lastStart + INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
    const body =
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="${NS}">` +
      `<soapenv:Body><ws:${operation}>${inner}</ws:${operation}></soapenv:Body></soapenv:Envelope>`;
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/xml;charset=UTF-8", SOAPAction: '""' },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };
  const p = queueTail.then(run, run);
  queueTail = p.catch(() => undefined);
  return p;
}

/**
 * Search GOV for a place string: resolve the top name matches to full objects,
 * keep those with a coordinate and a plausible name, and rank them. The caller
 * gates this behind the online opt-in (the query text leaves the device).
 * Rejects on a network/HTTP failure of the initial search; individual object
 * lookups that fail are skipped.
 */
export async function searchGov(query: string, language: string): Promise<GovResult[]> {
  const locality = decomposePlace(query).locality ?? query.split(",")[0].trim();
  const foldedLocality = foldToken(locality);
  if (!foldedLocality) return [];

  const searchXml = await govCall("searchByName", `<placename>${xmlEscape(locality)}</placename>`);
  const ids = parseSearchIds(searchXml).slice(0, MAX_LOOKUPS);
  if (!ids.length) return [];

  const objects = await Promise.all(
    ids.map((id) => govCall("getObject", `<itemId>${xmlEscape(id)}</itemId>`).then(parseObject, () => undefined)),
  );

  const results: (GovResult & { score: number })[] = [];
  const seen = new Set<string>();
  for (const obj of objects) {
    if (!obj || seen.has(obj.id)) continue;
    seen.add(obj.id);
    const scored = scoreObject(obj, foldedLocality, language);
    if (scored) results.push(scored);
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, MAX_RESULTS).map(({ score, ...r }) => {
    void score;
    return r;
  });
}
