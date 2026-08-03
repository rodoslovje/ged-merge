import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModalKeyboard } from "../keyboard/useModalKeyboard";
import { useSettings, useNameOf, type MapOverlay } from "./SettingsContext";
import { OVERLAY_PRESETS, resolveOverlay } from "./map/overlayPresets";
import { sampleMapView, type FramedOverlay } from "./map/sampleView";
import { BASEMAPS, CUSTOM_BASEMAP } from "./map/basemapPresets";
import type { MiniMapPin } from "./map/MiniPlaceMap";
import { xrefLabel, type NameOrder } from "../gedcom/nameDisplay";
import type { PersonName } from "../gedcom/types";
import { SUPPORTED_LANGUAGES } from "../locales/i18n";
import { PROXY_HOSTS } from "../normalize/urlMetadata";
import { DATE_PATTERN_CHOICES, type DetectedFormats, type FormatOverrides } from "../normalize/formatOverrides";
import { sampleDateFor } from "../normalize/formatDefaults";
import { sexClass } from "./sex";
import type { SettingsTab } from "./settingsBus";
import { GazetteerManager, useGazetteer } from "./tools/GazetteerManager";

// Leaflet is a lazy chunk everywhere else too — the Map tab loads it only when
// the base-map sample is actually shown.
const MiniPlaceMap = lazy(() => import("./map/MiniPlaceMap"));

export type ThemeMode = "auto" | "light" | "dark";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
  /** Wipe the cached workspace (loaded files + merge session) from IndexedDB. */
  onClearCache: () => void;
  /** The main file's detected formats (computed at load, in the worker) —
   *  the "Auto (detected)" examples on the GEDCOM tab. */
  detectedFormats?: DetectedFormats;
  /** Tab to open on. Set when something elsewhere sent the reader here for a
   *  particular setting ({@link requestSettings}); each fresh open honours it,
   *  and switching tabs by hand from then on is the reader's business. */
  initialTab?: SettingsTab;
}

const SETTINGS_TABS: SettingsTab[] = ["general", "format", "map", "advanced"];

/** One format dimension: a select whose first option is "Detected" (= no
 *  override) and whose value patches a single {@link FormatOverrides} key. */
interface FormatDimension {
  key: keyof FormatOverrides;
  /** Choice values; option labels come from `settings.format.{key}.{value}`
   *  unless the value is `verbatim` (shown as-is, e.g. date patterns). */
  choices: readonly string[];
  verbatim?: boolean;
}

/** The Format tab's dimensions, grouped for display. Matricula's own
 *  language form offers exactly those five languages; the Geneanet list
 *  mirrors GENEANET_CEMETERY_LOCALES (the locales the rewriter knows). */
const FORMAT_GROUPS: { group: string; dims: FormatDimension[] }[] = [
  {
    group: "dates",
    dims: [
      { key: "date", choices: DATE_PATTERN_CHOICES, verbatim: true },
      { key: "datePlaceholder", choices: ["none", "_", "?"] },
    ],
  },
  {
    group: "names",
    dims: [
      { key: "names", choices: ["records", "tags"] },
      { key: "unknownName", choices: ["blank", "NN", "N.N.", "_____"] },
    ],
  },
  {
    group: "places",
    dims: [
      { key: "place", choices: ["packed-plac", "structured-addr", "plain-structured", "address-only"] },
      { key: "placeSeparator", choices: ["comma", "comma-space"] },
    ],
  },
  {
    group: "sources",
    dims: [
      { key: "sourceLayout", choices: ["paginated", "repository", "literature", "inline"] },
      { key: "citations", choices: ["event", "record"] },
      { key: "pageMedia", choices: ["event", "source"] },
      { key: "baptism", choices: ["BIRT", "BAPM"] },
      { key: "doubledLinks", choices: ["fold", "keep"] },
      { key: "matriculaLang", choices: ["sl", "de", "en", "cs", "it"], verbatim: true },
      { key: "geneanetLang", choices: ["en", "de", "es", "fi", "fr", "it", "nl", "no", "pt", "sv"], verbatim: true },
    ],
  },
  {
    group: "privacy",
    dims: [{ key: "privacy", choices: ["PRIV", "_PRIV", "RESN"], verbatim: true }],
  },
];

/** Concrete, language-neutral samples of what each choice writes — shown
 *  between the row's label and its dropdown (GEDCOM-shaped where that is the
 *  clearest way to show structure). Dates and link languages are rendered
 *  from the value instead. */
const FORMAT_SAMPLES: Partial<Record<keyof FormatOverrides, Record<string, string>>> = {
  datePlaceholder: { none: "JUN 1879", _: "__.06.1879", "?": "??.06.1879" },
  place: {
    "structured-addr": "Kranj,Slovenija › ADDR Cesta 1",
    "packed-plac": "Cesta 1, Kranj (Slovenija)",
    "plain-structured": "Kranj,Slovenija",
    "address-only": "Cesta 1",
  },
  placeSeparator: { comma: "Kranj,Slovenija", "comma-space": "Kranj, Slovenija" },
  names: { records: "1 NAME › 2 TYPE married", tags: "2 _MARNM Kovač" },
  sourceLayout: {
    paginated: "0 SOUR › 1 OBJE ×N",
    repository: "0 SOUR › 1 REPO",
    literature: "1 AUTH, 1 PUBL",
    inline: '2 SOUR "…"',
  },
  citations: { event: "1 BIRT › 2 SOUR", record: "1 SOUR" },
  pageMedia: { event: "2 SOUR + 2 OBJE", source: "0 SOUR › 1 OBJE" },
  baptism: { BIRT: "1 BIRT › 2 SOUR", BAPM: "1 BAPM › 2 SOUR" },
  doubledLinks: { fold: "1 BIRT › 2 WWW", keep: "1 WWW + 2 WWW" },
  privacy: { PRIV: "1 PRIV", _PRIV: "1 _PRIV Y", RESN: "1 RESN privacy" },
};

/**
 * Whether a choice is the form the GEDCOM spec itself writes — marked in the
 * dropdown, since `<option>` can't be styled. The month-word date layouts are
 * the spec form (its day is 1–2 digits); numeric layouts are vendor
 * conventions. For places, 5.5.1's grammar and every example separate
 * jurisdictions with a comma *and* a space ("Cove, Cache, Utah, USA").
 */
function isGedcomStandard(key: keyof FormatOverrides, choice: string): boolean {
  if (key === "date") return choice === "D MMM YYYY" || choice === "DD MMM YYYY";
  return key === "placeSeparator" && choice === "comma-space";
}

const THEME_MODES: ThemeMode[] = ["auto", "light", "dark"];
const LANG_LABELS: Record<string, string> = { en: "🇬🇧 English", sl: "🇸🇮 Slovenščina" };

/** Sample person used by the live name-display preview — a married woman so the
 * married-surname, order and uppercase options are all visible at once. */
const SAMPLE_NAME: PersonName = { full: "Ana Novak", given: "Ana", surname: "Novak", married: "Kovač" };
const SAMPLE_XREF = "@I42@";

/** Nothing is plotted on the sample — a stable identity so the map's marker
 *  pass doesn't rerun on every render of this modal. */
const NO_PINS: MiniMapPin[] = [];

/** How long typing in an overlay field waits before the edit reaches the global
 *  settings. Long enough that a word is one commit rather than one per letter,
 *  short enough that the sample map follows a finished URL without a nudge. */
const OVERLAY_COMMIT_MS = 400;

const SAMPLE_LIFESPAN = "1850–1920";
const SAMPLE_AGE = 70;

/** Sentinel option value of the preset dropdown's "add every one" entry — the
 *  others carry an index into the list. */
const ADD_ALL_PRESETS = "all";

/** The place directories, in the only place that owns them. Its own component so
 *  the IndexedDB read happens when the Map tab is opened, not on every render of
 *  a modal that spends most of its life closed. */
function GazetteerSection() {
  const gaz = useGazetteer();
  return <GazetteerManager gaz={gaz} />;
}

/**
 * General settings: name-display preferences, the record-id toggle, and the
 * opt-in for online link-metadata lookups. Preferences live in
 * {@link useSettings} and persist to localStorage.
 */
export function SettingsModal({ isOpen, onClose, themeMode, onThemeMode, onClearCache, detectedFormats, initialTab }: Props) {
  const { t, i18n } = useTranslation();
  const { settings, set } = useSettings();
  const nameOf = useNameOf();
  const ref = useModalKeyboard(isOpen, onClose);
  const [tab, setTab] = useState<SettingsTab>("general");
  // Follow the requested tab on each open, not on every render: once open, the
  // reader's own tab clicks must stick.
  useEffect(() => {
    if (isOpen && initialTab) setTab(initialTab);
  }, [isOpen, initialTab]);
  // What "Auto (detected)" resolves to — computed at load in the worker and
  // stored with the file, so showing it here costs nothing.
  const detected = detectedFormats;

  // Preset names resolved to the current language and sorted by that label.
  const presets = useMemo(
    () => OVERLAY_PRESETS.map((p) => ({ preset: p, label: t(p.key) })).sort((a, b) => a.label.localeCompare(b.label, i18n.language)),
    [t, i18n.language],
  );

  // Overlay rows whose technical fields (URL, WMS layers, attribution…) are
  // unfolded. Collapsed by default: a preset layer is configured already, and
  // the list reads as a list of maps rather than a wall of endpoints.
  const [openOverlays, setOpenOverlays] = useState<ReadonlySet<string>>(new Set());
  const toggleOverlayDetails = (id: string) =>
    setOpenOverlays((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Overlay edits, echoed locally and committed on a pause. Committing is not
  // cheap: it re-renders the whole mounted app (see above), and a changed URL
  // or WMS field also tears the live tile layer down and rebuilds it — so a
  // commit per keystroke made typing a layer's name or endpoint crawl, and
  // fired a tile request for every half-typed URL. Clicks (add, remove, move,
  // the tick boxes) still commit at once; only typing waits.
  const [pendingOverlays, setPendingOverlays] = useState<MapOverlay[] | null>(null);
  const overlays = pendingOverlays ?? settings.mapOverlays;
  const overlayTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const typedOverlays = useRef<MapOverlay[] | null>(null);

  const setOverlays = useCallback(
    (next: MapOverlay[], typed = false) => {
      if (overlayTimer.current !== undefined) clearTimeout(overlayTimer.current);
      overlayTimer.current = undefined;
      typedOverlays.current = typed ? next : null;
      if (!typed) {
        setPendingOverlays(null);
        set({ mapOverlays: next });
        return;
      }
      setPendingOverlays(next);
      overlayTimer.current = setTimeout(() => {
        overlayTimer.current = undefined;
        // A keystroke landed after this commit was queued — that edit owns
        // the list now and carries its own timer; drop this stale one.
        if (typedOverlays.current !== next) return;
        set({ mapOverlays: next });
        setPendingOverlays(null);
      }, OVERLAY_COMMIT_MS);
    },
    [set],
  );

  // Closed mid-word: commit what was typed instead of dropping it. (The modal
  // renders null when shut but stays mounted, so this hangs off `isOpen`.)
  useEffect(
    () => () => {
      if (overlayTimer.current === undefined) return;
      clearTimeout(overlayTimer.current);
      overlayTimer.current = undefined;
      const typed = typedOverlays.current;
      typedOverlays.current = null;
      setPendingOverlays(null);
      if (typed) set({ mapOverlays: typed });
    },
    [isOpen, set],
  );

  // The layer the base-map sample frames: whichever was last switched on by
  // default, so ticking a regional map takes the sample to the region it
  // covers. Held by id — the layer may be edited, moved or removed meanwhile —
  // and counted, because switching a layer on asks for its frame again even
  // when that is the frame already shown (the sample may have been panned
  // away from it, or another layer of the same reach may have been holding it).
  const [framedOverlay, setFramedOverlay] = useState<FramedOverlay | null>(null);
  const sampleView = useMemo(
    () => sampleMapView(settings.mapOverlays, framedOverlay),
    [settings.mapOverlays, framedOverlay],
  );

  // A dropdown commits straight through: only the handful of components that
  // read formatOverrides re-render, and they do it in the same tick as the
  // change, so the select needs no local echo to stay responsive.
  const overrides = settings.formatOverrides;
  const updateOverride = (key: keyof FormatOverrides, value: string) => {
    const next = { ...overrides };
    if (value) next[key] = value as never;
    else delete next[key];
    set({ formatOverrides: next });
  };

  if (!isOpen) return null;

  /** Concrete sample of the row's *effective* value (the override when set,
   *  else the detected habit — the latter only while a main file is loaded). */
  const formatExample = ({ key }: FormatDimension): string | undefined => {
    const effective = overrides[key] ?? detected?.[key];
    if (!effective) return undefined;
    if (key === "date") return sampleDateFor(effective);
    if (key === "unknownName") return effective === "blank" ? "/Kovač/" : `${effective} /Kovač/`;
    if (key === "matriculaLang") return `…online.eu/${effective}/…`;
    if (key === "geneanetLang") return `${effective}.geneanet.org`;
    return FORMAT_SAMPLES[key]?.[effective];
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal settings-modal"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{t("settings.title")}</h2>
          <button className="modal-close" onClick={onClose} title={t("help.close")} aria-label={t("help.close")}>
            ×
          </button>
        </div>
        <div className="settings-tabs" role="tablist" aria-label={t("settings.title")}>
          {SETTINGS_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              {t(`settings.tab.${id}`)}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {tab === "general" && (
          <>
          <section className="settings-section">
            <h3>{t("settings.language.title")}</h3>
            <div className="settings-radio-row">
              {SUPPORTED_LANGUAGES.map((lng) => (
                <label key={lng} className="settings-radio">
                  <input
                    type="radio"
                    name="settings-language"
                    value={lng}
                    checked={i18n.language === lng}
                    onChange={() => i18n.changeLanguage(lng)}
                  />
                  <span className="settings-row-label">{LANG_LABELS[lng] ?? lng}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <h3>{t("settings.appearance.title")}</h3>
            <div className="settings-radio-row">
              {THEME_MODES.map((mode) => (
                <label key={mode} className="settings-radio">
                  <input
                    type="radio"
                    name="settings-theme"
                    value={mode}
                    checked={themeMode === mode}
                    onChange={() => onThemeMode(mode)}
                  />
                  <span className="settings-row-label">{t(`settings.theme.${mode}`)}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <h3>{t("settings.name.title")}</h3>

            <div className="settings-preview">
              <span className="settings-preview-label">{t("settings.name.preview")}</span>
              <span className="settings-preview-person">
                <span className={`person-name ${sexClass("F")}`}>{nameOf(SAMPLE_NAME)}</span>
                {settings.showXref && <span className="person-xref gm-data">{xrefLabel(SAMPLE_XREF)}</span>}
                <span className="person-years gm-data">{settings.showAge ? `${SAMPLE_LIFESPAN} (${SAMPLE_AGE})` : SAMPLE_LIFESPAN}</span>
              </span>
            </div>

            <fieldset className="settings-radio-group">
              <legend className="settings-row-label">{t("settings.name.order")}</legend>
              <div className="settings-radio-row">
              {(["given-surname", "surname-given"] as NameOrder[]).map((order) => (
                <label key={order} className="settings-radio">
                  <input
                    type="radio"
                    name="settings-name-order"
                    value={order}
                    checked={settings.order === order}
                    onChange={() => set({ order })}
                  />
                  <span className="settings-row-label">
                    {t(order === "given-surname" ? "settings.name.order.givenSurname" : "settings.name.order.surnameGiven")}
                  </span>
                </label>
              ))}
              </div>
            </fieldset>

            <label className="settings-row settings-row-toggle">
              <input
                type="checkbox"
                checked={settings.uppercaseSurname}
                onChange={(e) => set({ uppercaseSurname: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{t("settings.name.uppercase")}</span>
                <span className="settings-hint">{t("settings.name.uppercase.hint")}</span>
              </span>
            </label>

            <label className="settings-row settings-row-toggle">
              <input
                type="checkbox"
                checked={settings.marriedSurname}
                onChange={(e) => set({ marriedSurname: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{t("settings.name.married")}</span>
                <span className="settings-hint">{t("settings.name.married.hint")}</span>
              </span>
            </label>
          </section>

          <section className="settings-section">
            <h3>{t("settings.display.title")}</h3>
            <label className="settings-row settings-row-toggle">
              <input
                type="checkbox"
                checked={settings.showKinship}
                onChange={(e) => set({ showKinship: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{t("settings.display.kinship")}</span>
                <span className="settings-hint">{t("settings.display.kinship.hint")}</span>
              </span>
            </label>

            <label className="settings-row settings-row-toggle">
              <input
                type="checkbox"
                checked={settings.showXref}
                onChange={(e) => set({ showXref: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{t("settings.display.xref")}</span>
                <span className="settings-hint">{t("settings.display.xref.hint")}</span>
              </span>
            </label>

            <label className="settings-row settings-row-toggle">
              <input
                type="checkbox"
                checked={settings.showAge}
                onChange={(e) => set({ showAge: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{t("settings.display.age")}</span>
                <span className="settings-hint">{t("settings.display.age.hint")}</span>
              </span>
            </label>
          </section>
          </>
          )}

          {tab === "format" && (
          <>
          {FORMAT_GROUPS.map(({ group, dims }) => (
            <section key={group} className="settings-section settings-format-group">
              <h3>{t(`settings.format.group.${group}`)}</h3>
              {dims.map(({ key, choices, verbatim }) => (
                <label key={key} className="settings-row settings-format-row" title={t(`settings.format.${key}.hint`)}>
                  <span className="settings-row-label">{t(`settings.format.${key}`)}</span>
                  <span className="settings-format-example gm-data">{formatExample({ key, choices, verbatim })}</span>
                  <select
                    value={(overrides[key] as string | undefined) ?? ""}
                    onChange={(e) => updateOverride(key, e.target.value)}
                  >
                    <option value="">{t("settings.format.detected")}</option>
                    {choices.map((c) => (
                      <option key={c} value={c}>
                        {(verbatim ? c : t(`settings.format.${key}.${c}`)) +
                          (isGedcomStandard(key, c) ? ` — ${t("settings.format.gedcomStandard")}` : "")}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </section>
          ))}
          </>
          )}

          {tab === "advanced" && (
          <>
          <section className="settings-section">
            <h3>{t("settings.links.title")}</h3>
            <label className="settings-row settings-row-toggle">
              <input
                type="checkbox"
                checked={settings.allowLinkFetch}
                onChange={(e) => set({ allowLinkFetch: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{t("settings.links.fetch")}</span>
                <span className="settings-hint">{t("settings.links.fetch.hint")}</span>
                <span className="settings-hint">
                  {t("settings.links.fetch.relays")}{" "}
                  {PROXY_HOSTS.map((host, i) => (
                    <span key={host}>
                      {i > 0 && ", "}
                      <a href={`https://${host}/`} target="_blank" rel="noreferrer">
                        {host}
                      </a>
                    </span>
                  ))}
                  {". "}
                  {t("settings.links.fetch.relaysNote")}
                </span>
              </span>
            </label>
          </section>

          </>
          )}

          {tab === "map" && (
          <>
          {/* First on the tab: the directories are what every place name in the
              app resolves against, and the one thing here that needs setting up
              once rather than choosing. */}
          <section className="settings-section">
            <h3>{t("settings.geo.title")}</h3>
            <p className="settings-hint">{t("settings.geo.hint")}</p>
            <GazetteerSection />
          </section>

          <section className="settings-section">
            <h3>{t("settings.map.base")}</h3>
            <label className="settings-row settings-row-toggle">
              <input
                type="checkbox"
                checked={settings.allowMapTiles}
                onChange={(e) => set({ allowMapTiles: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{t("settings.map.tiles")}</span>
                <span className="settings-hint">{t("settings.map.tiles.hint")}</span>
              </span>
            </label>
            {/* Shown but inert until tiles are allowed: the choice is worth
                seeing before opting in, and the toggle sits right above it. */}
            <fieldset className="settings-fieldset" disabled={!settings.allowMapTiles}>
              {/* The choice below, drawn: the sample redraws on every change of
                  base map, custom URL or theme, and carries the layers marked
                  Default — what every map in the app will then look like. It
                  goes to the ground and the zoom of whichever of those layers
                  was switched on last, so a layer covering another country, or
                  drawn only at close range, is not switched on into an empty
                  frame. Shown only once tiles are allowed: before that
                  there is nothing to preview but the offline outline. Its
                  caption is a tooltip: a live, draggable map says what it is by
                  being one, and a line under it only crowds the tab. */}
              {settings.allowMapTiles && (
                <div
                  className="settings-map-preview"
                  title={t("settings.map.preview")}
                  role="img"
                  aria-label={t("settings.map.previewAria")}
                >
                  <Suspense fallback={<div className="tools-geo-minimap" />}>
                    <MiniPlaceMap pins={NO_PINS} view={sampleView} />
                  </Suspense>
                </div>
              )}
              <label className="settings-row settings-format-row" title={t("settings.map.basemap.hint")}>
                <span className="settings-row-text">
                  <span className="settings-row-label">{t("settings.map.base")}</span>
                  <span className="settings-hint">{t("settings.map.basemap.hint")}</span>
                </span>
                <select value={settings.mapBasemap} onChange={(e) => set({ mapBasemap: e.target.value })}>
                  {BASEMAPS.map((b) => (
                    <option key={b.id} value={b.id}>
                      {t(b.key)}
                    </option>
                  ))}
                  <option value={CUSTOM_BASEMAP}>{t("basemap.custom")}</option>
                </select>
              </label>
              {settings.mapBasemap === CUSTOM_BASEMAP && (
                <label className="settings-row settings-format-row" title={t("settings.map.tileUrl.hint")}>
                  <span className="settings-row-text">
                    <span className="settings-row-label">{t("settings.map.tileUrl")}</span>
                    <span className="settings-hint">{t("settings.map.tileUrl.hint")}</span>
                  </span>
                  <input
                    type="text"
                    className="settings-text-input"
                    value={settings.mapTileUrl}
                    placeholder={t("settings.map.tileUrl.placeholder")}
                    onChange={(e) => set({ mapTileUrl: e.target.value.trim() })}
                  />
                </label>
              )}
            </fieldset>
          </section>

          <section className="settings-section">
            <h3>{t("settings.map.overlays")}</h3>
            {!settings.allowMapTiles && <p className="settings-note">{t("settings.map.needTiles")}</p>}
            {/* Overlays only draw where the base map does, so they follow the
                same opt-in — visible, but inert until it is ticked. */}
            <fieldset className="settings-fieldset" disabled={!settings.allowMapTiles}>
            <div className="settings-overlays-head">
              <p className="settings-hint">{t("settings.map.overlays.hint")}</p>
              <p className="settings-hint">{t("settings.map.overlays.sources")}</p>
              <span className="settings-overlays-actions">
                <select
                  className="settings-overlay-preset"
                  value=""
                  aria-label={t("settings.map.overlays.preset")}
                  onChange={(e) => {
                    // name stays empty so the layer's display name tracks the
                    // language via presetKey; renaming it later overrides that.
                    const add = ({ key, ...rest }: (typeof presets)[number]["preset"]) => ({
                      ...rest,
                      presetKey: key,
                      name: "",
                      id: crypto.randomUUID(),
                    });
                    if (e.target.value === ADD_ALL_PRESETS) {
                      // Only the ones missing: picking this twice must not
                      // leave the list holding every free map in duplicate.
                      const have = new Set(overlays.map((o) => o.presetKey).filter(Boolean));
                      const missing = presets.filter((p) => !have.has(p.preset.key));
                      if (missing.length) setOverlays([...overlays, ...missing.map((p) => add(p.preset))]);
                      return;
                    }
                    const entry = presets[Number(e.target.value)];
                    if (!entry) return;
                    setOverlays([...overlays, add(entry.preset)]);
                  }}
                >
                  <option value="">{t("settings.map.overlays.preset")}</option>
                  {presets.map((p, i) => (
                    <option key={p.preset.key} value={i}>
                      {p.label}
                    </option>
                  ))}
                  <option value={ADD_ALL_PRESETS}>{t("settings.map.overlays.preset.addAll")}</option>
                </select>
                <button
                  type="button"
                  className="nav-btn"
                  onClick={() => {
                    // Opened expanded: a blank layer is nothing but its fields,
                    // and adding one is a statement that you are about to fill
                    // them in. (A preset, by contrast, arrives complete.)
                    const id = crypto.randomUUID();
                    setOverlays([...overlays, { id, name: "", url: "" }]);
                    setOpenOverlays((open) => new Set(open).add(id));
                  }}
                >
                  {t("settings.map.overlays.add")}
                </button>
              </span>
            </div>
            {overlays.map((stored, index) => {
              // Show the resolved config (a preset layer reflects the live
              // preset). Renaming keeps the preset link; editing any technical
              // field detaches — it captures the current config and drops the
              // presetKey so the edit sticks and the layer stops auto-tracking.
              const layer = resolveOverlay(stored);
              const replace = (next: MapOverlay, typed = false) =>
                setOverlays(overlays.map((o) => (o.id === stored.id ? next : o)), typed);
              // Name and "show by default" are preferences, not config — they
              // patch the stored layer directly and keep the preset link.
              const updateName = (name: string) => replace({ ...stored, name }, true);
              const updateDefaultOn = (defaultOn: boolean) => {
                // Switching a layer on aims the sample above at it, so its
                // effect is visible even when it covers another country. Each
                // tick counts as its own request to be framed — see sampleView.
                if (defaultOn) setFramedOverlay((prev) => ({ id: stored.id, seq: (prev?.seq ?? 0) + 1 }));
                replace({ ...stored, defaultOn: defaultOn || undefined });
              };
              const update = (patch: Partial<MapOverlay>, typed = false) =>
                replace({ ...layer, ...patch, id: stored.id, name: stored.name, presetKey: undefined }, typed);
              const yearPatch = (key: "yearFrom" | "yearTo", raw: string): Partial<MapOverlay> => {
                const n = Number(raw);
                return { [key]: raw.trim() && Number.isFinite(n) ? n : undefined };
              };
              // The list order is the stacking order on the map (first = on
              // top), so moving a row is how a thin reference layer is put
              // above a full-page historical map.
              const move = (delta: number) => {
                const next = [...overlays];
                const [row] = next.splice(index, 1);
                next.splice(index + delta, 0, row!);
                setOverlays(next);
              };
              const open = openOverlays.has(layer.id);
              return (
                <div key={layer.id} className="settings-overlay-row">
                  <div className="settings-overlay-line">
                    <input
                      type="text"
                      className="settings-text-input settings-overlay-name settings-overlay-title"
                      value={layer.name || (layer.presetKey ? t(layer.presetKey) : "")}
                      placeholder={t("settings.map.overlays.name")}
                      onChange={(e) => updateName(e.target.value)}
                    />
                  </div>
                  {/* The name gets the whole line above — preset names run long
                      and an <input> cuts what doesn't fit. */}
                  <div className="settings-overlay-line">
                    <button
                      type="button"
                      className="settings-overlay-expand"
                      aria-expanded={open}
                      onClick={() => toggleOverlayDetails(layer.id)}
                      title={t(open ? "settings.map.overlays.details.hide" : "settings.map.overlays.details.show")}
                      aria-label={t(open ? "settings.map.overlays.details.hide" : "settings.map.overlays.details.show")}
                    >
                      {open ? "▾" : "▸"}
                    </button>
                    <input
                      type="number"
                      className="settings-overlay-year"
                      value={layer.yearFrom ?? ""}
                      placeholder={t("settings.map.overlays.from")}
                      title={t("settings.map.overlays.years.hint")}
                      onChange={(e) => update(yearPatch("yearFrom", e.target.value), true)}
                    />
                    <span className="settings-overlay-dash">–</span>
                    <input
                      type="number"
                      className="settings-overlay-year"
                      value={layer.yearTo ?? ""}
                      placeholder={t("settings.map.overlays.to")}
                      title={t("settings.map.overlays.years.hint")}
                      onChange={(e) => update(yearPatch("yearTo", e.target.value), true)}
                    />
                    <label
                      className="settings-overlay-wms settings-overlay-tail"
                      title={t("settings.map.overlays.default.hint")}
                    >
                      <input
                        type="checkbox"
                        checked={!!layer.defaultOn}
                        onChange={(e) => updateDefaultOn(e.target.checked)}
                      />
                      {t("settings.map.overlays.default")}
                    </label>
                    <button
                      type="button"
                      className="settings-overlay-move"
                      disabled={index === 0}
                      onClick={() => move(-1)}
                      title={t("settings.map.overlays.moveUp")}
                      aria-label={t("settings.map.overlays.moveUp")}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="settings-overlay-move"
                      disabled={index === overlays.length - 1}
                      onClick={() => move(1)}
                      title={t("settings.map.overlays.moveDown")}
                      aria-label={t("settings.map.overlays.moveDown")}
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      className="tools-geo-delete"
                      onClick={() => setOverlays(overlays.filter((o) => o.id !== layer.id))}
                      title={t("settings.map.overlays.remove")}
                      aria-label={t("settings.map.overlays.remove")}
                    >
                      🗑
                    </button>
                  </div>
                  {open && (
                    <>
                      <div className="settings-overlay-line">
                        <input
                          type="text"
                          className="settings-text-input"
                          value={layer.url}
                          placeholder={layer.wms ? t("settings.map.overlays.wmsUrl") : t("settings.map.overlays.url")}
                          title={layer.wms ? t("settings.map.overlays.wmsUrl.hint") : t("settings.map.overlays.url.hint")}
                          onChange={(e) => update({ url: e.target.value.trim() }, true)}
                        />
                        <label className="settings-overlay-wms" title={t("settings.map.overlays.wms.hint")}>
                          <input
                            type="checkbox"
                            checked={!!layer.wms}
                            onChange={(e) => update({ wms: e.target.checked || undefined })}
                          />
                          {t("settings.map.overlays.wms")}
                        </label>
                      </div>
                      {layer.wms && (
                        <>
                          <input
                            type="text"
                            className="settings-text-input"
                            value={layer.layers ?? ""}
                            placeholder={t("settings.map.overlays.wmsLayers")}
                            title={t("settings.map.overlays.wmsLayers.hint")}
                            onChange={(e) => update({ layers: e.target.value.trim() || undefined }, true)}
                          />
                          <input
                            type="text"
                            className="settings-text-input"
                            value={layer.styles ?? ""}
                            placeholder={t("settings.map.overlays.wmsStyles")}
                            title={t("settings.map.overlays.wmsStyles.hint")}
                            onChange={(e) => update({ styles: e.target.value.trim() || undefined }, true)}
                          />
                          <input
                            type="text"
                            className="settings-text-input"
                            value={layer.queryLayers ?? ""}
                            placeholder={t("settings.map.overlays.wmsQuery")}
                            title={t("settings.map.overlays.wmsQuery.hint")}
                            onChange={(e) => update({ queryLayers: e.target.value.trim() || undefined }, true)}
                          />
                          <input
                            type="text"
                            className="settings-text-input"
                            value={layer.params ?? ""}
                            placeholder={t("settings.map.overlays.wmsParams")}
                            title={t("settings.map.overlays.wmsParams.hint")}
                            onChange={(e) => update({ params: e.target.value.trim() || undefined }, true)}
                          />
                        </>
                      )}
                      <div className="settings-overlay-line">
                        <input
                          type="text"
                          className="settings-text-input settings-overlay-name"
                          value={layer.attribution ?? ""}
                          placeholder={t("settings.map.overlays.attribution")}
                          title={t("settings.map.overlays.attribution.hint")}
                          onChange={(e) => update({ attribution: e.target.value || undefined }, true)}
                        />
                        {!layer.wms && (
                          <input
                            type="number"
                            className="settings-overlay-year"
                            value={layer.maxZoom ?? ""}
                            placeholder={t("settings.map.overlays.maxZoom")}
                            title={t("settings.map.overlays.maxZoom.hint")}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              update({ maxZoom: e.target.value.trim() && Number.isFinite(n) ? n : undefined }, true);
                            }}
                          />
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
            </fieldset>
          </section>

          </>
          )}

          {tab === "advanced" && (
          <>
          <section className="settings-section">
            <h3>{t("settings.data.title")}</h3>
            <label className="settings-row settings-row-toggle">
              <input
                type="checkbox"
                checked={settings.persistWorkspace}
                onChange={(e) => set({ persistWorkspace: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{t("settings.data.persist")}</span>
                <span className="settings-hint">{t("settings.data.persist.hint")}</span>
              </span>
            </label>
            {settings.persistWorkspace && (
              <div className="settings-row">
                <span className="settings-row-text">
                  <span className="settings-row-label">{t("settings.data.clear")}</span>
                  <span className="settings-hint">{t("settings.data.clear.hint")}</span>
                </span>
                {/* The row's label already says what is cleared, so the button
                    only carries the verb. */}
                <button
                  type="button"
                  className="settings-danger-btn"
                  aria-label={t("settings.data.clear")}
                  onClick={onClearCache}
                >
                  {t("settings.data.clear.button")}
                </button>
              </div>
            )}
          </section>
          </>
          )}
        </div>
      </div>
    </div>
  );
}
