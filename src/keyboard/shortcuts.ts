import type { FamilyStep } from "../gedcom/familyNav";
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
  /** Merge mode: show or hide the match list's filters. */
  filter: "f",
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
  /** Draw the chart for the start person — Edit's "go home", one letter for both. */
  home: KEY.home,
  /** Open the selected person in Edit — the mode's own letter. */
  edit: KEY.modeEdit,
} as const;

/**
 * Edit mode: which family step an Alt+arrow chord means. The arrows map the
 * layout around the person — parents above, children below, the person's own
 * generation left and right — and Shift picks the other one on that axis: the
 * mother rather than the father, the youngest child rather than the eldest, a
 * partner rather than a sibling. Any other key is not a family step.
 */
export function familyStepFor(key: string, shift: boolean): FamilyStep | undefined {
  switch (key) {
    case "ArrowUp": return shift ? "mother" : "father";
    case "ArrowDown": return shift ? "lastChild" : "firstChild";
    case "ArrowLeft": return shift ? "prevPartner" : "prevSibling";
    case "ArrowRight": return shift ? "nextPartner" : "nextSibling";
    default: return undefined;
  }
}

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
 * The layers open over the page: every dialog (`useModalKeyboard`) and every
 * popover (`usePopoverKeyboard`) registers itself while it is up. Kept as a
 * registry rather than a class query so a menu with no overlay element counts
 * too — the Export menu and the chart gear used to be invisible here, and the
 * bare keys went on firing behind them.
 */
const layers = new Set<symbol>();

/** Hold a layer open; call the returned function to let it go. */
export function registerLayer(): () => void {
  const id = Symbol("layer");
  layers.add(id);
  return () => { layers.delete(id); };
}

/**
 * True while any modal is up — a registered dialog or popover, or (belt and
 * braces, for an overlay that bypasses the hooks) a dialog (`.modal-overlay`)
 * or the photo lightbox (`.person-media-overlay`) in the DOM. Bare-key and
 * undo/redo shortcuts bail on this so they don't act on the app behind an
 * open dialog: with the lightbox open, `e`/`m`/`t` would switch mode, `n` add
 * a person and `c`/`r`/`d` decide a match, all invisibly behind the photo.
 */
export function isModalOpen(): boolean {
  if (layers.size > 0) return true;
  return typeof document !== "undefined" && document.querySelector(".modal-overlay, .person-media-overlay") != null;
}

/** True when a typing surface has focus — shortcuts must not steal those keys. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

export type ShortcutCategory = "standard" | "app";

/** Where a shortcut works: a mode, or a full-page chart over one. */
export type ShortcutScope = "edit" | "merge" | "tools" | "chart";

export interface ShortcutItem {
  /**
   * Key combos to render as <kbd>. Each inner array is one chord ("mod" + "s");
   * multiple inner arrays are interchangeable alternatives (e.g. redo, arrows).
   * "mod" is rendered as ⌘ on macOS, Ctrl elsewhere.
   */
  keys: string[][];
  /** How the alternatives read: "/" between interchangeable keys (the default),
   *  "–" when they are the ends of a run (1–9). */
  sep?: "or" | "range";
  /** i18n key for the human-readable description. */
  descKey: string;
  /** Where the keys work. Omitted: the group's scope, and with neither,
   *  everywhere. The sheet leads with the items that apply where the user is. */
  scope?: readonly ShortcutScope[];
}

export interface ShortcutGroup {
  titleKey: string;
  category: ShortcutCategory;
  /** Default scope of the group's items. */
  scope?: readonly ShortcutScope[];
  items: ShortcutItem[];
}

/** Where an item works — its own scope, else its group's; undefined = everywhere. */
export function itemScope(group: ShortcutGroup, item: ShortcutItem): readonly ShortcutScope[] | undefined {
  return item.scope ?? group.scope;
}

// In sheet order: the groups flow into three columns top to bottom, each kept
// whole, so this order is what balances the columns.
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    titleKey: "shortcuts.group.general",
    category: "standard",
    items: [
      { keys: [["mod", "S"]], descKey: "shortcuts.item.save" },
      { keys: [["mod", "Z"]], descKey: "shortcuts.item.undo" },
      { keys: [["mod", "shift", "Z"], ["mod", "Y"]], descKey: "shortcuts.item.redo" },
      { keys: [["mod", "F"]], descKey: "shortcuts.item.find" },
      { keys: [["mod", "Enter"]], descKey: "shortcuts.item.confirmDialog" },
      { keys: [["/"]], descKey: "shortcuts.item.globalSearch" },
      // F1 also from inside a field, where `?` is the character being typed.
      { keys: [["?"], ["F1"]], descKey: "shortcuts.item.help" },
      { keys: [["Esc"]], descKey: "shortcuts.item.escape" },
    ],
  },
  {
    titleKey: "shortcuts.group.modes",
    category: "app",
    // Not on a chart page: the letters are held back there, where a mode
    // switch would happen invisibly behind the overlay.
    scope: ["edit", "merge", "tools"],
    items: [
      { keys: [[KEY.modeEdit.toUpperCase()]], descKey: "shortcuts.item.modeEdit" },
      { keys: [[KEY.modeMerge.toUpperCase()]], descKey: "shortcuts.item.modeMerge" },
      { keys: [[KEY.modeTools.toUpperCase()]], descKey: "shortcuts.item.modeTools" },
    ],
  },
  {
    titleKey: "shortcuts.group.decisions",
    category: "app",
    scope: ["merge", "tools"],
    items: [
      { keys: [[KEY.confirm.toUpperCase()]], descKey: "shortcuts.item.confirm" },
      { keys: [[KEY.reject.toUpperCase()]], descKey: "shortcuts.item.reject" },
      { keys: [[KEY.defer.toUpperCase()]], descKey: "shortcuts.item.defer" },
      { keys: [[KEY.filter.toUpperCase()]], descKey: "shortcuts.item.filters", scope: ["merge"] },
      { keys: [["1"], ["2"], ["3"]], descKey: "shortcuts.item.fieldChoice", scope: ["merge"] },
    ],
  },
  {
    titleKey: "shortcuts.group.navigation",
    category: "app",
    items: [
      { keys: [["↑"], ["↓"]], descKey: "shortcuts.item.scroll", scope: ["merge", "tools"] },
      { keys: [["←"], ["→"]], descKey: "shortcuts.item.prevNext", scope: ["merge", "edit", "tools"] },
      { keys: [["Home"], ["End"]], descKey: "shortcuts.item.homeEnd", scope: ["merge", "tools"] },
      { keys: [["PgUp"], ["PgDn"]], descKey: "shortcuts.item.page", scope: ["merge", "tools"] },
      // Edit's family steps. ⌥ alone and not ⌥⇧ (the edit-action family): with
      // arrows there is no menu accelerator to collide with, and the pair leaves
      // ⇧ free to mean "the other one on this axis".
      { keys: [["alt", "↑"], ["alt", "shift", "↑"]], descKey: "shortcuts.item.goParent", scope: ["edit", "chart"] },
      { keys: [["alt", "←"], ["alt", "→"]], descKey: "shortcuts.item.goSibling", scope: ["edit", "chart"] },
      { keys: [["alt", "↓"], ["alt", "shift", "↓"]], descKey: "shortcuts.item.goChild", scope: ["edit", "chart"] },
      { keys: [["alt", "shift", "←"], ["alt", "shift", "→"]], descKey: "shortcuts.item.goPartner", scope: ["edit", "chart"] },
      { keys: [["Enter"]], descKey: "shortcuts.item.enter", scope: ["merge", "tools"] },
      { keys: [[KEY.tree.toUpperCase()]], descKey: "shortcuts.item.tree", scope: ["edit", "merge"] },
      { keys: [[KEY.relationship.toUpperCase()]], descKey: "shortcuts.item.relationship", scope: ["edit"] },
      { keys: [[KEY.home.toUpperCase()]], descKey: "shortcuts.item.home", scope: ["edit"] },
      // The chord is the same step taken from inside a field, where the bare
      // key belongs to the text being typed.
      { keys: [["⌫"], ["alt", "shift", "⌫"]], descKey: "shortcuts.item.back", scope: ["edit", "chart"] },
    ],
  },
  {
    titleKey: "shortcuts.group.editing",
    category: "app",
    scope: ["edit"],
    items: [
      { keys: [[KEY.addPerson.toUpperCase()]], descKey: "shortcuts.item.addPerson", scope: ["edit", "merge", "tools"] },
      // ⌥⇧, so they fire inside a field too — and clear of the browser's own:
      // ⌥E/⌥S are menu accelerators on Windows and Linux, ⌃⌥ is AltGr, and
      // ⌃⇧N/P/M belong to the browser (see the EditView key handler).
      // The menu first, then the one-click events — the order of the row they
      // stand for, under the event list.
      { keys: [["alt", "shift", "E"]], descKey: "shortcuts.item.addEventMenu" },
      { keys: [["alt", "shift", "1"], ["alt", "shift", "9"]], sep: "range", descKey: "shortcuts.item.quickEvent" },
      { keys: [["alt", "shift", "N"], ["alt", "shift", "S"]], descKey: "shortcuts.item.addNoteSource" },
      { keys: [["alt", "shift", "D"]], descKey: "shortcuts.item.addDetailMenu" },
      { keys: [["alt", "shift", "A"], ["alt", "shift", "I"], ["alt", "shift", "L"]], descKey: "shortcuts.item.addNameMediaPrivate" },
      { keys: [["alt", "shift", "F"], ["alt", "shift", "M"]], descKey: "shortcuts.item.addParent" },
      { keys: [["alt", "shift", "P"], ["alt", "shift", "C"]], descKey: "shortcuts.item.addPartnerChild" },
      { keys: [["alt", "shift", "X"]], descKey: "shortcuts.item.sexCycle" },
      { keys: [["Enter"]], descKey: "shortcuts.item.commitField" },
      { keys: [["Esc"]], descKey: "shortcuts.item.leaveField" },
    ],
  },
  {
    titleKey: "shortcuts.group.charts",
    category: "app",
    scope: ["chart"],
    items: [
      { keys: [["1"], ["9"]], sep: "range", descKey: "shortcuts.item.chartKind" },
      { keys: [[CHART_KEY.ancestors.toUpperCase()], [CHART_KEY.descendants.toUpperCase()]], descKey: "shortcuts.item.chartDirection" },
      { keys: [["+"], ["−"]], descKey: "shortcuts.item.chartZoom" },
      { keys: [[CHART_KEY.zoomReset]], descKey: "shortcuts.item.chartZoomReset" },
      { keys: [[CHART_KEY.fit.toUpperCase()]], descKey: "shortcuts.item.chartFit" },
      { keys: [[CHART_KEY.home.toUpperCase()]], descKey: "shortcuts.item.chartHome" },
      { keys: [[CHART_KEY.edit.toUpperCase()]], descKey: "shortcuts.item.chartEdit" },
      { keys: [["Tab"], ["Enter"]], descKey: "shortcuts.item.chartNode" },
    ],
  },
];

/** A ⌘/Ctrl chord as it reads on this platform: "⌘S" on a Mac, "Ctrl+S" elsewhere. */
export function modLabel(key: string): string {
  return isMacKeyboard() ? `⌘${key}` : `Ctrl+${key}`;
}

/** The ⌘⇧/Ctrl+Shift chord, likewise. */
export function modShiftLabel(key: string): string {
  return isMacKeyboard() ? `⌘⇧${key}` : `Ctrl+Shift+${key}`;
}

/** A tooltip with its shortcut after it: "Undo last change (⌘Z)". One
 *  helper, so no tooltip spells a key by hand — or for the wrong platform. */
export function keyHint(label: string, key: string): string {
  return `${label} (${key})`;
}

/** Render "mod" for the current platform; pass other tokens through unchanged. */
export function renderKeyToken(token: string): string {
  if (token === "alt") return isMacKeyboard() ? "⌥" : "Alt";
  if (token === "shift") return isMacKeyboard() ? "⇧" : "Shift";
  if (token === "mod") return isMacKeyboard() ? "⌘" : "Ctrl";
  return token;
}

function isMacKeyboard(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** The ⌥⇧ combination as it reads on this platform: the glyphs run together on
 *  a Mac ("⌥⇧1"), the words need joining anywhere else ("Alt+Shift+1"). */
export function altShiftLabel(key: string): string {
  return isMacKeyboard() ? `⌥⇧${key}` : `Alt+Shift+${key}`;
}
