/** Local date as `YYYY-MM-DD`, used to stamp saved filenames so successive
 *  versions sort chronologically and never overwrite one another in Downloads. */
export function dateStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Strip a `.ged` extension and any stamp GED Merge previously appended, so a
 *  file that is saved, re-loaded and saved again keeps a clean base instead of
 *  stacking `…gedmerge.2026-01-01.gedmerge.ged`. */
export function baseStem(fileName: string): string {
  return fileName
    .replace(/\.ged$/i, "")
    .replace(/\.\d{4}-\d{2}-\d{2}\.gedmerge$/i, "") // a prior dated save
    .replace(/\.gedmerge$/i, ""); // a prior undated save
}

/** A saved-file name in GED Merge's shared `{base}.{date}.gedmerge.{ext}`
 *  convention. The base is normalized first (see {@link baseStem}). Pass a
 *  shared `Date` when naming sibling files (e.g. the `.ged` and its report) so
 *  they carry the same stamp and sort together. */
export function savedName(base: string, ext: string, d = new Date()): string {
  return `${baseStem(base)}.${dateStamp(d)}.gedmerge.${ext}`;
}

/** Trigger a client-side download of a text file (no server round-trip). */
export function downloadText(fileName: string, text: string, mime = "text/plain;charset=utf-8"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
