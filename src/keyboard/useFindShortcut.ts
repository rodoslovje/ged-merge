import { useEffect, useRef } from "react";
import { isModalOpen } from "./shortcuts";

/**
 * ⌘/Ctrl+F — the conventional "find" chord — focuses the search box of whatever
 * the user is looking at: the chart's find box, the match list's name filter,
 * a Tools explorer's filter. Each of those calls {@link useFindShortcut} to put
 * itself forward; the chord goes to the one that says it is on screen.
 *
 * Boxes are kept in mount order and the *last* visible one wins, so a chart
 * page opened over Edit takes the chord from the view behind it. When nothing
 * claims it — the Report, the landing page — the event is left alone and the
 * browser's own find runs, which is what you want on a page of plain text.
 */
export interface FindTarget {
  /** True while this box is on screen and should own the chord. */
  visible: () => boolean;
  /** Reveal (if hidden behind a toggle) and focus the box. */
  focus: () => void;
}

const targets: FindTarget[] = [];

function onKey(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "f") return;
  if (isModalOpen()) return;
  for (let i = targets.length - 1; i >= 0; i--) {
    if (!targets[i].visible()) continue;
    e.preventDefault();
    targets[i].focus();
    return;
  }
}

/** True when `el` is in the document and actually rendered (not `display:none`
 *  — which is how the app hides the mode it isn't showing). */
export function isOnScreen(el: HTMLElement | null | undefined): boolean {
  return !!el && el.getClientRects().length > 0;
}

/**
 * Claim ⌘/Ctrl+F for this search box while the component is mounted.
 * `visible` and `focus` are read fresh on every keypress, so they may close
 * over changing state.
 */
export function useFindShortcut(visible: () => boolean, focus: () => void): void {
  const latest = useRef({ visible, focus });
  latest.current = { visible, focus };

  useEffect(() => {
    const target: FindTarget = {
      visible: () => latest.current.visible(),
      focus: () => latest.current.focus(),
    };
    targets.push(target);
    if (targets.length === 1) window.addEventListener("keydown", onKey);
    return () => {
      targets.splice(targets.indexOf(target), 1);
      if (targets.length === 0) window.removeEventListener("keydown", onKey);
    };
  }, []);
}

/** The common case: an always-visible-while-mounted input that the chord
 *  focuses and selects. */
export function useFindShortcutOn(
  ref: React.RefObject<HTMLInputElement | null>,
  visible: () => boolean = () => isOnScreen(ref.current),
): void {
  useFindShortcut(visible, () => {
    ref.current?.focus();
    ref.current?.select();
  });
}
