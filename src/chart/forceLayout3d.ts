// A 3D force-directed layout for the network chart, stepped a frame at a time
// so the picture settles in front of the user. Linked people pull to a set
// distance, everyone pushes everyone apart (Barnes–Hut over an octree, so a
// few thousand people stay interactive), and a weak pull keeps the cloud
// centred. In the layered mode each person's height is held to their
// generation, so the trees stand upright: ancestors above, descendants below.
//
// Deterministic: the start positions come from a seeded generator, so the
// same graph settles the same way every time.
//
// Pure: no React, no DOM.

export interface LayoutEdge {
  a: number;
  b: number;
  /** Rest length, in layout units. */
  length: number;
}

export interface Layout3d {
  /** x, y, z per node, packed. */
  pos: Float32Array;
  /** One simulation step; false once the layout has cooled. */
  step(): boolean;
  /** Warm the layout up again (after a mode change). */
  reheat(): void;
  setLayered(layered: boolean): void;
  /** How far the layout has cooled, 0 to 1. */
  progress(): number;
}

/** Vertical distance between generations in the layered mode. */
export const LAYER = 60;
const LINK = 30;
const CHARGE = 900;
/** How much harder people push apart sideways than up and down. */
const SPREAD = 4;
const ALPHA_MIN = 0.004;
/** Past this many nodes the layout trades some precision for time: a coarser
 *  Barnes–Hut cut and fewer steps (it starts near its end anyway, see `via`). */
const BIG = 20000;
const DAMPING = 0.6;

/** A small seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Octree ───────────────────────────────────────────────────────────────────
// Flat arrays, rebuilt each step: per cell its centre of mass, mass, half size
// and eight children (−1 none). A leaf holds one body.

class Octree {
  cx = new Float32Array(0);
  cy = new Float32Array(0);
  cz = new Float32Array(0);
  mass = new Float32Array(0);
  half = new Float32Array(0);
  ox = new Float32Array(0);
  oy = new Float32Array(0);
  oz = new Float32Array(0);
  kids = new Int32Array(0);
  body = new Int32Array(0);
  count = 0;

  private grow(n: number) {
    if (n <= this.mass.length) return;
    const cap = Math.max(n, this.mass.length * 2, 64);
    const f = (a: Float32Array) => { const b = new Float32Array(cap); b.set(a); return b; };
    this.cx = f(this.cx); this.cy = f(this.cy); this.cz = f(this.cz);
    this.mass = f(this.mass); this.half = f(this.half);
    this.ox = f(this.ox); this.oy = f(this.oy); this.oz = f(this.oz);
    const k = new Int32Array(cap * 8); k.set(this.kids); this.kids = k;
    const b = new Int32Array(cap); b.set(this.body); this.body = b;
  }

  private cell(x: number, y: number, z: number, h: number): number {
    const i = this.count++;
    this.grow(this.count);
    this.ox[i] = x; this.oy[i] = y; this.oz[i] = z; this.half[i] = h;
    this.cx[i] = 0; this.cy[i] = 0; this.cz[i] = 0; this.mass[i] = 0;
    this.kids.fill(-1, i * 8, i * 8 + 8);
    this.body[i] = -1;
    return i;
  }

  build(p: Float32Array, n: number) {
    this.count = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const h = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1) / 2 + 1;
    const root = this.cell((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2, h);
    for (let i = 0; i < n; i++) this.insert(root, i, p, 0);
    this.finish(p);
  }

  private octant(c: number, x: number, y: number, z: number): number {
    return (x > this.ox[c] ? 1 : 0) | (y > this.oy[c] ? 2 : 0) | (z > this.oz[c] ? 4 : 0);
  }

  private child(c: number, o: number): number {
    const h = this.half[c] / 2;
    return this.cell(
      this.ox[c] + (o & 1 ? h : -h),
      this.oy[c] + (o & 2 ? h : -h),
      this.oz[c] + (o & 4 ? h : -h),
      h,
    );
  }

  private insert(c: number, i: number, p: Float32Array, depth: number) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    for (;;) {
      const m = this.mass[c];
      this.mass[c] = m + 1;
      if (m === 0) { this.body[c] = i; return; }
      // Bodies at (almost) one spot stop splitting: a cell this small keeps them all.
      if (depth > 24) return;
      if (this.body[c] >= 0) {
        const j = this.body[c];
        this.body[c] = -1;
        const oj = this.octant(c, p[j * 3], p[j * 3 + 1], p[j * 3 + 2]);
        const kj = this.child(c, oj);
        this.kids[c * 8 + oj] = kj;
        this.mass[kj] = 1;
        this.body[kj] = j;
      }
      const o = this.octant(c, x, y, z);
      let k = this.kids[c * 8 + o];
      if (k < 0) { k = this.child(c, o); this.kids[c * 8 + o] = k; }
      c = k;
      depth++;
    }
  }

  /** Centres of mass, bottom up. A cell is always made after its parent, so
   *  walking the cells from the last made to the first visits every child
   *  before its parent — no recursion, nothing allocated. */
  private finish(p: Float32Array) {
    const { cx, cy, cz, mass, kids, body } = this;
    for (let c = this.count - 1; c >= 0; c--) {
      const b = body[c];
      if (b >= 0) {
        cx[c] = p[b * 3]; cy[c] = p[b * 3 + 1]; cz[c] = p[b * 3 + 2];
        continue;
      }
      let sx = 0, sy = 0, sz = 0, m = 0;
      for (let o = 0; o < 8; o++) {
        const k = kids[c * 8 + o];
        if (k < 0) continue;
        const km = mass[k];
        sx += cx[k] * km; sy += cy[k] * km; sz += cz[k] * km; m += km;
      }
      if (m > 0) { cx[c] = sx / m; cy[c] = sy / m; cz[c] = sz / m; }
      else { cx[c] = this.ox[c]; cy[c] = this.oy[c]; cz[c] = this.oz[c]; }
    }
  }
}

/**
 * A layout for `n` nodes. `gen[i]` is a node's generation (up positive), or
 * NaN for a node with none — it floats free even in the layered mode. `hops`
 * seeds the start: nearer people start nearer the middle. `trees[i]` is the
 * separate tree a node belongs to (0 the root's): see {@link treeAnchors}.
 * `via[i]`, an earlier node (or -1), is where node `i` starts beside: a child
 * next to their family, a family next to its partner — so the start is already
 * shaped like the tree and the layout has little left to do.
 */
export function createLayout3d(
  n: number,
  edges: LayoutEdge[],
  gen: Float64Array,
  hops: Int32Array,
  trees?: Int32Array,
  via?: Int32Array,
  seed = 1,
): Layout3d {
  const theta2 = n > BIG ? 1.44 : 0.81;
  const decay = Math.pow(ALPHA_MIN, 1 / (n > BIG ? 150 : n > 5000 ? 220 : 300));
  const pos = new Float32Array(n * 3);
  const vel = new Float32Array(n * 3);
  const force = new Float32Array(n * 3);
  const rand = rng(seed);
  const degree = new Int32Array(n);
  for (const e of edges) { degree[e.a]++; degree[e.b]++; }
  const anchor = treeAnchors(trees ?? new Int32Array(n));
  // Start positions. A node with a `via` waits for that one to be placed (the
  // chain is followed with a stack, not recursion: it can run thousands deep).
  // `via` must not loop; a loop is cut where it closes.
  const placed = new Uint8Array(n); // 0 not yet, 1 on the stack, 2 placed
  const chain: number[] = [];
  const placeOne = (i: number) => {
    const u = rand() * 2 - 1;
    const th = rand() * Math.PI * 2;
    const from = via ? via[i] : -1;
    if (from >= 0 && placed[from] === 2) {
      // Beside the node it hangs from, about a link's length away.
      const d = LINK * (0.6 + rand() * 0.6);
      pos[i * 3] = pos[from * 3] + d * Math.cos(th);
      pos[i * 3 + 1] = Number.isNaN(gen[i]) ? pos[from * 3 + 1] + d * u : gen[i] * LAYER;
      pos[i * 3 + 2] = pos[from * 3 + 2] + d * Math.sin(th);
    } else {
      // A random direction on a shell round its tree's spot, wider with the hops.
      const s = Math.sqrt(1 - u * u);
      const r = LINK * (0.5 + Math.cbrt(hops[i] + 1) * 2) * (0.6 + rand() * 0.8);
      const t = trees ? trees[i] : 0;
      pos[i * 3] = anchor[t * 2] + r * s * Math.cos(th);
      pos[i * 3 + 1] = Number.isNaN(gen[i]) ? r * u : gen[i] * LAYER;
      pos[i * 3 + 2] = anchor[t * 2 + 1] + r * s * Math.sin(th);
    }
    placed[i] = 2;
  };
  for (let i = 0; i < n; i++) {
    if (placed[i]) continue;
    for (let j = i; j >= 0 && !placed[j]; j = via ? via[j] : -1) {
      placed[j] = 1;
      chain.push(j);
    }
    while (chain.length) placeOne(chain.pop()!);
  }
  let layered = true;
  let alpha = 1;
  const tree = new Octree();

  // The repulsion of each node, kept apart from the other forces: on a big
  // graph it is recomputed only every other step — it changes slowly, and it is
  // nearly all the cost — while the springs and the moves run every step.
  const rep = new Float32Array(n * 3);
  const stack = new Int32Array(64 * 8);
  const repel = (i: number) => {
    const { cx, cy, cz, mass, half, kids, body } = tree;
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    let fx = 0, fy = 0, fz = 0;
    let top = 0;
    stack[top++] = 0;
    while (top) {
      const c = stack[--top];
      const m = mass[c];
      if (!m) continue;
      const b = body[c];
      if (b === i) continue;
      let dx = x - cx[c], dy = y - cy[c], dz = z - cz[c];
      let d2 = dx * dx + dy * dy + dz * dz;
      const size = half[c] * 2;
      if (b >= 0 || size * size < theta2 * d2) {
        if (d2 < 1) {
          // Coincident: nudge apart in a direction of their own.
          dx = (i % 7) - 3 + 0.5; dy = (i % 5) - 2 + 0.5; dz = (i % 3) - 1 + 0.5;
          d2 = dx * dx + dy * dy + dz * dz;
        }
        const f = (CHARGE * m) / (d2 * Math.sqrt(d2));
        fx += dx * f; fy += dy * f; fz += dz * f;
        continue;
      }
      const k0 = c * 8;
      for (let o = 0; o < 8; o++) {
        const k = kids[k0 + o];
        if (k >= 0) stack[top++] = k;
      }
    }
    // Sideways the push is stronger than up and down: the generations are
    // already a layer apart, and the families of one generation need the room.
    rep[i * 3] = fx * SPREAD; rep[i * 3 + 1] = fy; rep[i * 3 + 2] = fz * SPREAD;
  };

  // The springs as flat arrays, each end's share of the pull split by degree
  // up front, so a hub with many children is not yanked about.
  const m = edges.length;
  const ea = new Int32Array(m), eb = new Int32Array(m);
  const elen = new Float32Array(m), ewa = new Float32Array(m), ewb = new Float32Array(m);
  edges.forEach((e, k) => {
    ea[k] = e.a; eb[k] = e.b; elen[k] = e.length;
    ewa[k] = 1 / Math.max(degree[e.a], 1);
    ewb[k] = 1 / Math.max(degree[e.b], 1);
  });
  const every = n > BIG ? 2 : 1;
  let steps = 0;

  const step = (): boolean => {
    if (alpha < ALPHA_MIN || n === 0) return false;
    if (steps++ % every === 0) {
      tree.build(pos, n);
      for (let i = 0; i < n; i++) repel(i);
    }
    force.set(rep);
    for (let k = 0; k < m; k++) {
      const a = ea[k] * 3, b = eb[k] * 3;
      const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const f = (d - elen[k]) / d;
      const fa = f * ewa[k], fb = f * ewb[k];
      force[a] += dx * fa; force[a + 1] += dy * fa; force[a + 2] += dz * fa;
      force[b] -= dx * fb; force[b + 1] -= dy * fb; force[b + 2] -= dz * fb;
    }
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      // A pull to the tree's own spot: the root's tree to the middle (weakly),
      // each separate tree firmly to its place around it.
      const t = trees ? trees[i] : 0;
      const pull = t === 0 ? 0.002 : 0.02;
      force[j] -= (pos[j] - anchor[t * 2]) * pull;
      force[j + 2] -= (pos[j + 2] - anchor[t * 2 + 1]) * pull;
      const fixed = layered && !Number.isNaN(gen[i]);
      if (!fixed) force[j + 1] -= pos[j + 1] * 0.002;
      for (let d = 0; d < 3; d++) {
        let v = (vel[j + d] + force[j + d] * alpha) * DAMPING;
        // Cap the speed, so a far-flung start cannot fling anyone off.
        if (v > 20) v = 20; else if (v < -20) v = -20;
        vel[j + d] = v;
        pos[j + d] += v;
      }
      if (fixed) {
        // Ease the height onto the generation's layer.
        pos[j + 1] += (gen[i] * LAYER - pos[j + 1]) * 0.3;
        vel[j + 1] = 0;
      }
    }
    alpha *= decay;
    return true;
  };

  return {
    pos,
    step,
    reheat: () => { alpha = Math.max(alpha, 0.5); },
    setLayered: (on) => { layered = on; alpha = Math.max(alpha, 0.5); },
    progress: () => Math.min(Math.log(alpha) / Math.log(ALPHA_MIN), 1),
  };
}

/** A tree of this many people takes about this radius once settled. */
function treeRadius(size: number): number {
  // The sideways push widens a tree with it, by about its cube root.
  return LINK * (1 + 1.6 * Math.cbrt(size)) * Math.cbrt(SPREAD);
}

/**
 * Where each separate tree settles, as packed x, z per tree index: the root's
 * tree (0) in the middle, the others on a sunflower spiral in the floor plane
 * around it, clear of its edge, the bigger ones first and nearer. A tree in a
 * separate spot reads as separate; left to the shared centre, the small ones
 * would sink into the main cloud and never be seen.
 */
export function treeAnchors(tree: Int32Array): Float64Array {
  let count = 0;
  for (const t of tree) if (t + 1 > count) count = t + 1;
  const size = new Int32Array(Math.max(count, 1));
  for (const t of tree) size[t]++;
  const out = new Float64Array(Math.max(count, 1) * 2);
  const others = Array.from({ length: Math.max(count - 1, 0) }, (_, k) => k + 1)
    .sort((a, b) => size[b] - size[a] || a - b);
  const inner = treeRadius(size[0]) + LINK * 3;
  // Spiral spacing from the typical tree among the others.
  const spacing = 2 * treeRadius(others.length ? size[others[Math.floor(others.length / 2)]] : 1) + LINK;
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  let reach = inner;
  others.forEach((t, k) => {
    // Grow outward as the ring fills, and never closer than the tree's own size.
    reach = Math.max(reach, inner + spacing * Math.sqrt(k + 1) * 0.9, inner + treeRadius(size[t]));
    out[t * 2] = reach * Math.cos(k * GOLDEN);
    out[t * 2 + 1] = reach * Math.sin(k * GOLDEN);
  });
  return out;
}

/** Rest length of a link: partners sit close beside their family's hub, the
 *  children a little more than a generation below, so they fan out under it. */
export function linkLength(kind: "partner" | "child"): number {
  return kind === "partner" ? LINK * 0.35 : LAYER * 1.7;
}
