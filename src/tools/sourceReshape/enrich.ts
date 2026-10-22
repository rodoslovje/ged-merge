import { type MatriculaUrlParts, parseMatriculaUrl, quotedCollection, recognizeSourceUrl, siteTitle } from "./urls";
import { decodeHtmlEntities, type DirectResponse, fetchDirect, pageTitleOf } from "../../normalize/urlMetadata";
import {
  type BookType,
  isFamilySearchImageArk,
  isFetchableSite,
  type ReshapeEnrichment,
  type ReshapeGroup,
  type ReshapeMeta,
  type ReshapeOccurrence,
  type ReshapeReport,
  type ReshapeSite,
} from "./model";
import { bookEventTarget, classifyBookType } from "./scan";
import { parseFamilySearchUrl, withMatriculaLang } from "../../normalize/links";
import { bookKeyOf, looseKey } from "../../gedcom/source";
import { createThrottledQueue, retryOnce } from "../../geo/net";
import { parseSourceInput } from "../../gedcom/citationParse";

// ---------------------------------------------------------------------------
// Enrichment (optional, online; main thread only)

/** Parse a Matricula page title — `Krstna knjiga / Taufbuch - 04406 | Vodice |
 *  Nadškofijski arhiv Ljubljana | Slovenia` with an optional trailing
 *  `| Matricula Online` (present in the raw `<title>`, absent in the rendering
 *  relay's version). */
export function parseMatriculaTitle(
  title: string,
): { title: string; agency?: string; place?: string } | undefined {
  const parts = title.split("|").map((p) => p.trim());
  if (/matricula\s*online/i.test(parts[parts.length - 1] ?? "")) parts.pop();
  if (parts.length < 4) return undefined;
  return { title: `${parts[0]} | ${parts[1]}`, place: parts[1], agency: parts[2] };
}

/** Strip markdown link syntax, keeping the link text: `[Naklo](url)` → `Naklo`. */
function stripMdLinks(s: string): string {
  return s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

/**
 * The archive's full display name from the fetched Matricula page's
 * breadcrumb — the link to the archive index (`…/{country}/{archive}/`),
 * in HTML (`<a href>`) or the rendering relay's markdown. Fallback for pages
 * whose title doesn't carry the agency, upgrading the offline slug guess
 * ("Ljubljana" → "Nadškofijski arhiv Ljubljana").
 */
function matriculaArchiveName(text: string, mat: MatriculaUrlParts): string | undefined {
  const path = `/${mat.country}/${mat.archiveSlug}/`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const html = new RegExp(`<a[^>]+href="[^"]*${path}"[^>]*>([^<]+)</a>`, "i").exec(text)?.[1];
  const md = new RegExp(`\\[([^\\]]+)\\]\\([^)]*${path}\\)`, "i").exec(text)?.[1];
  const name = html ?? md;
  return name ? decodeHtmlEntities(name).replace(/\s+/g, " ").trim() || undefined : undefined;
}

/** Parse the metadata table of a Matricula book page (fetched via the `/en/`
 *  URL so the row labels are stable English). Accepts both the raw HTML
 *  `table-register-data` rows and the rendering relay's markdown table
 *  (`| Date from | Jan. 1, 1891 |`). */
export function parseMatriculaBookPage(
  html: string,
): { title?: string; type?: string; place?: string; agency?: string; dateFrom?: string; dateTo?: string } | undefined {
  const row = (label: string): string | undefined => {
    const h = new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>(.*?)</td>`, "is").exec(html);
    if (h) return decodeHtmlEntities(h[1].replace(/<[^>]+>/g, "")).trim() || undefined;
    const md = new RegExp(`^\\|\\s*${label}\\s*\\|\\s*([^|\\n]+?)\\s*\\|`, "im").exec(html);
    return md ? decodeHtmlEntities(stripMdLinks(md[1])).trim() || undefined : undefined;
  };
  const titleText = pageTitleOf(html);
  const fromTitle = titleText ? parseMatriculaTitle(titleText) : undefined;
  const type = row("Type");
  const place = row("Parish/place") ?? fromTitle?.place;
  const id = row("ID");
  const result = {
    title: fromTitle?.title ?? (type && id && place ? `${type} - ${id} | ${place}` : undefined),
    type,
    place,
    agency: fromTitle?.agency,
    dateFrom: row("Date from"),
    dateTo: row("Date to"),
  };
  return result.title || result.type || result.dateFrom ? result : undefined;
}

/**
 * Parse a Geneanet cemetery ("Save our Graves") view page. Geneanet's bot
 * protection 403s the plain relays, so in practice this sees the rendering
 * relay's markdown, whose "Localisation" block reads:
 *
 *     **Localisation**
 *     [Pokopališče Zgornje Bitnje](…/cemetery/collection/…) - P02
 *     [Žabnica](…/cemetery/search/…) (Slovenia)
 */
export function parseGeneanetCemeteryPage(
  text: string,
): { title?: string; cemetery?: string; plot?: string; town?: string; country?: string } | undefined {
  const title = pageTitleOf(text)?.replace(/\s*[-|]\s*Geneanet\s*$/i, "");
  const loc =
    /\*\*Localisation\*\*\s*\n+\[([^\]]+)\]\([^)]*\)[ \t]*(?:-[ \t]*([^\n]*?))?[ \t]*\n+\[([^\]]+)\]\([^)]*\)[ \t]*(?:\(([^)]+)\))?/.exec(
      text,
    );
  const result = {
    title,
    cemetery: loc?.[1]?.trim() || undefined,
    plot: loc?.[2]?.trim() || undefined,
    town: loc?.[3]?.trim() || undefined,
    country: loc?.[4]?.trim() || undefined,
  };
  return result.title || result.cemetery ? result : undefined;
}

/** Year-range (`1891-1920`) from the page's "Date from"/"Date to" values. */
function yearRange(from: string | undefined, to: string | undefined): string | undefined {
  const year = (s: string | undefined) => s && /(\d{4})/.exec(s)?.[1];
  const a = year(from);
  const b = year(to);
  if (a && b) return a === b ? a : `${a}-${b}`;
  return a ?? b ?? undefined;
}

/** The span of years a text names — a FamilySearch book step often holds two
 *  registers at once ("Births (Rođeni) 1892-1899 Marriages (Vjenčani)
 *  1858-1890"), and the source covers all of it. */
export function yearSpan(text: string | undefined): string | undefined {
  const years = [...(text ?? "").matchAll(/\b(1[5-9]\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  if (!years.length) return undefined;
  const from = Math.min(...years);
  const to = Math.max(...years);
  return from === to ? String(from) : `${from}-${to}`;
}

/** Media type that makes a FamilySearch ark answer with GedcomX JSON instead
 *  of the app shell — the whole reason an FS link can be read without a login. */
export const FS_GEDCOMX_ACCEPT = "application/x-gedcomx-v1+json";

interface FsArkJson {
  sourceDescriptions?: { resourceType?: string; citations?: { value?: string }[] }[];
}

/**
 * Read the GedcomX JSON a FamilySearch image ark serves. The citation
 * FamilySearch composes for the image is the richest thing in it:
 *
 *     "Croatia, Church Books, 1516-1994," database with images, FamilySearch
 *     (https://familysearch.org/ark:/61903/3:1:3QSQ-G99F-FHWS… : 16 July 2014),
 *     Roman Catholic (Rimokatolička crkva) > Pakrac >
 *     Births (Rođeni) 1892-1899 Marriages (Vjenčani) 1858-1890 > image 556 of 689;
 *     Arhiva Hrvatske u Zagrebu (Croatia State Archives), Zagreb.
 *
 * — the collection, the browse path, the image number and the holding archive.
 * The path's last step is the book (its years date the source) and the one
 * before it the place; deeper category steps ("Roman Catholic …") stay in the
 * title. The image number is FamilySearch's own, one ahead of the URL's
 * zero-based `i=`. An image outside a published collection carries no citation
 * at all — nothing to read, and the offline fields stand.
 */
export function parseFamilySearchArkJson(json: string): ReshapeMeta | undefined {
  let parsed: FsArkJson;
  try {
    parsed = JSON.parse(json) as FsArkJson;
  } catch {
    return undefined;
  }
  const citation = parsed.sourceDescriptions
    ?.find((sd) => sd.resourceType?.endsWith("/DigitalArtifact"))
    ?.citations?.find((c) => c.value?.trim())?.value;
  const meta = citation ? parseFamilySearchCitation(citation) : undefined;
  if (!meta) return undefined;
  // The collection's id, which a link need not carry itself — a repository
  // kept for that collection is found by it.
  const id = /\/records\/collections\/(\d+)/.exec(json)?.[1];
  return id ? { ...meta, collectionId: id } : meta;
}

/** Words that name the institution holding the originals, as a FamilySearch
 *  citation's "citing …" chain runs through place, place, place, archive. */
const ARCHIVE_WORD_RE = /arhiv|archiv|archive|library|knji[žz]nic|mati[čc]n|museum|muzej|registry|record office/i;

/** The film/microfilm number a citation ends with ("FHL microfilm 005,498,154",
 *  "film 005498154", "DGS 4826234", "Image Group Number: 108918058" — the last
 *  is the DGS number under its current on-site name). */
const FILM_NUMBER_RE = /(?:FHL\s+)?(?:microfilm|film|DGS|image group number)\s*[#:]?\s*([\d][\d,\s]*\d|\d)/i;

/**
 * Read a citation copied from FamilySearch's own "Copy citation" button. Its
 * indexed **record** pages are sign-in-only — no lookup of any kind reaches
 * them — so a pasted citation is the one way their details reach the file:
 *
 *     "Croatia, Church Books, 1516-1994," database with images, FamilySearch
 *     (https://familysearch.org/ark:/61903/1:1:JFVN-KMV : 11 March 2018),
 *     Ana Renko in entry for Josip Renko, 1885; citing Baptism, Ravna Gora,
 *     Primorje-Gorski Kotar, Croatia, Državni arhiv u Rijeci (State Archives),
 *     Rijeka; FHL microfilm 005,498,154.
 *
 * The collection names the source, the "citing" chain gives the register type,
 * the place and the holding archive, and the tail gives the film number. The
 * person and entry the citation names are *this* record, not the source, and
 * stay out of the source's fields. An image citation pasted here is understood
 * too — same head, different tail.
 */
export function parsePastedFsCitation(text: string): ReshapeMeta | undefined {
  const plain = decodeHtmlEntities(text.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  if (!/familysearch/i.test(plain)) return undefined;
  if (/ > /.test(plain) && /image \d+/i.test(plain)) return parseFamilySearchCitation(plain);

  const collection = quotedCollection(plain);
  const rest = /\(https?:[^)]*\)\s*,?\s*(.*)$/i.exec(plain)?.[1] ?? plain;
  const parts = rest.split(";").map((s) => s.trim()).filter(Boolean);
  const citing = parts.find((p) => /^citing\b/i.test(p))?.replace(/^citing\s+/i, "");
  const film = FILM_NUMBER_RE.exec(rest)?.[1].replace(/[,\s]/g, "");
  // An image citation's tail is "image 23 of 35; National Archives and
  // Records Administration. Image Group Number: 108918058" — the image number
  // is the cited page, what follows the semicolon the holding institution.
  const image = /^image (\d+) of \d+\.?$/i.exec(parts[0] ?? "");
  // "Entry for Anna Rakar and Martin Sadec, 9 July 1901" — which record within
  // the collection this is. That is what a citation's PAGE says; the source
  // itself is the collection, so it never goes into the source's own fields.
  const entry = !image && parts[0] && !/^citing\b/i.test(parts[0]) ? parts[0].replace(/\.\s*$/, "") : undefined;

  let place: string | undefined;
  let agency: string | undefined;
  let type: BookType = "unknown";
  if (citing) {
    const tokens = citing.replace(/\.\s*$/, "").split(",").map((s) => s.trim()).filter(Boolean);
    if (tokens.length && classifyBookType([tokens[0]]) !== "unknown") type = classifyBookType([tokens.shift()]);
    const archiveAt = tokens.findIndex((tok) => ARCHIVE_WORD_RE.test(tok));
    const placeTokens = archiveAt === -1 ? tokens : tokens.slice(0, archiveAt);
    place = placeTokens.join(", ") || undefined;
    if (archiveAt !== -1) agency = tokens.slice(archiveAt).join(", ") || undefined;
  } else if (image && parts[1]) {
    // The holder, minus the film sentence the same part may carry.
    agency = parts[1].replace(FILM_NUMBER_RE, "").replace(/[\s.,:]+$/, "").trim() || undefined;
  }
  if (!collection && !place && !agency && !film) return undefined;
  return {
    title: collection ?? "FamilySearch",
    collection,
    place,
    agency,
    filingNumber: film,
    page: image?.[1] ?? entry,
    // The years the collection's own name gives ("…, 1892-1925") — all a
    // record page says about the source's span.
    dateRange: yearSpan(collection),
    bookType: type === "unknown" ? undefined : type,
  };
}

function parseFamilySearchCitation(raw: string): ReshapeMeta | undefined {
  const text = decodeHtmlEntities(raw.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  const collection = quotedCollection(text);
  // Everything past the "(url : accessed date)": the browse path, then the
  // holding archive after the last semicolon.
  const rest = /\(https?:[^)]*\)\s*,?\s*(.*)$/i.exec(text)?.[1] ?? "";
  const semi = rest.lastIndexOf(";");
  const holder = semi >= 0 ? rest.slice(semi + 1).replace(/\.\s*$/, "").replace(/^\s*citing\s+/i, "").trim() : "";
  // A published microfilm names its publisher the bibliographic way — "NARA
  // microfilm publication T715 and M237 (Washington D.C.: National Archives
  // and Records Administration, n.d.)" — where an archive's own holding names
  // only itself ("Arhiva Hrvatske u Zagrebu (Croatia State Archives), Zagreb").
  const published = /^(.*?)\s*\(([^:()]{2,60}):\s*([^()]+?)(?:,\s*(?:n\.d\.|\d{4}))?\)$/.exec(holder);
  const agency = published ? published[1].trim() : holder;
  const publisher = published?.[3].trim();
  const publishedPlace = published?.[2].trim();
  const steps = (semi >= 0 ? rest.slice(0, semi) : rest).split(">").map((s) => s.trim()).filter(Boolean);
  const image = /^image (\d+)\b/i.exec(steps[steps.length - 1] ?? "");
  if (image) steps.pop();
  const book = steps[steps.length - 1];
  const place = steps.length > 1 ? steps[steps.length - 2] : undefined;
  if (!collection && !book) return undefined;
  const type = classifyBookType([book]);
  return {
    // Most specific first, the collection naming the whole: "Pakrac - Births
    // (Rođeni) 1892-1899 … - Croatia, Church Books, 1516-1994".
    title: siteTitle(place, book, collection ?? "FamilySearch"),
    collection,
    book,
    // The browse path's own place first; the publication's city only where the
    // path named none.
    place: place ?? publishedPlace,
    agency: agency || undefined,
    publisher,
    page: image?.[1],
    dateRange: yearSpan(book),
    // A book holding births *and* marriages classifies as neither — "unknown"
    // must not clobber an offline guess from the citation text.
    bookType: type === "unknown" ? undefined : type,
  };
}

/**
 * The registers a FamilySearch book label names, when it names more than one:
 * "Births (Rođeni) 1892-1899 Marriages (Vjenčani) 1858-1890" is one browse
 * step covering two registers, and a page of it belongs to exactly one — which
 * only the person looking at the image knows (FamilySearch's own item-level
 * view of that film sits behind a sign-in). Each part runs up to and including
 * its year range; a label the parts don't fully account for names nothing to
 * choose between, and comes back empty.
 */
export function splitFsRegisters(book: string | undefined): string[] {
  if (!book) return [];
  const parts = book.match(/\S.*?\d{4}(?:\s*[-–]\s*\d{4})?(?=\s|$)/g) ?? [];
  if (parts.length < 2) return [];
  // Every word of the label must belong to a part — otherwise the split is a
  // guess about text it doesn't understand.
  return parts.join(" ").replace(/\s+/g, " ") === book.replace(/\s+/g, " ").trim() ? parts : [];
}

/** The same fetched metadata narrowed to one of {@link splitFsRegisters}'
 *  registers: its own title, year span and register type — the last of which
 *  puts the citation on the matching event. */
export function narrowFsRegister(meta: ReshapeMeta, register: string): ReshapeMeta {
  const type = classifyBookType([register]);
  return {
    ...meta,
    book: register,
    title: siteTitle(meta.place, register, meta.collection ?? "FamilySearch"),
    dateRange: yearSpan(register),
    bookType: type === "unknown" ? undefined : type,
  };
}

/** Rewrite a Matricula book URL to its `/en/` variant (stable table labels). */
function matriculaEnUrl(bookUrl: string): string {
  return withMatriculaLang(bookUrl, "en");
}

/** Session-wide fetched-metadata cache, keyed by page-independent book key —
 *  re-opening the panel or re-running enrichment never refetches a book. */
const bookMetaCache = new Map<string, ReshapeMeta>();

/** What a book's own page said, if this session has already read it — the
 *  synchronous half of {@link fetchBookMeta}, for callers that cannot wait for
 *  the network (the merge writes its sources in one pass) and take the offline
 *  proposal when nothing has been read. */
export function cachedBookMeta(site: ReshapeSite, bookUrl: string): ReshapeMeta | undefined {
  return bookMetaCache.get(`${site}:${bookKeyOf(bookUrl)}`);
}

/** FamilySearch's edge answers a burst of requests with a block page (403 from
 *  its security service) — which would also hit the user's own FamilySearch
 *  tab, on the same address. Ark lookups therefore run one at a time with a
 *  gap: a file full of links takes longer, and nothing gets locked out. */
const FS_GAP_MS = 600;
/** Should the edge block anyway (or the connection drop), wait this long and
 *  try that one link again — a whole file's worth of lookups must not be lost
 *  to a single refusal partway through. */
const FS_RETRY_MS = 5000;
const pacedFsFetch = createThrottledQueue(FS_GAP_MS, { fromEnd: true });

/** A refused request worth trying again: the edge's block/rate-limit answers,
 *  and a connection that produced no answer at all. A 401 (a record page
 *  wanting a sign-in) is a real answer — retrying it changes nothing. */
function fsWorthRetrying(status: number): boolean {
  return status === 0 || status === 403 || status === 429 || status >= 500;
}

async function fetchFsArk(
  fetchArk: (url: string, accept: string) => Promise<DirectResponse>,
  url: string,
): Promise<string | undefined> {
  const res = await retryOnce(
    () => fetchArk(url, FS_GEDCOMX_ACCEPT).catch(() => ({ status: 0 }) as DirectResponse),
    (first) => (first.text || !fsWorthRetrying(first.status) ? undefined : FS_RETRY_MS),
  );
  return res.text;
}

/** Parse one fetched book/record page into source metadata — the per-site
 *  rules shared by the cleanup tool's enrichment and the Add Source dialog. */
function parseBookMeta(site: ReshapeSite, bookUrl: string, html: string): ReshapeMeta | undefined {
  let meta: ReshapeMeta | undefined;
  if (site === "matricula") {
    const page = parseMatriculaBookPage(html);
    if (page) {
      // "unknown" must not clobber a correct offline classification
      // (e.g. baptism inferred from a "KK" citation prefix).
      const fetchedType = classifyBookType([page.type]);
      const mat = parseMatriculaUrl(bookUrl);
      meta = {
        title: page.title,
        // Title-derived agency first; else the breadcrumb's archive link.
        agency: page.agency ?? (mat && matriculaArchiveName(html, mat)),
        place: page.place,
        dateRange: yearRange(page.dateFrom, page.dateTo),
        bookType: fetchedType === "unknown" ? undefined : fetchedType,
      };
    }
  } else if (site === "geneanet") {
    const page = parseGeneanetCemeteryPage(html);
    if (page) {
      meta = {
        // PLAC is the *place* (town, country); the cemetery itself
        // names the source and stays in the title.
        place: [page.town, page.country].filter(Boolean).join(", ") || undefined,
        // The cemetery is address-level detail for the BURI event; the plot
        // says where within the cemetery, so it goes on the citation PAGE.
        address: page.cemetery,
        page: page.plot,
        // `{cemetery} - Geneanet Cemeteries` — the town stays out of the
        // title (PLAC carries it) and the view id is the filing number.
        title: page.cemetery ? siteTitle(page.cemetery, undefined, "Geneanet Cemeteries") : undefined,
      };
    }
  } else if (site === "findagrave") {
    // `Frank Gorishek (1881-1968) - Find a Grave Memorial` → the name;
    // the suffix may arrive ellipsized ("- Find a…"), match loosely.
    // Find a Grave blocks the plain relays, so in practice this sees the
    // rendering relay's markdown, whose Burial block reads:
    //
    //     [St. Theresa of Avila Catholic Church Cemetery](…/cemetery/2622358/…)
    //     Ravna Gora, Općina Ravna Gora, Primorsko-Goranska, Croatia[_Add to Map_](…)
    //
    // The cemetery names the grave (`{person} - {cemetery} - Find a Grave`)
    // and becomes the BURI address; the location line is the place.
    const name = pageTitleOf(html)?.replace(/\s*[-–]\s*Find a.*$/i, "").trim();
    const cem = /\[([^\]\n]+)\]\(https?:\/\/[^)]*findagrave\.com\/cemetery\/\d+\/(?!memorial-search)[^)]*\)\s*\n+([^\n[]+)/i.exec(html);
    const cemetery = cem?.[1]?.trim();
    const location = cem?.[2]?.trim().replace(/[,\s]+$/, "");
    if (name) {
      meta = {
        title: siteTitle(name, cemetery, "Find a Grave"),
        place: location || undefined,
        address: cemetery,
      };
    }
  } else if (site === "billiongraves") {
    // The grave page is server-rendered with a schema.org Person JSON-LD:
    // name, birth/death dates, and the cemetery (`deathPlace`) with its
    // postal address. `{person} - {cemetery} - BillionGraves` names the
    // grave; the cemetery is the BURI address, its town/country the place.
    interface BgPlace {
      name?: string;
      address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string };
    }
    interface BgPerson {
      "@type"?: string;
      name?: string;
      deathPlace?: BgPlace;
    }
    let person: BgPerson | undefined;
    for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const parsed = JSON.parse(m[1]) as BgPerson | BgPerson[];
        person = (Array.isArray(parsed) ? parsed : [parsed]).find((x) => x?.["@type"] === "Person");
        if (person) break;
      } catch {
        // not JSON — try the next block
      }
    }
    const name = person?.name ?? pageTitleOf(html)?.replace(/\s*[-|]\s*BillionGraves.*$/i, "").trim();
    if (name) {
      const cemetery = person?.deathPlace?.name;
      const addr = person?.deathPlace?.address;
      const place =
        [...new Set([addr?.addressLocality, addr?.addressRegion, addr?.addressCountry].filter(Boolean))].join(", ") ||
        undefined;
      meta = { title: siteTitle(name, cemetery, "BillionGraves"), place, address: cemetery };
    }
  } else if (site === "geneanettree") {
    // The rendered page (Geneanet blocks plain relays) titles itself
    // `Family tree of Rajko Vute` — bookUrl carries lang=en for a stable
    // prefix. A trailing `(26)` is GeneWeb's occurrence ordinal that tells
    // same-named persons in the tree apart — technical, so it stays out of
    // the title (the URL keeps it). The tree's owner is the author:
    // `{person} - {owner} - Geneanet Trees`.
    const tree = /gw\.geneanet\.org\/([a-z0-9_-]+)\?/i.exec(bookUrl)?.[1];
    const name = pageTitleOf(html)
      ?.replace(/^\s*Family tree of\s+/i, "")
      .replace(/\s*[-|]\s*Geneanet\s*$/i, "")
      .replace(/\s*\(\d+\)\s*$/, "")
      .trim();
    if (name && !/^https?:\/\//i.test(name)) {
      meta = { title: siteTitle(name, tree, "Geneanet Trees"), author: tree };
    }
  } else if (site === "googlebooks") {
    // The reader page server-renders the volume heading, and for a newspaper
    // it carries the issue's date: `<h1 class="gb-volume-title">The Windsor
    // Star <span dir=ltr>May 23, 1969</span></h1>` (hl=en on the fetch pins
    // the date language). The rendering relay flattens the same heading to a
    // markdown `# The Windsor Star May 23, 1969` line, so the date is
    // tail-matched there. A dated issue is unique — `{name}, {date} - Google
    // Books` — and the date fills the source's DATE; undated volumes (books)
    // keep the volume id in the title, since one newspaper spans many
    // volumes and the page title alone can't tell them apart. A relay
    // sometimes titles a failed render with the URL itself — that's not a
    // name; the offline title stands.
    const pageName = pageTitleOf(html)?.replace(/\s*-\s*Google\s+\p{L}+\s*$/u, "").trim();
    const h1 = /<h1 class="gb-volume-title"[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
    let name: string | undefined;
    let date: string | undefined;
    if (h1) {
      const heading = decodeHtmlEntities(h1.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      date = /<span[^>]*>([^<]+)<\/span>/i.exec(h1)?.[1].trim();
      name = (date ? heading.replace(date, "").replace(/[\s,]+$/, "") : heading).trim() || undefined;
    } else {
      // Markdown flattens the heading to `# {name} {date}`, with the date in
      // whatever shape the page used ("May 23, 1969" / "Dec 27, 1975" /
      // "13 Feb 1965") — the name is known from the page title, so the date
      // is simply the year-bearing remainder after it.
      const heading = /^#\s+(.+)$/m.exec(html)?.[1].trim();
      if (heading && pageName && heading.startsWith(pageName)) {
        const tail = heading.slice(pageName.length).replace(/^[\s,–—-]+/, "").trim();
        if (/\d{4}/.test(tail) && tail.length >= 4 && tail.length <= 24) date = tail;
      }
    }
    name = name ?? pageName;
    const volumeId = /[?&]id=([A-Za-z0-9_-]+)/.exec(bookUrl)?.[1];
    if (name && !/^https?:\/\//i.test(name)) {
      meta = date
        ? { title: siteTitle(`${name}, ${date}`, undefined, "Google Books"), dateRange: date }
        : { title: siteTitle(name, volumeId, "Google Books") };
    }
  } else if (site === "youtube") {
    // YouTube's public oEmbed endpoint returns JSON: the video's title and
    // channel. The watch page's title is the fallback.
    let data: { title?: string; author_name?: string } | undefined;
    try {
      data = JSON.parse(html) as { title?: string; author_name?: string };
    } catch {
      data = undefined;
    }
    const name = data?.title ?? pageTitleOf(html)?.replace(/\s*-\s*YouTube\s*$/i, "").trim();
    if (name) meta = { title: siteTitle(name, undefined, "YouTube"), author: data?.author_name };
  } else if (site === "legacy") {
    const name = pageTitleOf(html)?.replace(/\s*[-|]\s*Legacy\.com.*$/i, "").trim();
    if (name) meta = { title: siteTitle(name, undefined, "Legacy.com") };
  } else if (site === "wikipedia") {
    // `Primož Trubar - Wikipedija, prosta enciklopedija` / `… - Wikipedia` —
    // the display title (proper diacritics) replaces the URL-slug guess.
    const name = pageTitleOf(html)?.replace(/\s*[-–—]\s*Wikipedi\p{L}*.*$/iu, "").trim();
    if (name && !/^https?:\/\//i.test(name)) {
      meta = { title: siteTitle(name, undefined, "Wikipedia") };
    }
  } else if (site === "biografija") {
    // `Trubar, Primož (med 1507 in 1509–1586) - Slovenska biografija` — the
    // person's name with life years; a missing entry titles itself
    // "Stran ne obstaja", which is not a name.
    const name = pageTitleOf(html)?.replace(/\s*[-–—]\s*Slovenska biografija\s*$/i, "").trim();
    if (name && !/^https?:\/\//i.test(name) && !/^stran ne obstaja$/i.test(name)) {
      meta = { title: siteTitle(name, undefined, "Slovenska biografija") };
    }
  } else if (site === "obrazi") {
    // `Primož TRUBAR | Obrazi slovenskih pokrajin` — the name before the pipe.
    const name = pageTitleOf(html)?.replace(/\s*[|–—-]\s*Obrazi slovenskih pokrajin\s*$/i, "").trim();
    if (name && !/^https?:\/\//i.test(name)) {
      meta = { title: siteTitle(name, undefined, "Obrazi slovenskih pokrajin") };
    }
  } else if (site === "dlib") {
    // The dLib.si details page is server-rendered: a key/value metadata table
    // (Vir, Leto, Številčenje, Založnik, Izvor) plus a `dLib.si - {title}`
    // page title. `{publication}, {date}, {issue} - dLib.si` names the source;
    // the holding library is the agency.
    const row = (label: string): string | undefined => {
      const m = new RegExp(`class="[^"]*key">\\s*${label}\\s*</div>\\s*<div[^>]*class="[^"]*value">(.*?)</div>`, "is").exec(html);
      return m ? decodeHtmlEntities(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() || undefined : undefined;
    };
    const publication = pageTitleOf(html)?.replace(/^\s*dLib\.si\s*[-–]\s*/i, "").trim() || row("Vir");
    const date = row("Leto");
    const numbering = row("Številčenje");
    if (publication) {
      meta = {
        title: siteTitle([publication, date, numbering].filter(Boolean).join(", "), undefined, "dLib.si"),
        periodical: row("Vir"),
        publisher: row("Založnik"),
        agency: row("Izvor"),
        dateRange: date,
      };
    }
  } else if (site === "sistory") {
    const war = /\/(ww[12])\//i.exec(bookUrl)?.[1].toUpperCase();
    // The record pages are client-rendered (Next.js): a plain relay sees an
    // empty <title> and no visible text, but the embedded __NEXT_DATA__ JSON
    // carries the record — the person's name, the contributor (author) list
    // and the publishing institute. The record id stays out of the title
    // (it's the filing number).
    const nextData = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
    let record:
      | {
          titles?: string[];
          contributors?: { firstName?: string; lastName?: string }[];
          contributorGroups?: { name?: string }[];
        }
      | undefined;
    if (nextData) {
      try {
        record = (JSON.parse(nextData) as { props?: { pageProps?: { data?: typeof record } } }).props?.pageProps?.data;
      } catch {
        record = undefined;
      }
    }
    if (record?.titles?.[0]) {
      const authors = (record.contributors ?? [])
        .map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ").trim())
        .filter(Boolean)
        .join(", ");
      meta = {
        title: siteTitle(record.titles[0], war, "SIstory.si"),
        author: authors || undefined,
        // The corpus title and publication place the page's own Citiranje
        // section uses for the WW2 casualty database.
        periodical: war === "WW2" ? "Smrtne žrtve druge svetovne vojne in zaradi nje v Sloveniji" : undefined,
        place: war === "WW2" ? "Ljubljana" : undefined,
        agency: record.contributorGroups?.[0]?.name,
      };
    } else {
      // The rendering relay returns the composed page instead — its
      // "Citiranje" section is a full citation; parse it with the same
      // citation parser the paste box uses, so a fetched URL fills the same
      // fields as pasting the Citiranje content by hand.
      const citStart = html.search(/Citiranje/i);
      const citText =
        citStart >= 0
          ? decodeHtmlEntities(stripMdLinks(html.slice(citStart + "Citiranje".length, citStart + 800)).replace(/<[^>]+>/g, " "))
              .replace(/\s+/g, " ")
              .trim()
          : undefined;
      const cit = citText ? parseSourceInput(citText) : {};
      const name = cit.title ?? pageTitleOf(html)?.replace(/\s*[-|·]\s*S[Ii]story.*$/i, "").trim();
      if (name) {
        meta = {
          title: siteTitle(name, war, "SIstory.si"),
          author: cit.author,
          periodical: cit.periodical,
          // The citation's "(Ljubljana: Inštitut …)" — place + agency.
          place: cit.place,
          agency: cit.publisher,
        };
      }
    }
  } else if (site === "familysearch") {
    // JSON, not a page — and the app shell a relay would return says nothing
    // ("FamilySearch.org"), so there is no title fallback here.
    meta = parseFamilySearchArkJson(html);
  } else {
    const title = pageTitleOf(html);
    if (title) meta = { title: title.replace(/\s*[-|]\s*Geneanet\s*$/i, "") };
  }
  if (meta && !Object.values(meta).some(Boolean)) return undefined; // nothing usable parsed
  return meta;
}

/**
 * Fetch and parse the metadata for one book/record URL — cached session-wide
 * by book key, so the cleanup tool's enrichment and the Add Source dialog
 * never refetch the same book. Undefined on any fetch/parse failure.
 */
export async function fetchBookMeta(
  site: ReshapeSite,
  bookUrl: string,
  fetchHtml: (url: string) => Promise<string | undefined>,
  /** The no-relay fetch FamilySearch arks use; injectable for tests. */
  fetchArk: (url: string, accept: string) => Promise<DirectResponse> = fetchDirect,
): Promise<ReshapeMeta | undefined> {
  // A FamilySearch record page or catalog film would only answer 401/403 —
  // don't ask at all.
  if (site === "familysearch" && !isFamilySearchImageArk(bookUrl)) return undefined;
  const cacheKey = `${site}:${bookKeyOf(bookUrl)}`;
  const cached = bookMetaCache.get(cacheKey);
  if (cached) return cached;
  const url =
    site === "matricula"
      ? matriculaEnUrl(bookUrl)
      : site === "youtube"
        ? `https://www.youtube.com/oembed?url=${encodeURIComponent(bookUrl)}&format=json`
        : site === "googlebooks"
          ? // The bare volume URL redirects to the About page, which carries no
            // issue date — printsec=frontcover keeps the *reader* page, whose
            // heading dates a newspaper issue; hl=en pins the date language.
            `${bookUrl}&printsec=frontcover&hl=en`
          : bookUrl;
  // FamilySearch is asked directly: its ark answers cross-origin requests
  // itself, so no relay sees the URL and the answer is the site's own. The
  // image's film (DGS) number rides in the same paced slot — one more tiny
  // anonymous request against the ark, answering `dgs:005482250.…_00127`;
  // that number is the film the source's FILN and the repository's CALN cite.
  let meta: ReshapeMeta | undefined;
  if (site === "familysearch") {
    const ark = parseFamilySearchUrl(bookUrl)?.ark;
    const { json, film } = await pacedFsFetch(async () => {
      const json = await fetchFsArk(fetchArk, url);
      let film: string | undefined;
      if (json && ark) {
        const name = await fetchArk(
          `https://www.familysearch.org/das/v2/${ark}/name?namespace=dgs`,
          "text/plain",
        ).catch(() => ({ status: 0 }) as DirectResponse);
        film = /^dgs:(\d+)\./.exec(name.text?.trim() ?? "")?.[1];
      }
      return { json, film };
    });
    meta = json ? parseBookMeta(site, bookUrl, json) : undefined;
    if (meta && film) meta = { ...meta, filingNumber: meta.filingNumber ?? film };
  } else {
    const html = await fetchHtml(url).catch(() => undefined);
    meta = html ? parseBookMeta(site, bookUrl, html) : undefined;
  }
  // A dateless Google Books result usually means a relay was served the About
  // page instead of the reader — don't pin that for the session; a later run
  // through a different relay may land the dated reader heading.
  if (meta && !(site === "googlebooks" && !meta.dateRange)) bookMetaCache.set(cacheKey, meta);
  return meta;
}

/**
 * Fetch metadata for the given (new-source) groups — **one fetch per book**,
 * via the injected `fetchHtml` (the allorigins relay wrapper; injectable for
 * tests) — except FamilySearch arks, which are read directly from the site.
 * Geneanet blocks non-browser clients (kept best-effort via the page title if
 * the relay gets through). Failures are swallowed — offline fallbacks stay.
 */
export async function fetchReshapeMeta(
  groups: ReshapeGroup[],
  fetchHtml: (url: string) => Promise<string | undefined>,
  onProgress?: (done: number, total: number) => void,
  /** Called the moment one book resolves, so the UI can update incrementally. */
  onMeta?: (groupId: string, meta: ReshapeMeta) => void,
): Promise<ReshapeEnrichment> {
  const enrichment: ReshapeEnrichment = new Map();
  const targets = groups.filter((g) => isFetchableSite(g.site, g.bookUrl));
  let done = 0;
  onProgress?.(0, targets.length);

  const worker = async (queue: ReshapeGroup[]): Promise<void> => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      const meta = await fetchBookMeta(g.site, g.bookUrl, fetchHtml);
      if (meta) {
        enrichment.set(g.id, meta);
        onMeta?.(g.id, meta);
      }
      onProgress?.(++done, targets.length);
    }
  };

  const queue = [...targets];
  await Promise.all([worker(queue), worker(queue)]);
  return enrichment;
}

/**
 * Read the pages of the given books — the same per-site parsers and the same
 * session cache {@link fetchBookMeta} keeps, two at a time as the enrichment
 * pass does — so what each page says is on hand for the source about to be
 * written for it. Used by the save, which mints sources for the links a merge
 * brings in and would otherwise name them from the address alone. Failures are
 * swallowed; the offline proposal stands. Returns how many books answered.
 */
export async function readBookPages(
  bookUrls: readonly string[],
  fetchHtml: (url: string) => Promise<string | undefined>,
): Promise<number> {
  let read = 0;
  const worker = async (queue: BookTarget[]): Promise<void> => {
    for (let target = queue.shift(); target; target = queue.shift()) {
      if (await readBook(target, fetchHtml)) read++;
    }
  };
  const queue = bookTargets(bookUrls);
  await Promise.all([worker(queue), worker(queue)]);
  return read;
}

interface BookTarget { site: ReshapeSite; bookUrl: string }

/** The distinct fetchable books among `bookUrls`, minus the ones this session
 *  has already read or already tried and failed (see {@link readBook}). */
function bookTargets(bookUrls: readonly string[]): BookTarget[] {
  const targets: BookTarget[] = [];
  for (const bookUrl of new Set(bookUrls)) {
    const site = recognizeSourceUrl(bookUrl)?.site;
    if (!site || !isFetchableSite(site, bookUrl)) continue;
    if (cachedBookMeta(site, bookUrl) || silentBooks.has(`${site}:${bookKeyOf(bookUrl)}`)) continue;
    targets.push({ site, bookUrl });
  }
  return targets;
}

/**
 * Books that were asked and said nothing — a relay chain that ends in silence
 * costs the better part of a minute (Geneanet answers none of the plain relays),
 * and asking the same book again on the next save spends it again for the same
 * answer. The offline proposal names the source instead, and a reload gives any
 * book a fresh chance.
 */
const silentBooks = new Set<string>();

/** One book, read once per session: an in-flight read is joined rather than
 *  duplicated, so the save and the background queue never fetch the same page
 *  twice, and silence is remembered. */
function readBook(
  target: BookTarget,
  fetchHtml: (url: string) => Promise<string | undefined>,
): Promise<ReshapeMeta | undefined> {
  const key = `${target.site}:${bookKeyOf(target.bookUrl)}`;
  const running = inFlightBooks.get(key);
  if (running) return running;
  const p = fetchBookMeta(target.site, target.bookUrl, fetchHtml)
    .catch(() => undefined)
    .then((meta) => {
      inFlightBooks.delete(key);
      if (!meta) silentBooks.add(key);
      return meta;
    });
  inFlightBooks.set(key, p);
  return p;
}

const inFlightBooks = new Map<string, Promise<ReshapeMeta | undefined>>();

/**
 * Start reading these books in the background, two at a time, and return at
 * once. Called as matches are confirmed, so the pages a save would need are
 * already read by the time it runs — the same session cache serves both, and
 * {@link readBookPages} joins whatever is still in flight instead of asking
 * again. Books already read, already queued, or already silent cost nothing.
 */
export function queueBookPages(
  bookUrls: readonly string[],
  fetchHtml: (url: string) => Promise<string | undefined>,
): void {
  for (const target of bookTargets(bookUrls)) {
    if (!inFlightBooks.has(`${target.site}:${bookKeyOf(target.bookUrl)}`)) backlog.push(target);
  }
  while (backlogWorkers < BACKLOG_WORKERS && backlog.length) {
    backlogWorkers++;
    void (async () => {
      for (let target = backlog.shift(); target; target = backlog.shift()) {
        await readBook(target, fetchHtml);
      }
      backlogWorkers--;
    })();
  }
}

/** Two at a time, as every other reading pass here: the relays rate-limit, and
 *  this one runs while the reader is working. */
const BACKLOG_WORKERS = 2;
const backlog: BookTarget[] = [];
let backlogWorkers = 0;

/** Test seam: forget what this session has read, queued and given up on. */
export function resetBookQueue(): void {
  silentBooks.clear();
  inFlightBooks.clear();
  backlog.length = 0;
}

/**
 * Fold the FamilySearch groups that turned out to be pages of one book into a
 * single group — one source with a page citation per image, the shape a
 * paginated register wants, instead of one source per image.
 *
 * It can only run *after* enrichment: a FamilySearch image link says nothing
 * about the book it belongs to (`ark:/61903/3:1:…?view=index` and no more), so
 * which pages are one book is knowledge that arrives with the lookup. Each
 * image keeps its own page number, moved onto the member it belongs to.
 *
 * Groups already bound to a source in the file, and groups marked for removal,
 * are left alone. Returns the same report and enrichment untouched when there
 * is nothing to fold, and `keyOf` — the original group ids that went into each
 * book — for {@link reshapeSources} to fold its own scan the same way.
 */
export function mergeFsBooks(
  report: ReshapeReport,
  enrichment: ReshapeEnrichment,
  baptismTag: "BIRT" | "BAPM" = "BIRT",
): { report: ReshapeReport; enrichment: ReshapeEnrichment; keyOf: Map<string, string> } {
  // A member scanned before the lookup knew the book's type shows no move,
  // yet the apply relocates it with the enriched type — fill the display in
  // so the row promises the move the apply will make. Moves the scan *did*
  // compute (incl. marriage, which needs the family) are kept as they are.
  const refreshMove = (m: ReshapeOccurrence, bookType: BookType): ReshapeOccurrence => {
    if (m.targetEvent || m.foldedInto || m.shape === "sourTitle") return m;
    const target = bookEventTarget(m.recordTag, m.eventTag, bookType, baptismTag);
    return target ? { ...m, targetEvent: target } : m;
  };

  const byBook = new Map<string, { meta: ReshapeMeta; groups: ReshapeGroup[] }>();
  for (const g of report.groups) {
    if (g.site !== "familysearch" || g.removeLinks) continue;
    const meta = enrichment.get(g.id);
    if (!meta?.book) continue;
    const key = `f:book:${looseKey(`${meta.collection ?? ""} ${meta.place ?? ""} ${meta.book}`)}`;
    const slot = byBook.get(key);
    if (slot) slot.groups.push(g);
    else byBook.set(key, { meta, groups: [g] });
  }

  const keyOf = new Map<string, string>();
  const books = new Map<string, ReshapeGroup>();
  const bookMeta = new Map<string, ReshapeMeta>();
  for (const [key, { meta, groups }] of byBook) {
    if (groups.length < 2) continue; // one page is already its own group
    const bookType = meta.bookType ?? "unknown";
    const members: ReshapeOccurrence[] = [];
    for (const g of groups) {
      keyOf.set(g.id, key);
      const page = enrichment.get(g.id)?.page;
      for (const m of g.members) members.push(refreshMove(page && !m.page ? { ...m, page } : m, bookType));
    }
    // A page of this book that the file already cites names the source the
    // whole book belongs to: the new pages join *that* record instead of
    // minting a second source for one book.
    const bound = groups.find((g) => g.existingSourceXref);
    books.set(key, {
      id: key,
      site: "familysearch",
      bookType,
      existingSourceXref: bound?.existingSourceXref,
      existingSourceTitle: bound?.existingSourceTitle,
      urlTitled: bound?.urlTitled,
      proposed: {
        title: meta.title ?? groups[0].proposed.title,
        author: meta.author,
        agency: meta.agency,
        place: meta.place,
        // Not the ark (that named a single image) — the film (DGS) number,
        // when the lookup resolved it, is an id the whole book shares.
        filingNumber: meta.filingNumber,
        dateRange: meta.dateRange,
      },
      bookUrl: groups[0].bookUrl,
      pages: [...new Set(members.map((m) => m.page).filter((p): p is string => !!p))].sort(
        (a, b) => Number(a) - Number(b) || a.localeCompare(b),
      ),
      members,
    });
    // The book's own metadata: the page belongs to each image, not to the book.
    bookMeta.set(key, { ...meta, page: undefined });
  }
  // Each book takes the place of the first of its pages; the rest disappear.
  // A group left unfolded still takes its lookup's book type — the scan may
  // not have known it (a bare image link says nothing), and the apply will
  // relocate by the enriched type, so the row must say so too.
  let changed = keyOf.size > 0;
  const groups: ReshapeGroup[] = [];
  const emitted = new Set<string>();
  for (const g of report.groups) {
    const key = keyOf.get(g.id);
    if (!key) {
      const bookType = (!g.removeLinks && enrichment.get(g.id)?.bookType) || g.bookType;
      const members = g.members.map((m) => refreshMove(m, bookType));
      if (bookType !== g.bookType || members.some((m, i) => m !== g.members[i])) {
        groups.push({ ...g, bookType, members });
        changed = true;
      } else groups.push(g);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    groups.push(books.get(key)!);
  }
  if (!changed) return { report, enrichment, keyOf };
  const merged: ReshapeEnrichment = new Map(enrichment);
  // A hand-edited book keeps its edits — only an unseen one takes the fold's.
  for (const [key, meta] of bookMeta) if (!merged.has(key)) merged.set(key, meta);
  return { report: { ...report, groups }, enrichment: merged, keyOf };
}
