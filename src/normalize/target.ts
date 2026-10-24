import type { Dataset } from "../gedcom/types";
import { producerSoftware, vendorTagInfo } from "../gedcom/vendorTags";
import { firstChild } from "../gedcom/node";
import type { DetectedFormats, FormatOverrides } from "./formatOverrides";
import { versionFamily, type VersionFamily } from "./migrate";
import { walkNodes } from "./walk";

/**
 * The main file's target format: what every write follows — the editor, the
 * merge, the Tools passes, Normalize and the save (see AGENTS.md, "GEDCOM
 * standard compliance").
 *
 *  - `file`  — the file's own format, quirks included: a file another program
 *    keeps writing (MacFamilyTree's bare `NOBI`, `PRIV`, numeric dates) is
 *    not reshaped behind that program's back. Where the file shows no habit,
 *    the standard form is written.
 *  - `5.5.1` / `7.0` — strict: only that version's standard forms are written,
 *    dates in the GEDCOM grammar, and the save writes that version.
 */
export type TargetMode = "file" | VersionFamily;

export const TARGET_MODES: readonly TargetMode[] = ["file", "5.5.1", "7.0"];

/** A target resolved against the loaded file. */
export interface WriteTarget {
  mode: TargetMode;
  /** The version lines are written in: the chosen one, or the file's own. */
  version: VersionFamily;
  /** A strict mode — standard forms only. */
  strict: boolean;
}

export function writeTarget(mode: TargetMode, ds: Pick<Dataset, "version">): WriteTarget {
  return mode === "file"
    ? { mode, version: versionFamily(ds.version), strict: false }
    : { mode, version: mode, strict: true };
}

export function isTargetMode(v: unknown): v is TargetMode {
  return typeof v === "string" && (TARGET_MODES as readonly string[]).includes(v);
}

/**
 * The name a file's choice is remembered under: its base name, without the
 * extension and without the `.gedmerge` a save adds — so the choice survives
 * saving the file and opening the saved copy.
 */
export function targetFileKey(fileName: string): string {
  return fileName
    .trim()
    .toLowerCase()
    .replace(/\.(ged|gedcom|txt)$/i, "")
    .replace(/(\.gedmerge)+$/, "");
}

/** At most this many files' choices are remembered; the oldest go first. */
export const MAX_REMEMBERED_TARGETS = 200;

/** `map` with `key` set to `mode`, moved to the end (newest) and capped. */
export function rememberTarget(
  map: Readonly<Record<string, TargetMode>>,
  key: string,
  mode: TargetMode,
): Record<string, TargetMode> {
  const entries = Object.entries(map).filter(([k]) => k !== key);
  entries.push([key, mode]);
  return Object.fromEntries(entries.slice(-MAX_REMEMBERED_TARGETS));
}

export function sanitizeTargetFormats(raw: unknown): Record<string, TargetMode> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, TargetMode> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (k && isTargetMode(v)) out[k] = v;
  return out;
}

/**
 * The evidence that a file follows another program's own dialect — the
 * habits a strict mode would rewrite. Detected once at load.
 */
export interface FileDialect {
  /** The program the header names, when the vendor registry knows it. */
  software?: string;
  /** Vendor tags written without the underscore (MacFamilyTree's `NOBI`…). */
  bareTags: string[];
}

/** The bare vendor tags `ds` uses, and the program that wrote it — undefined
 *  when it uses none. */
export function detectDialect(ds: Pick<Dataset, "records">): FileDialect | undefined {
  const bare = new Set<string>();
  walkNodes(ds.records, (node) => {
    if (!node.tag.startsWith("_") && !bare.has(node.tag) && vendorTagInfo(node.tag)) bare.add(node.tag);
  });
  if (bare.size === 0) return undefined;
  const head = ds.records.find((r) => r.tag === "HEAD");
  const software = producerSoftware(head && firstChild(head, "SOUR")?.value);
  return { ...(software ? { software } : {}), bareTags: [...bare].sort() };
}

/** Date patterns the GEDCOM grammar itself writes. */
const STANDARD_DATE_PATTERNS = new Set(["D MMM YYYY", "DD MMM YYYY"]);

/** Whether a date pattern is the GEDCOM form (month words, uppercase). */
export function isStandardDatePattern(pattern: string | undefined): boolean {
  return !!pattern && STANDARD_DATE_PATTERNS.has(pattern);
}

/** Why a file is proposed to keep its own format, for the one-line notice. */
export interface TargetProposal {
  mode: TargetMode;
  /** The program whose habits are kept, when one is named. */
  software?: string;
}

/**
 * The target a file is first opened in: its own format when it carries
 * another program's habits a strict mode would rewrite (bare vendor tags,
 * numeric dates, the bare `PRIV` marker, vendor source fields), else strict
 * in the version it declares.
 */
export function proposeTarget(
  ds: Pick<Dataset, "version">,
  dialect: FileDialect | undefined,
  detected: DetectedFormats | undefined,
): TargetProposal {
  const habits =
    !!dialect?.bareTags.length ||
    (!!detected?.date && !isStandardDatePattern(detected.date)) ||
    detected?.privacy === "PRIV" ||
    detected?.sourceCoverage === "vendor";
  if (habits) return { mode: "file", ...(dialect?.software ? { software: dialect.software } : {}) };
  return { mode: versionFamily(ds.version) };
}

/**
 * The format choices a strict mode allows: where a choice writes a form the
 * standard does not have, the standard one replaces it — whatever the reader
 * picked or the file does. Dates go in the GEDCOM grammar (uppercase month
 * words; qualifiers are always the standard ones), privacy as `RESN`, married names as a typed `NAME`, a source's
 * coverage inside `DATA`, a doubled link folded into one. The file mode
 * keeps every choice.
 */
export function targetFormatOverrides(o: FormatOverrides, target: Pick<WriteTarget, "strict">): FormatOverrides {
  if (!target.strict) return o;
  return {
    ...o,
    date: isStandardDatePattern(o.date) ? o.date : "D MMM YYYY",
    datePlaceholder: "none",
    privacy: "RESN",
    names: "records",
    sourceCoverage: "standard",
    doubledLinks: "fold",
  };
}

/** The format rows a strict mode decides (see {@link targetFormatOverrides}). */
export const STRICT_FORMAT_KEYS: ReadonlySet<keyof FormatOverrides> = new Set([
  "date", "datePlaceholder", "privacy", "names", "sourceCoverage", "doubledLinks",
]);
