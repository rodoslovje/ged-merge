// Two-thumb year-range slider: two overlaid native range inputs whose thumbs
// are the only pointer targets, over a shared track with the selected span
// filled. Values clamp so from ≤ to; keyboard works per input (arrow keys).

interface Props {
  min: number;
  max: number;
  from: number;
  to: number;
  fromLabel: string;
  toLabel: string;
  onChange: (from: number, to: number) => void;
}

export function YearRangeSlider({ min, max, from, to, fromLabel, toLabel, onChange }: Props) {
  const span = Math.max(1, max - min);
  const loPct = ((from - min) / span) * 100;
  const hiPct = ((to - min) / span) * 100;
  return (
    <div className="year-slider">
      <div className="year-slider-track" />
      <div className="year-slider-fill" style={{ left: `${loPct}%`, width: `${hiPct - loPct}%` }} />
      <input
        type="range"
        min={min}
        max={max}
        value={from}
        aria-label={fromLabel}
        // When both thumbs sit at the right edge only the top input is
        // grabbable — that must be "from" so the range can be reopened.
        className={from > max - span * 0.05 ? "year-slider-ontop" : undefined}
        onChange={(e) => onChange(Math.min(Number(e.target.value), to), to)}
      />
      <input
        type="range"
        min={min}
        max={max}
        value={to}
        aria-label={toLabel}
        onChange={(e) => onChange(from, Math.max(Number(e.target.value), from))}
      />
    </div>
  );
}
