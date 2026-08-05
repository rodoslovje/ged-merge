import type { MatchDecisionStatus } from "../review/types";

/**
 * Single source of truth for keyboard shortcuts. View handlers import the KEY
 * constants below; the help overlay (`ShortcutsModal`) renders SHORTCUT_GROUPS.
 * Keeping both here means the cheat sheet can never drift from what the handlers
 * actually do.
 *
 * Convention — and the distinction the overlay makes visible:
 *   • "standard" actions use a modifier chord (Ctrl/Cmd) and keep their
 *     conventional browser/editor meaning (save, undo, redo, find).
 *   • "app" actions are GED Merge-specific and use a *bare* single letter
 *     (fixed Latin mnemonics, locale-independent so they never collide across
 *     translated labels the way label-derived keys did).
 */

/** Bare single-key shortcuts. Fixed Latin letters, independent of UI language. */
export const KEY = {
  modeEdit: "e",
  modeMerge: "m",
  modeTools: "t",
  tree: "v",
  relationship: "s",
  /** Edit mode: jump to the start ("home") person. */
  home: "h",
  /** Add a new person attached to nobody, from any mode. */
  addPerson: "n",
  confirm: "c",
  reject: "r",
  defer: "d",
} as const;

/** Bare keys active on the full-page chart overlays (handled by
 *  useChartShortcuts). Digits 1–n additionally pick a chart kind. */
export const CHART_KEY = {
  zoomIn: ["+", "="],
  zoomOut: ["-", "_"],
  zoomReset: "0",
  fit: "f",
  ancestors: "a",
  descendants: "d",
} as const;

type ActiveStatus = Exclude<MatchDecisionStatus, "undecided">;

/** Match-decision status → its bare shortcut key. */
export const STATUS_KEY: Record<ActiveStatus, string> = {
  confirmed: KEY.confirm,
  rejected: KEY.reject,
  deferred: KEY.defer,
};

/** Bare shortcut key → match-decision status (inverse of STATUS_KEY). */
export const KEY_STATUS: Record<string, ActiveStatus> = {
  [KEY.confirm]: "confirmed",
  [KEY.reject]: "rejected",
  [KEY.defer]: "deferred",
};

/**
 * True while any modal (`.modal-overlay`) is mounted. Bare-key and undo/redo
 * shortcuts bail on this so they don't act on the app behind an open dialog.
 */
export function isModalOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector(".modal-overlay") != null;
}

/** True when a typing surface has focus — shortcuts must not steal those keys. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

export type ShortcutCategory = "standard" | "app";

export interface ShortcutItem {
  /**
   * Key combos to render as <kbd>. Each inner array is one chord ("mod" + "s");
   * multiple inner arrays are interchangeable alternatives (e.g. redo, arrows).
   * "mod" is rendered as ⌘ on macOS, Ctrl elsewhere.
   */
  keys: string[][];
  /** i18n key for the human-readable description. */
  descKey: string;
}

export interface ShortcutGroup {
  titleKey: string;
  category: ShortcutCategory;
  /** Which column of the cheat-sheet grid the group renders in. */
  column: "left" | "right";
  items: ShortcutItem[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    titleKey: "shortcuts.group.general",
    category: "standard",
    column: "left",
    items: [
      { keys: [["mod", "S"]], descKey: "shortcuts.item.save" },
      { keys: [["mod", "Z"]], descKey: "shortcuts.item.undo" },
      { keys: [["mod", "Shift", "Z"], ["mod", "Y"]], descKey: "shortcuts.item.redo" },
      { keys: [["mod", "F"]], descKey: "shortcuts.item.find" },
      { keys: [["/"]], descKey: "shortcuts.item.globalSearch" },
      { keys: [["?"]], descKey: "shortcuts.item.help" },
      { keys: [["Esc"]], descKey: "shortcuts.item.escape" },
    ],
  },
  {
    titleKey: "shortcuts.group.modes",
    category: "app",
    column: "right",
    items: [
      { keys: [[KEY.modeEdit.toUpperCase()]], descKey: "shortcuts.item.modeEdit" },
      { keys: [[KEY.modeMerge.toUpperCase()]], descKey: "shortcuts.item.modeMerge" },
      { keys: [[KEY.modeTools.toUpperCase()]], descKey: "shortcuts.item.modeTools" },
    ],
  },
  {
    titleKey: "shortcuts.group.navigation",
    category: "app",
    column: "left",
    items: [
      { keys: [["←"], ["→"]], descKey: "shortcuts.item.prevNext" },
      { keys: [["↑"], ["↓"]], descKey: "shortcuts.item.scroll" },
      { keys: [["Enter"]], descKey: "shortcuts.item.enter" },
      { keys: [[KEY.tree.toUpperCase()]], descKey: "shortcuts.item.tree" },
      { keys: [[KEY.relationship.toUpperCase()]], descKey: "shortcuts.item.relationship" },
      { keys: [[KEY.home.toUpperCase()]], descKey: "shortcuts.item.home" },
      { keys: [["⌫"]], descKey: "shortcuts.item.back" },
    ],
  },
  {
    titleKey: "shortcuts.group.editing",
    category: "app",
    column: "right",
    items: [
      { keys: [[KEY.addPerson.toUpperCase()]], descKey: "shortcuts.item.addPerson" },
      { keys: [["1"], ["9"]], descKey: "shortcuts.item.quickEvent" },
      { keys: [["Enter"]], descKey: "shortcuts.item.commitField" },
    ],
  },
  {
    titleKey: "shortcuts.group.decisions",
    category: "app",
    column: "right",
    items: [
      { keys: [[KEY.confirm.toUpperCase()]], descKey: "shortcuts.item.confirm" },
      { keys: [[KEY.reject.toUpperCase()]], descKey: "shortcuts.item.reject" },
      { keys: [[KEY.defer.toUpperCase()]], descKey: "shortcuts.item.defer" },
    ],
  },
  {
    titleKey: "shortcuts.group.charts",
    category: "app",
    column: "right",
    items: [
      { keys: [["1"], ["8"]], descKey: "shortcuts.item.chartKind" },
      { keys: [[CHART_KEY.ancestors.toUpperCase()], [CHART_KEY.descendants.toUpperCase()]], descKey: "shortcuts.item.chartDirection" },
      { keys: [["+"], ["−"]], descKey: "shortcuts.item.chartZoom" },
      { keys: [[CHART_KEY.zoomReset]], descKey: "shortcuts.item.chartZoomReset" },
      { keys: [[CHART_KEY.fit.toUpperCase()]], descKey: "shortcuts.item.chartFit" },
    ],
  },
];

/** Render "mod" for the current platform; pass other tokens through unchanged. */
export function renderKeyToken(token: string): string {
  if (token !== "mod") return token;
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return isMac ? "⌘" : "Ctrl";
}
