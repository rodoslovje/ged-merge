import type { PublishedTree } from "./model";
import { PUBLISHED_FORMAT } from "./model";
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
const DESCRIPTION_MAX = 200;

/** The intro in the site's language (else in any), on one line and cut at a
 *  word to what a link preview shows. */
export function siteDescription(tree: PublishedTree): string {
  const intro = tree.intro?.[tree.lang] ?? Object.values(tree.intro ?? {})[0] ?? "";
  const text = intro.replace(/\s+/g, " ").trim();
  if (text.length <= DESCRIPTION_MAX) return text;
  const cut = text.slice(0, DESCRIPTION_MAX - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > DESCRIPTION_MAX / 2 ? cut.lastIndexOf(" ") : cut.length)}…`;
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
export function shareMeta(tree: PublishedTree): string {
  const title = tree.title || "Family tree";
  const description = siteDescription(tree);
  const tags: [string, string, string][] = [];
  if (description) tags.push(["name", "description", description]);
  tags.push(["property", "og:type", "website"], ["property", "og:title", title]);
  if (description) tags.push(["property", "og:description", description]);
  const url = tree.url?.trim() ? absoluteUrl(tree.url.trim()) : undefined;
  const cover = tree.cover ? tree.photos?.find((p) => p.id === tree.cover) : undefined;
  let image: string | undefined;
  if (url) {
    tags.push(["property", "og:url", url]);
    try {
      // The page's folder: the address itself, or where its page file sits.
      const folder = /\.html?$/i.test(new URL(url).pathname) ? url : url.replace(/\/*$/, "/");
      if (cover) image = new URL(cover.path, folder).href;
    } catch {
      // An address that is no URL: no image to point at.
    }
  }
  if (image) tags.push(["property", "og:image", image], ["property", "og:image:alt", title]);
  tags.push(["name", "twitter:card", image ? "summary_large_image" : "summary"]);
  return tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeHtml(value)}">`).join("\n");
}

/** The whole site as one self-contained HTML file: open it from disk, or put it
 *  on any static web server. */
export function publishedHtml(tree: PublishedTree, bundle: ViewerBundle): string {
  return pageShell(
    tree,
    `<style>${inlineSafe(bundle.css, "style")}</style>`,
    `<script type="application/json" id="${DATA_ELEMENT_ID}">${scriptSafeJson(tree)}</script>
<script>${inlineSafe(bundle.js, "script")}</script>`,
  );
}

/** The page around the viewer: the head (title, a shared link's preview, the
 *  icon, the theme before the first paint), then the root the viewer fills. */
function pageShell(tree: PublishedTree, styles: string, scripts: string): string {
  const title = escapeHtml(tree.title || "Family tree");
  return `<!doctype html>
<html lang="${escapeHtml(tree.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="generator" content="GED Merge (${PUBLISHED_FORMAT})">
<title>${title}</title>
${shareMeta(tree)}
<link rel="icon" type="image/svg+xml" href="${DEFAULT_FAVICON}">
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

/** Where `data.js` leaves the site's data for the viewer (see `viewer/main.tsx`). */
export const DATA_GLOBAL = "gedmergeSite";
export const DATA_FILE = "data.js";

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
  text: string;
  /** Named after its content: the same name is the same file, whatever the
   *  export, so it may carry a fixed time (an unchanged copy then stays
   *  unchanged for rsync and a browser's cache). */
  stable?: true;
}

/**
 * The site as files beside each other — the ZIP's form: a small `index.html`
 * (the head a shared link's preview reads, and three references), the data in
 * `data.js`, and the viewer in files named by their content. A link preview
 * reads only the start of a page, and a large page is refused outright; this
 * one is a few kilobytes. Plain `<script src>`, so it opens from disk too.
 */
export function publishedSiteFiles(tree: PublishedTree, bundle: ViewerBundle): SiteFile[] {
  const hash = contentHash(bundle.js + bundle.css);
  const js = `viewer-${hash}.js`;
  const css = `viewer-${hash}.css`;
  return [
    {
      name: "index.html",
      text: pageShell(tree, `<link rel="stylesheet" href="${css}">`, `<script src="${DATA_FILE}"></script>\n<script src="${js}"></script>`),
    },
    { name: DATA_FILE, text: `window.${DATA_GLOBAL}=${scriptSafeJson(tree)};\n` },
    { name: js, text: bundle.js, stable: true },
    { name: css, text: bundle.css, stable: true },
  ];
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
