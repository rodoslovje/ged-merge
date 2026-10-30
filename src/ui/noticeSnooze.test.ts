import { beforeEach, describe, expect, it, vi } from "vitest";
import { SNOOZE_MS, noticeSnoozed, snoozeNotice } from "./noticeSnooze";

let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
  });
});

describe("noticeSnooze", () => {
  it("keeps a notice away for a week, then lets it back", () => {
    const now = 1_000_000;
    expect(noticeSnoozed("a", now)).toBe(false);
    snoozeNotice("a", now);
    expect(noticeSnoozed("a", now + SNOOZE_MS - 1)).toBe(true);
    expect(noticeSnoozed("a", now + SNOOZE_MS)).toBe(false);
    expect(noticeSnoozed("b", now)).toBe(false);
  });

  it("drops expired entries when it writes", () => {
    snoozeNotice("old", 0);
    snoozeNotice("new", SNOOZE_MS + 1);
    expect(Object.keys(JSON.parse(storage.get("noticeSnoozedUntil")!))).toEqual(["new"]);
  });

  it("survives a corrupt entry", () => {
    storage.set("noticeSnoozedUntil", "{oops");
    expect(noticeSnoozed("a")).toBe(false);
  });
});
