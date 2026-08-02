import { describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { commitFieldOnEnter } from "./commitOnEnter";

/** A keydown event as React hands it over, with the pieces the handler reads. */
function keyEvent(
  key: string,
  target: { tagName: string; type?: string; inModal?: boolean },
  opts: { defaultPrevented?: boolean; shiftKey?: boolean; metaKey?: boolean } = {},
) {
  const blur = vi.fn();
  const preventDefault = vi.fn();
  const el = {
    tagName: target.tagName,
    type: target.type ?? "text",
    closest: (sel: string) => (sel === ".modal-overlay" && target.inModal ? {} : null),
    blur,
  };
  const e = {
    key,
    target: el,
    defaultPrevented: opts.defaultPrevented ?? false,
    shiftKey: opts.shiftKey ?? false,
    metaKey: opts.metaKey ?? false,
    ctrlKey: false,
    altKey: false,
    preventDefault,
  } as unknown as KeyboardEvent;
  return { e, blur, preventDefault };
}

describe("commitFieldOnEnter", () => {
  it("commits a text field by blurring it (edit fields save on blur)", () => {
    const { e, blur, preventDefault } = keyEvent("Enter", { tagName: "INPUT" });
    commitFieldOnEnter(e);
    expect(blur).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
  });

  it("leaves a textarea's Enter alone so it still breaks the line", () => {
    const { e, blur } = keyEvent("Enter", { tagName: "TEXTAREA" });
    commitFieldOnEnter(e);
    expect(blur).not.toHaveBeenCalled();
  });

  it("leaves an Enter the field already handled itself", () => {
    // A place suggestion or a picked relative signals it consumed the key.
    const { e, blur } = keyEvent("Enter", { tagName: "INPUT" }, { defaultPrevented: true });
    commitFieldOnEnter(e);
    expect(blur).not.toHaveBeenCalled();
  });

  it("ignores checkboxes, chords, other keys, and fields inside a dialog", () => {
    for (const { e, blur } of [
      keyEvent("Enter", { tagName: "INPUT", type: "checkbox" }),
      keyEvent("Enter", { tagName: "INPUT" }, { shiftKey: true }),
      keyEvent("Enter", { tagName: "INPUT" }, { metaKey: true }),
      keyEvent("a", { tagName: "INPUT" }),
      keyEvent("Enter", { tagName: "INPUT", inModal: true }),
    ]) {
      commitFieldOnEnter(e);
      expect(blur).not.toHaveBeenCalled();
    }
  });
});
