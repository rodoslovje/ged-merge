import { mediaKindOf } from "../mediaPath";

export interface DroppedMediaDeps {
  /** The folder-relative path of a handle inside the media folder, if it is. */
  resolveHandle: (handle: FileSystemHandle) => Promise<string | null | undefined>;
  /** Copy a file from outside into the media folder; its new path, if copied. */
  importFile: (file: File) => Promise<string | null | undefined>;
  /** Whether the person the drop was made on is still in the file. */
  exists: (personId: string) => boolean;
  /** Attach the photo at `rel` to that person. */
  attach: (personId: string, rel: string) => void;
}

/**
 * Attach the dropped image files to the person they were dropped on. The
 * handles resolve over awaits — a permission prompt, a copy into the folder —
 * during which the user may well open someone else, so the person is fixed
 * when the drop lands and every photo goes to that record; if it has been
 * deleted meanwhile, the rest are not attached at all.
 */
export async function attachDroppedMedia(
  personId: string,
  handlePromises: Promise<FileSystemHandle | null>[],
  deps: DroppedMediaDeps,
): Promise<{ added: number; anyFailed: boolean }> {
  let anyFailed = false;
  let added = 0;
  for (const promise of handlePromises) {
    const handle = await promise;
    if (!handle || handle.kind !== "file" || mediaKindOf(handle.name) === null) continue;
    // Inside the folder → reference it; outside → copy it in first (the
    // browser asks once per session to allow writing to the folder).
    let rel = await deps.resolveHandle(handle);
    if (!rel) {
      const file = await (handle as FileSystemFileHandle).getFile().catch(() => null);
      rel = file && (await deps.importFile(file));
    }
    if (!deps.exists(personId)) break;
    if (rel) { deps.attach(personId, rel); added++; }
    else anyFailed = true;
  }
  return { added, anyFailed };
}
