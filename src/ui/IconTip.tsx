import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

/**
 * Tooltips for the small source/link icon chips (📖 ⛪ 🔗 ↗).
 *
 * The native `title` waits about a second before it shows and never shows on a
 * touch screen, where a tap on the chip went straight to the link or the edit
 * dialog without saying what it was. A chip opts in by spreading `tipProps`
 * instead of setting `title`; one `IconTipLayer`, mounted once, then shows the
 * text quickly on hover and on keyboard focus. On touch the first tap shows the
 * tip with the chip's actions (Edit, Open link) and the second tap acts as a
 * click always did.
 */
export function tipProps(text: string, opts?: { href?: string; edit?: boolean }) {
  return {
    "data-tip": text,
    "aria-label": text,
    ...(opts?.href ? { "data-tip-href": opts.href } : {}),
    ...(opts?.edit ? { "data-tip-edit": "" } : {}),
  };
}

const HOVER_DELAY_MS = 150;
const MARGIN = 8;

interface Shown {
  el: HTMLElement;
  /** Opened by a tap: the tip takes taps and offers the chip's actions. */
  touch: boolean;
}

function tipTarget(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? (node.closest("[data-tip]") as HTMLElement | null) : null;
}

export function IconTipLayer() {
  const { t } = useTranslation();
  const [shown, setShown] = useState<Shown | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef<Shown | null>(null);
  shownRef.current = shown;

  useEffect(() => {
    let hoverTimer: number | undefined;
    // The click that follows the tap which opened a tip must not also follow
    // the link or open the dialog.
    let swallowClick: HTMLElement | null = null;
    const cancelHover = () => window.clearTimeout(hoverTimer);
    const hide = () => {
      cancelHover();
      setShown(null);
    };
    const insideTip = (n: EventTarget | null) => n instanceof Node && !!tipRef.current?.contains(n);

    const onPointerOver = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const el = tipTarget(e.target);
      if (!el || el === shownRef.current?.el) return;
      cancelHover();
      hoverTimer = window.setTimeout(() => {
        if (el.isConnected) setShown({ el, touch: false });
      }, HOVER_DELAY_MS);
    };
    const onPointerOut = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const el = tipTarget(e.target);
      if (!el || (e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) return;
      cancelHover();
      if (shownRef.current?.el === el && !shownRef.current.touch) setShown(null);
    };
    const onPointerDown = (e: PointerEvent) => {
      const cur = shownRef.current;
      if (cur && !insideTip(e.target) && !cur.el.contains(e.target as Node)) hide();
    };
    // pointerup rather than click: iOS sends no click for a tap on a plain
    // span, and the no-link citation chip is one.
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      const el = tipTarget(e.target);
      if (!el || el === shownRef.current?.el) return;
      swallowClick = el;
      setShown({ el, touch: true });
    };
    const onClick = (e: MouseEvent) => {
      if (swallowClick && swallowClick.contains(e.target as Node)) {
        e.preventDefault();
        e.stopPropagation();
        swallowClick = null;
        return;
      }
      swallowClick = null;
      // The second tap (or a mouse click) acts — the tip has done its job.
      const cur = shownRef.current;
      if (cur && cur.el.contains(e.target as Node)) hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = tipTarget(e.target);
      if (el && el === e.target && el.matches(":focus-visible")) setShown({ el, touch: false });
    };
    const onFocusOut = (e: FocusEvent) => {
      const cur = shownRef.current;
      if (cur && !cur.touch && cur.el === e.target) hide();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && shownRef.current) hide();
    };
    const onScroll = (e: Event) => {
      if (shownRef.current && !insideTip(e.target)) hide();
    };

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    return () => {
      cancelHover();
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  // A chip that leaves the page (its row re-rendered away) takes its tip along.
  useEffect(() => {
    if (!shown) return;
    const id = window.setInterval(() => {
      if (!shown.el.isConnected) setShown(null);
    }, 500);
    return () => window.clearInterval(id);
  }, [shown]);

  // Above the chip, or below it when there is no room; kept inside the window.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!shown || !tip) return;
    const r = shown.el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.min(Math.max(MARGIN, r.left + r.width / 2 - w / 2), window.innerWidth - w - MARGIN);
    const top = r.top - h - 6 >= MARGIN ? r.top - h - 6 : Math.min(r.bottom + 6, window.innerHeight - h - MARGIN);
    tip.style.left = `${Math.max(MARGIN, left)}px`;
    tip.style.top = `${Math.max(MARGIN, top)}px`;
    tip.style.visibility = "visible";
  }, [shown]);

  if (!shown) return null;
  const { el, touch } = shown;
  const text = el.dataset.tip ?? "";
  const href = el instanceof HTMLAnchorElement ? el.href : el.dataset.tipHref;
  const canEdit = el.dataset.tipEdit !== undefined;
  const showActions = touch && (href || canEdit);

  return createPortal(
    <div
      ref={tipRef}
      className={"icon-tip" + (touch ? " icon-tip--touch" : "")}
      role="tooltip"
      style={{ visibility: "hidden" }}
    >
      <div className="icon-tip-text">{text}</div>
      {showActions && (
        <div className="icon-tip-actions">
          {canEdit && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setShown(null);
                el.click();
              }}
            >
              {t("iconTip.edit")}
            </button>
          )}
          {href && (
            <a className="btn-secondary" href={href} target="_blank" rel="noopener noreferrer" onClick={() => setShown(null)}>
              {t("edit.openLink")} ↗
            </a>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
