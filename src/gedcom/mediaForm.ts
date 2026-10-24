/**
 * File extension ⇄ IANA media type for `OBJE FORM` payloads — the one
 * spelling of the mapping, shared by the 5.5.1⇄7.0 migration and the edit
 * layer's media-record creation so both dialects always translate the same
 * way. 5.5.1 speaks in extension tokens (`jpg`, `tif`), 7.0 in media types
 * (`image/jpeg`).
 */

import { childrenByTag, cloneNode, firstChild } from "./node";
import type { GedNode } from "./types";

export const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  djvu: "image/vnd.djvu",
  pdf: "application/pdf",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  htm: "text/html",
  html: "text/html",
  txt: "text/plain",
  text: "text/plain",
};

export const MIME_TO_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_TO_MIME)
    .reverse() // first spelling of each extension wins (jpg over jpeg, tif over tiff)
    .map(([ext, mime]) => [mime, ext]),
);

/** The `FORM` value for a `FILE` — the extension's own token where the name
 *  carries one (`tif`, the 5.5.1 spelling, never `tiff`), `htm` for a web
 *  page (`https://…`, or a bare `www.…`); its IANA media type when `mime`
 *  (7.0). Undefined for an extensionless local file, whose format nothing
 *  states. */
export function fileFormOf(file: string, mime = false): string | undefined {
  const ext = /\.(jpe?g|png|gif|tiff?|bmp|pdf|wav|mp[34]|webp)(?:[?#]|$)/i.exec(file.trim())?.[1].toLowerCase();
  const form = ext ? (ext === "jpeg" ? "jpg" : ext === "tiff" ? "tif" : ext) : /^(?:https?:\/\/|www\.)/i.test(file.trim()) ? "htm" : undefined;
  return form && mime ? (EXT_TO_MIME[form] ?? form) : form;
}

/** A 5.5.1 `FORM` token as 7.0's media type. A format with no registered
 *  type keeps its name in a private subtype (`application/x-xyz`), which a
 *  downgrade reads back; octet-stream would say only "some bytes". */
export function mimeFormOf(form: string): string {
  const ext = form.trim().toLowerCase();
  if (ext.includes("/")) return form;
  return EXT_TO_MIME[ext] ?? (/^[a-z0-9]+$/.test(ext) ? `application/x-${ext}` : "application/octet-stream");
}

function relevel(node: GedNode, level: number): void {
  node.level = level;
  for (const c of node.children) relevel(c, level + 1);
}

/**
 * Hang a media record's record-level `FORM` and `TITL` (the 5.5 shape) under
 * its `FILE`, where 5.5.1 and 7.0 keep them: the `FORM` under every `FILE`
 * without one, the `TITL` under the first. A line whose place is already
 * taken by an equal one is dropped as a copy; one that differs stays for the
 * user to settle. `form` reshapes a moved `FORM` value (7.0's media type).
 * Returns the lines moved or dropped, for the caller's report.
 */
export function hangMediaLinesUnderFile(obje: GedNode, form?: (value: string) => string): GedNode[] {
  const files = childrenByTag(obje, "FILE");
  if (!files.length) return [];
  const same = (a?: string, b?: string) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
  const done: GedNode[] = [];
  const settle = (stray: GedNode, homes: GedNode[]) => {
    let placed = false;
    homes.forEach((file) => {
      if (firstChild(file, stray.tag)) return;
      const line = placed ? cloneNode(stray) : stray;
      relevel(line, file.level + 1);
      if (form && line.tag === "FORM" && line.value) line.value = form(line.value);
      // FORM leads a FILE's lines, TITL follows it.
      if (line.tag === "FORM") file.children.unshift(line);
      else file.children.splice(firstChild(file, "FORM") ? 1 : 0, 0, line);
      placed = true;
    });
    const value = form && stray.tag === "FORM" && stray.value ? form(stray.value) : stray.value;
    if (placed || homes.every((f) => same(firstChild(f, stray.tag)?.value, value))) {
      obje.children = obje.children.filter((c) => c !== stray);
      done.push(stray);
    }
  };
  for (const stray of childrenByTag(obje, "FORM")) settle(stray, files);
  const titl = firstChild(obje, "TITL");
  if (titl) settle(titl, [files[0]]);
  return done;
}

/** Drop a media record's record-level `TITL` lines when its first `FILE` has
 *  a title of its own — the one the app shows, and the one the standard
 *  reads. Returns the lines dropped. */
export function dropTitleBesideFileTitle(obje: GedNode): GedNode[] {
  const file = firstChild(obje, "FILE");
  if (!file || !firstChild(file, "TITL")) return [];
  const dropped = childrenByTag(obje, "TITL");
  if (dropped.length) obje.children = obje.children.filter((c) => !dropped.includes(c));
  return dropped;
}
