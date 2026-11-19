/// <reference lib="webworker" />
// The 3D network chart's force layout, off the main thread: steps the
// simulation (src/chart/forceLayout3d.ts) as fast as it goes and posts a copy
// of the positions about every frame, so the page stays responsive however
// many people the file holds. One worker per laid-out graph; the chart
// terminates it when the graph changes or the chart closes.

import { createLayout3d, type Layout3d } from "../chart/forceLayout3d";
import type { Layout3dPositions, Layout3dRequest } from "./layout3dMessages";

declare const self: DedicatedWorkerGlobalScope;

/** Post the positions after this much stepping, in ms. */
const SLICE_MS = 30;

let layout: Layout3d | undefined;
let running = false;

function post(done: boolean) {
  if (!layout) return;
  const pos = layout.pos.slice();
  const msg: Layout3dPositions = { type: "pos", pos, done };
  self.postMessage(msg, [pos.buffer]);
}

function run() {
  if (!layout) return;
  const until = performance.now() + SLICE_MS;
  let warm = true;
  // At least one step a slice, even when one step takes longer than a slice.
  do warm = layout.step();
  while (warm && performance.now() < until);
  post(!warm);
  if (warm) setTimeout(run, 0);
  else running = false;
}

function start() {
  if (running) return;
  running = true;
  setTimeout(run, 0);
}

self.onmessage = (e: MessageEvent<Layout3dRequest>) => {
  const m = e.data;
  if (m.type === "init") {
    const edges = Array.from({ length: m.ea.length }, (_, k) => ({ a: m.ea[k], b: m.eb[k], length: m.len[k] }));
    layout = createLayout3d(m.n, edges, m.gen, m.hops, m.trees);
    layout.setLayered(m.layered);
    // The start positions at once, so the chart has something to draw.
    post(false);
    start();
  } else if (m.type === "layered") {
    layout?.setLayered(m.on);
    start();
  }
};
