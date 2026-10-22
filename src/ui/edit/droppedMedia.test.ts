import { describe, expect, it } from "vitest";
import { attachDroppedMedia, type DroppedMediaDeps } from "./droppedMedia";

const handle = (name: string) => ({ kind: "file", name, getFile: async () => new File([], name) }) as unknown as FileSystemHandle;

// Regression: a dropped photo was attached to whoever was on screen when its
// import finished — the permission prompt and the copy into the folder are
// awaited, and the user may open another person meanwhile.
describe("attachDroppedMedia", () => {
  it("attaches every photo to the person it was dropped on", async () => {
    let onScreen = "@I1@";
    const attached: [string, string][] = [];
    const deps: DroppedMediaDeps = {
      resolveHandle: async (h) => {
        onScreen = "@I2@"; // the user moves on while the browser asks
        return `photos/${h.name}`;
      },
      importFile: async () => null,
      exists: () => true,
      attach: (id, rel) => attached.push([id, rel]),
    };
    const out = await attachDroppedMedia(onScreen, [Promise.resolve(handle("a.jpg")), Promise.resolve(handle("b.jpg"))], deps);
    expect(out).toEqual({ added: 2, anyFailed: false });
    expect(attached).toEqual([["@I1@", "photos/a.jpg"], ["@I1@", "photos/b.jpg"]]);
  });

  it("attaches nothing once that person has been deleted", async () => {
    let alive = true;
    const attached: string[] = [];
    const out = await attachDroppedMedia("@I1@", [Promise.resolve(handle("a.jpg"))], {
      resolveHandle: async () => { alive = false; return null; },
      importFile: async () => "photos/a.jpg",
      exists: () => alive,
      attach: (_id, rel) => attached.push(rel),
    });
    expect(out.added).toBe(0);
    expect(attached).toEqual([]);
  });
});
