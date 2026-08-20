import { describe, expect, it } from "vitest";
import { basename, mediaKindOf, pathSegments, sameMediaFile } from "./mediaPath";

describe("pathSegments / basename", () => {
  it("splits on either separator and drops empties", () => {
    expect(pathSegments("a\\b/c.jpg")).toEqual(["a", "b", "c.jpg"]);
    expect(pathSegments("/a//b/")).toEqual(["a", "b"]);
  });

  it("basename returns the final segment", () => {
    expect(basename("photos\\sub/janez.jpg")).toBe("janez.jpg");
    expect(basename("janez.jpg")).toBe("janez.jpg");
  });
});

describe("mediaKindOf", () => {
  it("classifies raster and vector images as image", () => {
    expect(mediaKindOf("a.JPG")).toBe("image");
    expect(mediaKindOf("sub/tree.svg")).toBe("image");
    expect(mediaKindOf("scan.tiff")).toBe("image");
  });

  it("classifies PDFs", () => {
    expect(mediaKindOf("krstna-knjiga.PDF")).toBe("pdf");
  });

  it("returns null for anything it can't preview", () => {
    expect(mediaKindOf("notes.txt")).toBeNull();
    expect(mediaKindOf("video.mp4")).toBeNull();
    expect(mediaKindOf("noextension")).toBeNull();
  });
});

describe("sameMediaFile", () => {
  it("matches a bare stored filename against its folder path, and full paths against themselves", () => {
    expect(sameMediaFile("scan1.jpg", "krsti/scan1.jpg")).toBe(true);
    expect(sameMediaFile("krsti/scan1.jpg", "krsti/scan1.jpg")).toBe(true);
    expect(sameMediaFile("media\\krsti\\Scan1.JPG", "krsti/scan1.jpg")).toBe(true);
  });

  it("never matches two different files that merely share a basename", () => {
    expect(sameMediaFile("poroke/scan1.jpg", "krsti/scan1.jpg")).toBe(false);
    expect(sameMediaFile("a/b/scan1.jpg", "x/b2/scan1.jpg")).toBe(false);
  });
});
