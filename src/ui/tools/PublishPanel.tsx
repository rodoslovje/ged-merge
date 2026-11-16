import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { nextTask, runSliced } from "../../state/localLoad";
import {
  buildPublishedTree,
  buildPublishedTreeSteps,
  defaultPublishOptions,
  LIVING_MODES,
  SCOPE_KINDS,
  SITE_INCLUDES,
  START_PAGES,
  type LivingMode,
  type PublishOptions,
  type ScopeKind,
  type SiteDisplay,
  type StartPage,
} from "../../publish/model";
import { publishedHtml, siteFileName } from "../../publish/page";
import { clearStoredPublish, readStoredPublish, writeStoredPublish } from "../../publish/stored";
import type { NameOrder } from "../../gedcom/nameDisplay";
import { baseStem, downloadText } from "../download";
import { StartPersonSelector } from "../StartPersonSelector";
import { SelectMenu } from "../DropdownMenu";
import { useSettingsSlice } from "../SettingsContext";
import { LANGUAGE_FLAGS, LANGUAGE_NAMES, SUPPORTED_LANGUAGES } from "../../locales/i18n";
import { DATE_DISPLAY_CHOICES, DATE_DISPLAY_WORDS } from "../dateDisplayFormat";
import { ToolsIntro, ToolsLoading } from "./shared";
import { ToolSummary } from "./ToolSummary";

/** The app's display settings a site carries (see {@link SiteDisplay}). */
const PERSIST_KEYS = ["persistWorkspace"] as const;
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
  step: "viewer" | "data" | "page";
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
  const [stored] = useState(() => {
    const defaults = defaultPublishOptions(baseStem(fileName), i18n.language, { ...appDisplay, dateDisplay: appDisplay.dateDisplay || DATE_DISPLAY_WORDS });
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
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const set = (patch: Partial<PublishOptions>) => setOptions((o) => ({ ...o, ...patch }));
  const siteStart = ownStart && dataset.individuals.has(ownStart) ? ownStart : startId;

  // The counts follow the choices when React has a moment — a title typed
  // letter by letter does not re-walk the file on every key.
  const settled = useDeferredValue(options);
  const { summary } = useMemo(
    () => (active ? buildPublishedTree(dataset, settled, siteStart) : { summary: undefined }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editVersion: the dataset is mutated in place
    [active, dataset, settled.scope, settled.partners, settled.living, settled.include, siteStart, editVersion],
  );

  // The download's three steps, each named while it runs: loading the viewer
  // (a large chunk, fetched on the first export), walking the file — in slices,
  // with a percentage — and writing the page.
  const download = async () => {
    const alive = () => mounted.current;
    setError(null);
    setPhase({ step: "viewer" });
    try {
      const bundle = await import("virtual:site-viewer");
      if (!alive()) return;
      setPhase({ step: "data", done: 0, total: 1 });
      const steps = buildPublishedTreeSteps(dataset, { ...options, lang: i18n.language }, siteStart, new Date(), (done, total) => {
        if (alive()) setPhase({ step: "data", done, total });
      });
      const result = await runSliced(steps, alive);
      if (!result) return;
      setPhase({ step: "page" });
      await nextTask();
      downloadText(siteFileName(options.title), publishedHtml(result.tree, bundle), "text/html;charset=utf-8");
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
        <label className="tools-norm-check">
          <input type="checkbox" checked={options.exports} onChange={() => set({ exports: !options.exports })} />
          <span>{t("tools.publish.exports")}</span>
        </label>
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
          <p className="tools-fix-hint">{t("tools.publish.omitted")}</p>
        </div>
      )}

      {error && <p className="tools-error">{t("tools.publish.error", { message: error })}</p>}
      <button className="nav-btn primary tools-run" onClick={() => void download()} disabled={!!phase || !summary?.people}>
        {t("tools.publish.download")}
      </button>
      {phase && (
        <ToolsLoading
          label={t(`tools.publish.step.${phase.step}`)}
          progress={phase.total ? { done: phase.done ?? 0, total: phase.total } : undefined}
        />
      )}
    </div>
  );
}
