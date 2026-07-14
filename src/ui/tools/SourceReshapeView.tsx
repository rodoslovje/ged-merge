import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import {
  fetchReshapeMeta,
  reshapeSources,
  type ReshapeEnrichment,
  type ReshapeGroup,
  type ReshapeOccurrence,
  type ReshapeReport,
  type ReshapeSite,
} from "../../tools/sourceReshape";
import { downloadOptions, ensureUtf8Charset, serializeGedcom } from "../../gedcom/serialize";
import { fetchPageHtml } from "../../normalize/urlMetadata";
import { downloadText } from "../download";
import { isEditableTarget, isModalOpen } from "../../keyboard/shortcuts";
import { BackButton } from "../BackButton";
import { useSettings } from "../SettingsContext";

const SITES: ReshapeSite[] = ["matricula", "geneanet", "familysearch", "other"];
const SITE_ICON: Record<ReshapeSite, string> = { matricula: "⛪", geneanet: "🪦", familysearch: "🌳", other: "🔗" };
const QUAY_CHOICES = ["", "0", "1", "2", "3"];

/**
 * "Source reshape": turns bare Matricula / Geneanet Cemeteries / FamilySearch
 * links (and, optionally, any other URL) into proper source records with
 * pointer citations. The scan comes from the tools worker via the parent; the
 * user picks site categories and groups, optionally fetches book metadata
 * (one request per book, only when link-fetching is allowed in Settings), and
 * downloads the reshaped GEDCOM — the live dataset is never touched, same
 * contract as the duplicate finder.
 */
export function SourceReshapeView({
  report,
  dataset,
  fileName,
  onBack,
}: {
  report: ReshapeReport;
  dataset: Dataset;
  fileName: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  // "other" is opt-in: generic links usually aren't archive sources.
  const [sites, setSites] = useState<Set<ReshapeSite>>(new Set(["matricula", "geneanet", "familysearch"]));
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [relocate, setRelocate] = useState(true);
  const [quay, setQuay] = useState("");
  const [quayOverrides, setQuayOverrides] = useState<Map<string, string>>(new Map());
  const [enrichment, setEnrichment] = useState<ReshapeEnrichment>(new Map());
  const [fetching, setFetching] = useState<{ done: number; total: number } | null>(null);

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

  const toggleSite = (site: ReshapeSite) =>
    setSites((s) => {
      const next = new Set(s);
      if (next.has(site)) next.delete(site);
      else next.add(site);
      return next;
    });

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

  const visibleGroups = useMemo(() => report.groups.filter((g) => sites.has(g.site)), [report, sites]);
  const selectedGroups = useMemo(
    () =>
      visibleGroups
        .filter((g) => !excluded.has(g.id))
        .map((g) => {
          const groupQuay = quayOverrides.get(g.id) ?? quay;
          return groupQuay ? { ...g, quay: groupQuay } : g;
        }),
    [visibleGroups, excluded, quayOverrides, quay],
  );
  const citationCount = selectedGroups.reduce((n, g) => n + g.members.length, 0);
  const newSourceGroups = selectedGroups.filter(
    (g) => !g.existingSourceXref && (g.site === "matricula" || g.site === "geneanet"),
  );

  function download() {
    const { records } = reshapeSources(dataset.records, selectedGroups, enrichment, { relocate });
    const base = fileName.replace(/\.ged$/i, "");
    ensureUtf8Charset(records, dataset); // downloads are UTF-8 bytes
    const text = serializeGedcom(records, downloadOptions(dataset));
    downloadText(`${base}.gedmerge.ged`, text);
  }

  async function fetchDetails() {
    setFetching({ done: 0, total: newSourceGroups.length });
    const fetched = await fetchReshapeMeta(newSourceGroups, fetchPageHtml, (done, total) =>
      setFetching({ done, total }),
    );
    setEnrichment((prev) => new Map([...prev, ...fetched]));
    setFetching(null);
  }

  const groupTitle = (g: ReshapeGroup) => enrichment.get(g.id)?.title ?? g.proposed.title;

  return (
    <>
      <div className="tools-filter-row">
        <BackButton label={t("tools.sources.reshapeBack")} shortcutHint="Esc" showLabel onClick={onBack} />
        <div className="tools-dup-bulk">
          <button className="tools-issue-link" onClick={() => setExcluded(new Set())}>
            {t("tools.sources.dupSelectAll")}
          </button>
          <button className="tools-issue-link" onClick={() => setExcluded(new Set(report.groups.map((g) => g.id)))}>
            {t("tools.sources.dupSelectNone")}
          </button>
        </div>
        <p className="tools-summary">{t("tools.sources.reshapeFound", { count: visibleGroups.length })}</p>
      </div>
      <p className="tools-intro">{t("tools.sources.reshapeIntro")}</p>

      <div className="tools-reshape-options">
        {SITES.filter((s) => report.bySite[s] > 0).map((site) => (
          <label key={site} className="tools-reshape-site">
            <input type="checkbox" checked={sites.has(site)} onChange={() => toggleSite(site)} />
            {SITE_ICON[site]} {t(`tools.sources.reshapeSite.${site}`)}
            <span className="tools-chip-count">{report.bySite[site]}</span>
          </label>
        ))}
        <label className="tools-reshape-site" title={t("tools.sources.reshapePlaceHint")}>
          <input type="checkbox" checked={relocate} onChange={() => setRelocate((v) => !v)} />
          {t("tools.sources.reshapePlace")}
        </label>
        <label className="tools-reshape-site" title={t("tools.sources.reshapeQuayHint")}>
          {t("tools.sources.reshapeQuay")}
          <select value={quay} onChange={(e) => setQuay(e.target.value)}>
            {QUAY_CHOICES.map((q) => (
              <option key={q} value={q}>
                {q === "" ? "–" : q}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ul className="tools-tree">
        {visibleGroups.map((g) => (
          <ReshapeGroupRow
            key={g.id}
            group={g}
            title={groupTitle(g)}
            checked={!excluded.has(g.id)}
            open={expanded.has(g.id)}
            relocate={relocate}
            quay={quayOverrides.get(g.id) ?? quay}
            onQuay={(v) => setQuayOverrides((m) => new Map(m).set(g.id, v))}
            onToggleCheck={() => toggleGroup(g.id)}
            onToggleOpen={() => toggleExpand(g.id)}
          />
        ))}
      </ul>

      <div className="tools-dup-actions">
        <button className="nav-btn primary tools-run" onClick={download} disabled={selectedGroups.length === 0}>
          {t("tools.sources.reshapeDownload")}
        </button>
        {settings.allowLinkFetch && newSourceGroups.length > 0 && (
          <button className="nav-btn tools-run" onClick={fetchDetails} disabled={fetching !== null}>
            {fetching
              ? t("tools.sources.reshapeFetching", { done: fetching.done, total: fetching.total })
              : t("tools.sources.reshapeFetch")}
          </button>
        )}
        {selectedGroups.length > 0 && (
          <span className="tools-fix-hint">
            {t("tools.sources.reshapeDownloadCount", { groups: selectedGroups.length, citations: citationCount })}
          </span>
        )}
      </div>
    </>
  );
}

/** One book/grave/film group: checkbox, title, badges, and expandable members. */
function ReshapeGroupRow({
  group,
  title,
  checked,
  open,
  relocate,
  quay,
  onQuay,
  onToggleCheck,
  onToggleOpen,
}: {
  group: ReshapeGroup;
  title: string;
  checked: boolean;
  open: boolean;
  relocate: boolean;
  quay: string;
  onQuay: (value: string) => void;
  onToggleCheck: () => void;
  onToggleOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="tools-tree-node">
      <div className="tools-tree-row">
        <input type="checkbox" className="tools-dup-check" checked={checked} onChange={onToggleCheck} />
        <button className={`tools-pair-toggle ${open ? "open" : ""}`} onClick={onToggleOpen} aria-expanded={open}>
          ▶
        </button>
        <span className="tools-tree-label clickable" onClick={onToggleOpen} title={group.bookUrl}>
          {SITE_ICON[group.site]} {title}
        </span>
        {group.bookType !== "unknown" && (
          <span className="tools-tree-meta">{t(`tools.sources.reshapeType.${group.bookType}`)}</span>
        )}
        {group.pages.length > 0 && (
          <span className="tools-tree-meta">{t("tools.sources.reshapePages", { count: group.pages.length })}</span>
        )}
        <span className="tools-tree-meta">
          {group.existingSourceXref
            ? t("tools.sources.reshapeReuses", { title: group.existingSourceTitle ?? group.existingSourceXref })
            : t("tools.sources.reshapeNew")}
        </span>
        <span className="tools-chip-count">{group.members.length}</span>
      </div>
      {open && (
        <div className="tools-tree-children">
          <label className="tools-reshape-site" title={t("tools.sources.reshapeQuayHint")}>
            {t("tools.sources.reshapeQuay")}
            <select value={quay} onChange={(e) => onQuay(e.target.value)}>
              {QUAY_CHOICES.map((q) => (
                <option key={q} value={q}>
                  {q === "" ? "–" : q}
                </option>
              ))}
            </select>
          </label>
          <ul className="tools-dup-members">
            {group.members.map((m, i) => (
              <MemberRow key={`${m.recordXref}:${i}`} member={m} relocate={relocate} />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function MemberRow({ member: m, relocate }: { member: ReshapeOccurrence; relocate: boolean }) {
  const { t } = useTranslation();
  const at = m.eventTag ?? t("tools.sources.reshapeRecordLevel");
  return (
    <li className="tools-dup-member">
      <span className="tools-dup-title" title={m.url}>
        {m.recordLabel}
      </span>
      <span className="tools-tree-meta">
        {at}
        {relocate && m.targetEvent && ` → ${m.targetEvent}`} · {t(`tools.sources.reshapeShape.${m.shape}`)}
        {m.page && ` · ${t("tools.sources.reshapePage", { page: m.page })}`}
      </span>
      <a className="tools-tree-meta" href={m.url} target="_blank" rel="noreferrer">
        ↗
      </a>
    </li>
  );
}
