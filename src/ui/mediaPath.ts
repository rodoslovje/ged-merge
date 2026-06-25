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
