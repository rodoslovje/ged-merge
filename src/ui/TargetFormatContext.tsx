import { createContext, useContext } from "react";
import type { FormatOverrides } from "../normalize/formatOverrides";
import type { TargetMode, TargetProposal, WriteTarget } from "../normalize/target";
import type { EventOffer } from "./edit/editConstants";

/**
 * The loaded main file's target format, and the format choices it leaves —
 * provided by App, which resolves both from Settings (see
 * `normalize/target.ts`). Every writer reads its format choices through
 * {@link useFormatOverrides} rather than from Settings directly: in a strict
 * mode the standard's forms replace the ones the reader or the file chose.
 */
export interface TargetFormatValue {
  target: WriteTarget;
  /** The reader's format choices, with the target's applied. */
  formatOverrides: FormatOverrides;
  /** What the file was proposed when it was first opened (undefined with no
   *  main file). */
  proposal?: TargetProposal;
  /** Choose the loaded main file's target format. */
  setMode: (mode: TargetMode) => void;
  /** What the event menus may offer (see `offersEventTag`). */
  eventOffer: EventOffer;
}

const NO_FILE: TargetFormatValue = {
  target: { mode: "file", version: "5.5.1", strict: false },
  formatOverrides: {},
  setMode: () => {},
  eventOffer: { version: "5.5.1", strict: false, dialectTags: new Set() },
};

export const TargetFormatContext = createContext<TargetFormatValue>(NO_FILE);

export function useTargetFormat(): TargetFormatValue {
  return useContext(TargetFormatContext);
}

/** The format choices every write follows: Settings → GEDCOM, with the main
 *  file's target format applied. */
export function useFormatOverrides(): FormatOverrides {
  return useContext(TargetFormatContext).formatOverrides;
}
