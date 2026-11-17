import { useMemo, useState } from "react";
import { forceLayout } from "../../chart/forceLayout";
import { tipProps } from "../IconTip";

// The Names page's marriage network: a circle per surname, sized by its
// people, and a line per pair of surnames that married each other, as thick as
// their marriages are many. Pointing at a surname brings out its own lines;
// every circle and line is a button that lists the marriages behind it.

export interface NetworkNode {
  key: string;
  label: string;
  /** Sets the circle's size. */
  people: number;
  tip: string;
  /** Hover heading: the surname. */
  heading: string;
}

export interface NetworkLink {
  key: string;
  a: string;
  b: string;
  count: number;
  tip: string;
}

const WIDTH = 820;
const HEIGHT = 560;
const R_MIN = 7;
const R_MAX = 26;
/** Room below a circle for its name. */
const LABEL = 16;

export function SurnameNetwork({
  nodes,
  links,
  picked,
  onPickNode,
  onPickLink,
}: {
  nodes: NetworkNode[];
  links: NetworkLink[];
  /** A node's key, or `link:` and a link's key. */
  picked?: string;
  onPickNode: (key: string) => void;
  onPickLink: (key: string) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const layout = useMemo(() => {
    const maxPeople = nodes.reduce((m, n) => Math.max(m, n.people), 1);
    const radius = nodes.map((n) => R_MIN + (R_MAX - R_MIN) * Math.sqrt(n.people / maxPeople));
    const index = new Map(nodes.map((n, i) => [n.key, i]));
    const pos = forceLayout(
      radius.map((r) => ({ r })),
      links.map((l) => ({ a: index.get(l.a)!, b: index.get(l.b)!, weight: l.count })),
      WIDTH,
      HEIGHT,
      { below: LABEL },
    );
    const at = new Map(nodes.map((n, i) => [n.key, { ...pos[i], r: radius[i] }]));
    const maxCount = links.reduce((m, l) => Math.max(m, l.count), 1);
    return { at, width: (count: number) => 1 + 6 * Math.sqrt((count - 1) / Math.max(1, maxCount - 1)) };
  }, [nodes, links]);

  // The surname pointed at (or, failing that, picked) and its partners stand out.
  const focus = active ?? (picked && !picked.startsWith("link:") ? picked : null);
  const near = useMemo(() => {
    if (!focus) return null;
    const set = new Set([focus]);
    for (const l of links) if (l.a === focus) set.add(l.b); else if (l.b === focus) set.add(l.a);
    return set;
  }, [focus, links]);

  // Thin lines first, thick ones over them; the focused surname's on top.
  const drawn = [...links].sort((x, y) => {
    const fx = focus && (x.a === focus || x.b === focus) ? 1 : 0;
    const fy = focus && (y.a === focus || y.b === focus) ? 1 : 0;
    return fx - fy || x.count - y.count;
  });

  return (
    <svg
      className={`stats-network${focus ? " focused" : ""}`}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="group"
      onMouseLeave={() => setActive(null)}
    >
      {drawn.map((l) => {
        const a = layout.at.get(l.a)!;
        const b = layout.at.get(l.b)!;
        const lit = focus ? l.a === focus || l.b === focus : false;
        const isPicked = picked === `link:${l.key}`;
        return (
          <g key={l.key} className={`stats-network-link${lit ? " lit" : ""}${isPicked ? " picked" : ""}`} role="button" onClick={() => onPickLink(l.key)} {...tipProps(l.tip, { acts: true })}>
            {/* A wide clear line under the drawn one makes a thin line easy to hit. */}
            <line className="hit" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={layout.width(l.count)} />
          </g>
        );
      })}
      {nodes.map((n) => {
        const p = layout.at.get(n.key)!;
        const dim = near ? !near.has(n.key) : false;
        return (
          <g
            key={n.key}
            className={`stats-network-node${dim ? " dim" : ""}${focus === n.key ? " focus" : ""}${picked === n.key ? " picked" : ""}`}
            role="button"
            tabIndex={0}
            onMouseEnter={() => setActive(n.key)}
            onFocus={() => setActive(n.key)}
            onBlur={() => setActive(null)}
            onClick={() => onPickNode(n.key)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPickNode(n.key);
              }
            }}
            {...tipProps(n.tip, { acts: true, heading: n.heading })}
          >
            <circle cx={p.x} cy={p.y} r={p.r} />
            <text x={p.x} y={p.y + p.r + 13} textAnchor="middle">{n.label}</text>
          </g>
        );
      })}
    </svg>
  );
}
