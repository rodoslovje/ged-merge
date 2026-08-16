import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Sex } from "../../gedcom/types";
import { firstChild } from "../../gedcom/node";
import { collectLocalMediaFiles } from "../../tools/mediaFiles";
import { FAM_EVENT_TAG_ORDER, INDI_EVENT_TAG_ORDER, eventDisplayLabel } from "../../gedcom/eventTags";
import { INDIVIDUAL_EVENT_GROUPS } from "../edit/editConstants";
import {
  ANY_EVENT,
  ANY_VENDOR_EVENT,
  applyBatchAction,
  buildBatchRows,
  computeKinship,
  computeLineSides,
  matchesBatch,
  previewBirthEstimates,
  previewMarriedNames,
  readMarriedNames,
  BATCH_ACTION_KINDS,
  BATCH_CRITERION_KINDS,
  type BatchActionSpec,
  type BatchContext,
  type BatchCriterion,
  type SavedBatchFilter,
} from "../../tools/batch";
import type { RecordPatch } from "../historyTypes";
import { useNameOf, useSettings } from "../SettingsContext";
import { createKinshipResolver, lineageClass } from "../../match/kinship";
import { useDatasetDerivations } from "../DatasetDerivations";
import { PersonLink } from "../PersonLink";
import { useVirtualList } from "../useVirtualList";
import { PickerMenu } from "../PickerMenu";
import { SelectMenu } from "../DropdownMenu";

/**
 * Tools → Normalize & batch → Batch actions: stackable filters over the whole
 * file, a reviewable match list with per-person checkboxes, and one action
 * applied to every selected match as a single undo step. Filters (with their
 * action) can be saved by name; the saved list shows how many people currently
 * match each one, so a recurring chore ("new people still missing the
 * placeholder image?") is answered at a glance.
 */

interface Props {
  dataset: Dataset;
  /** Content version of the dataset (see ToolsView) — rows rebuild when it moves. */
  editVersionRef: { readonly current: number };
  /** True while this section is the visible one. */
  active: boolean;
  onNavigate: (id: string) => void;
  /** Apply the action's patches through the app's undo stack. */
  onApplyPatches: (patches: RecordPatch[]) => number;
  /** The app-wide start person — home base for the family-line filter. */
  startId?: string;
}

/** One pickable image: a distinct local file, with its shared record when one holds it. */
interface MediaOption {
  key: string;
  file: string;
  xref?: string;
  title?: string;
}

const NEW_KEY = "__new";

function mediaOptionKey(o: { xref?: string; file?: string }): string {
  return o.xref ? `x:${o.xref}` : `f:${o.file?.toLowerCase() ?? ""}`;
}

/** The select value showing a stored media reference: its option, "new", or unset. */
function mediaPickValue(ref: { xref?: string; file?: string }, options: MediaOption[]): string {
  const opt = options.find(
    (o) => (ref.xref && o.xref === ref.xref) || (!!ref.file && o.file.toLowerCase() === ref.file.toLowerCase()),
  );
  if (opt) return mediaOptionKey(opt);
  return ref.xref || ref.file ? NEW_KEY : "";
}

export function BatchSection({ dataset, editVersionRef, active, onNavigate, onApplyPatches, startId }: Props) {
  const { t } = useTranslation();
  const derivations = useDatasetDerivations();
  const nameOf = useNameOf();
  const { settings } = useSettings();

  // Rows rebuild when the file content moves: any render while visible (tab
  // return, an undo/redo elsewhere, this panel's own apply) re-reads the
  // version counter, adjusting state during render per the React pattern —
  // guarded so it only fires when the version actually moved.
  const [ver, setVer] = useState(() => editVersionRef.current);
  if (active && ver !== editVersionRef.current) setVer(editVersionRef.current);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- ver stands in for in-place dataset edits
  const rows = useMemo(() => buildBatchRows(dataset, nameOf), [dataset, nameOf, ver]);
  const lineSides = useMemo(
    () => (startId ? computeLineSides(dataset, startId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ver stands in for in-place dataset edits
    [dataset, startId, ver],
  );
  const kinship = useMemo(
    () => (startId ? computeKinship(dataset, startId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ver stands in for in-place dataset edits
    [dataset, startId, ver],
  );
  /** Kinship-to-start labels for the result rows ("Show kinship" setting),
   *  resolved lazily per rendered row and cached inside the resolver. */
  const kinshipResolver = useMemo(
    () =>
      settings.showKinship && startId
        ? (derivations?.kinship(startId) ?? createKinshipResolver(dataset, startId, t))
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ver stands in for in-place dataset edits
    [dataset, startId, settings.showKinship, t, ver],
  );
  const ctx: BatchContext = useMemo(() => ({ lineSides, kinship }), [lineSides, kinship]);

  /** Tags offered by the event filter: the life-cycle basics plus whatever
   *  the file actually uses, in canonical order. */
  const eventOptions = useMemo(() => {
    const present = new Set<string>(["BIRT", "BAPM", "DEAT", "BURI", "OCCU", "RESI"]);
    for (const r of rows) for (const tag of r.eventTags) present.add(tag);
    return INDI_EVENT_TAG_ORDER.filter((tag) => present.has(tag));
  }, [rows]);
  /** Non-standard tags the file actually uses — the convert action's sources. */
  const vendorEventOptions = useMemo(() => eventOptions.filter((tag) => tag.startsWith("_")), [eventOptions]);
  /** Tags offered by the family-event filter: marriage always (the point of the
   *  filter is finding unions without it) plus whatever the file's unions use. */
  const familyEventOptions = useMemo(() => {
    const present = new Set<string>(["MARR"]);
    for (const r of rows) for (const tag of r.familyEventTags) present.add(tag);
    return FAM_EVENT_TAG_ORDER.filter((tag) => present.has(tag));
  }, [rows]);

  const [criteria, setCriteria] = useState<BatchCriterion[]>([]);
  const [action, setAction] = useState<BatchActionSpec | null>(null);
  /** Unchecked match ids — everyone matching is selected by default. */
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<{ changed: number; skipped: number } | null>(null);
  const [saved, setSaved] = useState<SavedBatchFilter[]>(loadSavedFilters);
  const [saveName, setSaveName] = useState("");
  /** The saved filter currently loaded into the builder — its conditions and
   *  action show below. Cleared as soon as the builder is edited by hand. */
  const [selectedSavedId, setSelectedSavedId] = useState<string | null>(null);

  const results = useMemo(() => rows.filter((r) => matchesBatch(r, criteria, ctx)), [rows, criteria, ctx]);
  const targets = useMemo(() => results.filter((r) => !excluded.has(r.id)), [results, excluded]);
  const savedCounts = useMemo(
    () => saved.map((f) => rows.filter((r) => matchesBatch(r, f.criteria, ctx)).length),
    [saved, rows, ctx],
  );

  const mediaOptions = useMemo<MediaOption[]>(() => {
    const sharedByFile = new Map<string, string>();
    for (const rec of dataset.records) {
      if (rec.tag !== "OBJE" || !rec.xref) continue;
      const f = firstChild(rec, "FILE")?.value?.trim().toLowerCase();
      if (f && !sharedByFile.has(f)) sharedByFile.set(f, rec.xref);
    }
    return collectLocalMediaFiles(dataset).map((f) => ({
      key: "",
      file: f.file,
      xref: sharedByFile.get(f.file.toLowerCase()),
      title: f.title,
    })).map((o) => ({ ...o, key: mediaOptionKey(o) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ver stands in for in-place dataset edits
  }, [dataset, ver]);

  const sourceOptions = useMemo(() => {
    const list: Array<{ xref: string; title: string }> = [];
    for (const rec of dataset.records) {
      if (rec.tag !== "SOUR" || !rec.xref) continue;
      list.push({ xref: rec.xref, title: firstChild(rec, "TITL")?.value?.trim() || rec.xref });
    }
    return list.sort((a, b) => a.title.localeCompare(b.title));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ver stands in for in-place dataset edits
  }, [dataset, ver]);

  /** Per-row preview of the birth-estimate action: what each checked person
   *  would get (no entry = would be skipped). Recomputed when the selection
   *  changes — unchecking a sibling re-spaces the others, as applying would. */
  const birthPreview = useMemo(() => {
    if (action?.kind !== "estimateBirth") return null;
    return new Map(
      [...previewBirthEstimates(dataset, targets.map((r) => r.id))].map(([id, y]) => [id, { text: `→ ABT ${y}` }]),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ver stands in for in-place dataset edits
  }, [action?.kind, dataset, targets, ver]);

  /** Per-row preview of the married-name action: the surnames the person would
   *  end up carrying, plus the doubt that left the row unchecked. Computed over
   *  every match, not just the checked ones — an unchecked row has to show what
   *  re-checking it would write. */
  const marriedPreview = useMemo(() => {
    if (action?.kind !== "addMarriedName") return null;
    return new Map(
      [...previewMarriedNames(dataset, results.map((r) => r.id))].map(([id, sources]) => {
        const { surnames, doubt } = readMarriedNames(sources);
        return [id, { text: `→ ${surnames.join(", ")}`, note: doubt ? t(`tools.batch.doubt.${doubt}`) : undefined }];
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ver stands in for in-place dataset edits
  }, [action?.kind, dataset, results, t, ver]);

  const rowPreview: Map<string, { text: string; note?: string }> | null = birthPreview ?? marriedPreview;
  /** The married-name preview speaks for unchecked rows too (see above). */
  const previewUnchecked = action?.kind === "addMarriedName";

  const virtual = useVirtualList({ count: results.length, estimate: 30, itemsKey: results });

  /**
   * The rows an action wants left unchecked when it arrives: the married-name
   * action starts with the doubtful people deselected — no marriage recorded,
   * the couple noted as partners, or children carrying the mother's surname.
   * The verdict only *seeds* the selection; from then on the set is the
   * researcher's, and re-checking a row means the surname does get written.
   */
  function seedExclusions(nextCriteria: BatchCriterion[], nextAction: BatchActionSpec | null): ReadonlySet<string> {
    if (nextAction?.kind !== "addMarriedName") return new Set();
    const ids = rows.filter((r) => matchesBatch(r, nextCriteria, ctx)).map((r) => r.id);
    const doubtful = new Set<string>();
    for (const [id, sources] of previewMarriedNames(dataset, ids)) {
      if (!readMarriedNames(sources).evidenced) doubtful.add(id);
    }
    return doubtful;
  }

  function resetReview(nextCriteria = criteria, nextAction = action) {
    setExcluded(seedExclusions(nextCriteria, nextAction));
    setDone(null);
    setConfirming(false);
  }
  function changeCriteria(next: BatchCriterion[]) {
    setCriteria(next);
    setSelectedSavedId(null);
    resetReview(next);
  }
  function changeAction(next: BatchActionSpec | null) {
    setAction(next);
    setSelectedSavedId(null);
    // A new action re-seeds the selection: the previous one's doubts are not
    // this one's, and a hand-picked selection belongs to the action it was made for.
    setExcluded(seedExclusions(criteria, next));
    setDone(null);
    setConfirming(false);
  }

  function addCriterion(kind: BatchCriterion["kind"]) {
    const fresh: Record<BatchCriterion["kind"], BatchCriterion> = {
      name: { kind: "name", text: "" },
      nameField: { kind: "nameField", field: "surname", mode: "lacks" },
      sex: { kind: "sex", value: "F" },
      birthYear: { kind: "birthYear" },
      age: { kind: "age", op: "lt", years: 20 },
      living: { kind: "living", value: true },
      event: { kind: "event", tag: "BIRT", mode: "lacks" },
      familyEvent: { kind: "familyEvent", tag: "MARR", mode: "lacks" },
      relation: { kind: "relation", rel: "spouse", mode: "has" },
      kinship: { kind: "kinship", rel: "blood" },
      place: { kind: "place", text: "" },
      note: { kind: "note", text: "" },
      private: { kind: "private", value: true },
      privateNote: { kind: "privateNote", mode: "has" },
      media: { kind: "media", mode: "none" },
      sources: { kind: "sources", mode: "none" },
      line: { kind: "line", side: "maternal" },
    };
    changeCriteria([...criteria, fresh[kind]]);
  }

  const actionReady =
    action !== null &&
    (action.kind === "addMedia"
      ? !!(action.xref || action.file.trim())
      : action.kind === "addSource"
        ? !!(action.xref || action.title?.trim())
        : action.kind === "markDeceased" || action.kind === "estimateBirth" || action.kind === "addMarriedName"
          ? true
          : action.kind === "convertEvent"
            ? !!(action.fromTag && action.toTag && action.fromTag !== action.toTag)
            : !!(action.xref || action.file?.trim()));

  function apply() {
    if (!action || !actionReady || targets.length === 0) return;
    const res = applyBatchAction(dataset, targets.map((r) => r.id), action);
    if (res.patches.length > 0) onApplyPatches(res.patches);
    setDone({ changed: res.changed, skipped: res.skipped });
    setConfirming(false);
    // Re-seeded, not cleared: whoever the action still doubts stays unchecked.
    setExcluded(seedExclusions(criteria, action));
    setVer(editVersionRef.current);
  }

  function persist(next: SavedBatchFilter[]) {
    setSaved(next);
    storeSavedFilters(next);
  }
  function saveCurrent() {
    const name = saveName.trim();
    if (!name || criteria.length === 0) return;
    const entry: SavedBatchFilter = {
      id: crypto.randomUUID(),
      name,
      criteria,
      ...(action && actionReady ? { action } : {}),
    };
    // Saving under an existing name replaces that filter.
    persist([...saved.filter((f) => f.name !== name), entry]);
    setSaveName("");
    setSelectedSavedId(entry.id);
  }
  function loadFilter(f: SavedBatchFilter) {
    setCriteria(f.criteria);
    setAction(f.action ?? null);
    setSelectedSavedId(f.id);
    resetReview(f.criteria, f.action ?? null);
  }

  /** Whether a saved filter's media/source/line references resolve in this file. */
  function refsResolve(f: SavedBatchFilter): boolean {
    const mediaExists = (xref?: string, file?: string) =>
      mediaOptions.some((o) => (xref && o.xref === xref) || (!!file && o.file.toLowerCase() === file.toLowerCase()));
    for (const c of f.criteria) {
      if (c.kind === "media" && (c.mode === "has" || c.mode === "lacks") && !mediaExists(c.xref, c.file)) return false;
      if (c.kind === "line" && !lineSides) return false;
      if (c.kind === "kinship" && !kinship) return false;
    }
    const a = f.action;
    if (a?.kind === "removeMedia" && !mediaExists(a.xref, a.file)) return false;
    if (a?.kind === "convertEvent" && !vendorEventOptions.includes(a.fromTag)) return false;
    if (a?.kind === "addSource" && a.xref && !a.title && !sourceOptions.some((s) => s.xref === a.xref)) return false;
    return true;
  }

  const needsStart =
    (criteria.some((c) => c.kind === "line") && !lineSides) ||
    (criteria.some((c) => c.kind === "kinship") && !kinship);

  return (
    <div className="batch-section">
      <p className="tools-intro">{t("tools.batch.intro")}</p>

      {saved.length > 0 && (
        <div className="batch-saved">
          <div className="batch-block-title">{t("tools.batch.saved")}</div>
          <ul className="batch-saved-list">
            {saved.map((f, i) => (
              <li key={f.id} className={`batch-saved-row ${selectedSavedId === f.id ? "active" : ""}`}>
                <button className="batch-saved-load" onClick={() => loadFilter(f)} title={t("tools.batch.load")}>
                  <span className="batch-saved-name">{f.name}</span>
                  <span className={`batch-saved-count ${savedCounts[i] > 0 ? "batch-count-live" : ""}`}>
                    ({savedCounts[i]})
                  </span>
                </button>
                {!refsResolve(f) && (
                  <span className="batch-saved-warn" title={t("tools.batch.missingRefs")}>⚠</span>
                )}
                <button
                  className="batch-remove"
                  onClick={() => {
                    persist(saved.filter((s) => s.id !== f.id));
                    if (selectedSavedId === f.id) setSelectedSavedId(null);
                  }}
                  title={t("tools.batch.deleteSaved")}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="batch-builder">
        <div className="batch-block-title">{t("tools.batch.filters")}</div>
        {criteria.length === 0 && <p className="batch-hint">{t("tools.batch.noFilters")}</p>}
        <ul className="batch-crit-list">
          {criteria.map((c, i) => (
            <CriterionRow
              key={i}
              c={c}
              mediaOptions={mediaOptions}
              eventOptions={eventOptions}
              familyEventOptions={familyEventOptions}
              onChange={(next) => changeCriteria(criteria.map((x, j) => (j === i ? next : x)))}
              onRemove={() => changeCriteria(criteria.filter((_, j) => j !== i))}
            />
          ))}
        </ul>
        <PickerMenu
          className="batch-add-filter"
          label={t("tools.batch.addFilter")}
          value={"" as string}
          onChange={(k) => {
            if (k) addCriterion(k as BatchCriterion["kind"]);
          }}
          items={[
            { key: "", label: `＋ ${t("tools.batch.addFilter")}` },
            ...BATCH_CRITERION_KINDS.map((k) => ({ key: k as string, label: t(`tools.batch.crit.${k}`) })),
          ]}
        />
        {needsStart && <p className="batch-hint batch-warn">{t("tools.batch.needStart")}</p>}
      </div>

      <div className="batch-results">
        <div className="batch-results-bar">
          <span className="batch-results-count">
            {t("tools.batch.matchCount", { count: results.length })}
            {excluded.size > 0 && <> · {t("tools.batch.selectedCount", { count: targets.length })}</>}
          </span>
          {previewUnchecked && excluded.size > 0 && (
            <span className="batch-results-note">{t("tools.batch.marriedUnchecked", { count: excluded.size })}</span>
          )}
          {excluded.size > 0 ? (
            <button className="batch-bar-btn" onClick={() => setExcluded(new Set())}>
              {t("tools.batch.selectAll")}
            </button>
          ) : (
            results.length > 0 && (
              <button className="batch-bar-btn" onClick={() => setExcluded(new Set(results.map((r) => r.id)))}>
                {t("tools.batch.selectNone")}
              </button>
            )
          )}
        </div>
        <ul className="batch-list">
          <li className="v-spacer" style={{ height: virtual.padTop }} ref={virtual.topRef} aria-hidden />
          {results.slice(virtual.start, virtual.end).map((r) => {
            const kin = kinshipResolver?.label(r.id);
            return (
              <li key={r.id} className="batch-row">
                <input
                  type="checkbox"
                  checked={!excluded.has(r.id)}
                  aria-label={r.name}
                  onChange={() => {
                    const next = new Set(excluded);
                    if (next.has(r.id)) next.delete(r.id);
                    else next.add(r.id);
                    setExcluded(next);
                  }}
                />
                <PersonLink dataset={dataset} id={r.id} fallback={r.name} onNavigate={onNavigate} />
                {rowPreview && (previewUnchecked || !excluded.has(r.id)) && (
                  <span
                    className={
                      "batch-preview"
                      + (rowPreview.has(r.id) ? "" : " batch-preview-skip")
                      + (excluded.has(r.id) ? " batch-preview-off" : "")
                    }
                    title={rowPreview.get(r.id)?.note}
                  >
                    {rowPreview.get(r.id)?.text ?? t("tools.batch.previewSkip")}
                    {rowPreview.get(r.id)?.note && (
                      <span className="batch-preview-note">{rowPreview.get(r.id)!.note}</span>
                    )}
                  </span>
                )}
                {kin && (
                  <span className={`global-search-kin ${lineageClass(kinshipResolver!.lineage(r.id))}`}>{kin}</span>
                )}
              </li>
            );
          })}
          <li className="v-spacer" style={{ height: virtual.padBottom }} ref={virtual.bottomRef} aria-hidden />
        </ul>
      </div>

      <div className="batch-action">
        <div className="batch-block-title">{t("tools.batch.actionTitle")}</div>
        <ActionEditor
          action={action}
          mediaOptions={mediaOptions}
          sourceOptions={sourceOptions}
          vendorEventOptions={vendorEventOptions}
          onChange={changeAction}
        />
        {done && <p className="batch-done">{t("tools.batch.done", done)}</p>}
        {confirming ? (
          <div className="batch-confirm">
            <span>{t("tools.batch.confirm", { count: targets.length })}</span>
            <button className="nav-btn primary" onClick={apply}>
              {t("confirm.continue")}
            </button>
            <button className="nav-btn" onClick={() => setConfirming(false)}>
              {t("confirm.cancel")}
            </button>
          </div>
        ) : (
          <button
            className="nav-btn primary tools-run"
            disabled={!actionReady || targets.length === 0}
            onClick={() => setConfirming(true)}
          >
            {t("tools.batch.apply", { count: targets.length })}
          </button>
        )}
      </div>

      <div className="batch-save">
        <input
          className="batch-save-name"
          placeholder={t("tools.batch.savePlaceholder")}
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveCurrent();
          }}
        />
        <button className="nav-btn" disabled={!saveName.trim() || criteria.length === 0} onClick={saveCurrent}>
          {t("tools.batch.save")}
        </button>
      </div>
    </div>
  );
}

// ── Criterion editor rows ───────────────────────────────────────────────────

function CriterionRow({
  c,
  mediaOptions,
  eventOptions,
  familyEventOptions,
  onChange,
  onRemove,
}: {
  c: BatchCriterion;
  mediaOptions: MediaOption[];
  eventOptions: string[];
  familyEventOptions: string[];
  onChange: (next: BatchCriterion) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="batch-crit">
      <span className="batch-crit-label" title={c.kind === "age" ? t("tools.batch.ageHint") : undefined}>
        {t(`tools.batch.crit.${c.kind}`)}
      </span>
      {c.kind === "name" && (
        <SelectMenu
          className="batch-select"
          value={c.part ?? "any"}
          onChange={(v) => onChange({ ...c, part: v === "any" ? undefined : (v as "given" | "surname") })}
          options={(["any", "given", "surname"] as const).map((p) => ({
            value: p,
            label: t(`tools.batch.name.${p}`),
          }))}
        />
      )}
      {(c.kind === "name" || c.kind === "place" || c.kind === "note") && (
        <input
          className="batch-input"
          value={c.text}
          placeholder={t("tools.batch.textPlaceholder")}
          onChange={(e) => onChange({ ...c, text: e.target.value })}
        />
      )}
      {c.kind === "nameField" && (
        <PresenceSelect
          prefix="tools.batch.nameField"
          fields={["given", "surname", "married"] as const}
          field={c.field}
          mode={c.mode}
          onPick={(field, mode) => onChange({ ...c, field, mode })}
        />
      )}
      {c.kind === "relation" && (
        <PresenceSelect
          prefix="tools.batch.relation"
          fields={["spouse", "children", "parents"] as const}
          field={c.rel}
          mode={c.mode}
          onPick={(rel, mode) => onChange({ ...c, rel, mode })}
        />
      )}
      {c.kind === "sex" && (
        <SelectMenu
          className="batch-select"
          value={c.value}
          onChange={(v) => onChange({ ...c, value: v as Sex })}
          options={(["M", "F", "U"] as const).map((s) => ({ value: s, label: t(`sex.${s}`) }))}
        />
      )}
      {c.kind === "birthYear" && (
        <>
          <input
            className="batch-input batch-year"
            type="number"
            placeholder={t("tools.batch.from")}
            value={c.from ?? ""}
            onChange={(e) => onChange({ ...c, from: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
          <span className="batch-sep">–</span>
          <input
            className="batch-input batch-year"
            type="number"
            placeholder={t("tools.batch.to")}
            value={c.to ?? ""}
            onChange={(e) => onChange({ ...c, to: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        </>
      )}
      {c.kind === "event" && (
        <>
          <SelectMenu
            className="batch-select"
            value={c.mode}
            onChange={(v) => onChange({ ...c, mode: v as "has" | "lacks" })}
            options={[
              { value: "lacks", label: t("tools.batch.event.lacks") },
              { value: "has", label: t("tools.batch.event.has") },
            ]}
          />
          <SelectMenu
            className="batch-select"
            value={c.tag}
            onChange={(v) => onChange({ ...c, tag: v })}
            options={[
              ...(c.tag === ANY_VENDOR_EVENT || eventOptions.includes(c.tag)
                ? eventOptions
                : [c.tag, ...eventOptions]
              ).map((tag) => ({ value: tag, label: eventDisplayLabel(tag, t) })),
              { value: ANY_VENDOR_EVENT, label: t("tools.batch.event.anyVendor") },
            ]}
          />
        </>
      )}
      {c.kind === "familyEvent" && (
        <>
          <SelectMenu
            className="batch-select"
            value={c.mode}
            onChange={(v) => onChange({ ...c, mode: v as "has" | "lacks" })}
            options={[
              { value: "lacks", label: t("tools.batch.event.lacks") },
              { value: "has", label: t("tools.batch.event.has") },
            ]}
          />
          <SelectMenu
            className="batch-select"
            value={c.tag}
            onChange={(v) => onChange({ ...c, tag: v })}
            options={[
              ...(c.tag === ANY_EVENT || familyEventOptions.includes(c.tag)
                ? familyEventOptions
                : [c.tag, ...familyEventOptions]
              ).map((tag) => ({ value: tag, label: eventDisplayLabel(tag, t) })),
              { value: ANY_EVENT, label: t("tools.batch.event.any") },
            ]}
          />
        </>
      )}
      {c.kind === "kinship" && (
        <SelectMenu
          className="batch-select"
          value={c.rel}
          onChange={(v) => onChange({ ...c, rel: v as typeof c.rel })}
          options={(["ancestor", "descendant", "blood", "notBlood"] as const).map((r) => ({
            value: r,
            label: t(`tools.batch.kinship.${r}`),
          }))}
        />
      )}
      {c.kind === "living" && (
        <SelectMenu
          className="batch-select"
          value={c.value ? "yes" : "no"}
          onChange={(v) => onChange({ ...c, value: v === "yes" })}
          options={[
            { value: "yes", label: t("tools.batch.living.yes") },
            { value: "no", label: t("tools.batch.living.no") },
          ]}
        />
      )}
      {c.kind === "private" && (
        <SelectMenu
          className="batch-select"
          value={c.value ? "yes" : "no"}
          onChange={(v) => onChange({ ...c, value: v === "yes" })}
          options={[
            { value: "yes", label: t("tools.batch.private.yes") },
            { value: "no", label: t("tools.batch.private.no") },
          ]}
        />
      )}
      {c.kind === "privateNote" && (
        <SelectMenu
          className="batch-select"
          value={c.mode}
          onChange={(v) => onChange({ ...c, mode: v as "has" | "lacks" })}
          options={[
            { value: "has", label: t("tools.batch.privateNote.has") },
            { value: "lacks", label: t("tools.batch.privateNote.lacks") },
          ]}
        />
      )}
      {c.kind === "age" && (
        <>
          <SelectMenu
            className="batch-select"
            value={c.op}
            onChange={(v) => onChange({ ...c, op: v as "lt" | "gte" })}
            options={[
              { value: "lt", label: t("tools.batch.age.lt") },
              { value: "gte", label: t("tools.batch.age.gte") },
            ]}
          />
          <input
            className="batch-input batch-year"
            type="number"
            min={0}
            value={c.years}
            onChange={(e) => onChange({ ...c, years: Math.max(0, Number(e.target.value) || 0) })}
          />
          <span className="batch-sep">{t("tools.batch.age.years")}</span>
        </>
      )}
      {c.kind === "media" && (
        <>
          <SelectMenu
            className="batch-select"
            value={c.mode}
            onChange={(v) => onChange({ ...c, mode: v as typeof c.mode })}
            options={(["none", "any", "has", "lacks"] as const).map((m) => ({
              value: m,
              label: t(`tools.batch.media.${m}`),
            }))}
          />
          {(c.mode === "has" || c.mode === "lacks") && (
            <MediaSelect
              value={mediaPickValue(c, mediaOptions)}
              options={mediaOptions}
              onPick={(o) => onChange({ ...c, xref: o.xref, file: o.file })}
            />
          )}
        </>
      )}
      {c.kind === "sources" && (
        <SelectMenu
          className="batch-select"
          value={c.mode}
          onChange={(v) => onChange({ ...c, mode: v as "none" | "any" })}
          options={[
            { value: "none", label: t("tools.batch.sourcesFilter.none") },
            { value: "any", label: t("tools.batch.sourcesFilter.any") },
          ]}
        />
      )}
      {c.kind === "line" && (
        <SelectMenu
          className="batch-select"
          value={c.side}
          onChange={(v) => onChange({ ...c, side: v as "maternal" | "paternal" })}
          options={[
            { value: "maternal", label: t("tools.batch.line.maternal") },
            { value: "paternal", label: t("tools.batch.line.paternal") },
          ]}
        />
      )}
      <button className="batch-remove" onClick={onRemove} title={t("tools.batch.removeFilter")}>
        ✕
      </button>
    </li>
  );
}

/**
 * "Is this part of the record there?" select — one option per field × has/lacks
 * pair, so the choice reads as a sentence ("has no married name") instead of two
 * abstract dropdowns. The pair is encoded in the option value and split back out.
 */
function PresenceSelect<F extends string>({
  prefix,
  fields,
  field,
  mode,
  onPick,
}: {
  prefix: string;
  fields: readonly F[];
  field: F;
  mode: "has" | "lacks";
  onPick: (field: F, mode: "has" | "lacks") => void;
}) {
  const { t } = useTranslation();
  return (
    <SelectMenu
      className="batch-select"
      value={`${field}:${mode}`}
      onChange={(v) => {
        const [f, m] = v.split(":");
        onPick(f as F, m as "has" | "lacks");
      }}
      options={fields.flatMap((f) =>
        (["has", "lacks"] as const).map((m) => ({
          value: `${f}:${m}`,
          label: t(`${prefix}.${f}.${m}`),
        })),
      )}
    />
  );
}

/** Select over the file's distinct local images (title + file name). */
function MediaSelect({
  value,
  options,
  onPick,
  allowNew,
}: {
  value: string;
  options: MediaOption[];
  onPick: (o: { xref?: string; file: string }) => void;
  /** Adds a "New image…" entry, reported as `{ file: "" }`. */
  allowNew?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <SelectMenu
      className="batch-select batch-media-select"
      value={value}
      placeholder={t("tools.batch.pickMedia")}
      onChange={(key) => {
        if (key === NEW_KEY) onPick({ file: "" });
        const opt = options.find((o) => o.key === key);
        if (opt) onPick({ xref: opt.xref, file: opt.file });
      }}
      options={[
        ...options.map((o) => ({ value: o.key, label: o.title ? `${o.title} — ${o.file}` : o.file })),
        ...(allowNew ? [{ value: NEW_KEY, label: t("tools.batch.newMedia") }] : []),
      ]}
    />
  );
}

// ── Action editor ───────────────────────────────────────────────────────────

function ActionEditor({
  action,
  mediaOptions,
  sourceOptions,
  vendorEventOptions,
  onChange,
}: {
  action: BatchActionSpec | null;
  mediaOptions: MediaOption[];
  sourceOptions: Array<{ xref: string; title: string }>;
  /** Non-standard event tags present in the file — the convert action's sources. */
  vendorEventOptions: string[];
  onChange: (next: BatchActionSpec | null) => void;
}) {
  const { t } = useTranslation();
  /** The natural TYPE for a converted vendor event: its localized name. */
  const typeFor = (tag: string) => t(`event.${tag}`, { defaultValue: "" });
  const firstVendor = vendorEventOptions[0] ?? "";
  const fresh: Record<BatchActionSpec["kind"], BatchActionSpec> = {
    addMedia: { kind: "addMedia", file: "" },
    addSource: { kind: "addSource" },
    removeMedia: { kind: "removeMedia" },
    markDeceased: { kind: "markDeceased" },
    estimateBirth: { kind: "estimateBirth" },
    addMarriedName: { kind: "addMarriedName" },
    convertEvent: { kind: "convertEvent", fromTag: firstVendor, toTag: "EVEN", type: typeFor(firstVendor) },
  };
  // For addMedia, an empty file with a (possibly empty) title marks the
  // "new image" choice — picking an existing option clears the title again.
  const mediaPick =
    action && (action.kind === "addMedia" || action.kind === "removeMedia")
      ? action.xref || action.file
        ? mediaPickValue(action, mediaOptions)
        : action.kind === "addMedia" && action.title !== undefined
          ? NEW_KEY
          : ""
      : "";
  const sourcePick =
    action?.kind === "addSource" ? (action.xref ?? (action.title !== undefined ? NEW_KEY : "")) : "";
  return (
    <div className="batch-action-editor">
      <SelectMenu
        className="batch-select"
        value={action?.kind ?? ""}
        onChange={(v) => {
          const k = v as BatchActionSpec["kind"] | "";
          onChange(k === "" ? null : fresh[k]);
        }}
        options={[
          { value: "", label: t("tools.batch.action.none") },
          ...BATCH_ACTION_KINDS.map((k) => ({ value: k, label: t(`tools.batch.action.${k}`) })),
        ]}
      />

      {action?.kind === "addMedia" && (
        <>
          <MediaSelect
            value={mediaPick}
            options={mediaOptions}
            allowNew
            onPick={(o) =>
              o.file === "" && o.xref === undefined
                ? onChange({ kind: "addMedia", file: "", title: "" })
                : onChange({ ...action, xref: o.xref, file: o.file, title: undefined })
            }
          />
          {mediaPick === NEW_KEY && (
            <>
              <input
                className="batch-input"
                placeholder={t("tools.batch.filePlaceholder")}
                value={action.file}
                onChange={(e) => onChange({ ...action, xref: undefined, file: e.target.value })}
              />
              <input
                className="batch-input"
                placeholder={t("tools.batch.titlePlaceholder")}
                value={action.title ?? ""}
                onChange={(e) => onChange({ ...action, title: e.target.value })}
              />
            </>
          )}
        </>
      )}

      {action?.kind === "addSource" && (
        <>
          <SelectMenu
            className="batch-select batch-media-select"
            value={sourcePick}
            placeholder={t("tools.batch.pickSource")}
            onChange={(v) => {
              if (v === NEW_KEY) onChange({ kind: "addSource", title: "", page: action.page });
              else onChange({ kind: "addSource", xref: v, page: action.page });
            }}
            options={[
              ...sourceOptions.map((s) => ({ value: s.xref, label: s.title })),
              { value: NEW_KEY, label: t("tools.batch.newSource") },
            ]}
          />
          {sourcePick === NEW_KEY && (
            <input
              className="batch-input"
              placeholder={t("tools.batch.sourceTitlePlaceholder")}
              value={action.title ?? ""}
              onChange={(e) => onChange({ ...action, title: e.target.value })}
            />
          )}
          <input
            className="batch-input"
            placeholder={t("tools.batch.pagePlaceholder")}
            value={action.page ?? ""}
            onChange={(e) => onChange({ ...action, page: e.target.value })}
          />
        </>
      )}

      {action?.kind === "estimateBirth" && (
        <span className="batch-hint">{t("tools.batch.estimateBirthHint")}</span>
      )}

      {action?.kind === "addMarriedName" && (
        <span className="batch-hint">{t("tools.batch.addMarriedNameHint")}</span>
      )}

      {action?.kind === "removeMedia" && (
        <MediaSelect
          value={mediaPick}
          options={mediaOptions}
          onPick={(o) => onChange({ ...action, xref: o.xref, file: o.file })}
        />
      )}

      {action?.kind === "convertEvent" && (
        <>
          <SelectMenu
            className="batch-select"
            value={action.fromTag}
            onChange={(v) => {
              const named = action.toTag === "EVEN" || action.toTag === "FACT";
              onChange({ ...action, fromTag: v, type: named ? typeFor(v) : action.type });
            }}
            options={vendorEventOptions.map((tag) => ({ value: tag, label: eventDisplayLabel(tag, t) }))}
          />
          <span className="batch-sep">→</span>
          <SelectMenu
            className="batch-select"
            value={action.toTag}
            onChange={(v) => {
              const named = v === "EVEN" || v === "FACT";
              onChange({ ...action, toTag: v, type: named ? action.type?.trim() || typeFor(action.fromTag) : undefined });
            }}
            groups={INDIVIDUAL_EVENT_GROUPS.map((g) => ({
              label: t(g.labelKey),
              items: g.tags.map((tag) => ({ value: tag, label: eventDisplayLabel(tag, t) })),
            }))}
          />
          {(action.toTag === "EVEN" || action.toTag === "FACT") && (
            <input
              className="batch-input"
              placeholder={t("tools.batch.typePlaceholder")}
              value={action.type ?? ""}
              onChange={(e) => onChange({ ...action, type: e.target.value })}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── Saved-filter persistence ────────────────────────────────────────────────

const STORAGE_KEY = "gedmerge.batchFilters";

function isCriterion(c: unknown): c is BatchCriterion {
  return (
    !!c &&
    typeof c === "object" &&
    BATCH_CRITERION_KINDS.includes((c as BatchCriterion).kind)
  );
}

function isSavedFilter(f: unknown): f is SavedBatchFilter {
  if (!f || typeof f !== "object") return false;
  const s = f as SavedBatchFilter;
  return (
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    Array.isArray(s.criteria) &&
    s.criteria.every(isCriterion) &&
    (s.action === undefined ||
      (!!s.action && typeof s.action === "object" && BATCH_ACTION_KINDS.includes(s.action.kind)))
  );
}

/** Filters saved before the age/living split called today's "age" criterion "ageAtDeath". */
function migrateSavedFilter(f: unknown): unknown {
  if (!f || typeof f !== "object" || !Array.isArray((f as SavedBatchFilter).criteria)) return f;
  const s = f as SavedBatchFilter;
  return { ...s, criteria: s.criteria.map((c) => ((c.kind as string) === "ageAtDeath" ? { ...c, kind: "age" } : c)) };
}

function loadSavedFilters(): SavedBatchFilter[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(migrateSavedFilter).filter(isSavedFilter) : [];
  } catch {
    return [];
  }
}

function storeSavedFilters(filters: SavedBatchFilter[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Storage full/unavailable — the in-memory list still works this session.
  }
}
