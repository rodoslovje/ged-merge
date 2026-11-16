/**
 * The cover photo as a shared link's preview wants it: 1.91:1 (1200×630, the
 * shape Facebook, LinkedIn and X draw a large card in), a JPEG of a few
 * hundred kilobytes. Facebook takes up to 8 MB, but WhatsApp leaves out an
 * image much over 300 KB, and a camera's photo is often several megabytes.
 * Browser-only (a canvas); null where the image cannot be decoded.
 */

/** A preview's shape and its full size. */
export const PREVIEW_WIDTH = 1200;
export const PREVIEW_HEIGHT = 630;
/** What a preview may weigh before it is encoded again, less finely. */
const PREVIEW_BYTES = 300_000;
/** Where a crop sits across the photo's spare height: a little above the
 *  middle, where the faces of a portrait or a group usually are. */
const CROP_FROM_TOP = 0.4;

export interface PreviewImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/** The part of a `w`×`h` image a 1.91:1 preview shows, and its size: the
 *  whole width of a wide-enough photo (or the whole height of a wider one),
 *  never enlarged past the photo itself. */
export function previewCrop(w: number, h: number): { sx: number; sy: number; sw: number; sh: number; width: number; height: number } {
  const ratio = PREVIEW_WIDTH / PREVIEW_HEIGHT;
  let sw = w;
  let sh = Math.round(w / ratio);
  if (sh > h) {
    sh = h;
    sw = Math.round(h * ratio);
  }
  const sx = Math.round((w - sw) / 2);
  const sy = Math.round((h - sh) * CROP_FROM_TOP);
  const width = Math.min(PREVIEW_WIDTH, sw);
  return { sx, sy, sw, sh, width, height: Math.round(width / ratio) };
}

export async function previewImage(source: Uint8Array): Promise<PreviewImage | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([source as BlobPart]));
  } catch {
    return null;
  }
  const { sx, sy, sw, sh, width, height } = previewCrop(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // A JPEG has no transparency: a transparent PNG goes on white, not black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
  bitmap.close();
  let blob: Blob | null = null;
  for (const quality of [0.82, 0.7, 0.55]) {
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    if (blob.size <= PREVIEW_BYTES) break;
  }
  return blob ? { data: new Uint8Array(await blob.arrayBuffer()), width, height } : null;
}
