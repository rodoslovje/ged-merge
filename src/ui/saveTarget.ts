// Where a save lands. Every browser can hand the file over as a download; one
// with the File System Access API (Chrome, Edge and Opera on a computer) can
// also write it straight to disk — into a folder the reader picks, or over the
// file they opened. Firefox and Safari have no such API, so there the choice is
// never offered and a save stays a download.

import { hasPermApi } from "../persist/fingerprint";
import { downloadText, timedName } from "./download";

export type SaveDestination = "download" | "folder" | "file";
export const SAVE_DESTINATIONS: readonly SaveDestination[] = ["download", "folder", "file"];

/** The destination of one confirmed save, with the access to write there
 *  already granted — asked for inside the click that confirmed the save. */
export type SaveTarget =
  | { kind: "download" }
  | { kind: "folder"; dir: FileSystemDirectoryHandle }
  | { kind: "file"; handle: FileSystemFileHandle };

// showDirectoryPicker is not in the DOM lib's Window typing.
interface DirectoryPickerWindow {
  showDirectoryPicker(opts: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: FileSystemHandle | string;
  }): Promise<FileSystemDirectoryHandle>;
}

/** Whether this browser can write a save to disk at all. */
export const supportsSaveToDisk = typeof window !== "undefined" && "showDirectoryPicker" in window;

/** The folder saves go to, for as long as the page is open. Not kept across
 *  sessions: the browser asks for write access again anyway, and its picker
 *  reopens on the last folder by itself (see the picker's `id`). */
let saveFolder: FileSystemDirectoryHandle | null = null;

export function saveFolderName(): string | null {
  return saveFolder?.name ?? null;
}

/** Ask for write access to a handle. Must run inside a user gesture. */
export async function allowWrite(handle: FileSystemHandle): Promise<boolean> {
  if (!hasPermApi(handle)) return true;
  try {
    let perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm === "prompt") perm = await handle.requestPermission({ mode: "readwrite" });
    return perm === "granted";
  } catch {
    return false;
  }
}

/** The folder to save into: the one already chosen in this session, else (or
 *  with `pick`) the one the reader picks now — the picker opening beside
 *  `startIn`, the file they loaded. Null when they cancel or refuse access.
 *  Must run inside a user gesture. */
export async function acquireSaveFolder(
  startIn?: FileSystemFileHandle | null,
  pick = false,
): Promise<FileSystemDirectoryHandle | null> {
  if (!supportsSaveToDisk) return null;
  if (!pick && saveFolder && (await allowWrite(saveFolder))) return saveFolder;
  try {
    saveFolder = await (window as unknown as DirectoryPickerWindow).showDirectoryPicker({
      id: "gedmerge-save",
      mode: "readwrite",
      ...(startIn ? { startIn } : {}),
    });
    return saveFolder;
  } catch {
    // The reader cancelled, or the picker failed — nothing was chosen.
    return null;
  }
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** The names a save's `files` (the GEDCOM first, then its report) get at
 *  `target`. A folder that already holds one of them — an earlier save of the
 *  same day — gets both under a name with the time added, so no version is
 *  replaced; the file being overwritten keeps its own name. */
export async function targetNames(target: SaveTarget, files: string[], now = new Date()): Promise<string[]> {
  if (target.kind === "file") return [target.handle.name, ...files.slice(1)];
  if (target.kind === "folder") {
    for (const f of files) {
      if (await exists(target.dir, f)) return files.map((n) => timedName(n, now));
    }
  }
  return files;
}

async function writeHandle(handle: FileSystemFileHandle, text: string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(new Blob([text], { type: "text/plain;charset=utf-8" }));
  // The bytes reach the file only here: until the close, the browser writes
  // to a temporary file, so a failed write leaves the old file whole.
  await writable.close();
}

/** Write one file of a save to `target`. Only the GEDCOM (`main`) replaces the
 *  opened file; its report is downloaded. A write that fails falls back to a
 *  download, so the save is never lost — the result is false then. */
export async function writeSave(target: SaveTarget, name: string, text: string, main: boolean): Promise<boolean> {
  try {
    if (target.kind === "folder") {
      await writeHandle(await target.dir.getFileHandle(name, { create: true }), text);
      return true;
    }
    if (target.kind === "file" && main) {
      await writeHandle(target.handle, text);
      return true;
    }
  } catch {
    downloadText(name, text);
    return false;
  }
  downloadText(name, text);
  return true;
}
