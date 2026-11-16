import { describe, expect, it } from "vitest";
import type { PublishedTree } from "../publish/model";
import { trayFaces } from "./PhotoTray";

const tree = (people: PublishedTree["people"]): PublishedTree => ({
  format: "gedmerge-site",
  version: 1,
  title: "",
  created: "2026-11-16",
  lang: "sl",
  people,
  families: [],
});

describe("trayFaces", () => {
  it("prefers a photo of the person alone, and takes a group photo only when it is their one photo", () => {
    const faces = trayFaces(tree([
      { id: "a", photos: [{ photo: "group", crop: { top: 0, left: 0, width: 5, height: 5 } }] },
      { id: "b", photos: [{ photo: "group" }, { photo: "alone" }] },
      { id: "c", photos: [{ photo: "group" }, { photo: "group2" }] },
      { id: "d", photos: [{ photo: "group2" }] },
      { id: "e" },
    ]));
    expect(faces).toEqual([
      { id: "a", link: { photo: "group", crop: { top: 0, left: 0, width: 5, height: 5 } } },
      { id: "b", link: { photo: "alone" } },
      { id: "d", link: { photo: "group2" } },
    ]);
  });
});
