import { useState } from "react";
import { usePopoverKeyboard } from "../keyboard/usePopoverKeyboard";

// A one-of-many picker rendered as a dropdown instead of a row of tabs. The
// phone stand-in for the segmented pickers that don't fit across a narrow
// screen — the chart-kind switcher (8 kinds) and the Tools sub-tool row (6) —
// which otherwise become sideways scrollers where the choice you want is often
// off-screen. Same toggle-button + outside-click popover as ExportMenu/AppMenu,
// with the same menu keyboard; the desktop tab rows are untouched.

export interface PickerItem<T extends string> {
  key: T;
  label: string;
  /** Tooltip for the item, and for the button while this item is selected. */
  title?: string;
}

interface Props<T extends string> {
  items: PickerItem<T>[];
  value: T;
  onChange: (key: T) => void;
  /** Names the control for assistive tech (e.g. "Chart kind"). */
  label: string;
  className?: string;
}

export function PickerMenu<T extends string>({ items, value, onChange, label, className }: Props<T>) {
  const [open, setOpen] = useState(false);
  const { containerRef, triggerRef, close, onTriggerKeyDown } = usePopoverKeyboard(open, setOpen, { arrows: true });

  const current = items.find((i) => i.key === value);

  return (
    <div className={"picker-menu" + (className ? ` ${className}` : "")} ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`picker-menu-btn${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={current?.title}
      >
        <span className="picker-menu-value">{current?.label ?? label}</span>
        <span className="picker-menu-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="picker-menu-popover" role="menu" aria-label={label}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitemradio"
              aria-checked={item.key === value}
              className={`picker-menu-item${item.key === value ? " active" : ""}`}
              title={item.title}
              onClick={() => {
                close();
                if (item.key !== value) onChange(item.key);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
