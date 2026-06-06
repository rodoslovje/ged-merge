import type { ReactNode } from "react";

interface Props {
  title: string;
  /** Short text shown on the right of the header (counts, status…). */
  subtitle?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Disables the header toggle (e.g. nothing to show yet). */
  disabled?: boolean;
  /**
   * When open, make the body a scroll container within a full-height layout:
   *  - "grow" takes the remaining vertical space,
   *  - "cap" takes its natural height up to a limit, then scrolls.
   */
  fill?: "grow" | "cap";
  children: ReactNode;
}

/** A collapsible panel used for the three main sections of the app. */
export function Section({ title, subtitle, open, onToggle, disabled, fill, children }: Props) {
  const fillClass = open && fill ? ` fill ${fill}` : "";
  return (
    <section className={`section${open ? " open" : ""}${fillClass}`}>
      <button
        className="section-head"
        onClick={onToggle}
        disabled={disabled}
        aria-expanded={open}
      >
        <span className="section-chev">{open ? "▾" : "▸"}</span>
        <span className="section-title">{title}</span>
        {subtitle !== undefined && <span className="section-sub">{subtitle}</span>}
      </button>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}
