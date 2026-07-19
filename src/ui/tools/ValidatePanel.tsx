import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { type ValidationReport, type ValidationIssue, type IssueCategory } from "../../tools/validate";
import { countInferableSex } from "../../tools/fixSex";
import { countFixableDates } from "../../tools/fixDates";
import { countSplitCoordFills, scanSplitCoordPlaces } from "../../tools/placeCoords";
import { type StructureReport, type StructCategory, type StructIssue } from "../../tools/structure";
import { collectLocalMediaFiles, type MediaFileUse } from "../../tools/mediaFiles";
import { ConfirmDialog } from "../ConfirmDialog";
import { PersonLink } from "../PersonLink";
import { useMediaFolder } from "../MediaFolderContext";
import { type ToolsScans } from "../useToolsScans";
import { useVirtualList } from "../useVirtualList";
import { ToolsError, ToolsLoading, TreeSearch, UsageList, useDebounced } from "./shared";

/** One-button repair flows; the suffix is the i18n key segment (`fix<Suffix>`). */
type FixKind = "links" | "sex" | "dates" | "dups";
const FIX_SUFFIX: Record<FixKind, string> = { links: "Links", sex: "Sex", dates: "Dates", dups: "DupPointers" };

/** The Health-Check filter each fix previews before it runs, so confirming the
 *  fix happens with the affected findings on screen. */
const FIX_CATEGORY: Record<FixKind, IssueCategory | StructCategory> = {
  links: "brokenLink",
  dups: "duplicatePointer",
  sex: "missingSex",
  dates: "badDate",
};

const CATEGORIES: IssueCategory[] = [
  "brokenLink",
  "duplicatePointer",
  "pedigreeLoop",
  "roleSexConflict",
  "deathBeforeBirth",
  "ageAtDeath",
  "ageAtMarriage",
  "parentAge",
  "spouseAgeGap",
  "futureDate",
  "missingVitals",
  "missingName",
  "missingSex",
  "orphan",
];

/** Sort weight per severity, so a unified list shows errors → warnings → info. */
const SEV_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 };

/** A row in the unified Health Check list — a record-level finding or a structural
 *  ("spec") one. Both carry a severity so they interleave by it in the "All" view. */
type IssueRow =
  | { kind: "record"; severity: string; issue: ValidationIssue }
  | { kind: "struct"; severity: string; issue: StructIssue };

export function ValidatePanel({
  dataset,
  scans,
  onNavigate,
  active,
  onFixBrokenLinks,
  onFixSexFromRole,
  onFixDates,
  onFixDuplicatePointers,
  onFillPlaceCoords,
}: {
  dataset: Dataset;
  scans: ToolsScans;
  onNavigate: (id: string) => void;
  active: boolean;
  onFixBrokenLinks: () => number;
  onFixSexFromRole: () => number;
  onFixDates: () => number;
  onFixDuplicatePointers: () => number;
  onFillPlaceCoords: () => number;
}) {
  const { t } = useTranslation();
  // Both validation passes come from the worker scan cache. While a re-run is
  // in flight (a fix triggers one), the previous lists stay up via `lastRef`
  // so the panel doesn't flash back to a spinner.
  const scan = scans.validate;
  const lastRef = useRef<{ report: ValidationReport; structure: StructureReport } | null>(null);
  if (scan.status === "done") lastRef.current = scan.result;
  const report = scan.status === "done" ? scan.result.report : (lastRef.current?.report ?? null);
  const structure = scan.status === "done" ? scan.result.structure : (lastRef.current?.structure ?? null);
  const [filter, setFilter] = useState<IssueCategory | StructCategory | "all">("all");
  const [query, setQuery] = useState("");
  // Transient confirmation after a one-button fix: which fix, and how many
  // records it repaired.
  const [fixDone, setFixDone] = useState<{ kind: FixKind; count: number } | null>(null);
  // A fix the user has requested but not yet confirmed. Requesting it switches
  // the filter to that fix's category so the affected findings are on screen
  // behind the confirmation dialog.
  const [pendingFix, setPendingFix] = useState<FixKind | null>(null);

  // Photo-folder check: the local media files referenced by the dataset, and —
  // once checked — the subset not found in the loaded folder. The check is
  // user-triggered (a button click) because resolving a restored folder handle
  // can need permission, which the browser only grants under a user gesture.
  const { folderName, resolveFile } = useMediaFolder();
  const mediaFiles = useMemo(() => collectLocalMediaFiles(dataset), [dataset]);
  const [mediaMissing, setMediaMissing] = useState<MediaFileUse[] | null>(null);
  const [mediaChecking, setMediaChecking] = useState(false);

  async function runMediaCheck() {
    setMediaChecking(true);
    const results = await Promise.all(mediaFiles.map((f) => resolveFile(f.file)));
    setMediaMissing(mediaFiles.filter((_, i) => results[i] === null));
    setMediaChecking(false);
  }

  // Places geocoded on some events but not others: a coordinate the file
  // already carries for a value, missing from other occurrences of the same
  // value. Detected on the main thread (a PLAC walk), like the fixable-subset
  // counts above; re-derived after a fix's re-validate refreshes `report`.
  const splitPlaces = useMemo(
    () => scanSplitCoordPlaces(dataset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, report],
  );
  const splitFills = countSplitCoordFills(splitPlaces);
  const [placeCoordDone, setPlaceCoordDone] = useState<number | null>(null);
  const [placeCoordPending, setPlaceCoordPending] = useState(false);

  function applyPlaceCoordFix() {
    setPlaceCoordPending(false);
    const changed = onFillPlaceCoords();
    setPlaceCoordDone(changed);
    // Re-validate (in the worker) so the shared report — and this section's
    // main-thread scan, which keys on it — refreshes to the fixed data.
    scans.refresh("validate");
  }

  // Step 1: clicking a fix button shows the affected findings (switch the
  // filter to the fix's category), then asks for confirmation.
  function requestFix(kind: FixKind) {
    setFilter(FIX_CATEGORY[kind]);
    setPendingFix(kind);
  }

  // Step 2: the user confirmed — apply the fix and refresh both lists.
  function applyFix(kind: FixKind) {
    setPendingFix(null);
    const changed =
      kind === "links" ? onFixBrokenLinks()
      : kind === "sex" ? onFixSexFromRole()
      : kind === "dates" ? onFixDates()
      : onFixDuplicatePointers();
    setFixDone({ kind, count: changed });
    // App mutated the live dataset in place — re-validate (in the worker) to
    // refresh both lists; the current ones stay up until the fresh ones arrive.
    scans.refresh("validate");
    setFilter("all");
  }

  useEffect(() => {
    lastRef.current = null;
    setFilter("all");
    setQuery("");
    setFixDone(null);
    setPendingFix(null);
    setPlaceCoordDone(null);
    setPlaceCoordPending(false);
  }, [dataset]);

  // A new dataset or a changed folder invalidates a prior photo check.
  useEffect(() => {
    setMediaMissing(null);
    setMediaChecking(false);
  }, [dataset, folderName]);

  useEffect(() => {
    if (active) scans.ensure("validate");
  }, [active, scans]);

  const q = useDebounced(query).trim().toLowerCase();

  // The unified Health Check list: record-level findings and structural ("spec")
  // findings merged into one stream, filtered by the active category chip and the
  // search box, then sorted errors → warnings → info so both kinds interleave.
  const shown = useMemo<IssueRow[]>(() => {
    const rows: IssueRow[] = [];
    for (const issue of report?.issues ?? []) {
      if (filter !== "all" && issue.category !== filter) continue;
      if (q && !issue.subject.toLowerCase().includes(q)) continue;
      rows.push({ kind: "record", severity: issue.severity, issue });
    }
    for (const issue of structure?.issues ?? []) {
      if (filter !== "all" && issue.category !== filter) continue;
      // Structural rows have no person subject; match the search on the tag/record.
      if (q && !`${issue.sample ?? ""} ${issue.recordId ?? ""}`.toLowerCase().includes(q)) continue;
      rows.push({ kind: "struct", severity: issue.severity, issue });
    }
    rows.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
    return rows;
  }, [report, structure, filter, q]);

  // A big file's health check can produce six-figure finding counts — only the
  // rows near the viewport are mounted. The scroll container is the ancestor
  // `.tools-view`, which the hook discovers on its own.
  const virtual = useVirtualList({ count: shown.length, estimate: 34, itemsKey: shown });

  // How many "No sex" records can be resolved from family role (a subset of the
  // missingSex findings). Recomputed when the report changes (e.g. after a fix).
  const inferableSex = useMemo(
    () => (report && report.counts.missingSex > 0 ? countInferableSex(dataset) : 0),
    [report, dataset],
  );

  // How many unparseable dates can be safely repaired (a subset of the badDate
  // structural findings). Recomputed when the structure report changes.
  const fixableDates = useMemo(
    () => (structure && structure.counts.badDate > 0 ? countFixableDates(dataset) : 0),
    [structure, dataset],
  );

  if (!report) {
    return scan.status === "error" ? <ToolsError message={scan.message} /> : <ToolsLoading label={t("tools.running")} />;
  }

  // Record-level + structural findings count together toward the total / "All".
  const total = report.issues.length + (structure?.issues.length ?? 0);

  // The available fix actions, with their counts, gathered into one list. The
  // media-folder check is a read-only probe and so carries no count to repair.
  const fixActions: { kind: FixKind; count: number }[] = [];
  if (report.counts.brokenLink > 0) fixActions.push({ kind: "links", count: report.counts.brokenLink });
  if (report.counts.duplicatePointer > 0) fixActions.push({ kind: "dups", count: report.counts.duplicatePointer });
  if (inferableSex > 0) fixActions.push({ kind: "sex", count: inferableSex });
  if (fixableDates > 0) fixActions.push({ kind: "dates", count: fixableDates });
  const showMediaCheck = !!folderName && mediaFiles.length > 0 && mediaMissing === null;
  const pendingCount = pendingFix
    ? (fixActions.find((a) => a.kind === pendingFix)?.count ?? 0)
    : 0;

  return (
    <>
      {fixDone !== null && (
        <p className="tools-clean tools-clean--ok">
          {t(
            `tools.validate.fix${FIX_SUFFIX[fixDone.kind]}${fixDone.count > 0 ? "Done" : "None"}`,
            { count: fixDone.count },
          )}
        </p>
      )}
      {mediaMissing !== null && (
        mediaMissing.length === 0 ? (
          <p className="tools-clean tools-clean--ok">{t("tools.validate.media.allFound", { count: mediaFiles.length })}</p>
        ) : (
          <div className="tools-struct">
            <div className="tools-examples-title">{t("tools.validate.media.title")}</div>
            <p className="tools-fix-hint">
              {t("tools.validate.media.missing", { count: mediaMissing.length, total: mediaFiles.length })}
            </p>
            <ul className="tools-issues">
              {mediaMissing.map((m, i) => (
                <li key={`${m.file}-${i}`} className={`tools-issue sev-warning${i % 2 ? " zebra" : ""}`}>
                  <span className="tools-issue-msg" title={m.title ?? m.file}>{m.file}</span>
                  {m.usedBy.length > 0 && <UsageList dataset={dataset} uses={m.usedBy} onNavigate={onNavigate} />}
                </li>
              ))}
            </ul>
          </div>
        )
      )}
      {placeCoordDone !== null && (
        <p className="tools-clean tools-clean--ok">
          {t(`tools.validate.placeCoord.${placeCoordDone > 0 ? "done" : "none"}`, { count: placeCoordDone })}
        </p>
      )}
      {splitPlaces.length > 0 && placeCoordDone === null && (
        <div className="tools-struct">
          <div className="tools-examples-title">{t("tools.validate.placeCoord.title")}</div>
          <p className="tools-fix-hint">{t("tools.validate.placeCoord.hint", { count: splitPlaces.length, fills: splitFills })}</p>
          <button className="nav-btn tools-run" onClick={() => setPlaceCoordPending(true)}>
            {t("tools.validate.placeCoord.fix", { count: splitFills })}
          </button>
          <ul className="tools-issues">
            {splitPlaces.slice(0, 200).map((p, i) => (
              <li key={p.value} className={`tools-issue sev-warning${i % 2 ? " zebra" : ""}`}>
                <span className="tools-issue-msg">{p.value}</span>
                <span className="tools-chip-count" title={t("tools.validate.placeCoord.occ", { count: p.missing })}>
                  {p.missing}
                </span>
                <span className="gm-data">
                  {p.coord.lat.toFixed(4)}, {p.coord.lon.toFixed(4)}
                </span>
              </li>
            ))}
          </ul>
          {splitPlaces.length > 200 && (
            <p className="tools-fix-hint">{t("tools.geocode.more", { count: splitPlaces.length - 200 })}</p>
          )}
        </div>
      )}
      {placeCoordPending && (
        <ConfirmDialog
          message={`${t("tools.validate.placeCoord.fix", { count: splitFills })}\n\n${t("tools.validate.placeCoord.fixHint")}`}
          confirmLabel={t("tools.validate.applyFix")}
          onConfirm={applyPlaceCoordFix}
          onCancel={() => setPlaceCoordPending(false)}
        />
      )}
      {(showMediaCheck || fixActions.length > 0) && (
        <ul className="tools-fix-list">
          {showMediaCheck && (
            <li className="tools-fix-item">
              <button className="nav-btn tools-run" onClick={runMediaCheck} disabled={mediaChecking}>
                {t("tools.validate.media.check", { count: mediaFiles.length })}
              </button>
              <span className="tools-fix-hint">{t("tools.validate.media.checkHint", { name: folderName })}</span>
            </li>
          )}
          {fixActions.map(({ kind, count }) => (
            <li key={kind} className="tools-fix-item">
              <button className="nav-btn tools-run" onClick={() => requestFix(kind)}>
                {t(`tools.validate.fix${FIX_SUFFIX[kind]}`, { count })}
              </button>
              <span className="tools-fix-hint">{t(`tools.validate.fix${FIX_SUFFIX[kind]}Hint`)}</span>
            </li>
          ))}
        </ul>
      )}
      {pendingFix !== null && (
        <ConfirmDialog
          message={`${t(`tools.validate.fix${FIX_SUFFIX[pendingFix]}`, { count: pendingCount })}\n\n${t(`tools.validate.fix${FIX_SUFFIX[pendingFix]}Hint`)}`}
          confirmLabel={t("tools.validate.applyFix")}
          onConfirm={() => applyFix(pendingFix)}
          onCancel={() => setPendingFix(null)}
        />
      )}
      {total === 0 ? (
        !(mediaMissing && mediaMissing.length > 0) &&
        !(splitPlaces.length > 0 && placeCoordDone === null) && <p className="tools-clean">{t("tools.validate.clean")}</p>
      ) : (
        <>
          <div className="tools-filter-row">
            <TreeSearch value={query} onChange={setQuery} />
            <div className="tools-chips">
              {CATEGORIES.filter((c) => report.counts[c] > 0).map((c) => (
                <button
                  key={c}
                  className={`tools-chip ${filter === c ? "active" : ""}`}
                  onClick={() => setFilter(c)}
                >
                  {t(`tools.validate.cat.${c}`)} <span className="tools-chip-count">{report.counts[c]}</span>
                </button>
              ))}
              {STRUCT_CATEGORIES.filter((c) => (structure?.counts[c] ?? 0) > 0).map((c) => (
                <button
                  key={c}
                  className={`tools-chip ${filter === c ? "active" : ""}`}
                  onClick={() => setFilter(c)}
                >
                  {t(`tools.validate.struct.cat.${c}`)} <span className="tools-chip-count">{structure!.counts[c]}</span>
                </button>
              ))}
              <button
                className={`tools-chip ${filter === "all" ? "active" : ""}`}
                onClick={() => setFilter("all")}
              >
                {t("tools.validate.all")} <span className="tools-chip-count">{total}</span>
              </button>
            </div>
          </div>
          {shown.length === 0 ? (
            <p className="tools-clean">{t("tools.search.noMatch")}</p>
          ) : (
            <ul className="tools-issues">
              <li className="v-spacer" style={{ height: virtual.padTop }} ref={virtual.topRef} aria-hidden />
              {shown.slice(virtual.start, virtual.end).map((row, j) => {
                const i = virtual.start + j;
                const zebra = i % 2 ? " zebra" : "";
                return row.kind === "record" ? (
                  <li key={`r-${row.issue.id}-${row.issue.category}-${i}`} className={`tools-issue sev-${row.issue.severity}${zebra}`}>
                    <PersonLink dataset={dataset} id={row.issue.id} fallback={row.issue.subject} onNavigate={onNavigate} />
                    <span className="tools-issue-msg">{t(row.issue.messageKey, row.issue.messageVars)}</span>
                  </li>
                ) : (
                  <StructRow key={`s-${row.issue.category}-${i}`} issue={row.issue} zebra={!!zebra} dataset={dataset} onNavigate={onNavigate} />
                );
              })}
              <li className="v-spacer" style={{ height: virtual.padBottom }} ref={virtual.bottomRef} aria-hidden />
            </ul>
          )}
        </>
      )}
    </>
  );
}

// ── Structural ("spec") validation ───────────────────────────────────────────

const STRUCT_CATEGORIES: StructCategory[] = [
  "syntax",
  "level",
  "strayCont",
  "danglingXref",
  "duplicateXref",
  "encoding",
  "version",
  "unknownTag",
  "badDate",
  "customTag",
];

/** A record reference for a structural issue: an individual renders as a clickable
 *  person link; a family expands to its husband & wife links (so the row reads as
 *  the couple, not a bare @F..@ xref). Any other top-level record (SOUR, REPO,
 *  OBJE, NOTE, HEAD, …) is shown as plain `TAG @id@` to identify its type —
 *  *not* a link, since GED Merge can't open those records. */
function RecordRef({
  dataset,
  id,
  tag,
  onNavigate,
}: {
  dataset: Dataset;
  id?: string;
  tag?: string;
  onNavigate: (id: string) => void;
}) {
  if (id && dataset.individuals.has(id)) {
    return <PersonLink dataset={dataset} id={id} fallback={id} onNavigate={onNavigate} />;
  }
  const fam = id ? dataset.families.get(id) : undefined;
  const spouses = fam ? [fam.husband, fam.wife].filter((s): s is string => !!s) : [];
  if (spouses.length > 0) {
    return (
      <span className="tools-couple-ref">
        {spouses.map((sid, i) => (
          <span key={sid}>
            {i > 0 && <span className="tools-usage-amp">&amp;</span>}
            <PersonLink dataset={dataset} id={sid} fallback={sid} onNavigate={onNavigate} />
          </span>
        ))}
      </span>
    );
  }
  return <span className="tools-struct-rec">{[tag, id].filter(Boolean).join(" ")}</span>;
}

function StructRow({
  issue,
  zebra,
  dataset,
  onNavigate,
}: {
  issue: StructIssue;
  zebra?: boolean;
  dataset: Dataset;
  onNavigate: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <li className={`tools-issue sev-${issue.severity}${zebra ? " zebra" : ""}`} title={issue.tooltip}>
      {issue.recordTag ? (
        <RecordRef dataset={dataset} id={issue.recordId} tag={issue.recordTag} onNavigate={onNavigate} />
      ) : issue.line != null ? (
        <span className="tools-struct-loc">{t("tools.validate.struct.atLine", { line: issue.line })}</span>
      ) : null}
      <span className="tools-issue-msg">{t(issue.messageKey, issue.messageVars)}</span>
      {issue.fix && (
        <span className="tools-struct-fixable" title={t("tools.validate.struct.fixableTitle", { value: issue.fix })}>
          {t("tools.validate.struct.fixable", { value: issue.fix })}
        </span>
      )}
    </li>
  );
}
