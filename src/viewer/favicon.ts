/**
 * The family website's icon. The page carries GED Merge's inline (see
 * `publish/page.ts`), so it has one even from disk; where the author named the
 * site's address, the icon of that site — its `/favicon.ico` — takes over, but
 * only once it is seen to load: a missing one never leaves the tab blank.
 */

/** Where the site's own icon would be: `favicon.ico` at its address's root. */
export function siteFaviconUrl(siteUrl: string): string | undefined {
  try {
    const url = new URL("/favicon.ico", siteUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Use the site's own icon, when it loads. */
export function adoptSiteFavicon(siteUrl: string): void {
  const href = siteFaviconUrl(siteUrl);
  if (!href) return;
  const probe = new Image();
  probe.onload = () => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.removeAttribute("type");
    link.href = href;
  };
  probe.src = href;
}
