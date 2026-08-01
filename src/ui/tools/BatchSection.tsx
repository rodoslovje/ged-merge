import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Sex } from "../../gedcom/types";
import { firstChild } from "../../gedcom/node";
import { collectLocalMediaFiles } from "../../tools/mediaFiles";
import {
  applyBatchAction,
  buildBatchRows,
  computeLineSides,
  matchesBatch,
  BATCH_ACTION_KINDS,
  BATCH_CRITERION_KINDS,
  type BatchActionSpec,
  type BatchContext,
  type BatchCriterion,
  type SavedBatchFilter,
} from "../../tools/batch";
import type { RecordPatch } from "../historyTypes";
import { useNameOf } from "../SettingsContext";
import { PersonLink } from "../PersonLink";
import { useVirtualList } from "../useVirtualList";
import { PickerMenu } from "../PickerMenu";

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
  const nameOf = useNameOf();

  // Rows rebuild when the file content moves. Deliberately no dependency
  // array: any re-render while visible (tab return, an undo/redo elsewhere,
  // this panel's own apply) re-reads the version counter, and the state
  // update bails out when nothing changed.
  const [ver, setVer] = useState(() => editVersionRef.current);
  useEffect(() => {
    if (active) setVer(editVersionRef.current);
  });

  // eslint-disable-next-line react-hooks/exhaustive-deps -- ver stands in for in-place dataset edits
  const rows = useMemo(() => buildBatchRows(dataset, nameOf), [dataset, nameOf, ver]);
  const lineSides = useMemo(
    () => (startId ? computeLineSides(dataset, startId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ver stands in for in-place dataset edits
    [dataset, startId, ver],
  );
  const ctx: BatchContext = useMemo(() => ({ lineSides }), [lineSides]);

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

  const virtual = useVirtualList({ count: results.length, estimate: 30, itemsKey: results });

  function resetReview() {
    setExcluded(new Set());
    setDone(null);
    setConfirming(false);
  }
  function changeCriteria(next: BatchCriterion[]) {
    setCriteria(next);
    setSelectedSavedId(null);
    resetReview();
  }
  function changeAction(next: BatchActionSpec | null) {
    setAction(next);
    setSelectedSavedId(null);
    setDone(null);
    setConfirming(false);
  }

  function addCriterion(kind: BatchCriterion["kind"]) {
    const fresh: Record<BatchCriterion["kind"], BatchCriterion> = {
      name: { kind: "name", text: "" },
      sex: { kind: "sex", value: "F" },
      birthYear: { kind: "birthYear" },
      ageAtDeath: { kind: "ageAtDeath", op: "lt", years: 20 },
      place: { kind: "place", text: "" },
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
        : !!(action.xref || action.file?.trim()));

  function apply() {
    if (!action || !actionReady || targets.length === 0) return;
    const res = applyBatchAction(dataset, targets.map((r) => r.id), action);
    if (res.patches.length > 0) onApplyPatches(res.patches);
    setDone({ changed: res.changed, skipped: res.skipped });
    setConfirming(false);
    setExcluded(new Set());
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
    resetReview();
  }

  /** Whether a saved filter's media/source/line references resolve in this file. */
  function refsResolve(f: SavedBatchFilter): boolean {
    const mediaExists = (xref?: string, file?: string) =>
      mediaOptions.some((o) => (xref && o.xref === xref) || (!!file && o.file.toLowerCase() === file.toLowerCase()));
    for (const c of f.criteria) {
      if (c.kind === "media" && (c.mode === "has" || c.mode === "lacks") && !mediaExists(c.xref, c.file)) return false;
      if (c.kind === "line" && !lineSides) return false;
    }
    const a = f.action;
    if (a?.kind === "removeMedia" && !mediaExists(a.xref, a.file)) return false;
    if (a?.kind === "addSource" && a.xref && !a.title && !sourceOptions.some((s) => s.xref === a.xref)) return false;
    return true;
  }

  const needsStart = criteria.some((c) => c.kind === "line") && !lineSides;

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
          {results.slice(virtual.start, virtual.end).map((r) => (
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
            </li>
          ))}
          <li className="v-spacer" style={{ height: virtual.padBottom }} ref={virtual.bottomRef} aria-hidden />
        </ul>
      </div>

      <div className="batch-action">
        <div className="batch-block-title">{t("tools.batch.actionTitle")}</div>
        <ActionEditor
          action={action}
          mediaOptions={mediaOptions}
          sourceOptions={sourceOptions}
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
  onChange,
  onRemove,
}: {
  c: BatchCriterion;
  mediaOptions: MediaOption[];
  onChange: (next: BatchCriterion) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="batch-crit">
      <span className="batch-crit-label">{t(`tools.batch.crit.${c.kind}`)}</span>
      {(c.kind === "name" || c.kind === "place") && (
        <input
          className="batch-input"
          value={c.text}
          placeholder={t("tools.batch.textPlaceholder")}
          onChange={(e) => onChange({ ...c, text: e.target.value })}
        />
      )}
      {c.kind === "sex" && (
        <select className="batch-select" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value as Sex })}>
          {(["M", "F", "U"] as const).map((s) => (
            <option key={s} value={s}>
              {t(`sex.${s}`)}
            </option>
          ))}
        </select>
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
      {c.kind === "ageAtDeath" && (
        <>
          <select className="batch-select" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as "lt" | "gte" })}>
            <option value="lt">{t("tools.batch.age.lt")}</option>
            <option value="gte">{t("tools.batch.age.gte")}</option>
          </select>
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
          <select
            className="batch-select"
            value={c.mode}
            onChange={(e) => onChange({ ...c, mode: e.target.value as typeof c.mode })}
          >
            {(["none", "any", "has", "lacks"] as const).map((m) => (
              <option key={m} value={m}>
                {t(`tools.batch.media.${m}`)}
              </option>
            ))}
          </select>
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
        <select
          className="batch-select"
          value={c.mode}
          onChange={(e) => onChange({ ...c, mode: e.target.value as "none" | "any" })}
        >
          <option value="none">{t("tools.batch.sourcesFilter.none")}</option>
          <option value="any">{t("tools.batch.sourcesFilter.any")}</option>
        </select>
      )}
      {c.kind === "line" && (
        <select
          className="batch-select"
          value={c.side}
          onChange={(e) => onChange({ ...c, side: e.target.value as "maternal" | "paternal" })}
        >
          <option value="maternal">{t("tools.batch.line.maternal")}</option>
          <option value="paternal">{t("tools.batch.line.paternal")}</option>
        </select>
      )}
      <button className="batch-remove" onClick={onRemove} title={t("tools.batch.removeFilter")}>
        ✕
      </button>
    </li>
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
    <select
      className="batch-select batch-media-select"
      value={value}
      onChange={(e) => {
        const key = e.target.value;
        if (key === NEW_KEY) onPick({ file: "" });
        const opt = options.find((o) => o.key === key);
        if (opt) onPick({ xref: opt.xref, file: opt.file });
      }}
    >
      <option value="" disabled>
        {t("tools.batch.pickMedia")}
      </option>
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.title ? `${o.title} — ${o.file}` : o.file}
        </option>
      ))}
      {allowNew && <option value={NEW_KEY}>{t("tools.batch.newMedia")}</option>}
    </select>
  );
}

// ── Action editor ───────────────────────────────────────────────────────────

function ActionEditor({
  action,
  mediaOptions,
  sourceOptions,
  onChange,
}: {
  action: BatchActionSpec | null;
  mediaOptions: MediaOption[];
  sourceOptions: Array<{ xref: string; title: string }>;
  onChange: (next: BatchActionSpec | null) => void;
}) {
  const { t } = useTranslation();
  const fresh: Record<BatchActionSpec["kind"], BatchActionSpec> = {
    addMedia: { kind: "addMedia", file: "" },
    addSource: { kind: "addSource" },
    removeMedia: { kind: "removeMedia" },
  };
  // For addMedia, an empty file with a (possibly empty) title marks the
  // "new image" choice — picking an existing option clears the title again.
  const mediaPick =
    action && action.kind !== "addSource"
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
      <select
        className="batch-select"
        value={action?.kind ?? ""}
        onChange={(e) => {
          const k = e.target.value as BatchActionSpec["kind"] | "";
          onChange(k === "" ? null : fresh[k]);
        }}
      >
        <option value="">{t("tools.batch.action.none")}</option>
        {BATCH_ACTION_KINDS.map((k) => (
          <option key={k} value={k}>
            {t(`tools.batch.action.${k}`)}
          </option>
        ))}
      </select>

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
          <select
            className="batch-select batch-media-select"
            value={sourcePick}
            onChange={(e) => {
              const v = e.target.value;
              if (v === NEW_KEY) onChange({ kind: "addSource", title: "", page: action.page });
              else onChange({ kind: "addSource", xref: v, page: action.page });
            }}
          >
            <option value="" disabled>
              {t("tools.batch.pickSource")}
            </option>
            {sourceOptions.map((s) => (
              <option key={s.xref} value={s.xref}>
                {s.title}
              </option>
            ))}
            <option value={NEW_KEY}>{t("tools.batch.newSource")}</option>
          </select>
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

      {action?.kind === "removeMedia" && (
        <MediaSelect
          value={mediaPick}
          options={mediaOptions}
          onPick={(o) => onChange({ ...action, xref: o.xref, file: o.file })}
        />
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

function loadSavedFilters(): SavedBatchFilter[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSavedFilter) : [];
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
