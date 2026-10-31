import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, type RenderedHook } from "../testing/fakeReact";
import type { AppHistoryOptions } from "./useAppHistory";
import type { Mode } from "./useMode";

vi.mock("react", () => import("../testing/fakeReact"));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

/**
 * The browser-history state machine behind Back: the leave-guard under the
 * app's bottom entry, one entry per page or person, the overlays' trails kept
 * inside their one entry. Driven against a fake `window.history` whose
 * traversals fire `popstate` synchronously, and an "app" whose setters feed
 * the hook its next props, as App does.
 */

type Listener = (e: unknown) => void;

class FakeHistory {
  entries: unknown[] = [null];
  idx = 0;
  /** Set when a traversal went past the first entry — the user left the app. */
  left = false;
  constructor(private fire: (type: string, e: unknown) => void) {}
  get state() {
    return this.entries[this.idx];
  }
  pushState(state: unknown) {
    this.entries.splice(this.idx + 1);
    this.entries.push(structuredClone(state));
    this.idx++;
  }
  replaceState(state: unknown) {
    this.entries[this.idx] = structuredClone(state);
  }
  go(n: number) {
    const next = this.idx + n;
    if (next < 0) {
      this.left = true;
      return;
    }
    if (next >= this.entries.length) return;
    this.idx = next;
    this.fire("popstate", { state: this.state });
  }
  back() {
    this.go(-1);
  }
}

let history: FakeHistory;
let listeners: Map<string, Set<Listener>>;
let reload: ReturnType<typeof vi.fn>;
let storage: Map<string, string>;

beforeEach(() => {
  listeners = new Map();
  const fire = (type: string, e: unknown) => listeners.get(type)?.forEach((l) => l(e));
  history = new FakeHistory(fire);
  reload = vi.fn();
  storage = new Map();
  vi.stubGlobal("window", {
    history,
    location: { reload },
    addEventListener: (type: string, l: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(l);
    },
    removeEventListener: (type: string, l: Listener) => listeners.get(type)?.delete(l),
  });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
});

type Hist = ReturnType<typeof import("./useAppHistory").useAppHistory>;

interface App {
  mode: Mode;
  tool: string;
  toolView: string;
  current?: { mainId: string; compareId: string } | null;
  editPersonId?: string;
  gone: Set<string>;
  navigateTo: string[];
  historyPerson: string[];
  selected: { mainId: string; compareId: string }[];
  chartKind: string[];
  confirm: ReturnType<typeof vi.fn>;
  h: RenderedHook<Hist, AppHistoryOptions>;
  /** Re-render with the props App would now pass. */
  render: () => void;
  /** The hook's latest return value. */
  readonly api: Hist;
}

async function mount(over: Partial<Pick<App, "mode" | "tool" | "toolView" | "current" | "editPersonId">> = {}): Promise<App> {
  const { useAppHistory } = await import("./useAppHistory");
  const app = {
    mode: "edit" as Mode,
    tool: "validate",
    toolView: "list",
    current: null,
    editPersonId: undefined,
    gone: new Set<string>(),
    navigateTo: [] as string[],
    historyPerson: [] as string[],
    selected: [] as { mainId: string; compareId: string }[],
    chartKind: [] as string[],
    confirm: vi.fn(async () => true),
    ...over,
  } as unknown as App;
  const props = (): AppHistoryOptions => ({
    confirmDialog: app.confirm as unknown as AppHistoryOptions["confirmDialog"],
    current: app.current,
    editPersonId: app.editPersonId,
    mode: app.mode,
    tool: app.tool,
    toolView: app.toolView,
    setTool: (tool) => { app.tool = tool; app.h?.rerender(props()); },
    setToolView: (view) => { app.toolView = view; app.h?.rerender(props()); },
    setMode: (mode) => { app.mode = mode; app.h?.rerender(props()); },
    setSelectedId: (sel) => { app.selected.push(sel); app.current = sel; app.h?.rerender(props()); },
    setNavigateToId: (id) => app.navigateTo.push(id),
    setHistoryPersonId: (id) => app.historyPerson.push(id),
    hasPerson: (id) => !app.gone.has(id),
    setChartKind: (kind) => app.chartKind.push(kind),
  });
  app.h = renderHook((p: AppHistoryOptions) => useAppHistory(p), props());
  app.render = () => app.h.rerender(props());
  Object.defineProperty(app, "api", { get: () => app.h.result.current });
  return app;
}

const stateAt = (i = history.idx) => history.entries[i] as Record<string, unknown>;

describe("useAppHistory: entries and Back", () => {
  it("sets a leave-guard under the app's bottom entry, which names the page on screen", async () => {
    const app = await mount();
    expect(history.entries).toHaveLength(2);
    expect(stateAt(0)).toMatchObject({ gedPage: "leave-guard" });
    expect(stateAt(1)).toMatchObject({ gedPage: "main", gedMode: "edit", gedTool: "validate", gedToolView: "list" });
    expect(app.api.canGoBack).toBe(false);
  });

  it("keeps the existing entries on a remount", async () => {
    (await mount()).h.unmount();
    await mount();
    expect(history.entries).toHaveLength(2);
  });

  it("a page step pushes one entry; Back restores the mode, tool and page it left", async () => {
    const app = await mount();
    app.api.goToPage({ mode: "tools", tool: "places", toolView: "tree" });
    expect([app.mode, app.tool, app.toolView]).toEqual(["tools", "places", "tree"]);
    expect(history.entries).toHaveLength(3);
    expect(app.api.canGoBack).toBe(true);
    // The page already on screen is not a step.
    app.api.goToPage({ tool: "places" });
    expect(history.entries).toHaveLength(3);
    app.api.goBackPage();
    expect([app.mode, app.tool, app.toolView]).toEqual(["edit", "validate", "list"]);
    expect(app.api.canGoBack).toBe(false);
    // On the bottom entry a view's own Back does nothing.
    app.api.goBackPage();
    expect(history.idx).toBe(1);
    expect(history.left).toBe(false);
  });

  it("a view change that is not a navigation rewrites the entry it stands on", async () => {
    const app = await mount();
    app.mode = "merge";
    app.render();
    expect(history.entries).toHaveLength(2);
    expect(stateAt()).toMatchObject({ gedPage: "main", gedMode: "merge" });
  });

  it("walks back through the people Edit opened, one entry each", async () => {
    const app = await mount();
    app.api.recordEditPerson("@I1@"); // the first person names the bottom entry
    expect(history.entries).toHaveLength(2);
    app.api.recordEditPerson("@I2@");
    app.api.recordEditPerson("@I2@"); // the person already on the entry: no step
    app.api.recordEditPerson("@I3@");
    expect(history.entries).toHaveLength(4);
    history.back();
    expect(app.historyPerson).toEqual(["@I2@"]);
    // Edit arriving on the restored person is not a new step.
    app.api.recordEditPerson("@I2@", true);
    expect(history.entries).toHaveLength(4);
    history.back();
    expect(app.historyPerson).toEqual(["@I2@", "@I1@"]);
    expect(app.api.canGoBack).toBe(false);
  });

  it("skips an entry whose person no longer exists", async () => {
    const app = await mount();
    for (const id of ["@I1@", "@I2@", "@I3@"]) app.api.recordEditPerson(id);
    app.gone.add("@I2@");
    history.back();
    expect(history.idx).toBe(1);
    expect(app.historyPerson).toEqual(["@I1@"]);
  });

  it("a person Edit follows in the background is noted, not pushed", async () => {
    const app = await mount({ mode: "tools" });
    app.api.recordEditPerson("@I1@");
    app.api.recordEditPerson("@I2@");
    expect(history.entries).toHaveLength(2);
    expect(stateAt()).toMatchObject({ gedEditPerson: "@I2@" });
  });

  it("a person opened from a Tools list is a step of its own; Back returns to the list", async () => {
    const app = await mount({ mode: "tools", tool: "places" });
    app.api.navigateFromPage("@I5@");
    expect(app.mode).toBe("edit");
    expect(app.navigateTo).toEqual(["@I5@"]);
    // Edit's own report of the person it opened adds nothing.
    app.api.recordEditPerson("@I5@");
    expect(history.entries).toHaveLength(3);
    history.back();
    expect([app.mode, app.tool]).toEqual(["tools", "places"]);
  });

  it("recordEditPerson pushes after the first person, noting the mode it leaves", async () => {
    const app = await mount();
    app.api.recordEditPerson("@I1@");
    history.replaceState({ gedPage: "main" }); // an entry written before modes were recorded
    app.api.recordEditPerson("@I2@");
    expect(stateAt(1)).toEqual({ gedPage: "main", gedMode: "edit" });
    expect(stateAt(2)).toMatchObject({ gedMode: "edit", gedEditPerson: "@I2@" });
    expect(stateAt(2).gedPage).toBeUndefined();
  });

  it("a pair followed in Merge is a step; Back selects the pair it was followed from", async () => {
    const app = await mount({ mode: "merge", current: { mainId: "@I1@", compareId: "@X1@" } });
    app.api.selectFromPage({ mainId: "@I2@", compareId: "@X2@" });
    expect(stateAt(1)).toMatchObject({ gedSel: { mainId: "@I1@", compareId: "@X1@" } });
    history.back();
    expect(app.selected.at(-1)).toEqual({ mainId: "@I1@", compareId: "@X1@" });
  });

  it("a decision on a followed pair returns to the pair it was followed from", async () => {
    const app = await mount({ mode: "merge", current: { mainId: "@I1@", compareId: "@X1@" } });
    expect(app.api.returnFromFollowed({ mainId: "@I1@", compareId: "@X1@" })).toBe(false);
    app.api.selectFromPage({ mainId: "@I2@", compareId: "@X2@" });
    // Walked on in the list since: the pair on screen is not the followed one.
    expect(app.api.returnFromFollowed({ mainId: "@I3@", compareId: "@X3@" })).toBe(false);
    expect(app.api.returnFromFollowed({ mainId: "@I2@", compareId: "@X2@" })).toBe(true);
    expect(app.selected.at(-1)).toEqual({ mainId: "@I1@", compareId: "@X1@" });
  });

  it("the followed mark stays on its own entry, not on steps taken from it", async () => {
    const app = await mount({ mode: "merge", current: { mainId: "@I1@", compareId: "@X1@" } });
    app.api.selectFromPage({ mainId: "@I2@", compareId: "@X2@" });
    app.api.goToPage({ mode: "edit" });
    expect((history.state as { gedSelFollowed?: boolean }).gedSelFollowed).toBeUndefined();
  });
});

describe("useAppHistory: the leave guard", () => {
  it("leaves straight away when nothing is unsaved", async () => {
    await mount();
    history.back();
    expect(history.left).toBe(true);
  });

  it("asks first when there are unsaved changes, and stays when declined", async () => {
    const app = await mount();
    app.api.hasUnsavedChangesRef.current = true;
    app.confirm.mockResolvedValueOnce(false);
    history.back();
    expect(app.confirm).toHaveBeenCalledWith("app.navLeaveConfirm", "confirm.leave");
    await Promise.resolve();
    expect(history.left).toBe(false);
    expect(stateAt()).toMatchObject({ gedPage: "main" });
  });

  it("leaves without the browser's own prompt once confirmed", async () => {
    const app = await mount();
    app.api.hasUnsavedChangesRef.current = true;
    history.back();
    await Promise.resolve();
    await Promise.resolve();
    expect(history.left).toBe(true);
    const e = { preventDefault: vi.fn(), returnValue: "x" };
    listeners.get("beforeunload")!.forEach((l) => l(e));
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("beforeunload warns only with unsaved changes", async () => {
    const app = await mount();
    const fire = () => {
      const e = { preventDefault: vi.fn(), returnValue: "x" };
      listeners.get("beforeunload")!.forEach((l) => l(e));
      return e;
    };
    expect(fire().preventDefault).not.toHaveBeenCalled();
    app.api.hasUnsavedChangesRef.current = true;
    const e = fire();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.returnValue).toBe("");
  });

  it("discardAndReload marks a fresh start and reloads without the guard", async () => {
    const app = await mount();
    app.api.hasUnsavedChangesRef.current = true;
    app.api.discardAndReload();
    expect(storage.get("gedmerge.fresh-start")).toBe("1");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(listeners.get("beforeunload")!.size).toBe(0);
  });

  it("unmounting detaches its listeners", async () => {
    const app = await mount();
    app.h.unmount();
    expect(listeners.get("popstate")!.size).toBe(0);
    expect(listeners.get("beforeunload")!.size).toBe(0);
  });
});

describe("useAppHistory: overlays", () => {
  it("the Charts hub is one entry: re-roots join its trail, and Back leaves in one press", async () => {
    const app = await mount({ editPersonId: "@I0@" });
    app.api.openCharts("@I1@", "fan" as never);
    expect(app.chartKind).toEqual(["fan"]);
    expect(app.api.chartsRootId).toBe("@I1@");
    expect(app.api.chartsBackKey).toBe("edit.tree.back");
    expect(app.api.chartsFromId).toBe("@I0@");
    expect(app.api.overlayOpen).toBe(true);
    const entries = history.entries.length;
    app.api.openCharts("@I2@");
    app.api.openCharts("@I2@"); // the person already drawn
    app.api.openCharts("@I3@");
    expect(history.entries).toHaveLength(entries);
    expect(app.api.chartsTrail).toEqual({ ids: ["@I1@", "@I2@", "@I3@"], idx: 2 });
    app.api.stepChartsTrail(0);
    app.api.stepChartsTrail(9); // out of range
    expect(app.api.chartsRootId).toBe("@I1@");
    // A new person drops the ones stepped back past.
    app.api.openCharts("@I4@");
    expect(app.api.chartsTrail).toEqual({ ids: ["@I1@", "@I4@"], idx: 1 });
    history.back();
    expect(app.api.chartsRootId).toBeNull();
    expect(app.api.overlayOpen).toBe(false);
  });

  it("the hub's trail remembers ten people", async () => {
    const app = await mount();
    for (let n = 1; n <= 12; n++) app.api.openCharts(`@I${n}@`);
    expect(app.api.chartsTrail.ids).toHaveLength(10);
    expect(app.api.chartsTrail.ids[0]).toBe("@I3@");
    // Someone already on the trail moves to its end.
    app.api.openCharts("@I5@");
    expect(app.api.chartsTrail.ids.slice(-2)).toEqual(["@I12@", "@I5@"]);
  });

  it("Forward back onto the hub restores its trail and where its Back goes", async () => {
    const app = await mount({ mode: "tools" });
    app.api.openCharts("@I1@");
    app.api.openCharts("@I2@");
    expect(app.api.chartsBackKey).toBe("charts.back.tools");
    history.back();
    history.go(1);
    expect(app.api.chartsRootId).toBe("@I2@");
    expect(app.api.chartsTrail).toEqual({ ids: ["@I1@", "@I2@"], idx: 1 });
    expect(app.api.chartsBackKey).toBe("charts.back.tools");
  });

  it("names Merge's pair as the hub's origin", async () => {
    const app = await mount({ mode: "merge", current: { mainId: "@I7@", compareId: "@X7@" } });
    app.api.openCharts("@I1@");
    expect([app.api.chartsBackKey, app.api.chartsFromId]).toEqual(["charts.back.merge", "@I7@"]);
  });

  it("the Compare Tree: one entry, re-roots on its trail, mode kept, Back leaves it", async () => {
    const app = await mount({ mode: "merge", current: { mainId: "@I1@", compareId: "@X1@" } });
    app.api.openTree("@I1@", "@X1@");
    expect(app.api.treeView).toEqual({ mainId: "@I1@", compareId: "@X1@", mode: "ancestors" });
    const entries = history.entries.length;
    app.api.changeTreeMode("descendants" as never);
    app.api.rerootTree("@I2@", "@X2@");
    app.api.rerootTree("@I2@", "@X2@"); // already the root
    app.api.rerootTree(); // nobody
    app.api.rerootTree(undefined, "@X3@");
    expect(history.entries).toHaveLength(entries);
    expect(app.api.treeView).toEqual({ mainId: "", compareId: "@X3@", mode: "descendants" });
    expect(app.api.treeTrail.items).toHaveLength(3);
    app.api.stepTreeTrail(0);
    app.api.stepTreeTrail(-1);
    expect(app.api.treeView).toMatchObject({ mainId: "@I1@", compareId: "@X1@" });
    expect(stateAt()).toMatchObject({ gedTree: { mainId: "@I1@", mode: "descendants" } });
    history.back();
    expect(app.api.treeView).toBeNull();
    history.go(1);
    expect(app.api.treeView).toMatchObject({ mainId: "@I1@", mode: "descendants" });
  });

  it("an entry restored with only a tree rebuilds a one-pair trail", async () => {
    const app = await mount();
    history.pushState({ gedTree: { mainId: "@I1@", compareId: "@X1@", mode: "ancestors" } });
    history.pushState({});
    history.back();
    expect(app.api.treeTrail).toEqual({ items: [{ mainId: "@I1@", compareId: "@X1@" }], idx: 0 });
    // A pre-hub entry key still opens the hub.
    history.replaceState({ gedEditTreeId: "@I4@" });
    history.go(1);
    history.back();
    expect(app.api.chartsRootId).toBe("@I4@");
    expect(app.api.chartsTrail).toEqual({ ids: ["@I4@"], idx: 0 });
  });

  it("the hub opened from the tree replaces it, and Back returns to the tree", async () => {
    const app = await mount({ mode: "merge" });
    app.api.openTree("@I1@", "@X1@");
    app.api.openCharts("@I1@");
    expect(app.api.treeView).toBeNull();
    expect([app.api.chartsBackKey, app.api.chartsFromId]).toEqual(["charts.back.tree", undefined]);
    history.back();
    expect(app.api.chartsRootId).toBeNull();
    expect(app.api.treeView).toMatchObject({ mainId: "@I1@" });
  });

  it("showInMatches leaves the tree for the pair, as a step", async () => {
    const app = await mount({ mode: "merge" });
    app.api.openTree("@I1@", "@X1@");
    app.api.showInMatches("@I2@", "@X2@");
    expect(app.api.treeView).toBeNull();
    expect(app.selected.at(-1)).toEqual({ mainId: "@I2@", compareId: "@X2@" });
    history.back();
    expect(app.api.treeView).toMatchObject({ mainId: "@I1@" });
  });

  it("opening a person from an overlay closes it on a new entry; Back returns to the chart", async () => {
    const app = await mount({ mode: "merge" });
    app.api.openCharts("@I1@");
    app.api.navigateFromOverlay("@I9@");
    expect(app.api.chartsRootId).toBeNull();
    expect(app.mode).toBe("edit");
    expect(app.navigateTo).toEqual(["@I9@"]);
    app.api.recordEditPerson("@I9@"); // already recorded by the push
    history.back();
    expect(app.api.chartsRootId).toBe("@I1@");
    expect(app.mode).toBe("merge");
  });

  it("a page opened from an overlay closes it; Back returns to the chart", async () => {
    const app = await mount();
    app.api.openCharts("@I1@");
    app.api.goToPageFromOverlay({ mode: "tools", tool: "geocode" });
    expect([app.mode, app.tool, app.toolView]).toEqual(["tools", "geocode", "list"]);
    expect(app.api.chartsRootId).toBeNull();
    history.back();
    expect(app.api.chartsRootId).toBe("@I1@");
    expect(app.mode).toBe("edit");
  });
});
