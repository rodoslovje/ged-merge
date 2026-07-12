import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { dedupeSources, type DuplicateReport, type DupGroup, type DupKind } from "../../tools/sourceDuplicates";
import { downloadOptions, ensureUtf8Charset, serializeGedcom } from "../../gedcom/serialize";
import { downloadText } from "../download";
import { isEditableTarget, isModalOpen } from "../../keyboard/shortcuts";
import { BackButton } from "../BackButton";

const DUP_KINDS: DupKind[] = ["media", "source", "repo"];
const DUP_KIND_ICON: Record<DupKind, string> = { media: "🖼", source: "📚", repo: "🏛" };

/** The default-kept member of a group (the one the finder flagged as survivor). */
function defaultSurvivor(g: DupGroup): string {
  return (g.members.find((m) => m.survivor) ?? g.members[0]).xref;
}

/** A copy of `g` with `xref` marked as the kept record (the rest fold into it). */
function withSurvivor(g: DupGroup, xref: string): DupGroup {
  return { ...g, members: g.members.map((m) => ({ ...m, survivor: m.xref === xref })) };
}

/**
 * Lists the media/source/repository records that describe the same thing under
 * different ids (scan supplied by the parent). The user picks which groups to
 * merge and, within each, which record to keep, then downloads a deduplicated
 * GEDCOM (the live dataset is never touched — same contract as the Normalize
 * panel). Each selected group collapses to its chosen survivor with every
 * citation re-pointed onto it.
 */
export function SourceDuplicatesView({
  report,
  dataset,
  fileName,
  onBack,
}: {
  report: DuplicateReport;
  dataset: Dataset;
  fileName: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  // Groups excluded from the fix (default: all selected). Survivor overrides
  // keyed by group id (default: the finder's pick).
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [survivors, setSurvivors] = useState<Map<string, string>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Esc leaves the sub-page, matching the chart overlays.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || isEditableTarget(e.target) || isModalOpen()) return;
      e.preventDefault();
      onBack();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const back = <BackButton label={t("tools.sources.dupBack")} shortcutHint="Esc" showLabel onClick={onBack} />;

  const toggleGroup = (id: string) =>
    setExcluded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const chooseSurvivor = (id: string, xref: string) =>
    setSurvivors((m) => new Map(m).set(id, xref));

  const selectedGroups = report.groups
    .filter((g) => !excluded.has(g.id))
    .map((g) => withSurvivor(g, survivors.get(g.id) ?? defaultSurvivor(g)));
  const removeCount = selectedGroups.reduce((n, g) => n + g.removable, 0);

  function download() {
    const { records } = dedupeSources(dataset.records, selectedGroups);
    const base = fileName.replace(/\.ged$/i, "");
    ensureUtf8Charset(records, dataset); // downloads are UTF-8 bytes
    const text = serializeGedcom(records, downloadOptions(dataset));
    downloadText(`${base}.gedmerge.ged`, text);
  }

  return (
    <>
      <div className="tools-filter-row">
        {back}
        <div className="tools-dup-bulk">
          <button className="tools-issue-link" onClick={() => setExcluded(new Set())}>
            {t("tools.sources.dupSelectAll")}
          </button>
          <button className="tools-issue-link" onClick={() => setExcluded(new Set(report.groups.map((g) => g.id)))}>
            {t("tools.sources.dupSelectNone")}
          </button>
        </div>
        <p className="tools-summary">{t("tools.sources.dupFound", { count: report.groups.length })}</p>
      </div>
      <p className="tools-intro">{t("tools.sources.dupIntro")}</p>

      {DUP_KINDS.filter((k) => report.byKind[k] > 0).map((kind) => (
        <div key={kind} className="tools-dup-kind">
          <div className="tools-dup-kind-head">
            {DUP_KIND_ICON[kind]} {t(`tools.sources.dupKind.${kind}`)}
            <span className="tools-chip-count">{report.byKind[kind]}</span>
          </div>
          <ul className="tools-tree">
            {report.groups
              .filter((g) => g.kind === kind)
              .map((g) => (
                <DupGroupRow
                  key={g.id}
                  group={g}
                  checked={!excluded.has(g.id)}
                  survivorXref={survivors.get(g.id) ?? defaultSurvivor(g)}
                  open={expanded.has(g.id)}
                  onToggleCheck={() => toggleGroup(g.id)}
                  onToggleOpen={() => toggleExpand(g.id)}
                  onChooseSurvivor={(xref) => chooseSurvivor(g.id, xref)}
                />
              ))}
          </ul>
        </div>
      ))}

      <div className="tools-dup-actions">
        <button className="nav-btn primary tools-run" onClick={download} disabled={selectedGroups.length === 0}>
          {t("tools.sources.dupDownload")}
        </button>
        {selectedGroups.length > 0 && (
          <span className="tools-fix-hint">
            {t("tools.sources.dupDownloadCount", { groups: selectedGroups.length, records: removeCount })}
          </span>
        )}
      </div>
    </>
  );
}

/** One duplicate group: a checkbox to include it in the fix, the shared
 *  link/title, and an expandable list of its members with a radio to pick which
 *  record to keep (the rest fold into it). */
function DupGroupRow({
  group,
  checked,
  survivorXref,
  open,
  onToggleCheck,
  onToggleOpen,
  onChooseSurvivor,
}: {
  group: DupGroup;
  checked: boolean;
  survivorXref: string;
  open: boolean;
  onToggleCheck: () => void;
  onToggleOpen: () => void;
  onChooseSurvivor: (xref: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="tools-tree-node">
      <div className="tools-tree-row">
        <input type="checkbox" className="tools-dup-check" checked={checked} onChange={onToggleCheck} />
        <button
          className={`tools-pair-toggle ${open ? "open" : ""}`}
          onClick={onToggleOpen}
          aria-expanded={open}
        >
          ▶
        </button>
        <span className="tools-tree-label clickable" onClick={onToggleOpen} title={group.label}>
          {group.label}
        </span>
        <span className="tools-chip-count">{group.members.length}</span>
      </div>
      {open && (
        <div className="tools-tree-children">
          <ul className="tools-dup-members">
            {group.members.map((m) => {
              const keep = m.xref === survivorXref;
              return (
                <li key={m.xref} className={keep ? "tools-dup-member survivor" : "tools-dup-member"}>
                  <label className="tools-dup-keep-pick" title={t("tools.sources.dupKeepThis")}>
                    <input
                      type="radio"
                      name={`surv-${group.id}`}
                      checked={keep}
                      onChange={() => onChooseSurvivor(m.xref)}
                    />
                    {keep && <span className="tools-dup-keep">{t("tools.sources.dupKeep")}</span>}
                  </label>
                  <span className="tools-dup-title">{m.title}</span>
                  {m.detail && m.detail !== m.title && <span className="tools-tree-meta">{m.detail}</span>}
                  {m.usage > 0 && (
                    <span className="tools-tree-meta">· {t("tools.sources.dupUsage", { count: m.usage })}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </li>
  );
}
