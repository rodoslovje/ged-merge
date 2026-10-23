import { describe, expect, it } from "vitest";
import { TERMS_ORIGIN, TERMS_VENDORS, termsEntries, termsUri } from "../gedcom/extensionTerms";
import { namedVendorTags } from "../gedcom/vendorTags";
import { buildTermsPages, termsPageFor } from "./pages";

const assets = { css: ["assets/guide-x.css"], js: ["assets/legal-entry-x.js"] };
const pages = buildTermsPages(assets);
const files = new Set(pages.map((p) => p.file));

/** The built file a URI the writer emits is served from. */
const fileOf = (uri: string) => `${decodeURIComponent(uri.slice(TERMS_ORIGIN.length + 1))}/index.html`;

describe("buildTermsPages", () => {
  it("gives every documented tag its page, and no two pages one path", () => {
    expect(files.size).toBe(pages.length);
    for (const e of termsEntries()) expect(files.has(`terms/${e.vendor}/${e.tag}/index.html`), `${e.vendor}/${e.tag}`).toBe(true);
    for (const slug of new Set(termsEntries().map((e) => e.vendor))) expect(files.has(`terms/${slug}/index.html`)).toBe(true);
    expect(files.has("terms/extensions/index.html")).toBe(true);
    expect(files.has("terms/unknown/index.html")).toBe(true);
    expect(files.has("404.html")).toBe(true);
    // /terms/ itself is the Terms of Service, never overwritten.
    expect(files.has("terms/index.html")).toBe(false);
  });

  it("has a page for every URI the schema writer can emit", () => {
    const producers = [undefined, "Geneanet", ...TERMS_VENDORS.flatMap((v) => v.sour)];
    const tags = [...namedVendorTags(), ...termsEntries().map((e) => e.tag)];
    for (const tag of tags) {
      for (const sour of producers) {
        const uri = termsUri(tag, sour);
        expect(uri).not.toMatch(/\/$/);
        expect(files.has(fileOf(uri)), `${tag} from ${sour}: ${uri}`).toBe(true);
      }
    }
    // A tag no table knows is answered by the not-found page, which names it.
    expect(termsUri("_ZZZ", undefined)).toBe(`${TERMS_ORIGIN}/terms/unknown/_ZZZ`);
    expect(termsPageFor("/terms/unknown/_ZZZ", assets)?.file).toBe("404.html");
  });

  it("writes a tag page with the tag, the program, both meanings, the context and the standard form", () => {
    const html = pages.find((p) => p.file === "terms/common/_MARNM/index.html")!.html;
    expect(html).toContain("<h1><code>_MARNM</code></h1>");
    expect(html).toContain("https://gedmerge.com/terms/common/_MARNM</code>");
    expect(html).toContain("Married surname");
    expect(html).toContain('<span lang="sl">Slovensko: priimek po poroki</span>');
    expect(html).toContain("<code>INDI.NAME</code>");
    expect(html).toContain("<code>a NAME of its own with TYPE MARRIED</code>");
    expect(html).toContain('href="../../../guide/#extension-tags"');
    expect(html).toContain('href="../../../assets/guide-x.css"');
    expect(html).toContain('src="../../../assets/legal-entry-x.js"');
    expect(html).toContain('href="../../../terms/myheritage/_MARNM/"');
    const upd = pages.find((p) => p.file === "terms/myheritage/_UPD/index.html")!.html;
    expect(upd).toContain("<td>Program</td><td>MyHeritage</td>");
    expect(upd).toContain("None: GEDCOM 7 has no structure of its own for this.");
  });

  it("lists every program and tag on the index, with the registry's tags", () => {
    const html = pages.find((p) => p.file === "terms/extensions/index.html")!.html;
    for (const e of termsEntries()) expect(html).toContain(`href="../../terms/${e.vendor}/${encodeURIComponent(e.tag)}/"`);
    expect(html).toContain("https://armidalesoftware.com/issue/tags/AGER.htm");
  });

  it("serves the not-found page from the site root, for any address", () => {
    const html = pages.find((p) => p.file === "404.html")!.html;
    expect(html).toContain('href="/assets/guide-x.css"');
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).toContain("/^\\/terms\\/unknown\\/([^/]+)\\/?$/");
  });

  it("finds a dev-server page by its address, with or without the slash", () => {
    expect(termsPageFor("/terms/myheritage/_UPD", assets)?.file).toBe("terms/myheritage/_UPD/index.html");
    expect(termsPageFor("/terms/myheritage/_UPD/", assets)?.file).toBe("terms/myheritage/_UPD/index.html");
    expect(termsPageFor("/terms/extensions/", assets)?.file).toBe("terms/extensions/index.html");
    expect(termsPageFor("/terms/", assets)).toBeUndefined();
    expect(termsPageFor("/terms/myheritage/_NOPE/", assets)).toBeUndefined();
  });
});
