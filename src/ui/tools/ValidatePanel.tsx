import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Sex } from "../../gedcom/types";
import { type ValidationReport, type ValidationIssue, type IssueCategory } from "../../tools/validate";
import { inferableSexes } from "../../tools/fixSex";
import { countSwappedRoles, swappedRoleTargets } from "../../tools/fixRoleSwap";
import type { BrokenLinkRef } from "../../tools/fixLinks";
import { countFixableDates, type BadDateRef } from "../../tools/fixDates";
import { countDanglingRefs, type DanglingRef } from "../../tools/fixDanglingRefs";
import { countSplitCoordFills, scanPlaceCoords } from "../../tools/placeCoords";
import { type StructureReport, type StructCategory, type StructIssue } from "../../tools/structure";
import { collectLocalMediaFiles, type MediaFileUse } from "../../tools/mediaFiles";
import { eventDisplayLabel } from "../../gedcom/eventTags";
import { ConfirmDialog } from "../ConfirmDialog";
import { PersonLink } from "../PersonLink";
import { useMediaFolder } from "../MediaFolderContext";
import { charsetNotices } from "../charsetNotice";
import { type ToolsScans } from "../useToolsScans";
import { useVirtualList } from "../useVirtualList";
import { ToolsError, ToolsLoading, TreeSearch, UsageList, useDebounced } from "./shared";

/** One-button repair flows; the suffix is the i18n key segment (`fix<Suffix>`). */
type FixKind = "links" | "sex" | "roles" | "dates" | "dups" | "dangling";
const FIX_SUFFIX: Record<FixKind, string> = { links: "Links", sex: "Sex", roles: "Roles", dates: "Dates", dups: "DupPointers", dangling: "Dangling" };

/** The Health-Check filter each fix previews before it runs, so confirming the
 *  fix happens with the affected findings on screen. */
const FIX_CATEGORY: Record<FixKind, IssueCategory | StructCategory> = {
  links: "brokenLink",
  dups: "duplicatePointer",
  sex: "missingSex",
  roles: "roleSexConflict",
  dates: "badDate",
  dangling: "danglingXref",
};

const CATEGORIES: IssueCategory[] = [
  "brokenLink",
  "duplicatePointer",
  "pedigreeLoop",
  "roleSexConflict",
  "multiSpouseSlot",
  "multipleParents",
  "parentlessFamily",
  "deathBeforeBirth",
  "eventOrder",
  "ageAtDeath",
  "livingTooOld",
  "ageAtMarriage",
  "parentAge",
  "bornAfterParentDeath",
  "parallelFamilies",
  "spouseAgeGap",
  "futureDate",
  "missingVitals",
  "missingName",
  "missingSex",
  "island",
  "orphan",
];

/** The xref a `brokenLink` finding names — the family a person points at, or the
 *  person a family points at. Both arrive as message interpolation values. */
function brokenTarget(issue: ValidationIssue): string | undefined {
  const target = issue.messageVars?.fam ?? issue.messageVars?.indi;
  return typeof target === "string" ? target : undefined;
}

/** Identity of one row, for the set of rows already repaired from their own
 *  button — the record it names plus whatever narrows it to this finding (the
 *  broken pointer's target, the bad date's value). */
function rowKey(issue: ValidationIssue | StructIssue): string {
  return "id" in issue
    ? `${issue.category}\0${issue.id}\0${brokenTarget(issue) ?? ""}`
    : `${issue.category}\0${issue.recordId ?? ""}\0${issue.sample ?? ""}`;
}

/** One row's own repair: what its button says, and what clicking it does. A row
 *  carries the same fix as the button above, narrowed to that record — so a user
 *  can settle findings one at a time instead of all at once. */
interface RowFix {
  label: string;
  hint: string;
  /** A removal (danger-coloured), as opposed to a value being set or corrected. */
  removes?: boolean;
  run: () => void;
}

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
  onFixSwappedRoles,
  onFixDates,
  onFixDuplicatePointers,
  onFixDanglingRefs,
  onFillPlaceCoords,
}: {
  dataset: Dataset;
  scans: ToolsScans;
  onNavigate: (id: string) => void;
  active: boolean;
  onFixBrokenLinks: (only?: BrokenLinkRef) => number;
  onFixSexFromRole: (only?: string) => number;
  onFixSwappedRoles: (only?: string) => number;
  onFixDates: (only?: BadDateRef) => number;
  onFixDuplicatePointers: (only?: string) => number;
  onFixDanglingRefs: (only?: DanglingRef) => number;
  onFillPlaceCoords: () => number;
}) {
  const { t } = useTranslation();
  /** Message vars with a GEDCOM event tag turned into its display name —
   *  validate.ts is pure and can't localize, so tags travel raw. */
  const issueVars = (issue: ValidationIssue) =>
    typeof issue.messageVars?.tag === "string"
      ? { ...issue.messageVars, tag: eventDisplayLabel(issue.messageVars.tag, t) }
      : issue.messageVars;
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
  // Findings already repaired from their own row. The re-validate they trigger
  // runs in the worker, so the old list stays up for a moment — these rows go
  // quiet meanwhile instead of inviting a second, no-op click.
  const [fixedRows, setFixedRows] = useState<Set<string>>(() => new Set());

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

  // Places coordinated on some events but not others, grouped by place + the
  // event's address — fillable from the file itself. Detected on the main thread
  // (a PLAC walk), like the fixable-subset counts above; re-derived after a
  // fix's re-validate refreshes `report`. (The same scan's *conflicts* — one
  // pair carrying two different coordinates — are reported on the geocode page,
  // where the register and the maps that settle them are at hand.)
  const coordReport = useMemo(
    () => scanPlaceCoords(dataset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, report],
  );
  const splitPlaces = coordReport.fills;
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

  // One finding's own repair. Every batch button above is also offered here, on
  // the row that raised the question, narrowed to that record — so a user who
  // agrees with three of eight findings can settle those three and leave the
  // rest. It also reaches what Edit cannot: a broken link is invisible there (a
  // family that isn't there draws nothing), so the finding has to carry the fix.
  function runRowFix(issue: ValidationIssue | StructIssue, fix: () => void) {
    fix();
    setFixedRows((prev) => new Set(prev).add(rowKey(issue)));
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
      : kind === "roles" ? onFixSwappedRoles()
      : kind === "dates" ? onFixDates()
      : kind === "dangling" ? onFixDanglingRefs()
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

  // A fresh health check has landed: its rows are the repaired truth, so the
  // "already fixed" marks from the previous list have nothing left to suppress.
  useEffect(() => {
    setFixedRows((prev) => (prev.size === 0 ? prev : new Set()));
  }, [report]);

  // A new dataset or a changed folder invalidates a prior photo check.
  useEffect(() => {
    setMediaMissing(null);
    setMediaChecking(false);
  }, [dataset, folderName]);

  useEffect(() => {
    if (active) scans.ensure("validate");
  }, [active, scans]);

  // The encoding the file arrived in, and what the download will make of it.
  const charsetNotes = useMemo(() => charsetNotices(dataset, t), [dataset, t]);

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

  // The "No sex" records a family role settles, and what it settles them to (a
  // subset of the missingSex findings). Recomputed when the report changes (e.g.
  // after a fix). The same map drives the button's count and the rows' marks, so
  // the list points at exactly the records the button will change.
  const inferableSex = useMemo<Map<string, Sex>>(
    () => (report && report.counts.missingSex > 0 ? inferableSexes(dataset) : new Map()),
    [report, dataset],
  );

  // The spouses a swap would move, and the role each lands in — plus how many
  // families that is, which is what the button counts (one swap per family, two
  // findings). Both from the roleSexConflict findings a swap settles on its own.
  const swappedRoleFams = useMemo(
    () => (report && report.counts.roleSexConflict > 0 ? countSwappedRoles(dataset) : 0),
    [report, dataset],
  );
  const swappedRoles = useMemo<Map<string, "husband" | "wife">>(
    () => (report && report.counts.roleSexConflict > 0 ? swappedRoleTargets(dataset) : new Map()),
    [report, dataset],
  );

  /** This record-level finding's own repair, if a batch button covers it. The
   *  label doubles as the mark that says which rows of a category the button
   *  above would touch — "→ Female" on the three no-sex spouses among eight. */
  function recordRowFix(issue: ValidationIssue): RowFix | null {
    switch (issue.category) {
      case "brokenLink":
        return {
          label: t("tools.validate.fixOneLink"),
          hint: t("tools.validate.fixOneLinkHint"),
          removes: true,
          run: () => onFixBrokenLinks({ id: issue.id, target: brokenTarget(issue) }),
        };
      case "duplicatePointer":
        return {
          label: t("tools.validate.fixOneDup"),
          hint: t("tools.validate.fixOneDupHint"),
          removes: true,
          run: () => onFixDuplicatePointers(issue.id),
        };
      case "missingSex": {
        const sex = inferableSex.get(issue.id);
        if (!sex) return null;
        return {
          label: t("tools.validate.fixOneValue", { value: t(`sex.${sex}`) }),
          hint: t("tools.validate.fixOneSexHint"),
          run: () => onFixSexFromRole(issue.id),
        };
      }
      case "roleSexConflict": {
        const role = swappedRoles.get(issue.id);
        if (!role) return null;
        return {
          label: t("tools.validate.fixOneValue", { value: t(`field.${role}`) }),
          hint: t("tools.validate.fixOneRoleHint"),
          run: () => onFixSwappedRoles(issue.id),
        };
      }
      default:
        return null;
    }
  }

  /** The same, for a structural finding. */
  function structRowFix(issue: StructIssue): RowFix | null {
    if (issue.category === "badDate" && issue.fix && issue.recordId) {
      return {
        label: t("tools.validate.fixOneValue", { value: issue.fix }),
        hint: t("tools.validate.struct.fixableTitle", { value: issue.fix }),
        run: () => onFixDates({ id: issue.recordId!, sample: issue.sample }),
      };
    }
    if (issue.category === "danglingXref" && issue.recordId) {
      return {
        label: t("tools.validate.fixOneDangling"),
        hint: t("tools.validate.fixOneDanglingHint"),
        removes: true,
        run: () => onFixDanglingRefs({ id: issue.recordId!, xref: issue.sample }),
      };
    }
    return null;
  }

  // How many unparseable dates can be safely repaired (a subset of the badDate
  // structural findings). Recomputed when the structure report changes.
  const fixableDates = useMemo(
    () => (structure && structure.counts.badDate > 0 ? countFixableDates(dataset) : 0),
    [structure, dataset],
  );

  // Missing xrefs whose pointer lines the dangling-reference fix can drop — all
  // of the reported ones except any on a record with no xref of its own (HEAD),
  // which can't carry an undo patch.
  const fixableDangling = useMemo(
    () => (structure && structure.counts.danglingXref > 0 ? countDanglingRefs(dataset) : 0),
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
  if (fixableDangling > 0) fixActions.push({ kind: "dangling", count: fixableDangling });
  if (swappedRoleFams > 0) fixActions.push({ kind: "roles", count: swappedRoleFams });
  if (inferableSex.size > 0) fixActions.push({ kind: "sex", count: inferableSex.size });
  if (fixableDates > 0) fixActions.push({ kind: "dates", count: fixableDates });
  const showMediaCheck = !!folderName && mediaFiles.length > 0 && mediaMissing === null;
  // The check runs once per file, not on every visit: fixing a record in Edit
  // and coming back would otherwise still show the old findings. Say so, and
  // let the user re-run on demand.
  //
  // Only then, though. Freshness is keyed on the dataset and the edit version,
  // so a list that isn't stale is the file as it stands and re-running it cannot
  // say anything new — offering the button anyway reads as a warning about a
  // list that is in fact current. It stays up while a re-run is in flight, which
  // is where its progress hint belongs.
  const stale = scans.isStale("validate");
  const rerunning = scan.status === "running";
  const showRerun = stale || rerunning;
  const pendingCount = pendingFix
    ? (fixActions.find((a) => a.kind === pendingFix)?.count ?? 0)
    : 0;

  return (
    <>
      {showRerun && (
        <ul className="tools-fix-list">
          <li className="tools-fix-item">
            <button
              className={`nav-btn tools-run${stale ? " primary" : ""}`}
              onClick={() => scans.refresh("validate")}
              disabled={rerunning}
            >
              {t("tools.scan.rerun")}
            </button>
            <span className="tools-fix-hint">
              {rerunning ? t("tools.running") : t("tools.validate.stale")}
            </span>
          </li>
        </ul>
      )}
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
          <button className="nav-btn primary tools-run" onClick={() => setPlaceCoordPending(true)}>
            {t("tools.validate.placeCoord.fix", { count: splitFills })}
          </button>
          <ul className="tools-issues">
            {splitPlaces.slice(0, 200).map((p, i) => (
              <li key={`${p.value}\u0000${p.address}`} className={`tools-issue sev-warning${i % 2 ? " zebra" : ""}`}>
                <span className="tools-issue-msg">{p.address ? `${p.value} · ${p.address}` : p.value}</span>
                <span className="tools-chip-count" title={t("tools.validate.placeCoord.occ", { count: p.missing })}>
                  {p.missing}
                </span>
                <span className="gm-data gm-coord gm-coord--set">
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
              <button className="nav-btn primary tools-run" onClick={() => requestFix(kind)}>
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
              {/* "All" leads the row, as it does on the geocoding and naming
                  pages: the whole list first, then the categories that cut it. */}
              <button
                className={`tools-chip ${filter === "all" ? "active" : ""}`}
                onClick={() => setFilter("all")}
              >
                {t("tools.validate.all")} <span className="tools-chip-count">{total}</span>
              </button>
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
            </div>
          </div>
          {/* What saving will do to a file that didn't arrive as UTF-8. It sits
              directly above the findings — so filtering to Encoding puts it
              beside the decoder's own line, which says what was read but not
              what leaves. Outside the virtual list: its rows must stay a
              uniform height. */}
          {charsetNotes.map((note, i) => <p className="tools-note" key={i}>{note}</p>)}
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
                    <span className="tools-issue-msg">{t(row.issue.messageKey, issueVars(row.issue))}</span>
                    <RowFixButton
                      fix={recordRowFix(row.issue)}
                      done={fixedRows.has(rowKey(row.issue))}
                      onRun={(run) => runRowFix(row.issue, run)}
                    />
                  </li>
                ) : (
                  <StructRow
                    key={`s-${row.issue.category}-${i}`}
                    issue={row.issue}
                    zebra={!!zebra}
                    dataset={dataset}
                    onNavigate={onNavigate}
                    fix={structRowFix(row.issue)}
                    done={fixedRows.has(rowKey(row.issue))}
                    onRun={(run) => runRowFix(row.issue, run)}
                  />
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

/** A row's own fix button — or, once clicked, the note that it ran. Rendered at
 *  the end of the row, in place of nothing when the row has no repair of its
 *  own. Removals wear the danger colour, corrections the "changed" one. */
function RowFixButton({
  fix,
  done,
  onRun,
}: {
  fix: RowFix | null;
  done: boolean;
  onRun: (run: () => void) => void;
}) {
  const { t } = useTranslation();
  if (!fix) return null;
  if (done) return <span className="tools-issue-fixed">{t("tools.validate.fixOneDone")}</span>;
  return (
    <button
      className={`tools-issue-fix${fix.removes ? "" : " sets"}`}
      title={fix.hint}
      onClick={() => onRun(fix.run)}
    >
      {fix.label}
    </button>
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
  fix,
  done,
  onRun,
}: {
  issue: StructIssue;
  zebra?: boolean;
  dataset: Dataset;
  onNavigate: (id: string) => void;
  fix: RowFix | null;
  done: boolean;
  onRun: (run: () => void) => void;
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
      <RowFixButton fix={fix} done={done} onRun={onRun} />
      {/* A repairable date whose record can't carry an undo patch (no xref of its
          own) keeps the plain preview mark — the batch fix skips it too. */}
      {issue.fix && !fix && (
        <span className="tools-struct-fixable" title={t("tools.validate.struct.fixableTitle", { value: issue.fix })}>
          {t("tools.validate.struct.fixable", { value: issue.fix })}
        </span>
      )}
    </li>
  );
}
