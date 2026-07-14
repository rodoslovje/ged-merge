/**
 * Best-effort page-title lookup for the "Add Source" dialog's URL-only path.
 * This is a browser-only static app with no backend, and the genealogy sites
 * a URL typically points at (Matricula, sistory.si, …) send no CORS headers,
 * so a direct `fetch` of their HTML is blocked by the browser. Routed through
 * a public CORS-bypass relay instead; any failure (timeout, relay down,
 * non-200) is swallowed — the dialog just falls back to no title.
 */

/** Public CORS-bypass relays, tried in order — any one being down (observed
 *  regularly for each of them) must not take the feature out. */
const PROXY_URLS = [
  (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url: string) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];
const TIMEOUT_MS = 6000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

async function fetchViaProxy(proxied: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(proxied, { signal: controller.signal });
    if (!res.ok) return undefined;
    const text = await res.text();
    return text || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch `url`'s raw HTML through a CORS-bypass relay (first responsive one
 *  wins), or undefined when they all fail. */
export async function fetchPageHtml(url: string): Promise<string | undefined> {
  for (const proxy of PROXY_URLS) {
    const html = await fetchViaProxy(proxy(url));
    if (html) return html;
  }
  return undefined;
}

/** Fetch `url`'s HTML through a CORS-bypass relay and return its `<title>`, or undefined on any failure. */
export async function fetchPageTitle(url: string): Promise<string | undefined> {
  const html = await fetchPageHtml(url);
  if (!html) return undefined;
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (!match) return undefined;
  const title = decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim();
  return title || undefined;
}
