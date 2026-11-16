// Entry of the published family website: the read-only viewer that GED Merge
// bakes into one HTML file together with the tree's display data (see
// `src/publish/`). Built as a single script by `src/publish/vitePlugin.ts`.
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import "../theme/fonts.css";
import "../theme/heritage-pine.css";
import "../index.css";
import "../theme/components.css";
import "./viewer.css";
import i18n, { SUPPORTED_LANGUAGES } from "../locales/i18n";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { ErrorFallback } from "../ui/ErrorFallback";
import { SettingsProvider, DatasetProvider } from "../ui/SettingsContext";
import { ChartSettingsProvider } from "../ui/ChartSettingsContext";
import { MediaFolderProvider } from "../ui/MediaFolderContext";
import { MediaViewerProvider } from "../ui/MediaViewer";
import { DatasetDerivationsProvider } from "../ui/DatasetDerivations";
import { PublishedViewContext } from "../ui/PublishedView";
import { ChangeJournal } from "../state/mainSync";
import { DATA_ELEMENT_ID } from "../publish/page";
import { PUBLISHED_FORMAT, type PublishedTree } from "../publish/model";
import { hydrateTree } from "../publish/hydrate";
import { ViewerApp } from "./ViewerApp";

const LANG_KEY = "gedmerge-site.lang";

function readTree(): PublishedTree {
  const text = document.getElementById(DATA_ELEMENT_ID)?.textContent;
  const tree = text ? (JSON.parse(text) as PublishedTree) : undefined;
  if (tree?.format !== PUBLISHED_FORMAT) throw new Error("No family tree data on this page.");
  return tree;
}

/** The reader's own language choice, else the one the author published in. */
function startLanguage(tree: PublishedTree): string {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LANG_KEY);
  } catch {
    // Storage blocked: the author's language.
  }
  const ok = (l: string | null): l is string => !!l && (SUPPORTED_LANGUAGES as readonly string[]).includes(l);
  return ok(saved) ? saved : ok(tree.lang) ? tree.lang : "en";
}

function Site({ tree }: { tree: PublishedTree }) {
  const ds = useMemo(() => hydrateTree(tree), [tree]);
  const changes = useMemo(() => new ChangeJournal(), []);
  return (
    <PublishedViewContext.Provider value>
      <DatasetProvider dataset={ds}>
        <DatasetDerivationsProvider dataset={ds} version={0} changes={changes}>
          <ViewerApp tree={tree} ds={ds} />
        </DatasetDerivationsProvider>
      </DatasetProvider>
    </PublishedViewContext.Provider>
  );
}

const tree = readTree();
void i18n.changeLanguage(startLanguage(tree));
i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
  try {
    localStorage.setItem(LANG_KEY, lng);
  } catch {
    // Storage blocked: the choice lasts for this visit.
  }
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary fallback={(error, reset) => <ErrorFallback error={error} reset={reset} />}>
      <SettingsProvider>
        <ChartSettingsProvider>
          <MediaFolderProvider>
            <MediaViewerProvider>
              <Site tree={tree} />
            </MediaViewerProvider>
          </MediaFolderProvider>
        </ChartSettingsProvider>
      </SettingsProvider>
    </ErrorBoundary>
  </StrictMode>,
);
