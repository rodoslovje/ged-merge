/**
 * Best-effort page-title lookup for the "Add Source" dialog's URL-only path.
 * This is a browser-only static app with no backend, and the genealogy sites
 * a URL typically points at (Matricula, sistory.si, …) send no CORS headers,
 * so a direct `fetch` of their HTML is blocked by the browser. Routed through
 * a public CORS-bypass relay instead; any failure (timeout, relay down,
 * non-200) is swallowed — the dialog just falls back to no title.
 */

/** Public CORS-bypass relays, tried in order — any one being down (observed
 *  regularly for each of them) must not take the feature out. The last entry,
 *  r.jina.ai, renders the page in a real browser — it gets past the bot checks
 *  that 403 the plain relays (Geneanet) but returns **markdown**, not HTML, so
 *  page parsers must accept both shapes. It also needs a longer timeout. */
const PROXY_URLS: { proxied: (url: string) => string; timeoutMs: number }[] = [
  { proxied: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, timeoutMs: 6000 },
  { proxied: (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`, timeoutMs: 6000 },
  { proxied: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, timeoutMs: 6000 },
  { proxied: (url) => `https://r.jina.ai/${url}`, timeoutMs: 20000 },
];

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

async function fetchViaProxy(proxied: string, timeoutMs: number): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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

/** Fetch `url`'s content through a CORS-bypass relay (first responsive one
 *  wins) — HTML, or markdown from the rendering relay — or undefined when
 *  they all fail. */
export async function fetchPageHtml(url: string): Promise<string | undefined> {
  for (const proxy of PROXY_URLS) {
    const text = await fetchViaProxy(proxy.proxied(url), proxy.timeoutMs);
    if (text) return text;
  }
  return undefined;
}

/** The page's title from relayed content: `<title>` (HTML) or the rendering
 *  relay's `Title:` header line (markdown). */
export function pageTitleOf(text: string): string | undefined {
  const html = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1];
  const raw = html ?? /^Title:[ \t]*(.+)$/m.exec(text)?.[1];
  if (!raw) return undefined;
  return decodeHtmlEntities(raw).replace(/\s+/g, " ").trim() || undefined;
}

/** Fetch `url` through a CORS-bypass relay and return its page title, or undefined on any failure. */
export async function fetchPageTitle(url: string): Promise<string | undefined> {
  const text = await fetchPageHtml(url);
  return text ? pageTitleOf(text) : undefined;
}
