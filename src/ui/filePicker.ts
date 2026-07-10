// Shared File-System-Access-API helpers for GedcomLoader.tsx and Landing.tsx,
// which both need "pick/drop a file, and capture a live handle to it when the
// browser supports one" — the handle is what later lets App.tsx re-check the
// file against disk. Chrome/Edge only; Firefox/Safari callers fall back to
// their existing hidden <input type=file>.

export interface PickedFile {
  file: File;
  handle?: FileSystemFileHandle;
}

/** Whether the native File System Access picker is available at all — callers
 *  use this (not a `pickFile` null result, which also means "cancelled") to
 *  decide whether to fall back to a hidden `<input type=file>`. */
export const supportsFilePicker = "showOpenFilePicker" in window;

export interface AcceptSpec {
  description: string;
  /** MIME → extensions, as required by showOpenFilePicker's `accept`. */
  mime: Record<string, string[]>;
}

// showOpenFilePicker isn't declared as a window method in the DOM lib (only
// the handle interfaces are) — narrow cast mirrors MediaFolderContext's
// showDirectoryPicker cast.
interface FilePickerWindow {
  showOpenFilePicker(opts: {
    types: { description: string; accept: Record<string, string[]> }[];
    multiple?: boolean;
  }): Promise<FileSystemFileHandle[]>;
}

// DataTransferItem.getAsFileSystemHandle isn't in the DOM lib typings either.
interface DataTransferItemFsh extends DataTransferItem {
  getAsFileSystemHandle?(): Promise<FileSystemHandle>;
}

/** Opens the native file picker when supported. Returns null if the browser
 *  lacks File System Access (caller should fall back to its hidden <input>),
 *  or if the user cancels the dialog. */
export async function pickFile(accept: AcceptSpec): Promise<PickedFile | null> {
  if (!("showOpenFilePicker" in window)) return null;
  try {
    const [handle] = await (window as unknown as FilePickerWindow).showOpenFilePicker({
      types: [{ description: accept.description, accept: accept.mime }],
      multiple: false,
    });
    const file = await handle.getFile();
    return { file, handle };
  } catch {
    // AbortError (user cancelled) or a picker failure — nothing to load.
    return null;
  }
}

/** Extracts the dropped file plus, best-effort, a live handle to it. */
export async function fileFromDrop(dataTransfer: DataTransfer): Promise<PickedFile | null> {
  const file = dataTransfer.files?.[0];
  if (!file) return null;
  const item = dataTransfer.items?.[0] as DataTransferItemFsh | undefined;
  if (!item?.getAsFileSystemHandle) return { file };
  try {
    const h = await item.getAsFileSystemHandle();
    return h && h.kind === "file" ? { file, handle: h as FileSystemFileHandle } : { file };
  } catch {
    return { file };
  }
}
