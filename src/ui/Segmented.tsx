import { tabIndexFor, tablistKeyDown } from "../keyboard/tablist";

// One segmented row of the chart controls — the ancestors/descendants
// direction, a pedigree kind's look, …: a `.tree-mode` group of role="tab"
// buttons that is one Tab stop and walks with the arrows, so every chart's
// toggles look and read alike.

export interface SegmentedItem<K extends string> {
  key: K;
  label: React.ReactNode;
  /** Hover text for the segment. */
  title?: string;
}

interface Props<K extends string> {
  items: SegmentedItem<K>[];
  value: K;
  onChange: (value: K) => void;
  /** Accessible name of the row. */
  label: string;
}

export function Segmented<K extends string>({ items, value, onChange, label }: Props<K>) {
  return (
    <div className="tree-mode" role="tablist" aria-label={label} onKeyDown={tablistKeyDown}>
      {items.map((it) => (
        <button
          key={it.key}
          role="tab"
          aria-selected={value === it.key}
          tabIndex={tabIndexFor(value === it.key)}
          className={value === it.key ? "active" : ""}
          title={it.title}
          onClick={() => { if (value !== it.key) onChange(it.key); }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
