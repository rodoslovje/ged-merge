/**
 * A stand-in for React's hook runtime, for unit-testing the app's hooks in the
 * plain Node test environment (there is no DOM and no test renderer in the
 * repo). A test swaps it in for the real module:
 *
 *   vi.mock("react", () => import("../testing/fakeReact"));
 *
 * and drives the hook through {@link renderHook}. Only what the hooks under
 * test use is implemented — state, reducers, refs, memo/callback and effects
 * with React's dependency semantics, in call order like the real thing. A
 * state update outside a render re-renders at once; one made while rendering
 * or running effects re-renders when that pass is done. Effects run after
 * every render whose dependencies changed, cleanups before the next run and
 * on unmount.
 */

interface Slot {
  value: unknown;
  deps?: readonly unknown[];
  setter?: (update: unknown) => void;
  cleanup?: () => void;
}

interface Instance {
  slots: Slot[];
  idx: number;
  effects: (() => void)[];
  busy: boolean;
  dirty: boolean;
  mounted: boolean;
  render: () => void;
}

let current: Instance | null = null;

function owner(): Instance {
  if (!current) throw new Error("fakeReact: hook called outside renderHook");
  return current;
}

function slot(init: () => Slot): Slot {
  const inst = owner();
  const i = inst.idx++;
  if (!(i in inst.slots)) inst.slots[i] = init();
  return inst.slots[i];
}

const depsChanged = (prev: readonly unknown[] | undefined, next: readonly unknown[] | undefined) =>
  !prev || !next || prev.length !== next.length || prev.some((d, i) => !Object.is(d, next[i]));

function schedule(inst: Instance) {
  if (!inst.mounted) return;
  if (inst.busy) inst.dirty = true;
  else inst.render();
}

export function useState<S>(init: S | (() => S)): [S, (update: S | ((prev: S) => S)) => void] {
  const inst = owner();
  const s = slot(() => ({ value: typeof init === "function" ? (init as () => S)() : init }));
  s.setter ??= (update: unknown) => {
    const next = typeof update === "function" ? (update as (prev: unknown) => unknown)(s.value) : update;
    if (Object.is(next, s.value)) return;
    s.value = next;
    schedule(inst);
  };
  return [s.value as S, s.setter as (update: S | ((prev: S) => S)) => void];
}

export function useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S): [S, (action: A) => void] {
  const [state, setState] = useState(initial);
  const r = slot(() => ({ value: reducer }));
  r.value = reducer;
  const d = slot(() => ({ value: (action: A) => setState((prev) => (r.value as typeof reducer)(prev, action)) }));
  return [state, d.value as (action: A) => void];
}

export function useRef<T>(init: T): { current: T } {
  return slot(() => ({ value: { current: init } })).value as { current: T };
}

function memo<T>(fn: () => T, deps: readonly unknown[]): T {
  const s = slot(() => ({ value: undefined, deps: undefined }));
  if (depsChanged(s.deps, deps)) {
    s.value = fn();
    s.deps = deps;
  }
  return s.value as T;
}

export const useMemo = memo;

export function useCallback<T>(fn: T, deps: readonly unknown[]): T {
  return memo(() => fn, deps);
}

export function useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void {
  const inst = owner();
  const s = slot(() => ({ value: undefined, deps: undefined }));
  const first = !("ran" in s);
  if (!first && !depsChanged(s.deps, deps)) return;
  s.deps = deps;
  (s as Slot & { ran?: true }).ran = true;
  inst.effects.push(() => {
    s.cleanup?.();
    const cleanup = fn();
    s.cleanup = typeof cleanup === "function" ? cleanup : undefined;
  });
}

export const useLayoutEffect = useEffect;

export interface RenderedHook<T, P> {
  result: { current: T };
  rerender: (props?: P) => void;
  unmount: () => void;
}

/** Mount `hook` and keep `result.current` on its latest return value. */
export function renderHook<T, P = undefined>(hook: (props: P) => T, initialProps?: P): RenderedHook<T, P> {
  let props = initialProps as P;
  const result = { current: undefined as T };
  const inst: Instance = {
    slots: [],
    idx: 0,
    effects: [],
    busy: false,
    dirty: false,
    mounted: true,
    render() {
      let passes = 0;
      do {
        if (++passes > 50) throw new Error("fakeReact: too many re-renders");
        inst.dirty = false;
        inst.busy = true;
        const prev = current;
        current = inst;
        inst.idx = 0;
        try {
          result.current = hook(props);
        } finally {
          current = prev;
        }
        const effects = inst.effects.splice(0);
        try {
          for (const run of effects) run();
        } finally {
          inst.busy = false;
        }
      } while (inst.dirty && inst.mounted);
    },
  };
  inst.render();
  return {
    result,
    rerender(next?: P) {
      if (next !== undefined) props = next;
      inst.render();
    },
    unmount() {
      inst.mounted = false;
      for (const s of inst.slots) s?.cleanup?.();
    },
  };
}
