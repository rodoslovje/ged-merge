import { describe, expect, it } from "vitest";
import { joinDateTime, splitDateTime } from "./dateTime";
import { applyEventNodeUpdate } from "./edit";
import type { GedNode } from "./types";

const node = (tag: string, value?: string, children: GedNode[] = []): GedNode => ({ level: 0, tag, value, children });

describe("splitDateTime / joinDateTime", () => {
  it("cuts a trailing 24-hour time off the date, zero-padding the hour", () => {
    expect(splitDateTime("5 MAR 1850 14:30")).toEqual({ date: "5 MAR 1850", time: "14:30" });
    expect(splitDateTime("5.3.1850 9:05")).toEqual({ date: "5.3.1850", time: "09:05" });
    expect(splitDateTime("ABT 1850 23:59:30")).toEqual({ date: "ABT 1850", time: "23:59:30" });
  });

  it("leaves a date without a valid time whole", () => {
    expect(splitDateTime("5 MAR 1850")).toEqual({ date: "5 MAR 1850" });
    expect(splitDateTime("5 MAR 1850 25:00")).toEqual({ date: "5 MAR 1850 25:00" });
    expect(splitDateTime("5 MAR 1850 14:61")).toEqual({ date: "5 MAR 1850 14:61" });
  });

  it("joins them back as the field shows them", () => {
    expect(joinDateTime("5 MAR 1850", "14:30")).toBe("5 MAR 1850 14:30");
    expect(joinDateTime("5 MAR 1850", undefined)).toBe("5 MAR 1850");
  });
});

describe("applyEventNodeUpdate — TIME under the DATE", () => {
  it("writes, replaces and removes the time, and leaves it alone when not asked", () => {
    const record = node("INDI");
    const birth = node("BIRT", undefined, [node("DATE", "5 MAR 1850")]);
    record.children.push(birth);
    const time = () => birth.children.find((c) => c.tag === "DATE")?.children.find((c) => c.tag === "TIME")?.value;

    applyEventNodeUpdate(record, birth, { date: "5 MAR 1850", time: "14:30" });
    expect(time()).toBe("14:30");
    // Another writer of the date says nothing of the time: it stays.
    applyEventNodeUpdate(record, birth, { date: "6 MAR 1850" });
    expect(time()).toBe("14:30");
    applyEventNodeUpdate(record, birth, { date: "6 MAR 1850", time: "" });
    expect(time()).toBeUndefined();
  });
});
