/**
 * Shared file-path helpers for the media layer. GEDCOM `FILE` values and a
 * browser's `webkitRelativePath` both use either separator, so splitting is
 * centralized here rather than re-implemented per call site.
 */

/** Split a file path into its non-empty segments, treating `/` and `\` alike. */
export function pathSegments(filePath: string): string[] {
  return filePath.replace(/\\/g, "/").split("/").filter(Boolean);
}

/** The final path segment (filename), or the original string if it has none. */
export function basename(filePath: string): string {
  const segments = pathSegments(filePath);
  return segments[segments.length - 1] || filePath;
}

/** Whether a stored `FILE` value and a folder-relative path name the same
 *  file: after normalizing separators and case, one's path segments must be a
 *  suffix of the other's (`scan1.jpg` matches `krsti/scan1.jpg`; a stored
 *  `poroke/scan1.jpg` does NOT match the folder's `krsti/scan1.jpg`). Sharing
 *  a basename alone is a display-resolution leniency, never record identity —
 *  reusing a record by basename once attached the wrong photo to a person. */
export function sameMediaFile(stored: string, folderPath: string): boolean {
  const segments = (p: string) => pathSegments(p.toLowerCase()).filter((s) => s !== ".");
  const a = segments(stored);
  const b = segments(folderPath);
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length > 0 && short.every((seg, i) => seg === long[long.length - short.length + i]);
}

/** What the app can display from a media folder: images render in `<img>`
 *  (SVG included), PDFs in the viewer's embedded frame. */
export type MediaKind = "image" | "pdf";

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg"];

/** Classify a file path/name by extension: a displayable image, a PDF, or
 *  null for anything the app can't preview (those are still checked by the
 *  Tools health scan, just not listed/rendered as media). */
export function mediaKindOf(filePath: string): MediaKind | null {
  const name = filePath.toLowerCase();
  if (IMAGE_EXTS.some((ext) => name.endsWith(ext))) return "image";
  if (name.endsWith(".pdf")) return "pdf";
  return null;
}

/** `accept` attribute for file inputs feeding the media folder. */
export const MEDIA_ACCEPT = "image/*,.svg,.pdf";
