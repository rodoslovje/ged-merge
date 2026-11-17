import { describe, expect, it } from "vitest";
import { siteFaviconUrl } from "./favicon";

describe("siteFaviconUrl", () => {
  it("is favicon.ico at the root of the site's address", () => {
    expect(siteFaviconUrl("https://tree.example.org")).toBe("https://tree.example.org/favicon.ico");
    expect(siteFaviconUrl("https://tree.example.org/novak/index.html")).toBe("https://tree.example.org/favicon.ico");
  });

  it("is nothing for an address that is not a web one", () => {
    expect(siteFaviconUrl("not a url")).toBeUndefined();
    expect(siteFaviconUrl("file:///home/me/site.html")).toBeUndefined();
  });
});
