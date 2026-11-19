import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { buildFamilyGraph, SPOUSE_LINE, type GraphScope } from "../chart/familyGraph";
import { linkLength } from "../chart/forceLayout3d";
import type { Layout3dReply, Layout3dRequest } from "../worker/layout3dMessages";
import { lineColor, paletteColor, type BranchInfo } from "../chart/nodeColor";
import { livingLabelFor } from "../chart/nodeDisplay";
import { isPresumedLiving, lifespanOf } from "../gedcom/lifespan";

import { ChartPage } from "./ChartPage";
import { ChartRootTitle } from "./ChartRootTitle";
import { ChartSettings } from "./ChartSettings";
import { ChartLegend } from "./ChartLegend";
import { ZoomControls } from "./ZoomControls";
import { useChartSettings } from "./ChartSettingsContext";
import { useNodeColorer } from "./useNodeColorer";
import { useNameOf } from "./SettingsContext";
import { Segmented } from "./Segmented";
import { useDocTheme } from "./map/useDocTheme";
import { sexClass, sexColorVar } from "./sex";
import { useChartShortcuts } from "../keyboard/useChartShortcuts";

// The 3D network chart: everyone in the root's tree (or the whole file) as a
// dot, every parent–child and couple link as a line, laid out by a force
// simulation (src/chart/forceLayout3d.ts) and drawn on a 2D canvas with a
// perspective projection. Drag turns it, the wheel or a pinch zooms, a
// right/shift drag pans. The dots take the charts' shared Color axis, so a
// cluster's family line, country or surname reads at a glance; the colour key
// hides groups. Layered mode holds each generation to its own height.

/** Past this many people the canvas draws square dots, unsorted by depth. */
const BIG = 20000;
const HIT_PX = 9;
const DOT = 2.6;
/** The colour key's "other" entry (nodeColor folds the long tail into it). */
const OTHER_KEY = "\u0000other";

interface Props {
  mainDs: Dataset;
  rootId: string;
  startId?: string;
  backLabel: string;
  onBack: () => void;
  onNavigate: (id: string) => void;
  onRootChange: (id: string) => void;
  kindSwitcher: ReactNode;
}

interface Camera {
  yaw: number;
  pitch: number;
  zoom: number;
  panX: number;
  panY: number;
}

export function NetworkChart({ mainDs, rootId, backLabel, onBack, onNavigate, onRootChange, kindSwitcher }: Props) {
  const { t } = useTranslation();
  const { settings } = useChartSettings();
  const nameOf = useNameOf();
  const theme = useDocTheme();
  const [scope, setScope] = useState<GraphScope>("connected");
  const [layered, setLayered] = useState(true);
  const [spin, setSpin] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);

  useChartShortcuts({ onLeave: onBack });

  const graph = useMemo(() => buildFamilyGraph(mainDs, rootId, scope, Infinity), [mainDs, rootId, scope]);
  useEffect(() => setSelected(null), [graph]);

  // ─── Colour ───────────────────────────────────────────────────────────────
  const branches = useMemo(() => {
    const map = new Map<string, BranchInfo>();
    for (const l of graph.lines) {
      const indi = mainDs.individuals.get(l.ancestorId);
      map.set(l.key, { label: indi ? nameOf(indi) : t("kin.wedge.unknown"), color: lineColor(l.index, "ancestors") });
    }
    map.set(SPOUSE_LINE, { label: t("network.line.spouse"), color: paletteColor(6) });
    return map;
  }, [graph, mainDs, nameOf, t]);
  const subjects = useMemo(() => graph.nodes.map((n) => ({ indi: n.indi, pos: n.pos })), [graph]);
  const colorer = useNodeColorer(mainDs, subjects, branches);
  const categories = useMemo(() => graph.nodes.map((n) => colorer.categoryOf(n.indi, n.pos)), [graph, colorer]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => setHidden(new Set()), [colorer.axis]);
  const legendKeys = useMemo(() => new Set(colorer.legend.map((e) => e.key)), [colorer]);
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // The colours are CSS (theme variables, oklch); the canvas needs them
  // resolved. A probe element in the document computes each one once per theme
  // (made here, not rendered: a rendered ref is not attached yet on the first
  // pass, and every colour would come out unresolved).
  const colors = useMemo(() => {
    const probe = document.createElement("span");
    probe.hidden = true;
    document.body.appendChild(probe);
    const cache = new Map<string, string>();
    const resolve = (css: string) => {
      let c = cache.get(css);
      if (c === undefined) {
        probe.style.color = "";
        probe.style.color = css;
        c = getComputedStyle(probe).color;
        cache.set(css, c);
      }
      return c;
    };
    const fill = graph.nodes.map((n, i) => {
      const css = colorer.colorOf(categories[i]) ?? (colorer.axis === "plain" ? sexColorVar(n.indi.sex) : undefined) ?? "var(--muted)";
      return resolve(css);
    });
    // theme is a dependency: the variables change with it.
    void theme;
    const out = { fill, family: resolve("var(--map-marriage)"), accent: resolve("var(--accent)"), text: resolve("var(--text)"), panel: resolve("var(--panel)") };
    probe.remove();
    return out;
  }, [graph, colorer, categories, theme]);

  // Who is drawn: people per the colour key; a family hub while any of its
  // partners is. Indexed like the layout — the people, then the hubs.
  const shownMask = useMemo(() => {
    const n = graph.nodes.length;
    const mask = new Uint8Array(n + graph.families.length);
    graph.nodes.forEach((_, i) => {
      const c = categories[i];
      const key = c && !legendKeys.has(c) && legendKeys.has(OTHER_KEY) ? OTHER_KEY : c;
      mask[i] = hidden.has(key) ? 0 : 1;
    });
    graph.families.forEach((f, k) => { mask[n + k] = f.partners.some((p) => mask[p]) ? 1 : 0; });
    return mask;
  }, [graph, categories, hidden, legendKeys]);

  // ─── Layout ───────────────────────────────────────────────────────────────
  // The simulation runs in a worker (layout3d.worker.ts), which reports its
  // progress and posts the positions once they have settled; the frame loop
  // draws those. Until the first come there is nothing to draw, only the
  // progress; a switch of layout keeps the old picture up until the new one.
  const positions = useRef<{ pos: Float32Array | null; fresh: boolean }>({ pos: null, fresh: false });
  const [progress, setProgress] = useState<number | null>(0);
  const workerRef = useRef<Worker | null>(null);
  const layeredRef = useRef(layered);
  layeredRef.current = layered;
  useEffect(() => {
    // The layout's nodes: the people, then a hub per family, which stands at its
    // partners' generation, in their tree, and starts beside its first partner.
    const people = graph.nodes.length;
    const n = people + graph.families.length;
    const gen = new Float64Array(n);
    const hops = new Int32Array(n);
    const trees = new Int32Array(n);
    const via = new Int32Array(n);
    graph.nodes.forEach((node, i) => {
      gen[i] = node.pos ? node.pos.gen : NaN;
      hops[i] = node.hops;
      trees[i] = node.tree;
      via[i] = node.via;
    });
    graph.families.forEach((f, k) => {
      const i = people + k;
      const p = f.partners[0];
      gen[i] = gen[p];
      hops[i] = hops[p];
      trees[i] = trees[p];
      via[i] = p;
    });
    // A child starts beside their family's hub, so a couple's children start
    // together — when the walk reached the parent first. (Reached the other way,
    // the parent starts beside the child, and the hub beside the parent: the
    // child beside the hub would close a loop.)
    graph.edges.forEach((e) => {
      if (e.kind === "child" && graph.families[e.a - people].partners[0] < e.b) via[e.b] = e.a;
    });
    const m = graph.edges.length;
    const ea = new Int32Array(m), eb = new Int32Array(m), len = new Float32Array(m);
    graph.edges.forEach((e, k) => { ea[k] = e.a; eb[k] = e.b; len[k] = linkLength(e.kind); });
    positions.current = { pos: null, fresh: false };
    setProgress(0);
    // The last graph's picture goes; the new one shows once it has settled.
    const canvas = canvasRef.current;
    if (canvas) canvas.width = canvas.width;
    const worker = new Worker(new URL("../worker/layout3d.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<Layout3dReply>) => {
      const r = e.data;
      if (r.type === "progress") setProgress(r.share);
      else {
        positions.current = { pos: r.pos, fresh: true };
        setProgress(null);
      }
    };
    const init: Layout3dRequest = { type: "init", n, ea, eb, len, gen, hops, trees, via, layered: layeredRef.current };
    worker.postMessage(init, [ea.buffer, eb.buffer, len.buffer, gen.buffer, hops.buffer, trees.buffer, via.buffer]);
    return () => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [graph]);
  useEffect(() => {
    const msg: Layout3dRequest = { type: "layered", on: layered };
    workerRef.current?.postMessage(msg);
    // The current picture stays up under the progress until the new one.
    setProgress((p) => p ?? 0);
  }, [layered]);

  // ─── Drawing ──────────────────────────────────────────────────────────────
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cam = useRef<Camera>({ yaw: 0.6, pitch: 0.25, zoom: 1, panX: 0, panY: 0 });
  const proj = useRef<{ sx: Float32Array; sy: Float32Array; sr: Float32Array }>({ sx: new Float32Array(0), sy: new Float32Array(0), sr: new Float32Array(0) });
  const dirty = useRef(true);
  const fit = useRef({ cx: 0, cy: 0, cz: 0, r: 1 });
  const redraw = useCallback(() => { dirty.current = true; }, []);
  // The camera's zoom lives in the ref (the frame loop reads it); the zoom
  // controls show a copy.
  const [zoomShown, setZoomShown] = useState(1);
  const zoomTo = useCallback((z: number) => {
    cam.current.zoom = Math.min(Math.max(z, 0.2), 40);
    setZoomShown(cam.current.zoom);
    redraw();
  }, [redraw]);

  // Everything the frame loop reads, kept in a ref so the loop runs once.
  // The links grouped by colour (one canvas path each) and the dots likewise,
  // built once per colouring rather than on every frame.
  const batches = useMemo(() => {
    const links = new Map<string, number[]>();
    graph.edges.forEach((e, k) => {
      if (!shownMask[e.a] || !shownMask[e.b]) return;
      const col = e.kind === "partner" ? colors.family : colors.fill[e.b];
      let list = links.get(col);
      if (!list) links.set(col, (list = []));
      list.push(k);
    });
    const dots = new Map<string, number[]>();
    graph.nodes.forEach((_, i) => {
      if (!shownMask[i]) return;
      let list = dots.get(colors.fill[i]);
      if (!list) dots.set(colors.fill[i], (list = []));
      list.push(i);
    });
    return { links, dots };
  }, [graph, colors, shownMask]);
  const rootIdx = useMemo(() => graph.nodes.findIndex((nd) => nd.id === rootId), [graph, rootId]);

  const live = useRef({ graph, colors, shownMask, batches, selected, hover: hover?.i ?? null, spin, rootIdx });
  live.current = { graph, colors, shownMask, batches, selected, hover: hover?.i ?? null, spin, rootIdx };
  useEffect(redraw, [graph, colors, shownMask, batches, selected, hover, spin, redraw]);

  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const L = live.current;
      const canvas = canvasRef.current;
      if (!canvas) return;
      // The layout's nodes: the people (0 … people−1), then the family hubs.
      const people = L.graph.nodes.length;
      const n = people + L.graph.families.length;
      const P = positions.current;
      const p = P.pos;
      if (!p || p.length !== n * 3) return;
      // Settled positions from the worker change the picture; so does the spin.
      const refit = P.fresh;
      P.fresh = false;
      if (L.spin) cam.current.yaw += 0.004;
      if (!refit && !L.spin && !dirty.current) return;
      dirty.current = false;

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Frame the settled cloud as it arrives.
      if (refit) {
        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < n; i++) { cx += p[i * 3]; cy += p[i * 3 + 1]; cz += p[i * 3 + 2]; }
        cx /= n || 1; cy /= n || 1; cz /= n || 1;
        let r2 = 0;
        for (let i = 0; i < n; i++) {
          const dx = p[i * 3] - cx, dy = p[i * 3 + 1] - cy, dz = p[i * 3 + 2] - cz;
          r2 += dx * dx + dy * dy + dz * dz;
        }
        // Twice the RMS radius: a few stragglers do not shrink everyone else.
        fit.current = { cx, cy, cz, r: Math.max(2 * Math.sqrt(r2 / (n || 1)), 40) };
      }
      const { cx, cy, cz, r } = fit.current;
      const c = cam.current;
      const cyw = Math.cos(c.yaw), syw = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
      const scale = (Math.min(w, h) / (1.7 * r)) * c.zoom;
      const D = r * 3;
      const ox = w / 2 + c.panX, oy = h / 2 + c.panY;
      if (proj.current.sx.length !== n) proj.current = { sx: new Float32Array(n), sy: new Float32Array(n), sr: new Float32Array(n) };
      const { sx, sy, sr } = proj.current;
      const depth = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = p[i * 3] - cx, y = p[i * 3 + 1] - cy, z = p[i * 3 + 2] - cz;
        const x1 = x * cyw + z * syw;
        const z1 = -x * syw + z * cyw;
        const y2 = y * cp - z1 * sp;
        const z2 = y * sp + z1 * cp;
        const f = D / Math.max(D - z2, D * 0.1);
        sx[i] = ox + x1 * scale * f;
        sy[i] = oy - y2 * scale * f;
        sr[i] = f;
        depth[i] = z2;
      }

      // Links first, in one path per colour; a selection fades the rest.
      // A selected person lights up their families: the hubs they hang on, and
      // everyone else on those hubs — partner, parents, children, siblings.
      const sel = L.selected;
      const focus = new Uint8Array(n);
      if (sel !== null) {
        focus[sel] = 1;
        for (const e of L.graph.edges) if (e.a === sel || e.b === sel) { focus[e.a] = 1; focus[e.b] = 1; }
        for (const e of L.graph.edges) {
          const hub = e.a >= people ? e.a : e.b;
          if (focus[hub] && hub !== sel) { focus[e.a] = 1; focus[e.b] = 1; }
        }
      }
      const big = people > BIG;
      ctx.lineWidth = big ? 0.4 : n > 4000 ? 0.6 : 1;
      for (const [col, list] of L.batches.links) {
        ctx.strokeStyle = col;
        ctx.globalAlpha = (sel === null ? 0.4 : 0.12) * (big ? 0.5 : 1);
        ctx.beginPath();
        for (const k of list) {
          const e = L.graph.edges[k];
          ctx.moveTo(sx[e.a], sy[e.a]);
          ctx.lineTo(sx[e.b], sy[e.b]);
        }
        ctx.stroke();
      }
      if (sel !== null) {
        ctx.globalAlpha = 0.95;
        ctx.lineWidth = 2;
        for (const e of L.graph.edges) {
          if (!focus[e.a] || !focus[e.b]) continue;
          ctx.strokeStyle = e.kind === "partner" ? L.colors.family : L.colors.fill[e.b];
          ctx.beginPath();
          ctx.moveTo(sx[e.a], sy[e.a]);
          ctx.lineTo(sx[e.b], sy[e.b]);
          ctx.stroke();
        }
      }

      const base = DOT * Math.min(Math.max(Math.sqrt(c.zoom), 0.7), 2.5) * (people > 4000 ? 0.8 : 1);
      // The family hubs: small rings where the partners meet and the children
      // hang from (left out on a big file, where they would be specks).
      if (!big) {
        ctx.strokeStyle = L.colors.family;
        ctx.lineWidth = 1.2;
        ctx.globalAlpha = sel === null ? 0.8 : 0.2;
        ctx.beginPath();
        for (let i = people; i < n; i++) {
          if (!L.shownMask[i]) continue;
          const rad = base * sr[i] * 0.8;
          ctx.moveTo(sx[i] + rad, sy[i]);
          ctx.arc(sx[i], sy[i], rad, 0, Math.PI * 2);
        }
        ctx.stroke();
      }
      if (big) {
        // A big file: square dots in one path per colour, unsorted — sorting
        // and a circle each would cost more than a frame.
        ctx.globalAlpha = sel === null ? 0.75 : 0.15;
        for (const [col, list] of L.batches.dots) {
          ctx.fillStyle = col;
          ctx.beginPath();
          for (const i of list) {
            const s = Math.max(base * sr[i] * 0.8, 1);
            ctx.rect(sx[i] - s / 2, sy[i] - s / 2, s, s);
          }
          ctx.fill();
        }
        if (sel !== null) {
          ctx.globalAlpha = 1;
          for (let i = 0; i < people; i++) {
            if (!focus[i] || !L.shownMask[i]) continue;
            ctx.fillStyle = L.colors.fill[i];
            ctx.beginPath();
            ctx.arc(sx[i], sy[i], base * sr[i], 0, Math.PI * 2);
            ctx.fill();
          }
        }
      } else {
        // Dots back to front, the far ones fainter.
        const order = Array.from({ length: people }, (_, i) => i).filter((i) => L.shownMask[i]);
        order.sort((a, b) => depth[a] - depth[b]);
        for (const i of order) {
          const near = Math.min(Math.max((depth[i] / r + 1) / 2, 0), 1);
          ctx.globalAlpha = (sel === null || focus[i] ? 0.5 + 0.5 * near : 0.15);
          ctx.fillStyle = L.colors.fill[i];
          ctx.beginPath();
          ctx.arc(sx[i], sy[i], base * sr[i], 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // The root and the selected person get a ring and their name.
      ctx.globalAlpha = 1;
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.textAlign = "center";
      const ring = (i: number, color: string) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx[i], sy[i], base * sr[i] + 4, 0, Math.PI * 2);
        ctx.stroke();
      };
      const label = (i: number) => {
        const text = labelOf(i);
        const y = sy[i] - base * sr[i] - 8;
        ctx.lineWidth = 3;
        ctx.strokeStyle = L.colors.panel;
        ctx.strokeText(text, sx[i], y);
        ctx.fillStyle = L.colors.text;
        ctx.fillText(text, sx[i], y);
      };
      const rootIdx = L.rootIdx;
      if (rootIdx >= 0) { ring(rootIdx, L.colors.accent); label(rootIdx); }
      if (sel !== null && sel !== rootIdx) { ring(sel, L.colors.text); label(sel); }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const redacted = useCallback(
    (i: number) => settings.privacyLiving && isPresumedLiving(graph.nodes[i].indi, mainDs),
    [settings.privacyLiving, graph, mainDs],
  );
  const nameAt = useCallback(
    (i: number) => (redacted(i) ? livingLabelFor(t, graph.nodes[i].indi.sex) : nameOf(graph.nodes[i].indi)),
    [redacted, t, graph, nameOf],
  );
  const labelRef = useRef(nameAt);
  labelRef.current = nameAt;
  const labelOf = (i: number) => labelRef.current(i);

  // ─── Pointer ──────────────────────────────────────────────────────────────
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ moved: number; pan: boolean } | null>(null);
  const pinch = useRef<number | null>(null);

  const hitTest = (x: number, y: number): number | null => {
    const { sx, sy } = proj.current;
    let best = -1, bestD = HIT_PX * HIT_PX;
    for (let i = 0; i < Math.min(sx.length, graph.nodes.length); i++) {
      if (!shownMask[i]) continue;
      const dx = sx[i] - x, dy = sy[i] - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best >= 0 ? best : null;
  };
  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    drag.current = { moved: 0, pan: e.button === 2 || e.shiftKey };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) {
      const { x, y } = local(e);
      const i = hitTest(x, y);
      setHover((h) => (i === null ? null : h?.i === i ? h : { i, x, y }));
      return;
    }
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const c = cam.current;
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomTo(c.zoom * (d / pinch.current));
      pinch.current = d;
    } else if (drag.current) {
      drag.current.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.current.pan) { c.panX += dx; c.panY += dy; }
      else {
        c.yaw += dx * 0.008;
        c.pitch = Math.min(Math.max(c.pitch + dy * 0.008, -1.5), 1.5);
      }
    }
    setHover(null);
    redraw();
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drag.current;
    drag.current = null;
    if (d && d.moved < 5 && e.button === 0) {
      const { x, y } = local(e);
      setSelected(hitTest(x, y));
    }
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = local(e);
    const i = hitTest(x, y);
    if (i !== null && graph.nodes[i].id !== rootId) onRootChange(graph.nodes[i].id);
  };
  // Wheel zoom toward the pointer would need the inverse projection; the
  // centre is enough for a prototype. Bound natively: React's wheel is passive.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomTo(cam.current.zoom * Math.exp(-e.deltaY * 0.0015));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [zoomTo]);
  // Fit: back to the starting angle, the whole cloud in view.
  const fitView = () => {
    cam.current = { yaw: 0.6, pitch: 0.25, zoom: 1, panX: 0, panY: 0 };
    setZoomShown(1);
    redraw();
  };
  useEffect(() => {
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(redraw);
    if (wrapRef.current) ro?.observe(wrapRef.current);
    return () => ro?.disconnect();
  }, [redraw]);

  const root = mainDs.individuals.get(rootId);
  const pageKind = t("network.title");
  const sel = selected !== null ? graph.nodes[selected] : undefined;
  const yearsOf = (i: number) => (redacted(i) ? "" : lifespanOf(graph.nodes[i].indi));
  const categoryLabel = (i: number) => {
    const c = categories[i];
    return colorer.legend.find((e) => e.key === c)?.label;
  };

  return (
    <ChartPage
      backLabel={backLabel}
      onBack={onBack}
      title={root ? <ChartRootTitle name={nameOf(root)} sexCls={sexClass(root.sex)} years={lifespanOf(root)} kind={pageKind} /> : pageKind}
      actions={<ChartSettings lockedType="network" />}
      controlsLeft={
        <>
          {kindSwitcher}
          <Segmented
            label={t("network.scope")}
            value={scope}
            onChange={setScope}
            items={(["blood", "connected", "file"] as const).map((k) => ({ key: k, label: t(`network.scope.${k}`) }))}
          />
          <Segmented
            label={t("network.layout")}
            value={layered ? "layered" : "free"}
            onChange={(v) => setLayered(v === "layered")}
            items={(["layered", "free"] as const).map((k) => ({ key: k, label: t(`network.layout.${k}`) }))}
          />
          <label className="kin-year">
            <input type="checkbox" checked={spin} onChange={(e) => setSpin(e.target.checked)} />
            {t("network.spin")}
          </label>
        </>
      }
    >
      <div className="tree-canvas-wrap network-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="network-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setHover(null)}
          onDoubleClick={onDoubleClick}
          onContextMenu={(e) => e.preventDefault()}
        />
        <div className="network-count">
          {t("network.count", { shown: graph.nodes.length.toLocaleString(), links: graph.edges.length.toLocaleString() })}
          {scope === "file" && graph.trees > 1 && ` · ${t("network.trees", { count: graph.trees })}`}
        </div>
        {hover && hover.i !== selected && (
          <div className="network-hover" style={{ left: hover.x + 14, top: hover.y + 10 }}>
            <span className={`person-name ${sexClass(graph.nodes[hover.i].indi.sex)}`}>{nameAt(hover.i)}</span>
            {yearsOf(hover.i) && <span className="network-years"> {yearsOf(hover.i)}</span>}
            {categoryLabel(hover.i) && <div className="network-cat">{categoryLabel(hover.i)}</div>}
          </div>
        )}
        {sel && selected !== null && (
          <div className="network-panel">
            <div>
              <span className={`person-name ${sexClass(sel.indi.sex)}`}>{nameAt(selected)}</span>
              {yearsOf(selected) && <span className="network-years"> {yearsOf(selected)}</span>}
            </div>
            {categoryLabel(selected) && <div className="network-cat">{categoryLabel(selected)}</div>}
            <div className="network-panel-actions">
              {sel.id !== rootId && (
                <button type="button" className="tree-open-btn" onClick={() => onRootChange(sel.id)}>{t("network.reroot")}</button>
              )}
              <button type="button" className="tree-open-btn" onClick={() => onNavigate(sel.id)}>{t("network.open")}</button>
            </div>
          </div>
        )}
        {progress !== null && (
          <div className="network-progress" role="status">{t("network.progress", { pct: Math.round(progress * 100) })}</div>
        )}
        <div className="network-help">{t("network.help")}</div>
        {positions.current.pos && (
          <ZoomControls zoom={zoomShown} onZoomIn={() => zoomTo(zoomShown * 1.25)} onZoomOut={() => zoomTo(zoomShown / 1.25)} onSetZoom={zoomTo} onFit={fitView} />
        )}
        <ChartLegend entries={colorer.legend} hidden={hidden} onToggle={toggle} />
      </div>
    </ChartPage>
  );
}
