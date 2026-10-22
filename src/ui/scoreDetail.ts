import { useEffect, useState } from "react";
import type { ScoreComponent } from "../match/types";

/**
 * A match row's score breakdown, fetched from the worker when the row asks
 * for it. The match list arrives without the breakdowns — at half a million
 * rows they were most of what crossed the worker boundary — and only the
 * score tooltip reads them, one row at a time.
 *
 * A module-level store, like {@link requestSettings}: App connects the worker
 * once ({@link connectScoreDetails}) and hands answers back
 * ({@link receiveScoreDetail}); rows just ask ({@link useScoreDetail}).
 */

type Request = (mainId: string, compareId: string, generation: number) => void;

let request: Request | undefined;
/** Bumped by every new match list, so an answer about an older list is
 *  dropped and the cache starts over. */
let generation = 0;
const cache = new Map<string, ScoreComponent[]>();
const pending = new Set<string>();
const listeners = new Set<() => void>();

const pairKey = (mainId: string, compareId: string) => `${mainId}\u0000${compareId}`;

/** App: how to ask the worker for one pair's breakdown. */
export function connectScoreDetails(post: Request | undefined): void {
  request = post;
}

/** App: a new match list arrived — forget every breakdown of the last one.
 *  Returns the generation the worker's answers will carry. */
export function resetScoreDetails(): number {
  generation++;
  cache.clear();
  pending.clear();
  for (const l of listeners) l();
  return generation;
}

/** The generation requests are currently made for. */
export function scoreDetailGeneration(): number {
  return generation;
}

/** App: the worker's answer. */
export function receiveScoreDetail(
  mainId: string,
  compareId: string,
  gen: number,
  components: ScoreComponent[] | undefined,
): void {
  if (gen !== generation) return;
  const key = pairKey(mainId, compareId);
  pending.delete(key);
  // A pair the worker no longer knows has nothing to show; cached as such so
  // the row does not ask again.
  cache.set(key, components ?? []);
  for (const l of listeners) l();
}

/**
 * The pair's breakdown once `wanted` (the row is hovered) and the worker has
 * answered; undefined until then.
 */
export function useScoreDetail(mainId: string, compareId: string, wanted: boolean): ScoreComponent[] | undefined {
  const key = pairKey(mainId, compareId);
  const [components, setComponents] = useState(() => cache.get(key));
  useEffect(() => {
    if (!wanted) return;
    const update = () => {
      setComponents(cache.get(key));
      // Asked again after a reset too, while the row is still hovered.
      if (!cache.has(key) && !pending.has(key) && request) {
        pending.add(key);
        request(mainId, compareId, generation);
      }
    };
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, [key, mainId, compareId, wanted]);
  return components;
}
