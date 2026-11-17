/**
 * A small force-directed layout for a network of a few dozen circles: linked
 * circles pull together, all of them push apart, none overlap, and all stay
 * inside the box. Deterministic — the same input lays out the same way every
 * time, so a picture does not jump between visits.
 */

export interface ForceNode {
  /** The circle's radius. */
  r: number;
}

export interface ForceEdge {
  /** Indexes into the nodes. */
  a: number;
  b: number;
  /** How strongly the two pull together; 1 is the weakest link. */
  weight: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ForceOptions {
  iterations?: number;
  /** Free space kept below each circle (its label) and around it. */
  below?: number;
  gap?: number;
}

const GRAVITY = 0.3;

/** Positions of the circles' centres in a `width` × `height` box. */
export function forceLayout(nodes: ForceNode[], edges: ForceEdge[], width: number, height: number, opts: ForceOptions = {}): Point[] {
  const n = nodes.length;
  if (!n) return [];
  const iterations = opts.iterations ?? 400;
  const below = opts.below ?? 0;
  const gap = opts.gap ?? 4;
  const cx = width / 2;
  const cy = height / 2;
  // The first (the biggest) at the centre, the rest on a sunflower spiral round it.
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spread = Math.min(width, height) / 2 / Math.sqrt(n);
  const pos: Point[] = nodes.map((_, i) => ({
    x: cx + spread * Math.sqrt(i) * Math.cos(i * golden),
    y: cy + spread * Math.sqrt(i) * Math.sin(i * golden),
  }));
  const k = 0.7 * Math.sqrt((width * height) / n);
  const maxW = edges.reduce((m, e) => Math.max(m, e.weight), 1);
  const pull = edges.map((e) => 0.4 + 0.6 * (Math.log(e.weight) / Math.log(maxW + 1)));
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);

  const clamp = (i: number) => {
    const r = nodes[i].r + gap;
    pos[i].x = Math.min(width - r, Math.max(r, pos[i].x));
    pos[i].y = Math.min(height - r - below, Math.max(r, pos[i].y));
  };
  /** Push apart any two circles (with their labels' room) that overlap. */
  const separate = () => {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = pos[j].x - pos[i].x;
        let ey = pos[j].y - pos[i].y;
        let d = Math.hypot(ex, ey);
        const min = nodes[i].r + nodes[j].r + gap + below / 2;
        if (d >= min) continue;
        if (d < 1e-6) {
          // Two on one spot part along a fixed direction.
          ex = 1;
          ey = 0;
          d = 1;
        }
        const push = (min - d) / 2;
        pos[i].x -= (ex / d) * push;
        pos[i].y -= (ey / d) * push;
        pos[j].x += (ex / d) * push;
        pos[j].y += (ey / d) * push;
      }
    }
  };

  for (let it = 0; it < iterations; it++) {
    const temp = (Math.min(width, height) / 8) * (1 - it / iterations) + 0.5;
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ex = pos[i].x - pos[j].x;
        const ey = pos[i].y - pos[j].y;
        const d = Math.max(Math.hypot(ex, ey), 1);
        // Far apart, circles no longer push: loose groups stay near the rest
        // instead of being driven to the walls.
        if (d > 3 * k) continue;
        const f = (k * k) / d / d;
        dx[i] += ex * f;
        dy[i] += ey * f;
        dx[j] -= ex * f;
        dy[j] -= ey * f;
      }
    }
    edges.forEach((e, idx) => {
      const ex = pos[e.a].x - pos[e.b].x;
      const ey = pos[e.a].y - pos[e.b].y;
      const d = Math.max(Math.hypot(ex, ey), 1);
      const f = (d / k) * pull[idx];
      dx[e.a] -= ex * f;
      dy[e.a] -= ey * f;
      dx[e.b] += ex * f;
      dy[e.b] += ey * f;
    });
    for (let i = 0; i < n; i++) {
      // A pull to the middle holds the groups together, the stronger across
      // the box's short side so the picture fills its width.
      dx[i] += (cx - pos[i].x) * GRAVITY;
      dy[i] += (cy - pos[i].y) * GRAVITY * (width / height);
      const d = Math.hypot(dx[i], dy[i]);
      if (d > 0) {
        const step = Math.min(d, temp);
        pos[i].x += (dx[i] / d) * step;
        pos[i].y += (dy[i] / d) * step;
      }
      clamp(i);
    }
    separate();
  }
  for (let pass = 0; pass < 50; pass++) {
    separate();
    for (let i = 0; i < n; i++) clamp(i);
  }
  return pos;
}
