import { rememberTarget, targetFileKey } from "../normalize/target";
import type { PublishOptions } from "./model";

/**
 * The family website's choices, remembered per main file while the reader
 * keeps their workspace in the browser (Settings → "local browser data") —
 * the title, the texts, who and what is published. With that setting off
 * nothing is kept, and what was kept is forgotten.
 */

const KEY = "gedmerge.publish";

export interface StoredPublish {
  options: PublishOptions;
  /** The site's own start person, when one was picked in the tool. */
  start?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** `stored` laid over `defaults`, field by field: a field of the wrong type
 *  (a file from an older version, a hand edit) keeps its default. */
export function mergeStoredOptions(defaults: PublishOptions, stored: unknown): PublishOptions {
  if (!isRecord(stored)) return defaults;
  const out = { ...defaults } as Record<string, unknown>;
  for (const [k, def] of Object.entries(defaults)) {
    const v = stored[k];
    if (isRecord(def)) {
      if (!isRecord(v)) continue;
      const merged: Record<string, unknown> = { ...def };
      // `intro` (one text per language) and `photoFolders` (one choice per
      // folder) are open-ended, of strings; the others are fixed shapes.
      const open = k === "intro" || k === "photoFolders";
      const keys = open ? Object.keys(v) : Object.keys(def);
      for (const kk of keys) if (typeof v[kk] === (open ? "string" : typeof def[kk])) merged[kk] = v[kk];
      out[k] = merged;
    } else if (typeof v === typeof def) {
      out[k] = v;
    }
  }
  return out as unknown as PublishOptions;
}

function readAll(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The choices kept for a file, over `defaults`; undefined when none are. */
export function readStoredPublish(fileName: string, defaults: PublishOptions): StoredPublish | undefined {
  const entry = readAll()[targetFileKey(fileName)];
  if (!isRecord(entry)) return undefined;
  const options = mergeStoredOptions(defaults, entry.options);
  return typeof entry.start === "string" ? { options, start: entry.start } : { options };
}

export function writeStoredPublish(fileName: string, value: StoredPublish): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rememberTarget<unknown>(readAll(), targetFileKey(fileName), value)));
  } catch {
    // Storage full or blocked: the choices last for this visit.
  }
}

/** Forget every file's choices — the workspace is no longer kept. */
export function clearStoredPublish(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to forget where nothing could be kept.
  }
}
