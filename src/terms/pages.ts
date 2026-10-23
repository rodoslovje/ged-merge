import { REGISTRY_COMMIT, REGISTRY_ENTRIES } from "../gedcom/extensionRegistry.ts";
import {
  CATEGORY_LABEL, TERMS_ORIGIN, TERMS_VENDORS, termsEntries, termsPath, type TermsEntry,
} from "../gedcom/extensionTerms.ts";

/**
 * The static pages behind the GED Merge extension-tag URIs
 * (`gedcom/extensionTerms.ts`), rendered at build time by `vitePlugin.ts`:
 *
 *  - `terms/<vendor>/<TAG>/index.html` — one tag as one program writes it;
 *  - `terms/<vendor>/index.html`       — that program's tags;
 *  - `terms/extensions/index.html`     — every program and tag (`/terms/`
 *                                        itself is the Terms of Service);
 *  - `terms/unknown/index.html`        — what an unknown tag's URI means;
 *  - `404.html`                        — the site's not-found page, which also
 *                                        answers `terms/unknown/<TAG>` for any
 *                                        tag, since no table can list them all.
 *
 * Each page has the legal pages' shell (`terms/index.html`): the same
 * stylesheet, top bar, theme switch and footer, so it follows both themes.
 */

/** The stylesheets and scripts a page loads, as paths from the site root
 *  (`assets/legal-x.css`), or absolute (`/src/legal-entry.ts`) in dev. */
export interface PageAssets {
  css: string[];
  js: string[];
}

export interface TermsPage {
  /** Output path from the site root, e.g. `terms/myheritage/_UPD/index.html`. */
  file: string;
  html: string;
}

const GUIDE_ANCHOR = "guide/#extension-tags";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const vendorName = (slug: string): string => TERMS_VENDORS.find((v) => v.slug === slug)?.name ?? slug;

/** `../` up to the site root from a page at `file`; `/` for a page served at
 *  any path (the 404 page). */
function rootOf(file: string, absolute = false): string {
  if (absolute) return "/";
  return "../".repeat(file.split("/").length - 1) || "./";
}

function shell(opts: {
  file: string;
  title: string;
  description: string;
  canonical?: string;
  assets: PageAssets;
  side: string;
  body: string;
  absolute?: boolean;
  noindex?: boolean;
}): string {
  const root = rootOf(opts.file, opts.absolute);
  const asset = (p: string) => (p.startsWith("/") ? p : root + p);
  const css = opts.assets.css.map((p) => `    <link rel="stylesheet" crossorigin href="${esc(asset(p))}" />`).join("\n");
  const js = opts.assets.js.map((p) => `    <script type="module" crossorigin src="${esc(asset(p))}"></script>`).join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="${root}favicon.svg" />
    <link rel="icon" type="image/png" sizes="32x32" href="${root}icons/app-icon-32.png" />
    <link rel="apple-touch-icon" href="${root}icons/app-icon-180.png" />
    <meta name="theme-color" content="#151310" />
    <title>${esc(opts.title)} — GED Merge</title>
    <meta name="description" content="${esc(opts.description)}" />
${opts.canonical ? `    <link rel="canonical" href="${esc(opts.canonical)}" />\n` : ""}${opts.noindex ? `    <meta name="robots" content="noindex" />\n` : ""}    <script>
      // Set the theme before first paint: saved choice, else the OS preference.
      (function () {
        try {
          var saved = localStorage.getItem("gedmerge.theme");
          var theme = saved || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
          document.documentElement.setAttribute("data-theme", theme);
        } catch (e) {
          document.documentElement.setAttribute("data-theme", "dark");
        }
      })();
    </script>
${js}
${css}
  </head>
  <body>
    <header class="guide-topbar">
      <div class="guide-topbar-inner">
        <a class="gm-wordmark-link" href="${root}" aria-label="GED Merge">
          <span class="gm-wordmark">
            <span class="gm-wordmark-logo">
              <svg width="33" height="33" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="9" y1="31" x2="9" y2="11" />
                <line x1="9" y1="11" x2="20" y2="23.5" />
                <line x1="31" y1="11" x2="20" y2="23.5" />
                <line x1="31" y1="31" x2="31" y2="11" />
                <circle cx="9" cy="11" r="3.3" />
                <circle cx="31" cy="11" r="3.3" />
                <circle cx="20" cy="23.5" r="3.3" fill="currentColor" stroke="none" />
              </svg>
            </span>
            <span class="gm-wordmark-text"><span class="gm-wordmark-ged">GED</span><span class="gm-wordmark-merge">&nbsp;Merge</span></span>
          </span>
        </a>
        <div class="guide-topbar-controls">
          <button type="button" class="nav-btn icon-only" id="gm-theme" aria-label="Toggle theme" title="Toggle theme">🌙</button>
        </div>
      </div>
    </header>

    <div class="guide-shell">
      <aside class="guide-side">
        <p class="guide-side-title">Extension tags</p>
        <nav class="guide-toc-nav" aria-label="Extension tags">
          <ol>
${opts.side}
            <li class="guide-toc-part">See also</li>
            <li><a href="${root}terms/extensions/">All programs and tags</a></li>
            <li><a href="${root}${GUIDE_ANCHOR}">User's Guide: extension tags</a></li>
          </ol>
        </nav>
      </aside>

      <main class="guide-main">
${opts.body}
      </main>
    </div>

    <footer class="app-footer guide-footer">
      <a href="https://luka.renko.fyi" target="_blank" rel="noopener noreferrer">© 2026 Luka Renko</a>
      <span class="app-footer-sep">·</span>
      <a class="app-footer-link" href="${root}guide/">User's Guide</a>
      <span class="app-footer-sep">·</span>
      <a class="app-footer-link" href="${root}privacy/">Privacy</a>
      <span class="app-footer-sep">·</span>
      <a class="app-footer-link" href="${root}terms/">Terms</a>
      <span class="app-footer-sep">·</span>
      <a class="app-footer-link" href="mailto:support@gedmerge.com">Contact</a>
    </footer>

    <script>
      // Theme toggle, sharing the app's "gedmerge.theme" key.
      (function () {
        var btn = document.getElementById("gm-theme");
        if (!btn) return;
        function render() {
          btn.textContent = document.documentElement.getAttribute("data-theme") === "dark" ? "🌙" : "☀️";
        }
        render();
        btn.addEventListener("click", function () {
          var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
          document.documentElement.setAttribute("data-theme", next);
          try { localStorage.setItem("gedmerge.theme", next); } catch (e) {}
          render();
        });
      })();
    </script>
  </body>
</html>
`;
}

/** The tag's own URI, as a GEDCOM 7 header writes it: no trailing slash. */
const uriOf = (vendor: string, tag: string): string => TERMS_ORIGIN + termsPath(vendor, tag);

function contextHtml(e: TermsEntry): string {
  if (!e.seenIn?.length) return esc(e.context);
  const paths = e.seenIn.map((p) => (p ? `<code>${esc(p)}</code>` : "a record of its own (level 0)"));
  return `Found in files under ${paths.join(", ")}.`;
}

function standardHtml(e: TermsEntry): string {
  if (!e.standard) return "None: GEDCOM 7 has no structure of its own for this.";
  const note = e.standard.converted
    ? " GED Merge writes it in this tag's place when it converts a file to GEDCOM 7.0, and back when it converts to 5.5.1."
    : "";
  return `<code>${esc(e.standard.form)}</code>.${note}`;
}

/** The other programs the vendor-tag registry names for the tag. */
function alsoWrittenBy(e: TermsEntry, program: string): string {
  if (e.vendor === "gedmerge") return "";
  if (e.software === "multiple programs") return " (and other programs)";
  const others = e.software.split("/").filter((s) => s !== program);
  return others.length ? ` (also ${esc(others.join(", "))})` : "";
}

function tagPage(e: TermsEntry, assets: PageAssets): TermsPage {
  const file = `terms/${e.vendor}/${e.tag}/index.html`;
  const root = rootOf(file);
  const program = vendorName(e.vendor);
  const several = e.vendor === "common";
  const rows = [
    ["Tag", `<code>${esc(e.tag)}</code>`],
    ["URI", `<code>${esc(uriOf(e.vendor, e.tag))}</code>`],
    ["Program", several ? "Several programs write it." : esc(program) + alsoWrittenBy(e, program)],
    ["Meaning", esc(e.meaning.en.charAt(0).toUpperCase() + e.meaning.en.slice(1)) + (e.meaning.sl ? `<br /><span lang="sl">Slovensko: ${esc(e.meaning.sl)}</span>` : "")],
    ...(e.category ? [["Kind", esc(CATEGORY_LABEL[e.category])]] : []),
    ["Where it appears", contextHtml(e)],
    ["GEDCOM 7 standard form", standardHtml(e)],
  ];
  const others = termsEntries().filter((o) => o.tag === e.tag && o.vendor !== e.vendor);
  const body = `        <header class="guide-header">
          <h1><code>${esc(e.tag)}</code></h1>
          <p>An extension tag ${several ? "several genealogy programs write" : `as ${esc(program)} writes it`}, documented for GEDCOM 7 headers that declare it.</p>
        </header>
        <article class="guide-body">
          <table class="gm-table">
            <tbody>
${rows.map(([k, v]) => `              <tr><td>${k}</td><td>${v}</td></tr>`).join("\n")}
            </tbody>
          </table>
          <p>
            A GEDCOM 7 file lists the extension tags it uses in its header, under <code>HEAD.SCHMA</code>, each with a
            URI that says what the tag means. GED Merge declares <code>${esc(e.tag)}</code> with the URI above when it
            saves a file that carries ${several ? "the tag" : `${esc(program)}'s tag`} as GEDCOM 7.0. The tag and
            everything under it are kept as the file has them.
          </p>
${others.length ? `          <p>The same tag as other programs write it: ${others.map((o) => `<a href="${root}terms/${o.vendor}/${encodeURIComponent(o.tag)}/">${esc(vendorName(o.vendor))}</a>`).join(", ")}.</p>\n` : ""}          <p><a href="${root}terms/${e.vendor}/">All ${several ? "shared" : esc(program)} tags</a> · <a href="${root}${GUIDE_ANCHOR}">How GED Merge declares extension tags</a></p>
        </article>`;
  return {
    file,
    html: shell({
      file, assets, body,
      title: `${e.tag} (${several ? "several programs" : program})`,
      description: `The GEDCOM extension tag ${e.tag}${several ? "" : ` as ${program} writes it`}: ${e.meaning.en}.`,
      canonical: `${uriOf(e.vendor, e.tag)}/`,
      side: `            <li><a href="${root}terms/${e.vendor}/">${esc(program)}</a></li>`,
    }),
  };
}

function tagList(entries: TermsEntry[], root: string): string {
  return `          <table class="gm-table">
            <tbody>
${entries.map((e) => `              <tr><td><a href="${root}terms/${e.vendor}/${encodeURIComponent(e.tag)}/"><code>${esc(e.tag)}</code></a></td><td>${esc(e.meaning.en)}</td></tr>`).join("\n")}
            </tbody>
          </table>`;
}

function vendorPage(slug: string, entries: TermsEntry[], assets: PageAssets): TermsPage {
  const file = `terms/${slug}/index.html`;
  const root = rootOf(file);
  const name = vendorName(slug);
  const lead = slug === "common"
    ? "Extension tags that several genealogy programs write, documented for a file from none of the programs listed here."
    : slug === "gedmerge"
      ? "The extension tags GED Merge itself writes, where a GEDCOM version has no structure for the content."
      : `The extension tags ${esc(name)} writes, as GED Merge knows them.`;
  const body = `        <header class="guide-header">
          <h1>${esc(name)}</h1>
          <p>${lead}</p>
        </header>
        <article class="guide-body">
${tagList(entries, root)}
        </article>`;
  return {
    file,
    html: shell({
      file, assets, body,
      title: `${name} extension tags`,
      description: `GEDCOM extension tags of ${name}, with what each one means.`,
      canonical: `${TERMS_ORIGIN}/terms/${slug}/`,
      side: `            <li><a href="${root}terms/${slug}/">${esc(name)}</a></li>`,
    }),
  };
}

function indexPage(byVendor: Map<string, TermsEntry[]>, assets: PageAssets): TermsPage {
  const file = "terms/extensions/index.html";
  const root = rootOf(file);
  const sections = [...byVendor].map(([slug, entries]) => `          <section id="${slug}">
            <h2><a href="${root}terms/${slug}/">${esc(vendorName(slug))}</a></h2>
${tagList(entries, root)}
          </section>`).join("\n");
  const registry = REGISTRY_ENTRIES.map((r) => `              <tr><td><code>${esc(r.tag)}</code></td><td><a href="${esc(r.uri)}">${esc(r.uri)}</a> (${esc(r.by)})</td></tr>`).join("\n");
  const body = `        <header class="guide-header">
          <h1>GEDCOM extension tags</h1>
          <p>
            What the URIs GED Merge writes into a GEDCOM 7 header (<code>HEAD.SCHMA</code>) point to: one page per
            extension tag and the program that writes it.
          </p>
        </header>
        <article class="guide-body">
          <p>
            A tag with a standard GEDCOM 7 form is converted to it instead, and a tag documented in the
            <a href="https://github.com/FamilySearch/GEDCOM-registries">FamilySearch GEDCOM registry</a> keeps the
            registry's URI where it stands in its registered place. A tag no table knows points to
            <a href="${root}terms/unknown/">an unknown tag's page</a>.
          </p>
${sections}
          <section id="registry">
            <h2>From the FamilySearch registry</h2>
            <p>Declared with the registry's own URI (registry commit <code>${REGISTRY_COMMIT.slice(0, 8)}</code>).</p>
            <table class="gm-table">
              <tbody>
${registry}
              </tbody>
            </table>
          </section>
        </article>`;
  return {
    file,
    html: shell({
      file, assets, body,
      title: "GEDCOM extension tags",
      description: "Every GEDCOM extension tag GED Merge documents, by the program that writes it.",
      canonical: `${TERMS_ORIGIN}/terms/extensions/`,
      side: [...byVendor.keys()].map((slug) => `            <li><a href="#${slug}">${esc(vendorName(slug))}</a></li>`).join("\n"),
    }),
  };
}

const UNKNOWN_BODY = (tag: string, root: string) => `        <header class="guide-header">
          <h1 id="gm-unknown-title">${tag ? `<code>${esc(tag)}</code>` : "An unknown extension tag"}</h1>
          <p>An extension tag whose meaning GED Merge does not know.</p>
        </header>
        <article class="guide-body">
          <p>
            A GEDCOM 7 file lists the extension tags it uses in its header, under <code>HEAD.SCHMA</code>, each with a
            URI that says what the tag means. When GED Merge saves a file as GEDCOM 7.0 and the file carries an extension
            tag that neither its own tables nor the
            <a href="https://github.com/FamilySearch/GEDCOM-registries">FamilySearch GEDCOM registry</a> know, it
            declares the tag with a URI under <code>${TERMS_ORIGIN}/terms/unknown/</code>.
          </p>
          <p>
            Such a URI only says that the tag was found in the file. What the tag means is up to the program that wrote
            it — the file's header names that program under <code>HEAD.SOUR</code>, and its documentation is the place
            to look. GED Merge keeps the tag and everything under it as the file has it.
          </p>
          <p><a href="${root}terms/extensions/">All the tags GED Merge knows</a> · <a href="${root}${GUIDE_ANCHOR}">How GED Merge declares extension tags</a></p>
        </article>`;

function unknownPage(assets: PageAssets): TermsPage {
  const file = "terms/unknown/index.html";
  return {
    file,
    html: shell({
      file, assets, body: UNKNOWN_BODY("", rootOf(file)),
      title: "Unknown extension tag",
      description: "What a GED Merge URI for an unknown GEDCOM extension tag means.",
      canonical: `${TERMS_ORIGIN}/terms/unknown/`,
      side: "",
    }),
  };
}

/**
 * The site's not-found page. Static hosts serve it for any missing path, so
 * it is what answers `terms/unknown/<TAG>`: there, a script names the tag
 * from the address; anywhere else the page says it was not found.
 */
function notFoundPage(assets: PageAssets): TermsPage {
  const file = "404.html";
  const body = `        <div id="gm-unknown">
${UNKNOWN_BODY("", "/")}
        </div>
        <div id="gm-missing" hidden>
          <header class="guide-header">
            <h1>Page not found</h1>
            <p>There is no page at this address.</p>
          </header>
          <article class="guide-body">
            <p><a href="/">Open GED Merge</a> · <a href="/guide/">User's Guide</a></p>
          </article>
        </div>
        <script>
          // An unknown tag's URI (/terms/unknown/<TAG>) names its tag; any other
          // missing address is just not found.
          (function () {
            var m = /^\\/terms\\/unknown\\/([^/]+)\\/?$/.exec(location.pathname);
            if (!m) {
              document.getElementById("gm-unknown").hidden = true;
              document.getElementById("gm-missing").hidden = false;
              document.title = "Page not found — GED Merge";
              return;
            }
            var tag = decodeURIComponent(m[1]);
            var title = document.getElementById("gm-unknown-title");
            title.textContent = "";
            var code = document.createElement("code");
            code.textContent = tag;
            title.appendChild(code);
            document.title = tag + " (unknown extension tag) — GED Merge";
          })();
        </script>`;
  return {
    file,
    html: shell({
      file, assets, body, absolute: true, noindex: true,
      title: "Unknown extension tag",
      description: "What a GED Merge URI for an unknown GEDCOM extension tag means.",
      side: "",
    }),
  };
}

/** Every terms page. Paths are unique; the tag pages come first. */
export function buildTermsPages(assets: PageAssets): TermsPage[] {
  const entries = termsEntries();
  const byVendor = new Map<string, TermsEntry[]>();
  for (const e of entries) {
    const list = byVendor.get(e.vendor) ?? [];
    list.push(e);
    byVendor.set(e.vendor, list);
  }
  return [
    ...entries.map((e) => tagPage(e, assets)),
    ...[...byVendor].map(([slug, list]) => vendorPage(slug, list, assets)),
    indexPage(byVendor, assets),
    unknownPage(assets),
    notFoundPage(assets),
  ];
}

/** The page a dev-server request path asks for, if it is a terms page —
 *  including any `terms/unknown/<TAG>`, which the built site answers with
 *  its 404 page. */
export function termsPageFor(pathname: string, assets: PageAssets): TermsPage | undefined {
  const path = decodeURIComponent(pathname).replace(/^\/+/, "").replace(/\/?$/, "/");
  const pages = buildTermsPages(assets);
  const hit = pages.find((p) => p.file === `${path}index.html`);
  if (hit) return hit;
  const unknown = /^terms\/unknown\/([^/]+)\/$/.exec(path);
  return unknown ? pages.find((p) => p.file === "404.html") : undefined;
}
