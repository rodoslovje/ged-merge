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
import { IconTipLayer } from "../ui/IconTip";
import { SettingsProvider, DatasetProvider } from "../ui/SettingsContext";
import { ChartSettingsProvider } from "../ui/ChartSettingsContext";
import { SitePhotosProvider } from "./SitePhotos";
import { MediaViewerProvider } from "../ui/MediaViewer";
import { DatasetDerivationsProvider } from "../ui/DatasetDerivations";
import { PublishedViewContext, type PublishedView } from "../ui/PublishedView";
import { exportSiteLink, setExportSite } from "../ui/exportSvg";
import { adoptSiteFavicon } from "./favicon";
import { ChangeJournal } from "../state/mainSync";
import { DATA_ELEMENT_ID, DATA_GLOBAL } from "../publish/page";
import { unpackTree, type PackedTree } from "../publish/pack";
import { PUBLISHED_FORMAT, type PublishedTree } from "../publish/model";
import { useTranslation } from "react-i18next";
import { hydrateTree, pubId, xrefOf } from "../publish/hydrate";
import { routeHash } from "./route";
import { ViewerApp } from "./ViewerApp";

const LANG_KEY = "gedmerge-site.lang";

function readTree(): PublishedTree {
  // A ZIP's site: its data file has left it on the window. One file's: it is in
  // the page itself.
  const loaded = (window as unknown as Record<string, unknown>)[DATA_GLOBAL] as PackedTree | undefined;
  const text = loaded ? undefined : document.getElementById(DATA_ELEMENT_ID)?.textContent;
  const packed = loaded ?? (text ? (JSON.parse(text) as PackedTree) : undefined);
  // Its places as a table (see publish/pack.ts), back into each event.
  const tree = packed ? unpackTree(packed) : undefined;
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
  const { t, i18n } = useTranslation();
  // Rebuilt when the reader switches language: the nameless are named in it.
  const ds = useMemo(
    () => hydrateTree(tree, (deceased, sex) =>
      t(deceased ? "site.deceasedPerson" : "site.livingPerson", { context: sex === "M" || sex === "F" ? sex : undefined })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t follows i18n.language
    [tree, i18n.language],
  );
  const changes = useMemo(() => new ChangeJournal(), []);
  const view = useMemo<PublishedView>(() => ({
    exports: !!tree.exports,
    reduced: new Set(tree.people.filter((p) => p.living).map((p) => xrefOf(p.id))),
    openPerson: (id) => { location.hash = routeHash({ page: "person", id: pubId(id) }); },
  }), [tree]);
  return (
    <PublishedViewContext.Provider value={view}>
      <DatasetProvider dataset={ds}>
        <DatasetDerivationsProvider dataset={ds} version={0} changes={changes}>
          <ViewerApp tree={tree} ds={ds} />
          {/* The hover explanations the statistics (ⓘ) and charts offer. */}
          <IconTipLayer />
        </DatasetDerivationsProvider>
      </DatasetProvider>
    </PublishedViewContext.Provider>
  );
}

const tree = readTree();
// Exports credit GED Merge as the site's footer does, then name the site's own
// address when the author gave one.
// Downloads name the website itself (its own address; a site exported before
// that field had only the other).
const ownAddress = tree.siteUrl || tree.url;
setExportSite(ownAddress, () => `${i18n.t("site.footer.madeWith")} GED Merge`);
// The site's own icon, where the author named its address.
// An icon the author named is in the page already; else the site's own, if any.
if (!tree.favicon && ownAddress) adoptSiteFavicon(exportSiteLink().url);
// The charts' panel button that opens a person in the app's Edit view opens
// their page here: it says so, in both languages.
// The statistics' hints say a name opens "in Edit"; here it opens the person's
// page, so the words about Edit go.
const IN_EDIT: Record<string, RegExp> = { en: / in Edit/g, sl: / v Urejanju/g };
for (const lng of SUPPORTED_LANGUAGES) {
  i18n.addResource(lng, "translation", "relpath.openInEdit", i18n.t("site.person.open", { lng }));
  const bundle = i18n.getResourceBundle(lng, "translation") as Record<string, string>;
  for (const [key, text] of Object.entries(bundle)) {
    if (key.startsWith("stats.") && IN_EDIT[lng].test(text)) {
      i18n.addResource(lng, "translation", key, text.replace(IN_EDIT[lng], ""));
    }
    IN_EDIT[lng].lastIndex = 0;
  }
}
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
      {/* In memory only: a site on the same origin as GED Merge must not
          rewrite the reader's app preferences with its author's. */}
      <SettingsProvider persist={false}>
        <ChartSettingsProvider persist={false}>
          <SitePhotosProvider tree={tree}>
            <MediaViewerProvider>
              <Site tree={tree} />
            </MediaViewerProvider>
          </SitePhotosProvider>
        </ChartSettingsProvider>
      </SettingsProvider>
    </ErrorBoundary>
  </StrictMode>,
);
