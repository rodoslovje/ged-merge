/**
 * Best-effort page-title lookup for the "Add Source" dialog's URL-only path.
 * This is a browser-only static app with no backend, and the genealogy sites
 * a URL typically points at (Matricula, sistory.si, …) send no CORS headers,
 * so a direct `fetch` of their HTML is blocked by the browser. Routed through
 * a public CORS-bypass relay instead; any failure (timeout, relay down,
 * non-200) is swallowed — the dialog just falls back to no title.
 */

const PROXY_URL = "https://api.allorigins.win/raw?url=";
const TIMEOUT_MS = 6000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Fetch `url`'s HTML through a CORS-bypass relay and return its `<title>`, or undefined on any failure. */
export async function fetchPageTitle(url: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${PROXY_URL}${encodeURIComponent(url)}`, { signal: controller.signal });
    if (!res.ok) return undefined;
    const html = await res.text();
    const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
    if (!match) return undefined;
    const title = decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim();
    return title || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
