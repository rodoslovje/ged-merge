import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Mode } from "./useMode";
import type { ChartKind } from "./ChartSettingsContext";
import type { TreeMode } from "../chart/personTree";
import { markFreshStart } from "../persist/idb";

/** Which candidate pair the full-page compare tree is showing, and how. */
export interface TreeView {
  mainId: string;
  compareId: string;
  mode: TreeMode;
}

/** A compare selection remembered in browser history (for the Back button). */
interface SelRef {
  mainId: string;
  compareId: string;
}

export interface AppHistoryOptions {
  /** App-styled confirm dialog (stable) — the Back-button leave guard uses it. */
  confirmDialog: (message: string, confirmLabel: string, onConfirmAction?: () => void) => Promise<boolean>;
  /** Merge's currently selected candidate, remembered into history entries. */
  current: SelRef | null | undefined;
  mode: Mode;
  setMode: (mode: Mode) => void;
  setSelectedId: (sel: SelRef) => void;
  setNavigateToId: (id: string) => void;
  /** Hand Edit the person a Back/Forward press restored (see EditView's
   *  `historyToId`), as opposed to a fresh navigation. */
  setHistoryPersonId: (id: string) => void;
  /** False when the id no longer names a record — a history entry for a person
   *  since deleted (or absorbed by a merge) is skipped rather than opened. */
  hasPerson: (id: string) => boolean;
  setChartKind: (kind: ChartKind) => void;
}

/**
 * The browser-history/overlay state machine: the full-page Compare-Tree and
 * Charts-hub overlays, the popstate handler that keeps them (and the mode /
 * selection / navigation recorded on each entry) in sync with the Back button,
 * and the leave guards (the history "leave-guard" entry plus beforeunload)
 * that intercept leaving the app with unsaved changes.
 */
export function useAppHistory(opts: AppHistoryOptions) {
  const { t } = useTranslation();
  // Latest inputs for the mount-only popstate/beforeunload handlers, so they
  // never act through a stale closure.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const tRef = useRef(t);
  tRef.current = t;

  // Full-page "Compare tree" view, kept in sync with browser history so the
  // back button returns to the main view.
  const [treeView, setTreeView] = useState<TreeView | null>(null);
  // Charts hub: the full-page per-person diagram overlay (pedigree charts +
  // relationship). Which diagram it shows is the persisted chart "kind".
  const [chartsRootId, setChartsRootId] = useState<string | null>(null);
  // i18n key for where the hub's Back lands (the history entry beneath the
  // hub's): the previous chart on a re-root, the Compare Tree, or the mode view.
  const [chartsBackKey, setChartsBackKey] = useState("edit.tree.back");

  // Tracks whether there are unsaved changes — assigned by App each render so
  // the stable popstate/beforeunload handlers can check without stale-closure
  // issues.
  const hasUnsavedChangesRef = useRef(false);
  // Set right before an intentional reload so the beforeunload handler skips
  // the browser's native "leave page?" prompt after an in-app confirmation.
  const skipUnloadWarnRef = useRef(false);
  // Holds the currently-registered beforeunload handler so an intentional
  // reload can detach it synchronously before navigating.
  const beforeUnloadRef = useRef<((e: BeforeUnloadEvent) => void) | null>(null);

  // The person the *current* history entry stands for, so opening someone else
  // in Edit knows whether it is a new step (push an entry) or the app catching
  // up with the entry the Back button just restored (record nothing). Kept as
  // the recorded id rather than a "restoring" flag: a restore that lands on the
  // person already open leaves no flag behind to go stale.
  const editEntryPersonRef = useRef<string | undefined>(undefined);
  // Whether any entry has recorded a person yet. The first person the app opens
  // belongs on the entry already there — pushing for it would leave an entry
  // that names nobody, and Back to it would appear to do nothing.
  const editEntryStartedRef = useRef(false);
  // The people Back/Forward presses have asked Edit to show and that Edit has
  // not answered yet, oldest first. A press is not a navigation, so the person
  // change it causes must record no entry — and presses come faster than Edit
  // answers them, which is why the id of the entry we are on is not enough to
  // tell the two apart: hold ⌫ and the second press lands while the first
  // person is still on the way, so that person read as a fresh navigation and
  // was pushed as a new entry, over the very entries being walked back to.
  const restoringRef = useRef<string[]>([]);

  // True while a full-page overlay covers the mode views — mode switching (and
  // the hidden views' own bare-key handlers, via their `active` props) must not
  // act on the app underneath. A ref so mount-only key handlers can read it.
  const overlayOpenRef = useRef(false);
  overlayOpenRef.current = !!(treeView || chartsRootId);
  const overlayOpen = overlayOpenRef.current;

  // Whether there is a step of the app's own beneath this one — a person opened
  // before, the Tools tab a person was opened from, the chart behind an
  // overlay. False on the app's bottom entry, under which lies only the
  // leave-guard: Back there leaves the app, so the views' own Back must not
  // offer it. Every entry we push carries no `gedPage`, so the answer is
  // written on the entry itself and survives a Forward press as readily as a
  // Back one.
  const [canGoBack, setCanGoBack] = useState(false);
  const canGoBackRef = useRef(false);
  canGoBackRef.current = canGoBack;

  /** Push one history entry of the app's own, and remember that Back now has
   *  somewhere in-app to go. Every push but the leave-guard's own goes through
   *  here, so no navigation can leave the Back controls saying otherwise. */
  function pushEntry(state: Record<string, unknown>) {
    window.history.pushState(state, "");
    setCanGoBack(true);
  }

  useEffect(() => {
    // Keep a throwaway "leave-guard" entry beneath the app's main entry. The
    // browser Back button then lands on a same-document popstate we can intercept
    // with our own confirmation dialog, instead of the un-stylable native
    // beforeunload prompt. Set up once; a remount keeps the existing entries.
    if (window.history.state?.gedPage !== "main") {
      window.history.replaceState({ ...window.history.state, gedPage: "leave-guard" }, "");
      window.history.pushState({ gedPage: "main" }, "");
    }

    function onPop(e: PopStateEvent) {
      const st = (e.state ?? {}) as {
        gedPage?: string; gedTree?: TreeView; gedSel?: SelRef;
        gedChartsId?: string; gedChartsBack?: string;
        gedEditTreeId?: string; gedRelId?: string;
        gedMode?: Mode; gedNavigateTo?: string; gedEditPerson?: string;
      };
      // Landing on the leave-guard = the user pressed Back from the app's main
      // entry and is about to leave the app. Intercept it.
      if (st.gedPage === "leave-guard") {
        if (hasUnsavedChangesRef.current) {
          // Re-push main so we stay on the app, then confirm asynchronously.
          window.history.pushState({ gedPage: "main" }, "");
          optsRef.current.confirmDialog(tRef.current("app.navLeaveConfirm"), tRef.current("confirm.leave")).then((ok) => {
            if (ok) {
              // Already confirmed in-app — skip the native beforeunload prompt,
              // then navigate past the re-pushed main and the guard to leave.
              skipUnloadWarnRef.current = true;
              window.history.go(-2);
            }
          });
        } else {
          // No unsaved changes: continue past the guard to the previous page.
          window.history.back();
        }
        return;
      }
      // Wherever this press landed, the entry itself says whether anything of
      // ours is left beneath it.
      setCanGoBack(st.gedPage !== "main");
      setTreeView(st.gedTree ?? null);
      // gedEditTreeId / gedRelId are the pre-hub entry keys; restored session
      // history can still carry them, so they map onto the hub too.
      setChartsRootId(st.gedChartsId ?? st.gedEditTreeId ?? st.gedRelId ?? null);
      // Each charts entry records where its Back returns to (set at push time),
      // so forward/back through several chart entries keeps the label honest.
      setChartsBackKey(st.gedChartsBack ?? "edit.tree.back");
      // Restore the mode recorded for this entry (e.g. returning to the Tools tab
      // after opening a person from it). Absent on older/plain entries, in which
      // case the current mode is left untouched.
      if (st.gedMode) optsRef.current.setMode(st.gedMode);
      if (st.gedNavigateTo) optsRef.current.setNavigateToId(st.gedNavigateTo);
      // The person this entry stands for in Edit. Walking back through the
      // people opened one after another is what the Back button *should* do, so
      // the leave prompt only arrives once there is nothing left to go back to.
      if (st.gedEditPerson) {
        if (!optsRef.current.hasPerson(st.gedEditPerson)) {
          // The record is gone (deleted, or absorbed by a duplicate merge) —
          // this entry has nothing to open, so keep going the way we were.
          window.history.back();
          return;
        }
        editEntryPersonRef.current = st.gedEditPerson;
        restoringRef.current.push(st.gedEditPerson);
        optsRef.current.setHistoryPersonId(st.gedEditPerson);
      }
      // Restore a remembered compare selection (set when a person link pushed it).
      if (st.gedSel) {
        const { mainId, compareId } = st.gedSel;
        optsRef.current.setSelectedId({ mainId, compareId });
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Warn before leaving the page when there are unsaved changes. Registered once
  // on mount and reads refs so it always reflects the current state without
  // re-subscribing. The handler is kept in a ref so an intentional in-app reload
  // can detach it synchronously before navigating — some browsers (e.g. Firefox)
  // abort a programmatic reload while a beforeunload listener is attached.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (skipUnloadWarnRef.current || !hasUnsavedChangesRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    }
    beforeUnloadRef.current = onBeforeUnload;
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      beforeUnloadRef.current = null;
    };
  }, []);

  /** Drop the unsaved-changes guard and reload to the landing page. The cached
   *  workspace is marked for clearing (consumed on the next boot, see
   *  markFreshStart) so the reload shows the loader instead of restoring the
   *  session. Runs synchronously inside the dialog button's click handler so
   *  the reload keeps the user's activation — Firefox blocks a programmatic
   *  reload that fires from an async continuation. */
  function discardAndReload() {
    skipUnloadWarnRef.current = true;
    if (beforeUnloadRef.current) {
      window.removeEventListener("beforeunload", beforeUnloadRef.current);
      beforeUnloadRef.current = null;
    }
    markFreshStart();
    window.location.reload();
  }

  /**
   * Record the person Edit has just opened as a browser-history step, so the
   * browser Back button walks back through the people the user opened — the
   * same path Edit's own Back button takes — instead of going straight to the
   * "leave the page?" guard. Called on every change of the edited person, so
   * it ignores the ones that are the app *following* history rather than
   * making it: the restore a Back press triggered, and re-opening whoever the
   * current entry already stands for.
   */
  function recordEditPerson(id: string) {
    // Someone a Back/Forward press asked for: they already have an entry — this
    // is the app arriving on it, not leaving for somewhere new. Everything
    // asked for before them is answered too, whether Edit reported those people
    // one by one or went straight to the last of them.
    const restoring = restoringRef.current.indexOf(id);
    if (restoring >= 0) {
      restoringRef.current.splice(0, restoring + 1);
      editEntryPersonRef.current = id;
      return;
    }
    if (id === editEntryPersonRef.current) return;
    // A navigation of the reader's own, so any press still unanswered is past.
    restoringRef.current = [];
    editEntryPersonRef.current = id;
    if (!editEntryStartedRef.current) {
      // First person of the session: name them on the entry we're already on.
      editEntryStartedRef.current = true;
      window.history.replaceState({ ...window.history.state, gedEditPerson: id }, "");
      return;
    }
    // Note which view the entry we're leaving shows, unless it says already —
    // a caller that pushes its own entry (Tools) has recorded the truer answer,
    // since by now the mode has flipped to Edit.
    if (!window.history.state?.gedMode) {
      window.history.replaceState({ ...window.history.state, gedMode: optsRef.current.mode }, "");
    }
    pushEntry({ gedMode: "edit", gedEditPerson: id });
  }

  /** Tell the history state machine that an entry a caller pushed itself
   *  already stands for this person, so opening them isn't recorded twice. */
  function markEditEntry(id: string) {
    editEntryPersonRef.current = id;
    editEntryStartedRef.current = true;
  }

  /**
   * Leave whichever overlay is open straight into Edit on this person.
   *
   * Not a history.back(): Back is asynchronous, and its popstate lands on the
   * entry underneath the overlay's — which names the person Edit showed
   * *before* the overlay opened, so restoring it re-opened that person over
   * the one just clicked. The person is pushed as an entry of their own on
   * top of the overlay's instead: no traversal, no popstate, no race — and
   * the Back button returns into the chart the person was opened from, the
   * way Back undoes every other navigation here.
   */
  function navigateFromOverlay(id: string) {
    pushEntry({ gedMode: "edit", gedEditPerson: id });
    markEditEntry(id);
    setTreeView(null);
    setChartsRootId(null);
    opts.setNavigateToId(id);
    opts.setMode("edit");
  }

  /**
   * Open a person in Edit from another page of the app — a Tools list, where
   * the people behind a place, a duplicate or a finding are named.
   *
   * The page being left is written onto the entry it stands for and the person
   * pushed on top, so Back returns to that page rather than to whoever Edit
   * happened to be showing before it. Recorded here rather than left to Edit's
   * own person step, which runs once the mode has already flipped and so can no
   * longer tell which page the person was opened from.
   */
  function navigateFromPage(id: string) {
    window.history.replaceState({ ...window.history.state, gedMode: optsRef.current.mode }, "");
    markEditEntry(id);
    pushEntry({ gedMode: "edit", gedEditPerson: id });
    opts.setNavigateToId(id);
    opts.setMode("edit");
  }

  /**
   * One step back through the pages the app has been on, in the order it was on
   * them — the browser's own Back, which is the only record of that order: the
   * person opened before this one, the Tools tab a person was opened from, the
   * chart behind an overlay.
   *
   * The views' own Back controls go through this rather than walking a trail of
   * their own. Edit kept one, and it knew only about people: opened from a
   * Tools list, its Back stepped to whoever Edit had been showing an hour
   * earlier while the list the reader had actually come from sat one browser
   * step away, unreachable from inside the view.
   *
   * Refused on the app's bottom entry, where the next step back leaves the app
   * altogether: that is the browser's own Back button's business, not a
   * button's inside a view.
   */
  function goBackPage() {
    if (!canGoBackRef.current) return;
    window.history.back();
  }

  /** Record the current compare selection in the current history entry so the
   *  browser Back button returns here after a person-link or tree push. */
  function rememberSelection() {
    const { current } = opts;
    if (current) window.history.replaceState({ gedSel: { mainId: current.mainId, compareId: current.compareId } }, "");
  }

  function openTree(mainId: string, compareId: string) {
    rememberSelection();
    const view: TreeView = { mainId, compareId, mode: "ancestors" };
    pushEntry({ gedTree: view });
    setTreeView(view);
    setChartsRootId(null); // overlays are exclusive (see openCharts)
  }

  /** Re-root the open tree on another person, as a new history entry. */
  function rerootTree(mainId?: string, compareId?: string) {
    if (!mainId && !compareId) return;
    setTreeView((cur) => {
      const view: TreeView = { mainId: mainId ?? "", compareId: compareId ?? "", mode: cur?.mode ?? "ancestors" };
      pushEntry({ gedTree: view });
      return view;
    });
  }

  /** Leave the open tree and select this pair back in the Matches list. Pushes a
   *  fresh matches entry so the browser Back button returns to the tree. */
  function showInMatches(mainId: string, compareId: string) {
    pushEntry({ gedSel: { mainId, compareId } });
    opts.setSelectedId({ mainId, compareId });
    setTreeView(null);
  }

  function changeTreeMode(mode: TreeMode) {
    setTreeView((cur) => {
      if (!cur) return cur;
      const next = { ...cur, mode };
      window.history.replaceState({ gedTree: next }, "");
      return next;
    });
  }

  /** Open the Charts hub on a person — at the last-used kind, or a specific one.
   *  Also how the open hub re-roots: each person is its own history entry, so
   *  Back returns to the chart the user came from. */
  function openCharts(id: string, kind?: ChartKind) {
    // Re-rooting on the person already drawn (clicking the root node, picking
    // the current target) is not a navigation — don't stack an entry for it.
    if (id === chartsRootId && !kind) return;
    if (kind) opts.setChartKind(kind);
    const backKey = chartsRootId
      ? "edit.back" // re-root on top of an open chart: Back = the previous chart
      : treeView
        ? "charts.back.tree"
        : opts.mode === "merge"
          ? "charts.back.merge"
          : opts.mode === "tools"
            ? "charts.back.tools"
            : "edit.tree.back";
    pushEntry({ gedChartsId: id, gedChartsBack: backKey });
    setChartsBackKey(backKey);
    setChartsRootId(id);
    // The overlays are exclusive; opened from inside the Compare Tree, the hub
    // replaces it on screen and the browser Back button returns to the tree.
    setTreeView(null);
  }

  return {
    treeView,
    chartsRootId,
    setChartsRootId,
    chartsBackKey,
    overlayOpen,
    overlayOpenRef,
    hasUnsavedChangesRef,
    openTree,
    rerootTree,
    showInMatches,
    changeTreeMode,
    openCharts,
    discardAndReload,
    recordEditPerson,
    navigateFromOverlay,
    navigateFromPage,
    canGoBack,
    goBackPage,
  };
}
