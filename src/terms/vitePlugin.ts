import type { Plugin } from "vite";
import { buildTermsPages, termsPageFor, type PageAssets } from "./pages.ts";

/**
 * Builds the extension-tag terms pages (`pages.ts`) into the site, and serves
 * them from the dev server.
 *
 * At build time they are emitted beside the Terms of Service page
 * (`terms/index.html`) and load the same stylesheet and script that page was
 * built with — read from its emitted HTML, so the hashed names always match.
 */
export function termsPagesPlugin(): Plugin {
  return {
    name: "gedmerge-terms-pages",
    configureServer(server) {
      const dev: PageAssets = { css: [], js: ["/src/legal-entry.ts"] };
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split(/[?#]/)[0] ?? "";
        if (!path.startsWith("/terms/")) return next();
        const page = termsPageFor(path, dev);
        if (!page) return next();
        // Like a static host: a page's directory address gains its slash, so
        // the page's relative links resolve.
        if (!path.endsWith("/") && page.file !== "404.html") {
          res.statusCode = 301;
          res.setHeader("Location", `${path}/`);
          res.end();
          return;
        }
        server
          .transformIndexHtml(path, page.html)
          .then((html) => {
            res.statusCode = page.file === "404.html" ? 404 : 200;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(html);
          })
          .catch(next);
      });
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const legal = bundle["terms/index.html"];
        if (!legal || legal.type !== "asset") {
          this.error("terms pages: the Terms of Service page (terms/index.html) is not in the build");
        }
        const html = String(legal.source);
        // Its asset references are relative to /terms/ (`../assets/legal-x.css`).
        const fromRoot = (ref: string) => ref.replace(/^(\.\.\/)+/, "").replace(/^\//, "");
        const assets: PageAssets = {
          css: [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => fromRoot(m[1])),
          js: [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map((m) => fromRoot(m[1])),
        };
        if (assets.css.length === 0) this.error("terms pages: no stylesheet found in terms/index.html");
        for (const page of buildTermsPages(assets)) {
          this.emitFile({ type: "asset", fileName: page.file, source: page.html });
        }
      },
    },
  };
}
