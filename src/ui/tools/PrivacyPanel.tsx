import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import {
  findLiving,
  privatizeDataset,
  defaultPrivacyOptions,
  type PrivacyOptions,
  type FlaggedPerson,
  type NameStrategy,
  type PrivacyAction,
  type ResnMode,
  type StripCategory,
} from "../../tools/privacy";
import { downloadOptions, ensureUtf8Charset, serializeGedcom } from "../../gedcom/serialize";
import { downloadText, savedName } from "../download";
import { PersonLink } from "../PersonLink";
import { ToolsLoading } from "./shared";

const NAME_STRATEGIES: NameStrategy[] = ["living", "private", "initials", "initialSurname", "surnameOnly"];
const ACTIONS: PrivacyAction[] = ["sanitize", "remove", "removeDescendants"];
const RESN_MODES: ResnMode[] = ["stripStamp", "stripOnly", "markOnly"];
const STRIP_CATS: StripCategory[] = ["events", "notes", "sources", "media", "contact"];

/** Let React paint the "working…" state before a blocking computation runs. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A short plain-text audit of what the redaction did, downloaded alongside. */
function privacyReportText(flagged: FlaggedPerson[], opts: PrivacyOptions): string {
  const lines = [
    "GED Merge — privacy redaction report",
    `Living threshold: ${opts.livingThresholdYears} years`,
    `Action: ${opts.action} · names: ${opts.nameStrategy} · RESN: ${opts.resn}`,
    "",
    `Flagged living people (${flagged.length}):`,
    ...flagged.map((f) => {
      const note = f.estimate
        ? ` — est. born ~${f.estimate.estimatedYear} via ${f.estimate.relation} ${f.estimate.relativeName} (b. ${f.estimate.relativeYear})`
        : "";
      return `  ${f.id}  ${f.subject}  [${f.reason}]${note}`;
    }),
  ];
  return lines.join("\n") + "\n";
}

export function PrivacyPanel({
  dataset,
  fileName,
  onNavigate,
  active,
}: {
  dataset: Dataset;
  fileName: string;
  onNavigate: (id: string) => void;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<PrivacyOptions>(defaultPrivacyOptions);
  const [ready, setReady] = useState(false);
  const [showList, setShowList] = useState(false);

  useEffect(() => {
    setOptions(defaultPrivacyOptions());
    setReady(false);
    setShowList(false);
  }, [dataset]);

  // Defer the first scan one tick so the "working…" state paints first.
  useEffect(() => {
    if (!active || ready) return;
    let cancelled = false;
    void nextTick().then(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [active, ready]);

  const flagged = useMemo(() => (ready ? findLiving(dataset, options) : []), [ready, dataset, options]);
  const counts = useMemo(() => {
    const c = { birth: 0, relative: 0, unknown: 0, recentDeath: 0, declared: 0 };
    for (const f of flagged) c[f.reason]++;
    return c;
  }, [flagged]);

  if (!ready) return <ToolsLoading label={t("tools.privacy.running")} />;

  const markOnly = options.resn === "markOnly";
  const showSanitize = !markOnly && options.action === "sanitize";

  const set = (patch: Partial<PrivacyOptions>) => setOptions((o) => ({ ...o, ...patch }));
  const toggleStrip = (cat: StripCategory) =>
    setOptions((o) => ({ ...o, strip: { ...o.strip, [cat]: !o.strip[cat] } }));
  const toggleFile = (key: keyof PrivacyOptions["file"]) =>
    setOptions((o) => ({ ...o, file: { ...o.file, [key]: !o.file[key] } }));

  function download() {
    const { records, report } = privatizeDataset(dataset, options);
    ensureUtf8Charset(records, dataset); // downloads are UTF-8 bytes
    const d = new Date(); // one shared stamp so the .ged and its report sort together
    downloadText(savedName(fileName, "ged", d), serializeGedcom(records, downloadOptions(dataset)));
    downloadText(savedName(fileName, "report.txt", d), privacyReportText(report.flagged, options));
  }

  return (
    <div className="tools-privacy">
      <p className="tools-intro">{t("tools.privacy.intro")}</p>

      {/* Threshold + recent-death */}
      <div className="tools-privacy-group">
        <label className="tools-privacy-inline">
          {t("tools.privacy.threshold")}
          <input
            type="number"
            min={0}
            className="tools-privacy-num"
            value={options.livingThresholdYears}
            onChange={(e) => set({ livingThresholdYears: Math.max(0, Number(e.target.value) || 0) })}
          />
          {t("tools.privacy.thresholdYears")}
        </label>
        <label className="tools-privacy-inline">
          {t("tools.privacy.recentDeath")}
          <input
            type="number"
            min={0}
            className="tools-privacy-num"
            value={options.alsoRecentlyDeceasedYears}
            onChange={(e) => set({ alsoRecentlyDeceasedYears: Math.max(0, Number(e.target.value) || 0) })}
          />
          {t("tools.privacy.thresholdYears")}
          {options.alsoRecentlyDeceasedYears === 0 && <span className="muted"> {t("tools.privacy.recentDeathOff")}</span>}
        </label>
        <RadioRow
          label={t("tools.privacy.unknownBirth")}
          name="privacy-unknown"
          value={options.unknownBirthPolicy}
          options={[
            { id: "living", label: t("tools.privacy.unknownBirth.living") },
            { id: "skip", label: t("tools.privacy.unknownBirth.skip") },
          ]}
          onChange={(v) => set({ unknownBirthPolicy: v as PrivacyOptions["unknownBirthPolicy"] })}
        />
      </div>

      {/* RESN mode */}
      <RadioRow
        label={t("tools.privacy.resn")}
        name="privacy-resn"
        value={options.resn}
        options={RESN_MODES.map((m) => ({ id: m, label: t(`tools.privacy.resn.${m}`) }))}
        onChange={(v) => set({ resn: v as ResnMode })}
      />

      {/* Action (disabled in mark-only mode) */}
      {!markOnly && (
        <RadioRow
          label={t("tools.privacy.action")}
          name="privacy-action"
          value={options.action}
          options={ACTIONS.map((a) => ({ id: a, label: t(`tools.privacy.action.${a}`) }))}
          onChange={(v) => set({ action: v as PrivacyAction })}
        />
      )}

      {/* Name strategy + strip scope (sanitize only) */}
      {showSanitize && (
        <>
          <div className="tools-privacy-group">
            <div className="tools-privacy-legend">{t("tools.privacy.name")}</div>
            <div className="tools-privacy-radios">
              {NAME_STRATEGIES.map((s) => (
                <label key={s} className={`tools-norm-check ${options.nameStrategy === s ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="privacy-name"
                    checked={options.nameStrategy === s}
                    onChange={() => set({ nameStrategy: s })}
                  />
                  <span>{t(`tools.privacy.name.${s}`)}</span>
                  {s === "private" && options.nameStrategy === "private" && (
                    <input
                      type="text"
                      className="tools-privacy-text"
                      value={options.customName}
                      placeholder="Private"
                      onChange={(e) => set({ customName: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                    />
                  )}
                </label>
              ))}
            </div>
          </div>
          <div className="tools-privacy-group">
            <div className="tools-privacy-legend">{t("tools.privacy.strip")}</div>
            <ul className="tools-norm-summary">
              {STRIP_CATS.map((cat) => (
                <li key={cat}>
                  <label className="tools-norm-check">
                    <input type="checkbox" checked={options.strip[cat]} onChange={() => toggleStrip(cat)} />
                    <span>{t(`tools.privacy.strip.${cat}`)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {/* File-level privacy */}
      <div className="tools-privacy-group">
        <div className="tools-privacy-legend">{t("tools.privacy.file")}</div>
        <ul className="tools-norm-summary">
          {(["stripSubmitter", "stripExternalIds", "scrubAddress", "scrubEmail", "scrubPhone"] as const).map((key) => (
            <li key={key}>
              <label className="tools-norm-check">
                <input type="checkbox" checked={options.file[key]} onChange={() => toggleFile(key)} />
                <span>{t(`tools.privacy.file.${key}`)}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      {/* Affected preview */}
      {flagged.length === 0 ? (
        <p className="tools-clean">{t("tools.privacy.none")}</p>
      ) : (
        <div className="tools-privacy-group">
          <p className="tools-summary">{t("tools.privacy.affected", { count: flagged.length })}</p>
          <p className="tools-fix-hint">
            {t("tools.privacy.breakdown", counts)}
            {counts.recentDeath > 0 && t("tools.privacy.breakdownRecent", counts)}
          </p>
          <button className="tools-issue-link" onClick={() => setShowList((s) => !s)}>
            {showList ? t("tools.privacy.hideList") : t("tools.privacy.showList")}
          </button>
          {showList && (
            <ul className="tools-issues">
              {flagged.map((f, i) => (
                <li key={f.id} className={`tools-issue${i % 2 ? " zebra" : ""}`}>
                  <PersonLink dataset={dataset} id={f.id} fallback={f.subject} onNavigate={onNavigate} />
                  <span className="tools-issue-msg" title={t(`tools.privacy.reasonHint.${f.reason}`)}>
                    {t(`tools.privacy.reason.${f.reason}`)}
                  </span>
                  {f.estimate && (
                    <span className="tools-issue-detail">
                      {t("tools.privacy.reason.relativeDetail", {
                        year: f.estimate.estimatedYear,
                        relation: t(`tools.privacy.relation.${f.estimate.relation}`),
                        name: f.estimate.relativeName,
                        relativeYear: f.estimate.relativeYear,
                      })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button className="nav-btn primary tools-run" onClick={download} disabled={flagged.length === 0}>
        {t("tools.privacy.download")}
      </button>
    </div>
  );
}

/** A labeled inline group of radio buttons sharing one `name`. */
function RadioRow({
  label,
  name,
  value,
  options,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="tools-privacy-group">
      <div className="tools-privacy-legend">{label}</div>
      <div className="tools-privacy-radios">
        {options.map((o) => (
          <label key={o.id} className={`tools-norm-check ${value === o.id ? "active" : ""}`}>
            <input type="radio" name={name} checked={value === o.id} onChange={() => onChange(o.id)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
