import { useSyncExternalStore } from "react";
import { localRegisters, watchLocalRegisters } from "../geo/addressLookup";
import type { RegisterCountry } from "../geo/addressRegister";

/**
 * The countries whose address register this browser has stored, as a value a
 * component re-renders on.
 *
 * Whether a register is stored decides two things while rendering: whether a
 * lookup needs the network (and so whether the online-lookups opt-in governs
 * it), and whether the addresses list can answer itself. Both are asked
 * synchronously, so the answer is kept as plain module state in addressLookup
 * — but it *changes*, when the first read of IndexedDB lands a moment after
 * load and when a register is imported or removed mid-session. Without this a
 * row would keep the answer it happened to render with.
 *
 * The set itself is what most callers want; those that only need to re-render
 * can ignore the return value and go on calling `isOfflineQuery`, which reads
 * the same state.
 */
export function useLocalRegisters(): ReadonlySet<RegisterCountry> {
  return useSyncExternalStore(watchLocalRegisters, localRegisters, localRegisters);
}
