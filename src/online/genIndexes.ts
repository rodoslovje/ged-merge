/**
 * The genealogical indexes GED Merge searches and recognizes in links: the
 * Slovenian one (indeks.rodoslovje.si) and the Croatian one
 * (indeks.rodoslovlje.hr). Both run the same software, so they share URL
 * parameters, the REST search and the person-link shape — only the host,
 * the API address and the society behind them differ.
 */
export type GenIndex = "si" | "hr";

export const GEN_INDEXES: readonly GenIndex[] = ["si", "hr"];

export interface GenIndexInfo {
  host: string;
  /** The website's root, with its trailing slash. */
  site: string;
  /** The advanced person search of the index's REST API. */
  api: string;
  /** The index's own name, as a source title ends with it. */
  name: string;
  /** The society that publishes it — a source's agency. */
  agency: string;
}

export const GEN_INDEX: Record<GenIndex, GenIndexInfo> = {
  si: {
    host: "indeks.rodoslovje.si",
    site: "https://indeks.rodoslovje.si/",
    api: "https://indeks-api.rodoslovje.si/api/search/advanced/persons",
    name: "Slovenski rodoslovni indeks",
    agency: "Slovensko rodoslovno društvo",
  },
  hr: {
    host: "indeks.rodoslovlje.hr",
    site: "https://indeks.rodoslovlje.hr/",
    api: "https://indeks-api.rodoslovlje.hr/api/search/advanced/persons",
    name: "Hrvatski rodoslovni indeks",
    agency: "Hrvatsko rodoslovno društvo „Pavao Ritter Vitezović”",
  },
};

/** The index a host name belongs to, if any. */
export function genIndexOfHost(host: string): GenIndex | undefined {
  const h = host.toLowerCase().replace(/^www\./, "");
  return GEN_INDEXES.find((i) => GEN_INDEX[i].host === h);
}
