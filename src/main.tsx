import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
// Load order matters (see design README): fonts + tokens before the app's
// index.css so they redefine --bg/--text/etc., then components.css last so its
// overrides win the cascade.
import "./theme/fonts.css";
import "./theme/heritage-pine.css";
import "./index.css";
import "./design_handoff_gedmerge_edit_loading/patch.css";
import "./theme/components.css";
import "./locales/i18n";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
