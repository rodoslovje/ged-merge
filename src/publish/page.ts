import type { PublishedTree } from "./model";
import { PUBLISHED_FORMAT } from "./model";

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

/** The whole site as one self-contained HTML file: open it from disk, or put it
 *  on any static web server. */
export function publishedHtml(tree: PublishedTree, bundle: ViewerBundle): string {
  const title = escapeHtml(tree.title || "Family tree");
  return `<!doctype html>
<html lang="${escapeHtml(tree.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="generator" content="GED Merge (${PUBLISHED_FORMAT})">
<title>${title}</title>
<script>${THEME_BOOT}</script>
<style>${inlineSafe(bundle.css, "style")}</style>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="${DATA_ELEMENT_ID}">${scriptSafeJson(tree)}</script>
<script>${inlineSafe(bundle.js, "script")}</script>
</body>
</html>
`;
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
