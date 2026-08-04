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

/** How long a downloaded blob stays reachable before its URL is released. The
 *  browser reads the blob *after* the click returns — and if the user is asked
 *  where to save the file, only once they answer — so the URL has to outlive the
 *  call by more than a moment. */
const BLOB_LIFETIME_MS = 120_000;

/** How far apart two downloads are fired. Safari — most visibly an installed
 *  PWA on macOS — takes only one download from a burst of anchor clicks: a save
 *  that writes the `.ged` and its report landed the report alone, the `.ged`
 *  having been superseded before it reached Downloads. So a second file waits
 *  its turn instead of racing the first. */
const DOWNLOAD_GAP_MS = 900;

/** Epoch ms at which the next queued download may fire. */
let nextDownloadAt = 0;

function triggerDownload(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  a.style.display = "none";
  // The anchor must be in the document: Firefox ignores a click on a detached
  // one. Releasing the URL is deferred for the same reason the constant above
  // gives — revoking it in this tick cancels the download that just started.
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, BLOB_LIFETIME_MS);
}

/** Trigger a client-side download of a blob (no server round-trip). The first
 *  call fires inside the user gesture that asked for it; any call following
 *  close behind is spaced out by {@link DOWNLOAD_GAP_MS}, so a save that writes
 *  several files delivers all of them. */
export function downloadBlob(fileName: string, blob: Blob): void {
  const now = Date.now();
  const at = Math.max(now, nextDownloadAt);
  nextDownloadAt = at + DOWNLOAD_GAP_MS;
  if (at <= now) triggerDownload(fileName, blob);
  else setTimeout(() => triggerDownload(fileName, blob), at - now);
}

/** Trigger a client-side download of a text file. */
export function downloadText(fileName: string, text: string, mime = "text/plain;charset=utf-8"): void {
  downloadBlob(fileName, new Blob([text], { type: mime }));
}
