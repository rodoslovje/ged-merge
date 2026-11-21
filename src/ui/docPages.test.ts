/// <reference types="node" />
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { docPage, type DocPage } from "./docPages";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PAGES: DocPage[] = ["guide", "changelog", "privacy", "terms"];

describe("docPage", () => {
  it("sends each language to its own pages, any other to the English ones", () => {
    expect(docPage("guide", "sl")).toBe("navodila/");
    expect(docPage("changelog", "hr")).toBe("novosti/");
    expect(docPage("terms", "en")).toBe("terms/");
    expect(docPage("privacy", "de")).toBe("privacy/");
    expect(docPage("privacy", null)).toBe("privacy/");
  });

  it("names only pages that exist", () => {
    for (const lang of ["en", "sl", "hr"]) {
      for (const page of PAGES) expect(existsSync(resolve(ROOT, docPage(page, lang), "index.html")), `${lang} ${page}`).toBe(true);
    }
  });
});
