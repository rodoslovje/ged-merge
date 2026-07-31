import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { ErrorFallback } from "./ui/ErrorFallback";
// Load order matters (see design README): fonts + tokens before the app's
// index.css so they redefine --bg/--text/etc., then components.css last so its
// overrides win the cascade.
import "./theme/fonts.css";
import "./theme/heritage-pine.css";
import "./index.css";
import "./theme/components.css";
import "./locales/i18n";

// Legacy entry point: the Privacy/Terms texts used to be an in-app modal opened
// with `?legal=privacy|terms`. They are standalone pages now, so an old link (a
// bookmark, an indexed URL, an older build of the guide) is sent on to the page
// in the reader's own language before React mounts. `replace` so Back doesn't
// bounce straight back here.
const legalPage = new URLSearchParams(window.location.search).get("legal");
if (legalPage === "privacy" || legalPage === "terms") {
  let sl = false;
  try {
    sl = localStorage.getItem("gedmerge.lang") === "sl";
  } catch {
    // Storage blocked (private mode, embedded webview) — fall back to English.
  }
  const slug = legalPage === "privacy" ? (sl ? "zasebnost/" : "privacy/") : sl ? "pogoji/" : "terms/";
  window.location.replace(new URL(slug, window.location.href).toString());
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary fallback={(error, reset) => <ErrorFallback error={error} reset={reset} />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
