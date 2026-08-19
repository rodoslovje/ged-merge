import { describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { commitFieldOnEnter, leaveFieldOnEscape } from "./fieldKeys";

/** A keydown event as React hands it over, with the pieces the handler reads.
 *  `host` stands for the row a field sits in — focus parks there when there is
 *  one, else the field is blurred. */
function keyEvent(
  key: string,
  target: { tagName: string; type?: string; inModal?: boolean; host?: boolean },
  opts: { defaultPrevented?: boolean; shiftKey?: boolean; metaKey?: boolean } = {},
) {
  const blur = vi.fn();
  const focus = vi.fn();
  const preventDefault = vi.fn();
  const host = { hasAttribute: () => true, focus };
  const el = {
    tagName: target.tagName,
    type: target.type ?? "text",
    closest: (sel: string) => {
      if (sel === ".modal-overlay") return target.inModal ? {} : null;
      return target.host === false ? null : host;
    },
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
  return { e, blur, focus, preventDefault };
}

describe("commitFieldOnEnter", () => {
  it("commits a text field by leaving it (edit fields save on blur)", () => {
    const { e, focus, preventDefault } = keyEvent("Enter", { tagName: "INPUT" });
    commitFieldOnEnter(e);
    expect(focus).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
  });

  it("parks focus on the field's row, so the tab position survives", () => {
    const { e, focus, blur } = keyEvent("Enter", { tagName: "INPUT" });
    commitFieldOnEnter(e);
    expect(focus).toHaveBeenCalled();
    expect(blur).not.toHaveBeenCalled();
  });

  it("blurs a field that sits in no row at all", () => {
    const { e, blur } = keyEvent("Enter", { tagName: "INPUT", host: false });
    commitFieldOnEnter(e);
    expect(blur).toHaveBeenCalled();
  });

  it("leaves a textarea's Enter alone so it still breaks the line", () => {
    const { e, focus, blur } = keyEvent("Enter", { tagName: "TEXTAREA" });
    commitFieldOnEnter(e);
    expect(focus).not.toHaveBeenCalled();
    expect(blur).not.toHaveBeenCalled();
  });

  it("leaves an Enter the field already handled itself", () => {
    // A place suggestion or a picked relative signals it consumed the key.
    const { e, focus } = keyEvent("Enter", { tagName: "INPUT" }, { defaultPrevented: true });
    commitFieldOnEnter(e);
    expect(focus).not.toHaveBeenCalled();
  });

  it("ignores checkboxes, chords, other keys, and fields inside a dialog", () => {
    for (const { e, focus, blur } of [
      keyEvent("Enter", { tagName: "INPUT", type: "checkbox" }),
      keyEvent("Enter", { tagName: "INPUT" }, { shiftKey: true }),
      keyEvent("Enter", { tagName: "INPUT" }, { metaKey: true }),
      keyEvent("a", { tagName: "INPUT" }),
      keyEvent("Enter", { tagName: "INPUT", inModal: true }),
    ]) {
      commitFieldOnEnter(e);
      expect(focus).not.toHaveBeenCalled();
      expect(blur).not.toHaveBeenCalled();
    }
  });
});

describe("leaveFieldOnEscape", () => {
  it("leaves a text field, keeping what was typed", () => {
    const { e, focus, preventDefault } = keyEvent("Escape", { tagName: "INPUT" });
    leaveFieldOnEscape(e);
    expect(focus).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
  });

  it("leaves a textarea too — the way out Enter cannot open there", () => {
    const { e, focus } = keyEvent("Escape", { tagName: "TEXTAREA" });
    leaveFieldOnEscape(e);
    expect(focus).toHaveBeenCalled();
  });

  it("leaves an Escape the field answered itself (an open suggestion list)", () => {
    const { e, focus } = keyEvent("Escape", { tagName: "INPUT" }, { defaultPrevented: true });
    leaveFieldOnEscape(e);
    expect(focus).not.toHaveBeenCalled();
  });

  it("stays out of dialogs, where Escape closes the dialog", () => {
    const { e, focus } = keyEvent("Escape", { tagName: "INPUT", inModal: true });
    leaveFieldOnEscape(e);
    expect(focus).not.toHaveBeenCalled();
  });

  it("ignores non-typing controls and other keys", () => {
    for (const { e, focus } of [
      keyEvent("Escape", { tagName: "INPUT", type: "checkbox" }),
      keyEvent("Escape", { tagName: "BUTTON" }),
      keyEvent("a", { tagName: "INPUT" }),
    ]) {
      leaveFieldOnEscape(e);
      expect(focus).not.toHaveBeenCalled();
    }
  });
});
