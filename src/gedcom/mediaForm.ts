/**
 * File extension ⇄ IANA media type for `OBJE FORM` payloads — the one
 * spelling of the mapping, shared by the 5.5.1⇄7.0 migration and the edit
 * layer's media-record creation so both dialects always translate the same
 * way. 5.5.1 speaks in extension tokens (`jpg`, `tif`), 7.0 in media types
 * (`image/jpeg`).
 */

export const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
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
