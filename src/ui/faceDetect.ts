// Finds the faces on a photo, entirely in the browser, so the viewer can offer
// them as regions to name. The detector (MediaPipe's BlazeFace) and its Wasm
// runtime ship with the app and are loaded only the first time a photo is
// examined; the image never leaves the device.
//
// BlazeFace's short-range model looks at a 128×128 picture, which loses the
// smaller faces of a group photo. So the photo is examined whole and in
// overlapping tiles, and the overlapping finds are merged.
import type { CropRegion } from "../gedcom/source";
// The package's `exports` map hides its Wasm files; a relative path reaches them
// and `?url` lets Vite serve (dev) or emit (build) each as a plain asset.
import wasmLoaderPath from "../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js?url";
import wasmBinaryPath from "../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm?url";
import modelPath from "../assets/models/blaze_face_short_range.tflite?url";

/** Overlap of two regions: intersection over the smaller one's area. A small
 *  face found inside a larger box (or the other way round) counts as the same. */
export function overlap(a: CropRegion, b: CropRegion): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a.width * a.height, b.width * b.height);
}

/** Keep the most confident of each group of overlapping finds. */
export function mergeFinds(finds: { box: CropRegion; score: number }[], threshold = 0.5): CropRegion[] {
  const kept: { box: CropRegion; score: number }[] = [];
  for (const f of [...finds].sort((a, b) => b.score - a.score)) {
    if (!kept.some((k) => overlap(k.box, f.box) > threshold)) kept.push(f);
  }
  return kept.map((k) => k.box).sort((a, b) => a.left - b.left);
}

/** A face box widened to the head — hair, ears and chin — the way a person's
 *  region is usually drawn, clamped to the photo. */
export function headRegion(face: CropRegion, w: number, h: number): CropRegion {
  const left = Math.max(0, face.left - face.width * 0.3);
  const top = Math.max(0, face.top - face.height * 0.45);
  const right = Math.min(w, face.left + face.width * 1.3);
  const bottom = Math.min(h, face.top + face.height * 1.25);
  return { left: Math.round(left), top: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
}

/** The squares the photo is examined in: the whole picture, then 2×2 and 3×3
 *  grids of overlapping tiles (a 3×3 grid only on a large photo). */
export function tiles(w: number, h: number): CropRegion[] {
  const out: CropRegion[] = [{ left: 0, top: 0, width: w, height: h }];
  for (const n of Math.max(w, h) >= 1200 ? [2, 3] : [2]) {
    const tw = Math.round((w / n) * 1.4);
    const th = Math.round((h / n) * 1.4);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const left = Math.round(Math.min(w - tw, Math.max(0, (w / n) * i - (tw - w / n) / 2)));
        const top = Math.round(Math.min(h - th, Math.max(0, (h / n) * j - (th - h / n) / 2)));
        out.push({ left, top, width: tw, height: th });
      }
    }
  }
  return out;
}

type Detector = { detect(image: HTMLCanvasElement): { detections: { boundingBox?: { originX: number; originY: number; width: number; height: number }; categories: { score: number }[] }[] } };
let detector: Promise<Detector> | null = null;

function loadDetector(): Promise<Detector> {
  detector ??= import("@mediapipe/tasks-vision").then(({ FaceDetector }) =>
    FaceDetector.createFromOptions(
      { wasmLoaderPath, wasmBinaryPath },
      { baseOptions: { modelAssetPath: modelPath }, runningMode: "IMAGE", minDetectionConfidence: 0.6 },
    ),
  ).catch((e: unknown) => {
    detector = null; // let a later photo try again
    throw e;
  });
  return detector;
}

/** Longest side a tile is drawn at before detection: plenty for a 128-pixel model. */
const TILE_PX = 640;

/** The head regions of the faces on a loaded image, in its natural pixels.
 *  Resolves to an empty list when detection is unavailable. */
export async function detectHeads(img: HTMLImageElement): Promise<CropRegion[]> {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return [];
  let det: Detector;
  try {
    det = await loadDetector();
  } catch {
    return [];
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  const finds: { box: CropRegion; score: number }[] = [];
  for (const tile of tiles(w, h)) {
    const scale = Math.min(1, TILE_PX / Math.max(tile.width, tile.height));
    canvas.width = Math.round(tile.width * scale);
    canvas.height = Math.round(tile.height * scale);
    ctx.drawImage(img, tile.left, tile.top, tile.width, tile.height, 0, 0, canvas.width, canvas.height);
    for (const d of det.detect(canvas).detections) {
      const b = d.boundingBox;
      if (!b) continue;
      finds.push({
        score: d.categories[0]?.score ?? 0,
        box: { left: tile.left + b.originX / scale, top: tile.top + b.originY / scale, width: b.width / scale, height: b.height / scale },
      });
    }
  }
  return mergeFinds(finds).map((f) => headRegion(f, w, h));
}
