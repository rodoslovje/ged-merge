/**
 * The family website's pages, kept in the address's `#` part — the site is one
 * static file, so the hash is the only address it can own, and a link a relative
 * shares (`…/rodbina.html#/p/p1x9k`) opens on that very person.
 */
export type Route =
  | { page: "home" }
  | { page: "person"; id: string }
  | { page: "charts"; id: string }
  | { page: "stats"; view?: string };

export function parseRoute(hash: string): Route {
  const [page, arg] = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (page === "p" && arg) return { page: "person", id: arg };
  if (page === "c" && arg) return { page: "charts", id: arg };
  if (page === "stats") return arg ? { page: "stats", view: arg } : { page: "stats" };
  return { page: "home" };
}

export function routeHash(route: Route): string {
  switch (route.page) {
    case "person":
      return `#/p/${encodeURIComponent(route.id)}`;
    case "charts":
      return `#/c/${encodeURIComponent(route.id)}`;
    case "stats":
      return route.view ? `#/stats/${encodeURIComponent(route.view)}` : "#/stats";
    default:
      return "#/";
  }
}

/** Where a visit without an address lands: the page the author chose, as long
 *  as it has the person it needs. */
export function startRoute(startPage: string | undefined, start: string | undefined): Route {
  if (startPage === "stats") return { page: "stats" };
  if (start && startPage === "person") return { page: "person", id: start };
  if (start && startPage === "charts") return { page: "charts", id: start };
  return { page: "home" };
}

/** Folded for search: lower case, no accents (`Žnidaršič` → `znidarsic`). */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Whether every word of the query starts a word of the name. */
export function nameMatches(name: string, query: string): boolean {
  const words = fold(name).split(/[\s,./()-]+/).filter(Boolean);
  const terms = fold(query).split(/\s+/).filter(Boolean);
  return terms.length > 0 && terms.every((q) => words.some((w) => w.startsWith(q)));
}
