/**
 * The cover photo as a shared link's preview wants it: at most 1200 px on its
 * longer side, a JPEG of a few hundred kilobytes. Facebook takes up to 8 MB,
 * but WhatsApp leaves out an image much over 300 KB, and a camera's photo is
 * often several megabytes. Browser-only (a canvas); null where the image
 * cannot be decoded.
 */

/** The longer side of a preview image. */
export const PREVIEW_MAX = 1200;
/** What a preview may weigh before it is encoded again, less finely. */
const PREVIEW_BYTES = 300_000;

export interface PreviewImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export async function previewImage(source: Uint8Array): Promise<PreviewImage | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([source as BlobPart]));
  } catch {
    return null;
  }
  const scale = Math.min(1, PREVIEW_MAX / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // A JPEG has no transparency: a transparent PNG goes on white, not black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  let blob: Blob | null = null;
  for (const quality of [0.82, 0.7, 0.55]) {
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    if (blob.size <= PREVIEW_BYTES) break;
  }
  return blob ? { data: new Uint8Array(await blob.arrayBuffer()), width, height } : null;
}
