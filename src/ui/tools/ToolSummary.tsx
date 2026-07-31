import { createContext, useContext } from "react";
import { createPortal } from "react-dom";

// Every tool prints a one-line summary of what it is looking at ("36 countries ·
// 2820 places · 16668 mentions"). On a desktop that sits in the tool's own
// filter row; on a phone it moves up beside the tool picker, which has a row to
// itself and room to spare — one row saved, and the count reads next to the tool
// it counts for.
//
// The panels are two levels below the picker, so no CSS can put them on one row.
// Each panel keeps rendering its own summary and this portals it, rather than
// six panels having to hand their text upward.

const SlotContext = createContext<HTMLElement | null>(null);

export const ToolSummarySlotProvider = SlotContext.Provider;

/** The summary line. Rendered in place, or into the slot when one is offered. */
export function ToolSummary({ children }: { children: React.ReactNode }) {
  const slot = useContext(SlotContext);
  const line = <p className="tools-summary">{children}</p>;
  return slot ? createPortal(line, slot) : line;
}
