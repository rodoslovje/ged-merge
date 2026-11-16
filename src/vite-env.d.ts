/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />
/// <reference types="vite-plugin-pwa/client" />

// Injected by vite.config.ts `define` — the last commit date (yyyy-mm-dd).
declare const __APP_VERSION__: string;

// The family website's viewer, built into one script + stylesheet by
// src/publish/vitePlugin.ts.
declare module "virtual:site-viewer" {
  export const js: string;
  export const css: string;
}
