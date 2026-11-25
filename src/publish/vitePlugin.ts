import { resolve } from "node:path";
import type { Plugin } from "vite";

/** What the plugin hands the app: the viewer as one script and one stylesheet
 *  (the shape `page.ts` names ViewerBundle; restated here so the build config
 *  does not pull the app sources into its own type project). */
interface ViewerBundle {
  js: string;
  css: string;
}

/**
 * Builds the family website's viewer (`src/viewer/main.tsx`) into one script
 * and one stylesheet, and hands both to the app as the virtual module
 * `virtual:site-viewer` (`{ js, css }`). The app inlines them, with the tree's
 * data, into the single HTML file it exports (see `page.ts`) — so the export
 * works offline, from the precached app, with nothing to fetch.
 *
 * Everything is inlined: fonts as data URLs, the map chunk into the script.
 * The build runs once per app build; in dev, on first import and again after
 * a source file changes.
 */
export const VIEWER_MODULE = "virtual:site-viewer";
const RESOLVED = "\0" + VIEWER_MODULE;

export function siteViewerPlugin(define: Record<string, string>): Plugin {
  let bundle: Promise<ViewerBundle> | null = null;
  let root = process.cwd();
  return {
    name: "gedmerge-site-viewer",
    configResolved(config) {
      root = config.root;
    },
    resolveId(id) {
      return id === VIEWER_MODULE ? RESOLVED : undefined;
    },
    async load(id) {
      if (id !== RESOLVED) return undefined;
      bundle ??= buildViewer(root, define);
      const { js, css } = await bundle;
      return `export const js = ${JSON.stringify(js)};\nexport const css = ${JSON.stringify(css)};\n`;
    },
    // Dev: a change anywhere in the sources may touch the viewer — rebuild it
    // on the next import rather than tracking its graph.
    handleHotUpdate({ file, server }) {
      if (!file.includes("/src/")) return;
      bundle = null;
      const mod = server.moduleGraph.getModuleById(RESOLVED);
      if (mod) server.moduleGraph.invalidateModule(mod);
    },
  };
}

/** The photo viewer's face finder loads a 13 MB model the site never uses (it
 *  publishes no photos): its `?url` assets resolve to nothing in the viewer. */
function noFaceModels(): Plugin {
  const EMPTY = "\0site-viewer-empty-url";
  return {
    name: "gedmerge-site-viewer-no-face-models",
    enforce: "pre",
    resolveId(id) {
      return id.endsWith("?url") && /mediapipe|\/models\//.test(id) ? EMPTY : undefined;
    },
    load(id) {
      return id === EMPTY ? 'export default "";' : undefined;
    },
  };
}

async function buildViewer(root: string, define: Record<string, string>): Promise<ViewerBundle> {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const result = await build({
    configFile: false,
    root,
    base: "./",
    logLevel: "warn",
    // Always a production build, also when the dev server asks for it: the
    // site is what relatives get, never a development React.
    mode: "production",
    define,
    plugins: [react(), noFaceModels()],
    build: {
      write: false,
      emptyOutDir: false,
      cssCodeSplit: false,
      modulePreload: false,
      assetsInlineLimit: () => true,
      chunkSizeWarningLimit: 100_000,
      rolldownOptions: {
        input: resolve(root, "src/viewer/main.tsx"),
        // One script has no `import.meta`; the app reaches it only to load
        // chunks and workers. The site inlines its chunks and can load no
        // worker file: a chart it shows must import its worker `?worker&inline`
        // (as NetworkChart does), never as `new URL(…, import.meta.url)`.
        onLog(level, log, handler) {
          if (log.code !== "EMPTY_IMPORT_META") handler(level, log);
        },
        output: { format: "iife", entryFileNames: "viewer.js", assetFileNames: "[name][extname]" },
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as { output: ({ type: "chunk"; code: string } | { type: "asset"; fileName: string; source: string | Uint8Array })[] }[];
  let js = "";
  let css = "";
  for (const out of outputs) {
    for (const file of out.output) {
      if (file.type === "chunk") js += file.code;
      else if (file.fileName.endsWith(".css")) css += typeof file.source === "string" ? file.source : new TextDecoder().decode(file.source);
    }
  }
  if (!js) throw new Error("site viewer: the build produced no script");
  return { js, css };
}
