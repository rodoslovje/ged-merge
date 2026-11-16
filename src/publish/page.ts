import type { PublishedTree } from "./model";
import { PUBLISHED_FORMAT } from "./model";
import { packTree } from "./pack";
import FAVICON_SVG from "../ui/icons/favicon.svg?raw";

/** The family website's viewer, built once into one script and one stylesheet
 *  (see `vitePlugin.ts`). */
export interface ViewerBundle {
  js: string;
  css: string;
}

/** The element the viewer reads its data from. */
export const DATA_ELEMENT_ID = "gedmerge-site-data";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** JSON that cannot end its `<script>` early: every `<` as an escape (still the
 *  same JSON), and the two line separators JavaScript once choked on. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
}

/** Inline code that cannot close its element early: `</script` (any case)
 *  becomes `<\/script`, which reads the same inside a string, regex or
 *  comment, the only places a bundle can hold it. */
export function inlineSafe(code: string, tag: "script" | "style"): string {
  return code.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");
}

/** Sets the theme before the first paint, as the app's `index.html` does: the
 *  reader's saved choice, else the system's (see `ui/useTheme.ts`). */
const THEME_BOOT =
  'try{var s=localStorage.getItem("gedmerge.theme");document.documentElement.setAttribute("data-theme",s==="light"||s==="dark"?s:matchMedia("(prefers-color-scheme: light)").matches?"light":"dark")}catch(e){document.documentElement.setAttribute("data-theme","dark")}';

/** The site's icon until its own is found (see `viewer/favicon.ts`): GED
 *  Merge's, inline, so it shows from disk too. */
export const DEFAULT_FAVICON = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG.trim())}`;

/** How long a shared link's description may run before it is cut. */
const DESCRIPTION_MAX = 155;

/** The intro in the site's language (else in any), on one line and cut at a
 *  word to what a link preview shows. */
export function siteDescription(tree: PublishedTree, credit = ""): string {
  const intro = tree.intro?.[tree.lang] ?? Object.values(tree.intro ?? {})[0] ?? "";
  const text = intro.replace(/\s+/g, " ").trim();
  // The credit closes it, whole; the intro gives way to make room.
  const room = credit ? DESCRIPTION_MAX - credit.length - 1 : DESCRIPTION_MAX;
  let cut = text;
  if (text.length > room) {
    const head = text.slice(0, Math.max(0, room - 1));
    const at = head.lastIndexOf(" ");
    cut = room > 1 ? `${head.slice(0, at > room / 2 ? at : head.length)}…` : "";
  }
  return [cut, credit].filter(Boolean).join(" ");
}

/** What the page tells search results and link previews beside the tree's own
 *  words: a title naming the tree and GED Merge, and a closing line saying
 *  where it was made — in the site's language (see `site.meta.*`). */
export interface SiteMeta {
  title: string;
  credit: string;
}

/** The site's address made absolute (`https://` where it names none). */
const absoluteUrl = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

/**
 * What a shared link shows — title, description, and the cover photo as its
 * image (Open Graph, read by Facebook, WhatsApp, Slack and the like, and the
 * Twitter card). A preview takes an image by its full address only, so the
 * image (and the page's own address) need the site's address; the image is
 * then beside the page, in its folder.
 */
export function shareMeta(tree: PublishedTree, meta?: SiteMeta): string {
  const name = tree.title || "Family tree";
  const title = meta?.title ?? name;
  const description = siteDescription(tree, meta?.credit);
  const tags: [string, string, string][] = [];
  if (description) tags.push(["name", "description", description]);
  tags.push(["property", "og:type", "website"], ["property", "og:site_name", name], ["property", "og:title", title]);
  if (description) tags.push(["property", "og:description", description]);
  // The page's own address: the site's, else the one its Home button leads to.
  const own = tree.siteUrl?.trim() || tree.url?.trim();
  const url = own ? absoluteUrl(own) : undefined;
  const cover = tree.cover ? tree.photos?.find((p) => p.id === tree.cover) : undefined;
  // The small copy made for previews, else the cover itself.
  const picture = tree.preview ?? (cover ? { path: cover.path } : undefined);
  let image: string | undefined;
  if (url) {
    tags.push(["property", "og:url", url]);
    try {
      // The page's folder: the address itself, or where its page file sits.
      const folder = /\.html?$/i.test(new URL(url).pathname) ? url : url.replace(/\/*$/, "/");
      if (picture) image = new URL(picture.path, folder).href;
    } catch {
      // An address that is no URL: no image to point at.
    }
  }
  if (image) {
    tags.push(["property", "og:image", image]);
    if (tree.preview) {
      tags.push(
        ["property", "og:image:type", "image/jpeg"],
        ["property", "og:image:width", String(tree.preview.width)],
        ["property", "og:image:height", String(tree.preview.height)],
      );
    }
    tags.push(["property", "og:image:alt", name]);
  }
  tags.push(["name", "twitter:card", image ? "summary_large_image" : "summary"]);
  return tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeHtml(value)}">`).join("\n");
}

/** The whole site as one self-contained HTML file: open it from disk, or put it
 *  on any static web server. */
export function publishedHtml(tree: PublishedTree, bundle: ViewerBundle, meta?: SiteMeta): string {
  return pageShell(
    tree,
    meta,
    `<style>${inlineSafe(bundle.css, "style")}</style>`,
    `<script type="application/json" id="${DATA_ELEMENT_ID}">${scriptSafeJson(packTree(tree))}</script>
<script>${inlineSafe(bundle.js, "script")}</script>`,
  );
}

/** The page around the viewer: the head (title, a shared link's preview, the
 *  icon, the theme before the first paint), then the root the viewer fills. */
function pageShell(tree: PublishedTree, meta: SiteMeta | undefined, styles: string, scripts: string): string {
  // The viewer names the tab by the tree alone once it runs.
  const title = escapeHtml(meta?.title ?? (tree.title || "Family tree"));
  return `<!doctype html>
<html lang="${escapeHtml(tree.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="${tree.indexable ? "index, follow" : "noindex, nofollow"}">
<meta name="generator" content="GED Merge (${PUBLISHED_FORMAT})">
<title>${title}</title>
${shareMeta(tree, meta)}
${tree.favicon ? `<link rel="icon" href="${escapeHtml(tree.favicon)}">` : `<link rel="icon" type="image/svg+xml" href="${DEFAULT_FAVICON}">`}
<script>${THEME_BOOT}</script>
${styles}
</head>
<body>
<div id="root"></div>
${scripts}
</body>
</html>
`;
}

/** Where the data file leaves the site's data for the viewer (see `viewer/main.tsx`). */
export const DATA_GLOBAL = "gedmergeSite";

/** A short content hash (FNV-1a, hex), to name the viewer's files by what they hold. */
function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface SiteFile {
  name: string;
  /** A text file's content, or a binary one's (a font). */
  text?: string;
  data?: Uint8Array;
  /** Named after its content: the same name is the same file, whatever the
   *  export, so it may carry a fixed time (an unchanged copy then stays
   *  unchanged for rsync and a browser's cache). */
  stable?: true;
}

/**
 * The site as files beside each other — the ZIP's form: a small `index.html`
 * (the head a shared link's preview reads, and three references), the data in
 * `data-<hash>.js`, and the viewer in files named by their content. The data
 * is named by its content too: a server or browser that caches it then never
 * pairs a new page with old data, whose photos may be gone. A link preview
 * reads only the start of a page, and a large page is refused outright; this
 * one is a few kilobytes. Plain `<script src>`, so it opens from disk too.
 */
export function publishedSiteFiles(tree: PublishedTree, bundle: ViewerBundle, meta?: SiteMeta): SiteFile[] {
  const hash = contentHash(bundle.js + bundle.css);
  const js = `viewer-${hash}.js`;
  const css = `viewer-${hash}.css`;
  const { css: style, fonts } = fontFiles(bundle.css);
  const dataText = `window.${DATA_GLOBAL}=${scriptSafeJson(packTree(tree))};\n`;
  const data = `data-${contentHash(dataText)}.js`;
  return [
    {
      name: "index.html",
      text: pageShell(tree, meta, `<link rel="stylesheet" href="${css}">`, `<script src="${data}"></script>\n<script src="${js}"></script>`),
    },
    { name: data, text: dataText },
    { name: js, text: bundle.js, stable: true },
    { name: css, text: style, stable: true },
    ...fonts.map((f) => ({ ...f, stable: true as const })),
  ];
}

/** The bytes of a base64 text. */
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The stylesheet with its fonts as files beside it (`fonts/<hash>.woff2`)
 * rather than inline: a browser then fetches only the faces and character
 * ranges a page uses (the Latin ones for Slovenian or English), not every
 * alphabet of every weight, and without base64's third more. Named by
 * content, they cache like the viewer's files. Other inline images stay.
 */
export function fontFiles(css: string): { css: string; fonts: { name: string; data: Uint8Array }[] } {
  const fonts = new Map<string, { name: string; data: Uint8Array }>();
  const out = css.replace(/url\((["']?)data:font\/([a-z0-9]+);base64,([A-Za-z0-9+/=]+)\1\)/g, (_m, _q, ext: string, b64: string) => {
    let font = fonts.get(b64);
    if (!font) {
      font = { name: `fonts/${contentHash(b64)}.${ext}`, data: fromBase64(b64) };
      fonts.set(b64, font);
    }
    return `url(${font.name})`;
  });
  return { css: out, fonts: [...fonts.values()] };
}

/** A file name for the site: the title, slugged. */
export function siteFileName(title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "family-tree"}.html`;
}
