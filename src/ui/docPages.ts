/** The standalone static pages, each on a slug of its own per language
 *  (vite.config.ts builds them, public/sitemap.xml lists them). */
export type DocPage = "guide" | "changelog" | "privacy" | "terms";

const SLUGS: Record<string, Record<DocPage, string>> = {
  en: { guide: "guide/", changelog: "changelog/", privacy: "privacy/", terms: "terms/" },
  sl: { guide: "navodila/", changelog: "posodobitve/", privacy: "zasebnost/", terms: "pogoji/" },
  hr: { guide: "upute/", changelog: "novosti/", privacy: "privatnost/", terms: "uvjeti/" },
};

/** A page's relative address in the reader's language; English for any
 *  language the pages are not written in. */
export function docPage(page: DocPage, lang: string | null | undefined): string {
  return (SLUGS[(lang ?? "").slice(0, 2)] ?? SLUGS.en)[page];
}
