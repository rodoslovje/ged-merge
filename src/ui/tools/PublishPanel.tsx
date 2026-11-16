import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { nextTask, runSliced } from "../../state/localLoad";
import {
  buildPublishedTreeSteps,
  defaultPublishOptions,
  LIVING_MODES,
  SCOPE_KINDS,
  SITE_INCLUDES,
  START_PAGES,
  type LivingMode,
  type PublishOptions,
  type PublishSummary,
  type ScopeKind,
  type SiteDisplay,
  type StartPage,
} from "../../publish/model";
import { publishedHtml, publishedSiteFiles, siteFileName } from "../../publish/page";
import { previewImage } from "../../publish/previewImage";

/** The time the viewer's content-named files carry in the ZIP: any fixed one. */
const STABLE_TIME = new Date(Date.UTC(2026, 0, 1));
import { clearStoredPublish, readStoredPublish, writeStoredPublish } from "../../publish/stored";
import type { NameOrder } from "../../gedcom/nameDisplay";
import { baseStem, downloadBlob, downloadText } from "../download";
import { useMediaFolder } from "../MediaFolderContext";
import { zipFiles, type ZipFile } from "../../publish/zip";
import { withoutPhotos } from "../../publish/photos";
import { StartPersonSelector } from "../StartPersonSelector";
import { SelectMenu } from "../DropdownMenu";
import { PublishPhotoFolders } from "./PublishPhotoFolders";
import { PublishCover } from "./PublishCover";
import { overlayDisplayName, useSettingsSlice } from "../SettingsContext";
import { BASEMAPS, CUSTOM_BASEMAP } from "../map/basemapPresets";
import { LANGUAGE_FLAGS, LANGUAGE_NAMES, SUPPORTED_LANGUAGES } from "../../locales/i18n";
import { DATE_DISPLAY_CHOICES, DATE_DISPLAY_WORDS } from "../dateDisplayFormat";
import { ToolsIntro, ToolsLoading } from "./shared";
import { ToolSummary } from "./ToolSummary";

/** The app's display settings a site carries (see {@link SiteDisplay}). */
const PERSIST_KEYS = ["persistWorkspace"] as const;
/** The author's map, which the site's map starts from. */
const MAP_KEYS = ["mapBasemap", "mapTileUrl", "mapOverlays"] as const;
const DISPLAY_KEYS = ["order", "uppercaseSurname", "marriedSurname", "dateDisplay", "showAge", "showKinship", "emphasizeDirect"] as const;

/** The on/off display settings, with their labels in Settings. */
const DISPLAY_TOGGLES: [key: "uppercaseSurname" | "marriedSurname" | "showAge" | "showKinship" | "emphasizeDirect", label: string][] = [
  ["marriedSurname", "settings.name.married"],
  ["uppercaseSurname", "settings.name.uppercase"],
  ["showAge", "settings.display.age"],
  ["showKinship", "settings.display.kinship"],
  ["emphasizeDirect", "settings.display.emphasizeDirect"],
];

/** Where a download is: which step, and in the walk over the file, how far. */
interface Phase {
  step: "viewer" | "data" | "photos" | "page";
  done?: number;
  total?: number;
}

/**
 * Tools → Family website: the tree as one self-contained HTML page for
 * relatives to browse — the app's charts, statistics and person pages over
 * display data only (see `src/publish/`), with living people left out or
 * reduced. Nothing of the live file changes; the page is a download.
 */
export function PublishPanel({ dataset, fileName, startId, editVersion, active }: {
  dataset: Dataset;
  fileName: string;
  startId?: string;
  editVersion: number;
  active: boolean;
}) {
  const { t, i18n } = useTranslation();
  // The site shows people as the app does for its author, unless changed here;
  // a file's own date text reads poorly to relatives, so dates default to words.
  const appDisplay = useSettingsSlice(DISPLAY_KEYS);
  // With the workspace kept in the browser, the choices made for this file
  // last time come back; without it nothing is kept (see publish/stored.ts).
  const { persistWorkspace } = useSettingsSlice(PERSIST_KEYS);
  const appMap = useSettingsSlice(MAP_KEYS);
  const [stored] = useState(() => {
    const defaults = defaultPublishOptions(
      baseStem(fileName),
      i18n.language,
      { ...appDisplay, dateDisplay: appDisplay.dateDisplay || DATE_DISPLAY_WORDS },
      { basemap: appMap.mapBasemap, tileUrl: appMap.mapTileUrl, overlays: appMap.mapOverlays },
    );
    return (persistWorkspace ? readStoredPublish(fileName, defaults) : undefined) ?? { options: defaults };
  });
  const [options, setOptions] = useState<PublishOptions>(stored.options);
  const display = options.display;
  const setDisplay = (patch: Partial<SiteDisplay>) => setOptions((o) => ({ ...o, display: { ...o.display, ...patch } }));
  const [ownStart, setOwnStart] = useState<string | undefined>(stored.start);
  useEffect(() => {
    if (persistWorkspace) writeStoredPublish(fileName, ownStart ? { options, start: ownStart } : { options });
    else clearStoredPublish();
  }, [persistWorkspace, fileName, options, ownStart]);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the last download could not include (photos missing from the folder).
  const [notice, setNotice] = useState<string | null>(null);
  const media = useMediaFolder();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const set = (patch: Partial<PublishOptions>) => setOptions((o) => ({ ...o, ...patch }));
  const siteStart = ownStart && dataset.individuals.has(ownStart) ? ownStart : startId;
  // The edit version as of now, for a walk that spans several tasks: an edit
  // in between makes its privacy decisions stale (see `download`).
  const versionRef = useRef(editVersion);
  useEffect(() => { versionRef.current = editVersion; }, [editVersion]);
  // The map layers the site offers: those ticked here that Settings → Map
  // still holds, as Settings holds them now — a layer removed or changed there
  // since it was ticked is not published from a stale copy.
  const siteOverlays = useMemo(
    () => appMap.mapOverlays.filter((o) => options.map.overlays.some((x) => x.id === o.id)),
    [appMap.mapOverlays, options.map.overlays],
  );

  // The counts follow the choices when React has a moment — a title typed
  // letter by letter does not re-walk the file on every key — and are walked
  // in slices, so a file of half a million people keeps the page responsive.
  const settled = useDeferredValue(options);
  const [summary, setSummary] = useState<PublishSummary | undefined>();
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void runSliced(buildPublishedTreeSteps(dataset, settled, siteStart), () => !cancelled).then((r) => {
      if (r && !cancelled) setSummary(r.summary);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editVersion: the dataset is mutated in place
  }, [active, dataset, settled.scope, settled.partners, settled.living, settled.recentDeathYears, settled.include, siteStart, editVersion]);

  // The download's three steps, each named while it runs: loading the viewer
  // (a large chunk, fetched on the first export), walking the file — in slices,
  // with a percentage — and writing the page. An edit to the file while it
  // walks stops it: the people checked before the edit may not be the people
  // published after it.
  const download = async () => {
    const version = versionRef.current;
    const alive = () => mounted.current && versionRef.current === version;
    setError(null);
    setNotice(null);
    setPhase({ step: "viewer" });
    try {
      const bundle = await import("virtual:site-viewer");
      if (!alive()) return;
      setPhase({ step: "data", done: 0, total: 1 });
      const site = { ...options, map: { ...options.map, overlays: siteOverlays }, lang: i18n.language };
      const steps = buildPublishedTreeSteps(dataset, site, siteStart, new Date(), (done, total) => {
        if (alive()) setPhase({ step: "data", done, total });
      });
      const result = await runSliced(steps, alive);
      if (!result) {
        if (mounted.current) setError(t("tools.publish.changed"));
        return;
      }
      // Photos: each read from the media folder; one that is not there is left
      // out of the page too, so no picture shows broken.
      let tree = result.tree;
      const photos: ZipFile[] = [];
      if (result.files.length) {
        const missing = new Set<string>();
        for (const [i, f] of result.files.entries()) {
          if (!alive()) return;
          setPhase({ step: "photos", done: i, total: result.files.length });
          // The original file, so the photo keeps its time in the ZIP (an
          // unchanged photo is then skipped by rsync on the next upload).
          const file = (await media.resolveFileObject?.(f.source)) ?? null;
          const data = file ? await file.arrayBuffer().catch(() => null) : null;
          if (file && data) photos.push({ name: f.path, data: new Uint8Array(data), modified: new Date(file.lastModified) });
          else missing.add(f.path);
        }
        if (missing.size) {
          tree = withoutPhotos(tree, missing);
          setNotice(t("tools.publish.photosMissing", { count: missing.size }));
        }
        // The cover, small, for a shared link's preview — with the cover's time,
        // so an unchanged cover makes an unchanged preview for rsync.
        const cover = tree.cover ? tree.photos?.find((p) => p.id === tree.cover) : undefined;
        const original = cover && photos.find((p) => p.name === cover.path);
        const small = original ? await previewImage(original.data) : null;
        if (cover && original && small) {
          const path = `photos/${cover.id}-preview.jpg`;
          photos.push({ name: path, data: small.data, modified: original.modified });
          tree = { ...tree, preview: { path, width: small.width, height: small.height } };
        }
      }
      setPhase({ step: "page" });
      await nextTask();
      // In the site's language: what search results and link previews show.
      const tSite = i18n.getFixedT(tree.lang);
      const meta = { title: tSite("site.meta.title", { title: tree.title || tSite("site.untitled") }), credit: tSite("site.meta.credit") };
      if (options.include.photos) {
        // The site as files and its photos, ready to unpack onto a web server:
        // a small index.html a link preview can read. The viewer's files keep
        // a fixed time — their names change with their content — so rsync
        // skips them until GED Merge changes.
        const enc = new TextEncoder();
        const site = publishedSiteFiles(tree, bundle, meta).map((f) => ({
          name: f.name,
          data: f.data ?? enc.encode(f.text ?? ""),
          ...(f.stable ? { modified: STABLE_TIME } : {}),
        }));
        const zip = zipFiles([...site, ...photos]);
        downloadBlob(siteFileName(options.title).replace(/\.html$/, ".zip"), new Blob([zip], { type: "application/zip" }));
      } else {
        downloadText(siteFileName(options.title), publishedHtml(tree, bundle, meta), "text/html;charset=utf-8");
      }
    } catch (e) {
      if (alive()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive()) setPhase(null);
    }
  };

  const num = (n: number) => n.toLocaleString(i18n.language);
  const scoped = options.scope !== "all";

  return (
    <div className="tools-privacy tools-publish">
      <ToolsIntro>{t("tools.publish.intro")}</ToolsIntro>

      <div className="tools-privacy-group">
        <label className="tools-publish-field">
          <span className="tools-privacy-legend">{t("tools.publish.title")}</span>
          <input type="text" className="tools-publish-input" value={options.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        {/* One text per language the site speaks; a reader sees theirs, or
            the other one when theirs is left empty. */}
        <div className="tools-publish-field">
          <span className="tools-privacy-legend">{t("tools.publish.introText")}</span>
          {SUPPORTED_LANGUAGES.map((lng) => (
            <label key={lng} className="tools-publish-intro">
              <span className="tools-publish-intro-lang" title={LANGUAGE_NAMES[lng]} aria-label={LANGUAGE_NAMES[lng]}>{LANGUAGE_FLAGS[lng]}</span>
              <textarea
                className="tools-publish-input"
                rows={3}
                lang={lng}
                value={options.intro[lng] ?? ""}
                placeholder={t("tools.publish.introPlaceholder", { lng })}
                onChange={(e) => set({ intro: { ...options.intro, [lng]: e.target.value } })}
              />
            </label>
          ))}
        </div>
        <label className="tools-publish-field">
          <span className="tools-privacy-legend">{t("tools.publish.url")}</span>
          <input
            type="url"
            className="tools-publish-input"
            value={options.url}
            placeholder="https://tree.example.org"
            onChange={(e) => set({ url: e.target.value })}
          />
          <span className="tools-fix-hint">{t("tools.publish.urlHint")}</span>
        </label>
        <label className="tools-publish-field">
          <span className="tools-privacy-legend">{t("tools.publish.siteUrl")}</span>
          <input
            type="url"
            className="tools-publish-input"
            value={options.siteUrl}
            placeholder={options.url.trim() || "https://family.example.org"}
            onChange={(e) => set({ siteUrl: e.target.value })}
          />
          <span className="tools-fix-hint">{t("tools.publish.siteUrlHint")}</span>
        </label>
        <label className="tools-publish-field">
          <span className="tools-privacy-legend">{t("tools.publish.favicon")}</span>
          <input
            type="url"
            className="tools-publish-input"
            value={options.favicon}
            placeholder="https://example.org/favicon.png"
            onChange={(e) => set({ favicon: e.target.value })}
          />
          <span className="tools-fix-hint">{t("tools.publish.faviconHint")}</span>
        </label>
        <label className="tools-norm-check">
          <input type="checkbox" checked={options.exports} onChange={() => set({ exports: !options.exports })} />
          <span>{t("tools.publish.exports")}</span>
        </label>
        {/* Off unless chosen: a family's names in search results is the
            author's call. */}
        <label className="tools-norm-check">
          <input type="checkbox" checked={options.indexable} onChange={() => set({ indexable: !options.indexable })} />
          <span>{t("tools.publish.indexable")}</span>
        </label>
        {options.indexable && <p className="tools-fix-hint">{t("tools.publish.indexableHint")}</p>}
      </div>

      <div className="tools-privacy-group">
        <div className="tools-privacy-legend">{t("tools.publish.start")}</div>
        <StartPersonSelector
          individuals={dataset.individuals}
          version={editVersion}
          startId={siteStart}
          onChange={setOwnStart}
          placeholder={t("tools.publish.startPick")}
          tooltip={t("tools.publish.startHint")}
          onStartClick={ownStart && ownStart !== startId ? () => setOwnStart(undefined) : undefined}
          startClickTitle={t("tools.publish.startReset")}
        />
      </div>

      <div className="tools-privacy-group">
        <div className="tools-privacy-legend">{t("tools.publish.startPage")}</div>
        <div className="tools-privacy-radios">
          {START_PAGES.map((p: StartPage) => (
            <label key={p} className={`tools-norm-check ${options.startPage === p ? "active" : ""}`}>
              <input type="radio" name="publish-start-page" checked={options.startPage === p} disabled={(p === "person" || p === "charts") && !siteStart} onChange={() => set({ startPage: p })} />
              <span>{t(`tools.publish.startPage.${p}`)}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="tools-privacy-group">
        <div className="tools-privacy-legend">{t("tools.publish.scope")}</div>
        <div className="tools-privacy-radios">
          {SCOPE_KINDS.map((s: ScopeKind) => (
            <label key={s} className={`tools-norm-check ${options.scope === s ? "active" : ""}`}>
              <input type="radio" name="publish-scope" checked={options.scope === s} disabled={s !== "all" && !siteStart} onChange={() => set({ scope: s })} />
              <span>{t(`tools.publish.scope.${s}`)}</span>
            </label>
          ))}
        </div>
        {scoped && (
          <label className="tools-norm-check">
            <input type="checkbox" checked={options.partners} onChange={() => set({ partners: !options.partners })} />
            <span>{t("tools.publish.partners")}</span>
          </label>
        )}
      </div>

      <div className="tools-privacy-group">
        <div className="tools-privacy-legend">{t("tools.publish.living")}</div>
        <div className="tools-privacy-radios">
          {LIVING_MODES.map((m: LivingMode) => (
            <label key={m} className={`tools-norm-check ${options.living === m ? "active" : ""}`}>
              <input type="radio" name="publish-living" checked={options.living === m} onChange={() => set({ living: m })} />
              <span>{t(`tools.publish.living.${m}`)}</span>
            </label>
          ))}
        </div>
        {/* The recently dead, published as the living are — the Privacy tool's
            own choice, worded as there. */}
        <label className="tools-privacy-inline tools-publish-recent">
          {t("tools.privacy.recentDeath")}
          <input
            type="number"
            min={0}
            className="tools-privacy-num"
            value={options.recentDeathYears}
            onChange={(e) => set({ recentDeathYears: Math.max(0, Number(e.target.value) || 0) })}
          />
          {t("tools.privacy.recentDeathYears")}
          {options.recentDeathYears === 0 && <span className="muted"> {t("tools.privacy.recentDeathOff")}</span>}
        </label>
        <p className="tools-fix-hint">{t("tools.publish.livingHint")}</p>
      </div>

      {/* Beyond names, dates and places: each its own choice, all off to begin
          with. Without addresses, houses are shown at their settlement. */}
      <div className="tools-privacy-group">
        <div className="tools-privacy-legend">{t("tools.publish.include")}</div>
        <div className="tools-privacy-radios">
          {SITE_INCLUDES.map((key) => (
            <label key={key} className="tools-norm-check">
              <input
                type="checkbox"
                checked={options.include[key]}
                onChange={() => set({ include: { ...options.include, [key]: !options.include[key] } })}
              />
              <span>{t(`tools.publish.include.${key}`)}</span>
            </label>
          ))}
        </div>
        <p className="tools-fix-hint">{t(options.include.addresses ? "tools.publish.include.addressesOn" : "tools.publish.include.addressesOff")}</p>
        {/* Photos are read from the media folder, as the app shows them. */}
        {options.include.photos && (
          <p className="tools-fix-hint">
            {media.folderName ? t("tools.publish.photosHint", { folder: media.folderName }) : t("tools.publish.photosNoFolder")}{" "}
            {!media.folderName && (
              <button type="button" className="tools-issue-link" onClick={() => void media.openFolder()}>{t("media.chooseFolder")}</button>
            )}
          </p>
        )}
        {options.include.photos && (
          <PublishPhotoFolders dataset={dataset} value={options.photoFolders} onChange={(photoFolders) => set({ photoFolders })} />
        )}
        {options.include.photos && media.folderName && (
          <PublishCover dataset={dataset} value={options.cover} hasUrl={!!options.url.trim()} onChange={(cover) => set({ cover })} />
        )}
      </div>

      {/* The site's map: a base map, and which of the author's extra layers
          its readers may switch on (all of them to begin with). */}
      <div className="tools-privacy-group">
        <div className="tools-privacy-legend">{t("tools.publish.map")}</div>
        <label className="tools-publish-field tools-publish-dates">
          <span>{t("settings.map.base")}</span>
          <SelectMenu
            value={options.map.basemap}
            onChange={(v) => set({ map: { ...options.map, basemap: v } })}
            options={[
              ...BASEMAPS.map((b) => ({ value: b.id, label: t(b.key) })),
              ...(options.map.tileUrl ? [{ value: CUSTOM_BASEMAP, label: t("basemap.custom") }] : []),
            ]}
          />
        </label>
        <div className="tools-publish-subhead">{t("settings.map.overlays")}</div>
        {appMap.mapOverlays.length ? (
          <ul className="tools-norm-summary">
            {appMap.mapOverlays.map((o) => {
              const on = options.map.overlays.some((x) => x.id === o.id);
              const toggle = () => set({
                map: {
                  ...options.map,
                  // Kept in the author's order, whichever is ticked first.
                  overlays: on ? options.map.overlays.filter((x) => x.id !== o.id) : appMap.mapOverlays.filter((x) => x.id === o.id || options.map.overlays.some((y) => y.id === x.id)),
                },
              });
              return (
                <li key={o.id}>
                  <label className="tools-norm-check">
                    <input type="checkbox" checked={on} onChange={toggle} />
                    <span>{overlayDisplayName(o, t)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="tools-fix-hint">{t("tools.publish.mapNoOverlays")}</p>
        )}
      </div>

      {/* How the site shows people: the app's own display settings, starting
          from the author's, with the same labels as in Settings. */}
      <div className="tools-privacy-group">
        <div className="tools-privacy-legend">{t("tools.publish.display")}</div>
        <div className="tools-privacy-radios">
          {(["given-surname", "surname-given"] as NameOrder[]).map((order) => (
            <label key={order} className={`tools-norm-check ${display.order === order ? "active" : ""}`}>
              <input type="radio" name="publish-name-order" checked={display.order === order} onChange={() => setDisplay({ order })} />
              <span>{t(order === "given-surname" ? "settings.name.order.givenSurname" : "settings.name.order.surnameGiven")}</span>
            </label>
          ))}
        </div>
        <label className="tools-publish-field tools-publish-dates">
          <span>{t("settings.display.dates")}</span>
          <SelectMenu
            value={display.dateDisplay}
            onChange={(v) => setDisplay({ dateDisplay: v })}
            options={DATE_DISPLAY_CHOICES.map((c) => ({
              value: c,
              label: c === "" ? t("settings.display.dates.file") : c === DATE_DISPLAY_WORDS ? t("settings.display.dates.words") : c,
            }))}
          />
        </label>
        <ul className="tools-norm-summary">
          {DISPLAY_TOGGLES.map(([key, label]) => (
            <li key={key}>
              <label className="tools-norm-check">
                <input type="checkbox" checked={display[key]} onChange={() => setDisplay({ [key]: !display[key] })} />
                <span>{t(label)}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      {summary && (
        <div className="tools-privacy-group">
          <ToolSummary>{t("tools.publish.summary", { people: num(summary.people), families: num(summary.families) })}</ToolSummary>
          <p className="tools-fix-hint">
            {t("tools.publish.left", { reduced: num(summary.livingReduced), hidden: num(summary.livingHidden), private: num(summary.privateHidden) })}
          </p>
          {options.include.photos && (
            <p className="tools-fix-hint">{t("tools.publish.photosCount", { count: summary.photos, withheld: num(summary.photosWithheld) })}</p>
          )}
          <p className="tools-fix-hint">{t("tools.publish.omitted")}</p>
        </div>
      )}

      {error && <p className="tools-error">{t("tools.publish.error", { message: error })}</p>}
      {notice && <p className="tools-fix-hint">{notice}</p>}
      {/* The steps run beside the button, where the eye already is. */}
      <div className="tools-publish-run">
        <button className="nav-btn primary tools-run" onClick={() => void download()} disabled={!!phase || !summary?.people}>
          {t(options.include.photos ? "tools.publish.downloadZip" : "tools.publish.download")}
        </button>
        {phase && (
          <ToolsLoading
            label={t(`tools.publish.step.${phase.step}`)}
            progress={phase.total ? { done: phase.done ?? 0, total: phase.total } : undefined}
          />
        )}
      </div>
    </div>
  );
}
