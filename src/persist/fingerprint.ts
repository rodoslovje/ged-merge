// Content-fingerprinting + FileSystemHandle permission helpers shared by the
// external-file-change detection in App.tsx.

// queryPermission / requestPermission are Chrome/Edge-only (not yet in the DOM
// lib's FileSystemHandle typing), mirroring the same narrowing MediaFolderContext
// uses for the directory handle.
export interface FsHandlePerms extends FileSystemHandle {
  queryPermission?(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

export function hasPermApi(h: FileSystemHandle): h is FsHandlePerms & Required<FsHandlePerms> {
  return typeof (h as FsHandlePerms).queryPermission === "function";
}

/** SHA-256 of a file's bytes, hex-encoded — used to detect that a file loaded
 *  earlier has since changed on disk. */
export async function hashFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
