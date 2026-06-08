import type { ReactNode } from "react";

interface Props {
  title: string;
  /** Short text shown on the right of the header (counts, status…). */
  subtitle?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Disables the header toggle (e.g. nothing to show yet). */
  disabled?: boolean;
  children: ReactNode;
}

/** A collapsible panel used for the three main sections of the app. */
export function Section({ title, subtitle, open, onToggle, disabled, children }: Props) {
  return (
    <section className={`section${open ? " open" : ""}`}>
      {/* The toggle is its own button so the subtitle (which carries its own
          controls) isn't nested inside a button — invalid HTML. The header div
          also toggles, so clicking the subtitle text (e.g. file names) expands;
          the button stops propagation to avoid a double toggle, and interactive
          controls inside the subtitle stop propagation themselves. */}
      <div
        className={`section-head${disabled ? "" : " clickable"}`}
        onClick={disabled ? undefined : onToggle}
      >
        <button
          className="section-toggle"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          disabled={disabled}
          aria-expanded={open}
        >
          <span className="section-chev">{open ? "▾" : "▸"}</span>
          <span className="section-title">{title}</span>
        </button>
        {subtitle !== undefined && <span className="section-sub">{subtitle}</span>}
      </div>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}
