import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface DropdownItem {
  value: string;
  label: ReactNode;
}

export interface DropdownGroup {
  /** Optional non-selectable group heading (the optgroup label). */
  label?: string;
  items: DropdownItem[];
}

/** Viewport margin the menu keeps clear of the window edges. */
const EDGE = 8;
const MAX_MENU_H = 480;

export interface SelectMenuOption {
  value: string;
  label: ReactNode;
}

/**
 * Form-select equivalent of {@link DropdownMenu}: the trigger shows the
 * current option's label (or `placeholder` while nothing matches) plus a ▾
 * caret, and picking an option calls `onChange` with its value — a drop-in
 * for the native `<select>`-with-options pattern, minus the OS-drawn popup.
 * Pass `options` for a flat list or `groups` for optgroup-style headings.
 */
export function SelectMenu({
  value,
  onChange,
  options,
  groups,
  placeholder,
  className,
  title,
  ariaLabel,
  style,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options?: SelectMenuOption[];
  groups?: DropdownGroup[];
  /** Trigger text while `value` matches no option — the native pattern's
   *  disabled first option ("Pick a source…") or an action picker's label. */
  placeholder?: ReactNode;
  className?: string;
  title?: string;
  ariaLabel?: string;
  style?: CSSProperties;
  disabled?: boolean;
}) {
  const menuGroups = groups ?? [{ items: options ?? [] }];
  const current = menuGroups.flatMap((g) => g.items).find((o) => o.value === value);
  return (
    <DropdownMenu
      groups={menuGroups}
      current={value}
      onSelect={onChange}
      className={`select-menu${className ? ` ${className}` : ""}`}
      title={title}
      ariaLabel={ariaLabel}
      style={style}
      disabled={disabled}
      trigger={
        <>
          <span className="select-menu-value">{current ? current.label : placeholder ?? value}</span>
          <span className="select-menu-caret" aria-hidden="true">▾</span>
        </>
      }
    />
  );
}

/**
 * App-styled replacement for the native `<select>`-as-menu pattern (the event
 * type ▾ label, "+ Add event", "+ Detail", the sex picker): a trigger button
 * that opens a themed popup list instead of the OS-drawn select popup, which
 * CSS cannot reach. Options come as groups (a lone group with no label renders
 * flat); `current` gets the ✓ mark and is where keyboard navigation starts.
 *
 * The menu is portalled to `<body>` with `position: fixed` so no ancestor's
 * overflow can clip it (the events grid clips absolutely-positioned popups),
 * and drops up when the space below the trigger is too tight. It closes on
 * outside pointer-down, Escape (swallowed, so stay-mounted panels' own Esc
 * handlers never see it), scroll outside the list, resize, or selection —
 * returning focus to the trigger.
 */
export function DropdownMenu({
  groups,
  current,
  onSelect,
  trigger,
  className,
  title,
  ariaLabel,
  style,
  disabled,
}: {
  groups: DropdownGroup[];
  /** Value marked as the active choice (✓); omit for action menus. */
  current?: string;
  onSelect: (value: string) => void;
  /** Content of the trigger button (the closed control). */
  trigger: ReactNode;
  /** Classes for the trigger button — pair the caller's chip/label classes
   *  with `dd-reset` styling applied by the component. */
  className?: string;
  title?: string;
  ariaLabel?: string;
  /** Inline style for the trigger (e.g. the score pickers' value colour). */
  style?: CSSProperties;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<CSSProperties>();
  const [active, setActive] = useState(-1);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const flat = groups.flatMap((g) => g.items);

  function openMenu() {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect || flat.length === 0) return;
    const below = window.innerHeight - rect.bottom - EDGE;
    const above = rect.top - EDGE;
    // Drop down unless the space below is cramped and above beats it.
    const up = below < 240 && above > below;
    setMenuPos({
      left: rect.left,
      maxHeight: Math.min(MAX_MENU_H, up ? above : below),
      ...(up ? { bottom: window.innerHeight - rect.top + 2 } : { top: rect.bottom + 2 }),
    });
    const cur = current !== undefined ? flat.findIndex((i) => i.value === current) : -1;
    setActive(cur >= 0 ? cur : 0);
    setOpen(true);
  }

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }

  function pick(value: string) {
    close(true);
    onSelect(value);
  }

  // Keep the menu on-screen horizontally (its width is only known once
  // rendered) and hand it focus so the arrow keys work immediately.
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    const overflow = el.getBoundingClientRect().right - (window.innerWidth - EDGE);
    if (overflow > 0) setMenuPos((s) => ({ ...s, left: Math.max(EDGE, Number(s?.left ?? 0) - overflow) }));
    el.focus();
  }, [open]);

  // While open: any pointer-down outside dismisses; scrolling anywhere but
  // inside the list (which scrolls itself) and resizing dismiss too — the
  // anchor may have moved, and native popups behave the same way.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // Keep the keyboard-active row visible as the selection moves.
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector(".dd-item--active")
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function onMenuKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((a) => Math.min(flat.length - 1, a + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(flat.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (active >= 0 && active < flat.length) pick(flat[active].value);
        break;
      case "Escape":
        // Swallow it: an Esc that escapes the menu can reach a stay-mounted
        // panel's window handler and discard staged work there.
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case "Tab":
        // Close and hand focus back to the trigger (not the default Tab
        // target): the menu lives at the end of <body>, so the default move
        // would drop focus out of any modal hosting the trigger.
        e.preventDefault();
        close(true);
        break;
    }
  }

  // Flat index of the first item of each group, for keyboard bookkeeping.
  let base = 0;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`dd-reset${className ? ` ${className}` : ""}`}
        title={title}
        aria-label={ariaLabel}
        style={style}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="dd-menu"
            style={menuPos}
            role="listbox"
            tabIndex={-1}
            onKeyDown={onMenuKeyDown}
          >
            {groups.map((g, gi) => {
              const start = base;
              base += g.items.length;
              return (
                <div key={gi} className="dd-group">
                  {g.label && <div className="dd-group-label">{g.label}</div>}
                  {g.items.map((item, ii) => {
                    const idx = start + ii;
                    return (
                      <div
                        key={item.value}
                        role="option"
                        aria-selected={item.value === current}
                        className={
                          "dd-item" +
                          (idx === active ? " dd-item--active" : "") +
                          (item.value === current ? " dd-item--current" : "")
                        }
                        onMouseEnter={() => setActive(idx)}
                        // Mouse-down, not click: selection must beat the input
                        // blur/commit cycle the way native option picks do.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          pick(item.value);
                        }}
                      >
                        {item.label}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
