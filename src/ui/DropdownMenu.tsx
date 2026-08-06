import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
 * handlers never see it), scroll outside the list, resize, or selection.
 *
 * Focus stays on the trigger the whole time it is open — as a native `<select>`
 * keeps focus on itself while its popup shows — and the keyboard is driven from
 * there, with `aria-activedescendant` naming the highlighted row. Moving focus
 * into the portalled list instead would fire a focus-out that hosts closing on
 * blur (the inline name/nickname editors) read as "the user left", unmounting
 * the trigger and the menu with it. Opening also focuses the trigger explicitly:
 * Safari does not focus a button on click, so without it the keys would go
 * nowhere and the host would see focus leave for `<body>`.
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
  openNonce,
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
  /** Increment to open the menu programmatically (a keyboard shortcut). The
   *  first value seen at mount never opens — only a later change does. */
  openNonce?: number;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<CSSProperties>();
  const [active, setActive] = useState(-1);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  // Mirrors `open` synchronously. Two keys pressed inside one render pass would
  // both read a stale `open` from the state, so the second ArrowDown re-opened
  // the menu — resetting the highlight to the current value — instead of moving
  // down. The handlers branch on this, the render on the state.
  const openRef = useRef(false);
  const setOpenState = useCallback((next: boolean) => {
    openRef.current = next;
    setOpen(next);
  }, []);
  // The highlighted row is mirrored for the same reason: Enter arriving in the
  // same render pass as the arrow that moved the highlight would otherwise pick
  // the row the highlight had just left.
  const activeRef = useRef(-1);
  const setActiveIndex = useCallback((next: number) => {
    activeRef.current = next;
    setActive(next);
  }, []);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const openMenu = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect || flat.length === 0) return;
    // Safari leaves a clicked button unfocused: take focus before the list
    // shows, so the keys land here and the host sees focus stay inside.
    // preventScroll: the trigger was just pressed, so it is already in view —
    // and scrolling it "into view" anyway would both invalidate the rect
    // measured above and fire a scroll that the dismiss effect below reads as
    // the anchor moving, closing the menu the same click just opened.
    btnRef.current?.focus({ preventScroll: true });
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
    setActiveIndex(cur >= 0 ? cur : 0);
    setOpenState(true);
  }, [flat, current, setOpenState, setActiveIndex]);

  function close(refocus: boolean) {
    setOpenState(false);
    if (refocus) btnRef.current?.focus();
  }

  function pick(value: string) {
    close(true);
    onSelect(value);
  }

  // A shortcut-driven open: bring the trigger into view (the fixed-position
  // menu anchors to its on-screen rect), then open. The nonce guard skips the
  // mount run and makes the extra re-runs from openMenu's identity harmless.
  const seenOpenNonce = useRef(openNonce ?? 0);
  useEffect(() => {
    if (!openNonce || openNonce === seenOpenNonce.current) return;
    seenOpenNonce.current = openNonce;
    btnRef.current?.scrollIntoView({ block: "nearest" });
    openMenu();
  }, [openNonce, openMenu]);

  // Keep the menu on-screen horizontally (its width is only known once
  // rendered). Focus is not moved here — see the component comment.
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    const overflow = el.getBoundingClientRect().right - (window.innerWidth - EDGE);
    if (overflow > 0) setMenuPos((s) => ({ ...s, left: Math.max(EDGE, Number(s?.left ?? 0) - overflow) }));
  }, [open]);

  // While open: any pointer-down outside dismisses; scrolling anywhere but
  // inside the list (which scrolls itself) and resizing dismiss too — the
  // anchor may have moved, and native popups behave the same way.
  useEffect(() => {
    if (!open) return;
    // Where the anchor sat when the menu was placed. A scroll dismisses only if
    // the anchor has actually moved since — a scroll *event* is delivered a
    // frame after the position changed, so the scroll that brought the trigger
    // into view for the very click that opened this menu arrives once it is
    // already showing, and would otherwise shut it on the way up.
    const placedAt = btnRef.current?.getBoundingClientRect();
    const anchorMoved = () => {
      const now = btnRef.current?.getBoundingClientRect();
      if (!placedAt || !now) return true;
      return Math.abs(now.top - placedAt.top) > 1 || Math.abs(now.left - placedAt.left) > 1;
    };
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpenState(false);
    };
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (!anchorMoved()) return;
      setOpenState(false);
    };
    const onResize = () => setOpenState(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, setOpenState]);

  // Keep the keyboard-active row visible as the selection moves — by scrolling
  // the list itself, never `scrollIntoView`. That walks up and scrolls every
  // scrollable ancestor: anchored inside a dialog it scrolls the dialog body,
  // and the dismiss effect above reads that scroll as the anchor moving and
  // closes the menu the opening click just opened. The maths below is what
  // `block: "nearest"` does, confined to `.dd-menu`.
  useEffect(() => {
    if (!open) return;
    const list = menuRef.current;
    const row = list?.querySelector(".dd-item--active");
    if (!list || !row) return;
    const listBox = list.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    if (rowBox.top < listBox.top) list.scrollTop -= listBox.top - rowBox.top;
    else if (rowBox.bottom > listBox.bottom) list.scrollTop += rowBox.bottom - listBox.bottom;
  }, [open, active]);

  function onMenuKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex(Math.min(flat.length - 1, activeRef.current + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex(Math.max(0, activeRef.current - 1));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(flat.length - 1);
        break;
      case "Enter":
      case " ": {
        e.preventDefault();
        const idx = activeRef.current;
        if (idx >= 0 && idx < flat.length) pick(flat[idx].value);
        break;
      }
      case "Escape":
        // Swallow it: an Esc that escapes the menu can reach a stay-mounted
        // panel's window handler and discard staged work there.
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case "Tab":
        // Close, then let Tab do its ordinary thing: focus is already on the
        // trigger, so the next stop is the one following it in the document.
        setOpenState(false);
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
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        // Take focus on the press, not on the click: Safari focuses no button
        // on click, so the field the user was editing would otherwise blur to
        // <body> here — and a host that closes on blur (the inline name editor)
        // would unmount this trigger before the click could open anything.
        // preventDefault suppresses the browser's own focus handling; the click
        // still fires. preventScroll for the reason given in `openMenu`.
        onMouseDown={(e) => {
          e.preventDefault();
          btnRef.current?.focus({ preventScroll: true });
        }}
        onClick={() => (openRef.current ? close(false) : openMenu())}
        onKeyDown={(e) => {
          // While open the trigger still holds focus, so it drives the list.
          if (openRef.current) {
            onMenuKeyDown(e);
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div ref={menuRef} id={listId} className="dd-menu" style={menuPos} role="listbox">
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
                        id={`${listId}-${idx}`}
                        role="option"
                        data-value={item.value}
                        aria-selected={item.value === current}
                        className={
                          "dd-item" +
                          (idx === active ? " dd-item--active" : "") +
                          (item.value === current ? " dd-item--current" : "")
                        }
                        onMouseEnter={() => setActiveIndex(idx)}
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
