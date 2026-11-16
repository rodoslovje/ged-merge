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
  START_PAGES,
  type LivingMode,
  type PublishOptions,
  type ScopeKind,
  type StartPage,
} from "../../publish/model";
import { publishedHtml, siteFileName } from "../../publish/page";
import { baseStem, downloadText } from "../download";
import { StartPersonSelector } from "../StartPersonSelector";
import { ToolsIntro, ToolsLoading } from "./shared";
import { ToolSummary } from "./ToolSummary";

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
  const [options, setOptions] = useState<PublishOptions>(() => defaultPublishOptions(baseStem(fileName), i18n.language));
  const [ownStart, setOwnStart] = useState<string | undefined>();
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
    [active, dataset, settled.scope, settled.partners, settled.living, siteStart, editVersion],
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
        <label className="tools-publish-field">
          <span className="tools-privacy-legend">{t("tools.publish.introText")}</span>
          <textarea
            className="tools-publish-input"
            rows={3}
            value={options.intro}
            placeholder={t("tools.publish.introPlaceholder")}
            onChange={(e) => set({ intro: e.target.value })}
          />
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
