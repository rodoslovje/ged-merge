import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPageTitle } from "./urlMetadata";

describe("fetchPageTitle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the decoded <title> from a successful fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("<html><head><title>Pfarre St. Jakob &amp; Co</title></head></html>"),
    }));
    await expect(fetchPageTitle("https://example.com/page")).resolves.toBe("Pfarre St. Jakob & Co");
  });

  it("returns undefined on a non-200 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(fetchPageTitle("https://example.com/page")).resolves.toBeUndefined();
  });

  it("returns undefined when fetch throws (e.g. network/CORS failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    await expect(fetchPageTitle("https://example.com/page")).resolves.toBeUndefined();
  });

  it("returns undefined when the page has no <title>", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("<html><body>no title here</body></html>"),
    }));
    await expect(fetchPageTitle("https://example.com/page")).resolves.toBeUndefined();
  });
});
