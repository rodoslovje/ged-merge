/// <reference lib="webworker" />
// The 3D network chart's force layout, off the main thread: steps the
// simulation (src/chart/forceLayout3d.ts) in slices, reports how far it has
// got after each, and posts the positions once it has settled — so the page
// stays responsive however many people the file holds, and the chart never
// shows the cloud mid-way. One worker per laid-out graph; the chart terminates
// it when the graph changes or the chart closes.

import { createLayout3d, type Layout3d } from "../chart/forceLayout3d";
import type { Layout3dReply, Layout3dRequest } from "./layout3dMessages";

declare const self: DedicatedWorkerGlobalScope;

/** Report progress (and take messages) after this much stepping, in ms. */
const SLICE_MS = 100;

let layout: Layout3d | undefined;
let running = false;

function reply(msg: Layout3dReply, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function run() {
  if (!layout) return;
  const until = performance.now() + SLICE_MS;
  let warm = true;
  // At least one step a slice, even when one step takes longer than a slice.
  do warm = layout.step();
  while (warm && performance.now() < until);
  if (warm) {
    reply({ type: "progress", share: layout.progress() });
    setTimeout(run, 0);
  } else {
    running = false;
    const pos = layout.pos.slice();
    reply({ type: "pos", pos }, [pos.buffer]);
  }
}

function start() {
  if (running) return;
  running = true;
  setTimeout(run, 0);
}

self.onmessage = (e: MessageEvent<Layout3dRequest>) => {
  const m = e.data;
  if (m.type === "init") {
    const edges = Array.from({ length: m.ea.length }, (_, k) => ({ a: m.ea[k], b: m.eb[k], length: m.len[k], weak: m.weak[k] === 1 }));
    layout = createLayout3d(m.n, edges, m.gen, m.hops, m.trees, m.via);
    layout.setLayered(m.layered);
    start();
  } else if (m.type === "layered") {
    layout?.setLayered(m.on);
    start();
  }
};
