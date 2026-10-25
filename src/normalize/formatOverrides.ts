import { placeSeparatorText } from "./profile";
import type { DateFormatProfile, MainProfile, NameProfile, PlaceLayout, PlaceTargetFormat, SourceLayout } from "./types";

/**
 * User-chosen overrides for the file-format conventions the app otherwise
 * detects. Every field is optional — absent means "Detected": the tools use
 * whatever the file's own majority habit is. A set field wins everywhere the
 * corresponding detection is consumed: the compare-file normalizer (via
 * {@link applyFormatOverrides} on the inferred main profile), Organize
 * sources, Add Source and the editing helpers.
 *
 * Stored in AppSettings (localStorage), so the object must stay
 * JSON-serializable and tolerant of unknown/legacy keys.
 */
export interface FormatOverrides {
  /** Date pattern, one of {@link DATE_PATTERN_CHOICES} (e.g. "DD.MM.YYYY"). */
  date?: string;
  /** Marker for an unknown date component in numeric dates ("_" / "?"), or
   *  "none" to omit unknown parts. */
  datePlaceholder?: "none" | "_" | "?";
  /** Place layout (see {@link PlaceLayout}). */
  place?: Exclude<PlaceLayout, "unknown">;
  /** Between two place jurisdictions: `Kranj,Slovenija` vs `Kranj, Slovenija`. */
  placeSeparator?: "comma" | "comma-space";
  /** Alternate-name storage: separate NAME records vs inline sub-tags. */
  names?: "records" | "tags";
  /** Unknown-name marker: "blank" to strip placeholders, or a literal token
   *  (e.g. "NN") to write. */
  unknownName?: string;
  /** Source-record layout (drives repository creation and related shapes). */
  sourceLayout?: Exclude<SourceLayout, "unknown">;
  /** Where added citations land: on the matching event or on the record. */
  citations?: "event" | "record";
  /** Where cited page images are linked besides the source record. */
  pageMedia?: "event" | "source";
  /** How a citation names its page: by number, with the page's image under
   *  the source, or by the page's own link in `PAGE` (webtrees-style). */
  citationPage?: "number" | "url";
  /** Which event carries baptism-book citations. */
  baptism?: "BIRT" | "BAPM";
  /** How a source states what it covers: the vendor fields (level-1
   *  PLAC/DATE, MacFamilyTree-style) or the spec's `DATA > EVEN` structure
   *  (one entry per register, with its period and jurisdiction). */
  sourceCoverage?: "vendor" | "standard";
  /** Person+event duplicated links: fold into one, or keep both. */
  doubledLinks?: "fold" | "keep";
  /** Preferred Matricula Online URL language ("sl", "de", "en", …). */
  matriculaLang?: string;
  /** Preferred Geneanet cemetery URL language ("en", "de", "fr", …). */
  geneanetLang?: string;
  /** Privacy-marker dialect (MacFamilyTree PRIV / MyHeritage _PRIV / standard RESN). */
  privacy?: "PRIV" | "_PRIV" | "RESN";
  /** How a record's own notes are written: as shared `0 @N…@ NOTE` records the
   *  record points at, or inline on the record itself. */
  notes?: "shared" | "inline";
  /** The same for notes deeper in the record — on events, names, citations. A
   *  file can hold opposite habits at the two levels, so they are chosen apart. */
  eventNotes?: "shared" | "inline";
  /** Set by a strict target format, never stored or offered: every writer
   *  writes only this version's standard forms (see `normalize/target.ts`). */
  standard?: "5.5.1" | "7.0";
  /** Set by the target format, never stored or offered: the version lines are
   *  written in — the strict one, else the file's own. */
  writeVersion?: "5.5.1" | "7.0";
}

/** What "Auto (detected)" resolves to per dimension, as override-value
 *  strings — computed at load (in the worker) and stored with the file. */
export type DetectedFormats = Partial<Record<keyof FormatOverrides, string>>;

/** Curated date patterns offered in Settings; {@link dateProfileFromPattern}
 *  parses anything of these shapes. */
export const DATE_PATTERN_CHOICES = [
  "D MMM YYYY",
  "DD MMM YYYY",
  "D Mmm YYYY",
  "DD.MM.YYYY",
  "D.M.YYYY",
  "YYYY-MM-DD",
  "MM/DD/YYYY",
] as const;

const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthTokensFor(token: string): string[] {
  const abbreviated = token.length === 3;
  const tokens = MONTHS_FULL.map((m) => (abbreviated ? m.slice(0, 3) : m));
  const cased =
    token === token.toUpperCase()
      ? tokens.map((t) => t.toUpperCase())
      : token === token.toLowerCase()
        ? tokens.map((t) => t.toLowerCase())
        : tokens;
  return ["", ...cased]; // 1-indexed like DateFormatProfile.monthTokens
}

/**
 * Build the date profile a chosen pattern describes. Only the *layout* comes
 * from the pattern — qualifier tokens (ABT/OK./…) keep the detected file's
 * own spellings, since the pattern string carries no information about them.
 * Returns undefined for an unrecognized pattern (the caller keeps detection).
 */
export function dateProfileFromPattern(
  pattern: string,
  detected: DateFormatProfile,
  placeholder?: "none" | "_" | "?",
): DateFormatProfile | undefined {
  const ph = placeholder === undefined ? detected.numeric?.placeholder : placeholder === "none" ? undefined : placeholder;
  const monthWord = /^(D{1,2}) ((?:MMM|Mmm|mmm)M?m?m?) (YYYY)$/.exec(pattern.trim());
  if (monthWord) {
    return {
      monthTokens: monthTokensFor(monthWord[2]),
      padDay: monthWord[1] === "DD",
      qualifierTokens: detected.qualifierTokens,
    };
  }
  const dmy = /^(D{1,2})([./-])(M{1,2})\2(YYYY)$/.exec(pattern.trim());
  const mdy = /^(M{1,2})([./-])(D{1,2})\2(YYYY)$/.exec(pattern.trim());
  const ymd = /^(YYYY)([./-])(M{1,2})\2(D{1,2})$/.exec(pattern.trim());
  const m = dmy ?? mdy ?? ymd;
  if (!m) return undefined;
  const dayToken = dmy ? m[1] : mdy ? m[3] : m[4];
  const monthToken = dmy ? m[3] : mdy ? m[1] : m[3];
  return {
    numeric: {
      order: dmy ? "DMY" : mdy ? "MDY" : "YMD",
      separator: m[2],
      padDay: dayToken === "DD",
      padMonth: monthToken === "MM",
      placeholder: ph,
    },
    monthTokens: detected.monthTokens,
    padDay: dayToken === "DD",
    qualifierTokens: detected.qualifierTokens,
  };
}

/** The date part of {@link applyFormatOverrides}: a chosen pattern replaces
 *  the detected layout, a chosen placeholder replaces the detected marker. */
export function applyDateOverrides(date: DateFormatProfile, o: FormatOverrides | undefined): DateFormatProfile {
  if (!o || (!o.date && !o.datePlaceholder)) return date;
  const fromPattern = o.date ? dateProfileFromPattern(o.date, date, o.datePlaceholder) : undefined;
  if (fromPattern) return fromPattern;
  if (o.datePlaceholder && date.numeric) {
    return { ...date, numeric: { ...date.numeric, placeholder: o.datePlaceholder === "none" ? undefined : o.datePlaceholder } };
  }
  return date;
}

/** Default sub-tag / TYPE token per alternate-name variant, for overrides. */
const VARIANT_TAGS: Record<keyof NameProfile, { tag: string; type: string }> = {
  married: { tag: "_MARNM", type: "married" },
  birth: { tag: "_BIRN", type: "birth" },
  aka: { tag: "_AKA", type: "aka" },
  nick: { tag: "NICK", type: "nick" },
};

/**
 * Merge the user's format overrides over a detected main profile. Fields left
 * "Detected" pass through untouched; a set field replaces the corresponding
 * detection wholesale (keeping unrelated detected detail — e.g. an overridden
 * date pattern keeps the file's own qualifier tokens, an overridden place
 * layout keeps the learned place hierarchy and country spellings).
 */
export function applyFormatOverrides(profile: MainProfile, o: FormatOverrides | undefined): MainProfile {
  if (!o) return profile;
  const out: MainProfile = { ...profile, date: applyDateOverrides(profile.date, o) };
  if (o.place) out.place = { ...profile.place, layout: o.place };
  out.placeFmt = applyPlaceOverrides(profile.placeFmt, o);
  if (o.names) {
    const variants = { ...profile.nameVariants };
    for (const kind of Object.keys(VARIANT_TAGS) as (keyof NameProfile)[]) {
      const detectedTarget = profile.nameVariants[kind];
      variants[kind] =
        o.names === "tags"
          ? { form: "tag", tag: detectedTarget.form === "tag" && detectedTarget.tag ? detectedTarget.tag : VARIANT_TAGS[kind].tag }
          : {
              form: "record",
              type: detectedTarget.form === "record" && detectedTarget.type ? detectedTarget.type : VARIANT_TAGS[kind].type,
            };
    }
    out.nameVariants = variants;
  }
  if (o.unknownName !== undefined) {
    out.unknownName = o.unknownName === "blank" ? { form: "blank" } : { form: "token", token: o.unknownName };
  }
  if (o.matriculaLang || o.geneanetLang) {
    out.linkLangs = {
      ...profile.linkLangs,
      ...(o.matriculaLang ? { matricula: o.matriculaLang } : {}),
      ...(o.geneanetLang ? { geneanet: o.geneanetLang } : {}),
    };
  }
  if (o.privacy) out.privacyStyle = o.privacy;
  // A strict target keeps none of a source's 5.5-EL lines.
  if (o.standard) out.sourceTags = { FILN: false, PERI: false };
  return out;
}

/**
 * The reader's place choices over a detected place format. Its own function
 * because the write paths that never build a whole {@link MainProfile} — the
 * Edit view's register lookup, the merge apply — need exactly this much.
 */
export function applyPlaceOverrides(fmt: PlaceTargetFormat, o: FormatOverrides | undefined): PlaceTargetFormat {
  if (!o?.place && !o?.placeSeparator) return fmt;
  return {
    ...fmt,
    ...(o.place ? { layout: o.place } : {}),
    ...(o.placeSeparator
      ? { separator: placeSeparatorText(o.placeSeparator), separatorEnforced: true }
      : {}),
  };
}

/** Read a persisted overrides blob field-by-field, dropping invalid values. */
export function sanitizeFormatOverrides(raw: unknown): FormatOverrides {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: FormatOverrides = {};
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const oneOf = <T extends string>(v: unknown, all: readonly T[]): T | undefined =>
    typeof v === "string" && (all as readonly string[]).includes(v) ? (v as T) : undefined;
  out.date = str(r.date);
  out.datePlaceholder = oneOf(r.datePlaceholder, ["none", "_", "?"] as const);
  out.place = oneOf(r.place, ["structured-addr", "packed-plac", "address-only", "plain-structured"] as const);
  out.placeSeparator = oneOf(r.placeSeparator, ["comma", "comma-space"] as const);
  out.names = oneOf(r.names, ["records", "tags"] as const);
  out.unknownName = str(r.unknownName);
  out.sourceLayout = oneOf(r.sourceLayout, ["paginated", "repository", "literature", "inline"] as const);
  out.citations = oneOf(r.citations, ["event", "record"] as const);
  out.pageMedia = oneOf(r.pageMedia, ["event", "source"] as const);
  out.citationPage = oneOf(r.citationPage, ["number", "url"] as const);
  out.baptism = oneOf(r.baptism, ["BIRT", "BAPM"] as const);
  out.sourceCoverage = oneOf(r.sourceCoverage, ["vendor", "standard"] as const);
  out.doubledLinks = oneOf(r.doubledLinks, ["fold", "keep"] as const);
  out.matriculaLang = str(r.matriculaLang);
  out.geneanetLang = str(r.geneanetLang);
  out.privacy = oneOf(r.privacy, ["PRIV", "_PRIV", "RESN"] as const);
  out.notes = oneOf(r.notes, ["shared", "inline"] as const);
  out.eventNotes = oneOf(r.eventNotes, ["shared", "inline"] as const);
  for (const k of Object.keys(out) as (keyof FormatOverrides)[]) if (out[k] === undefined) delete out[k];
  return out;
}
