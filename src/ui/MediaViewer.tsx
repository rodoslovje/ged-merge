import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GedNode } from "../gedcom/types";
import type { CropRegion } from "../gedcom/source";
import { collectMediaRefs, type MediaAddress } from "../gedcom/media";
import { mediaKindOf } from "./mediaPath";
import { familySpouses, mediaUsedBy, type PersonRef } from "../tools/sources";
import { lifespanLabel } from "../match/relatives";
import { PersonLink } from "./PersonLink";
import { useMediaFolder } from "./MediaFolderContext";
import { basename } from "./mediaPath";

/**
 * One full-screen photo viewer shared by every part of the app (Edit, Merge,
 * Tools, trees). A single overlay is mounted by `MediaViewerProvider`; any
 * thumbnail opens it through `useMediaViewer()`, so the controls — enlarged
 * image, prev/next, thumbnail tray, info panel, keyboard nav — are identical
 * everywhere.
 */

/** A label/value line in the info panel. */
export interface MediaMetaRow {
  label: string;
  value: ReactNode;
}

/** Editable descriptive fields shown as inputs in the info panel (Edit only). */
export interface MediaEditFields {
  title: string;
  date: string;
  place: string;
  description: string;
}

/** Makes a photo's info panel editable (Edit/main context only): the current
 *  field values to seed the inputs, the file path shown read-only, and a commit
 *  callback that writes them back through the edit/undo flow. */
export interface MediaEdit {
  file: string;
  /** Where the media is attached when not on the record itself — the event's
   *  display label (e.g. "Birth"), shown read-only under the filename. */
  context?: string;
  initial: MediaEditFields;
  onSave: (fields: MediaEditFields) => void;
  /** This link's GEDCOM 7 crop region (the record's marked part of the photo)
   *  as it was when the viewer opened — seeds the crop editor. */
  crop?: CropRegion;
  /** When set (image media in Edit context), the info panel offers marking the
   *  record's region: save a drawn rectangle, or `null` to clear it. */
  onSaveCrop?: (crop: CropRegion | null) => void;
}

/** A crop region plus the label (person name) shown under it. */
export interface CropMark {
  crop: CropRegion;
  label: string;
}

/** One photo plus the metadata shown beside it in the info panel. */
export interface MediaItem {
  url: string;
  /** How the stage renders it: `<img>` (default) or an embedded PDF frame. */
  kind?: "image" | "pdf";
  /** Caption headline (title, or a filename fallback). */
  title?: string;
  /** Key/value rows under the caption. */
  meta?: MediaMetaRow[];
  /** Extra info block (e.g. a "referenced by" list). Receives a `close`
   *  callback so navigation links can dismiss the viewer first, an
   *  `onHoverCrop` setter so a hovered entry can show that person's crop box,
   *  and a `refreshKey` that bumps when a crop was just edited (so a memoized
   *  block can re-read the live records). */
  details?: (close: () => void, onHoverCrop?: (mark: CropMark | null) => void, refreshKey?: number) => ReactNode;
  /** When set, the info panel shows editable inputs instead of static rows. */
  edit?: MediaEdit;
  /** Every tagged person's GEDCOM 7 crop region on this (group) photo, each with
   *  a name label. Nothing is drawn by default; hovering/touching the image
   *  reveals all of these boxes with their names. */
  allCrops?: CropMark[];
  /** Live variant of {@link allCrops}: re-reads the records so a region saved
   *  while the viewer is open shows up immediately. Takes precedence. */
  getAllCrops?: () => CropMark[];
}

/**
 * Lets the info panel show a shared media object's "referenced by" list (and
 * navigate to a citing record) when a person's photo is opened in Edit. Omitted
 * where no Edit navigation target exists (e.g. trees).
 */
export interface MediaRefContext {
  dataset: Dataset;
  onNavigate: (id: string) => void;
  /** When provided (Edit/main context), the info panel becomes editable; the
   *  callback writes a photo's fields back by its media address (record- or
   *  event-level `OBJE`). */
  onEditMedia?: (addr: MediaAddress, fields: MediaEditFields) => void;
  /** Writes (or clears, with `null`) the link's crop region — the part of a
   *  group photo depicting the record. Enables the viewer's crop editor. */
  onEditMediaCrop?: (addr: MediaAddress, crop: CropRegion | null) => void;
}

interface MediaViewerCtx {
  /** Open the viewer with already-resolved items. */
  openItems(items: MediaItem[], startIndex?: number): void;
  /** Resolve a person/record's local photos, then open the viewer. `start` is
   *  the tray index to open at, or a media address (the add flow targets the
   *  just-added `OBJE` that way — a plain "last index" could land on an
   *  event-level photo, which sorts after the record-level ones). `focusEdit`
   *  autofocuses the edit form's first field once — used by the add flow so a
   *  just-added photo is ready to caption; left off for plain viewing (tray
   *  navigation / opening from Edit) so the user decides whether to edit. */
  openPerson(raw: GedNode, records: GedNode[], start?: number | MediaAddress, refCtx?: MediaRefContext, focusEdit?: boolean): void;
}

const MediaViewerContext = createContext<MediaViewerCtx>({
  openItems: () => {},
  openPerson: () => {},
});

export function useMediaViewer() {
  return useContext(MediaViewerContext);
}

// ── Person/record photo collection ─────────────────────────────────────────

/** The descriptive caption rows (date depicted, place, description, file) for a
 *  media object — shared by the person-media and Sources-tree info panels so
 *  both render an identical block. Absent fields are omitted; order is fixed. */
export function mediaMetaRows(
  info: { file?: string; date?: string; place?: string; description?: string },
  t: (key: string) => string,
): MediaMetaRow[] {
  const rows: MediaMetaRow[] = [];
  if (info.date) rows.push({ label: t("tools.sources.mediaDate"), value: info.date });
  if (info.place) rows.push({ label: t("tools.sources.mediaPlace"), value: info.place });
  if (info.description) rows.push({ label: t("tools.sources.mediaDesc"), value: info.description });
  if (info.file) rows.push({ label: t("tools.sources.mediaFile"), value: info.file });
  return rows;
}

/** Every tagged person's crop region on a shared media object, with a name label
 *  — the boxes revealed when the lightbox image is hovered/touched. Skips
 *  references that carry no crop region. */
function mediaCropMarks(dataset: Dataset, mediaXref: string): CropMark[] {
  return mediaUsedBy(dataset, mediaXref)
    .filter((u) => u.crop)
    .map((u) => ({ crop: u.crop!, label: personsLabel(dataset, u.persons) }));
}

/** Combined "Name lifespan" label for a usage row's person(s) — name + lifespan
 *  ("Ana Novak 1900–1980") rather than the full birth date; "&"-joined for a
 *  family. Used for both the hover marker and the reveal-all boxes. */
function personsLabel(dataset: Dataset, persons: PersonRef[]): string {
  return persons
    .map((p) => {
      const indi = dataset.individuals.get(p.id);
      return indi ? lifespanLabel(indi) : p.label;
    })
    .join(" & ");
}

/** Crop-box label for an *inline* media link's owning record — the person's
 *  name, or the spouses' names for a family. */
function recordCropLabel(dataset: Dataset, raw: GedNode): string {
  if (!raw.xref) return "";
  const persons: PersonRef[] =
    raw.tag === "FAM" ? familySpouses(dataset, raw.xref) : [{ id: raw.xref, label: raw.xref }];
  return personsLabel(dataset, persons);
}

/** The "referenced by N records" block shown in the info panel for a shared
 *  media object — the `INDI`/`FAM` records that cite it, each a link into Edit.
 *  Mirrors the Tools › Sources panel so a photo's usage is visible there too. */
export function MediaReferencedBy({
  dataset,
  mediaXref,
  onNavigate,
  onHoverCrop,
  refreshKey = 0,
}: {
  dataset: Dataset;
  mediaXref: string;
  onNavigate: (id: string) => void;
  /** When given, hovering a usage row that carries a crop region reports it (with
   *  the person's name) so the image shows that one person's box; leaving reports null. */
  onHoverCrop?: (mark: CropMark | null) => void;
  /** Bumped when a crop was edited while the viewer is open — `dataset` is
   *  mutated in place (stable reference), so the memo needs another trigger
   *  to re-read the live records. */
  refreshKey?: number;
}) {
  const { t } = useTranslation();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the in-place-mutation trigger
  const uses = useMemo(() => mediaUsedBy(dataset, mediaXref), [dataset, mediaXref, refreshKey]);
  if (uses.length === 0) return null;
  return (
    <>
      <div className="media-lightbox-uses-head">
        {t("tools.sources.referencedBy", { count: uses.length })}
      </div>
      <ul className="tools-usage">
        {uses.map((u, i) => {
          const hoverable = onHoverCrop && u.crop;
          return (
            <li
              key={`${u.persons.map((p) => p.id).join("-")}-${i}`}
              className={hoverable ? "has-crop" : undefined}
              onMouseEnter={hoverable ? () => onHoverCrop!({ crop: u.crop!, label: personsLabel(dataset, u.persons) }) : undefined}
              onMouseLeave={hoverable ? () => onHoverCrop!(null) : undefined}
            >
              {u.persons.map((p, j) => (
                <span key={p.id}>
                  {j > 0 && <span className="tools-usage-amp">&amp;</span>}
                  <PersonLink dataset={dataset} id={p.id} fallback={p.label} onNavigate={onNavigate} />
                </span>
              ))}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ── Provider + overlay ──────────────────────────────────────────────────────

export function MediaViewerProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { resolveFile } = useMediaFolder();
  const [request, setRequest] = useState<{ items: MediaItem[]; index: number; focusEdit: boolean } | null>(null);

  const openItems = useCallback((items: MediaItem[], startIndex = 0, focusEdit = false) => {
    if (items.length === 0) return;
    setRequest({ items, index: Math.max(0, Math.min(startIndex, items.length - 1)), focusEdit });
  }, []);

  const openPerson = useCallback(
    async (raw: GedNode, records: GedNode[], start: number | MediaAddress = 0, refCtx?: MediaRefContext, focusEdit = false) => {
      const refs = collectMediaRefs(raw, records);
      if (refs.length === 0) return;
      const resolved = await Promise.all(refs.map((r) => resolveFile(r.file)));
      const items: MediaItem[] = [];
      let startIndex = typeof start === "number" ? start : 0;
      const atStart = (r: MediaAddress) =>
        typeof start === "object" &&
        r.eventTag === start.eventTag &&
        (r.eventIndex ?? 0) === (start.eventIndex ?? 0) &&
        r.objeIndex === start.objeIndex;
      for (let i = 0; i < refs.length; i++) {
        const url = resolved[i];
        if (!url) continue;
        const ref = refs[i];
        const { xref } = ref;
        const onEditMedia = refCtx?.onEditMedia;
        if (atStart(ref)) startIndex = items.length;
        // Media attached to an event (rather than the record itself) shows the
        // event's label so it's clear what the photo documents.
        const eventLabel = ref.eventTag
          ? t(`event.${ref.eventTag}`, { defaultValue: ref.eventTag })
          : undefined;
        const metaRows = mediaMetaRows(ref, t);
        if (eventLabel) metaRows.unshift({ label: t("media.field.event"), value: eventLabel });
        items.push({
          url,
          kind: mediaKindOf(ref.file) === "pdf" ? "pdf" : "image",
          // Live so a region saved while the viewer is open shows immediately.
          // Shared media: every referencing record's crop. Inline media: only
          // this record's own link can crop it — re-read it by address.
          getAllCrops: refCtx
            ? xref
              ? () => mediaCropMarks(refCtx.dataset, xref)
              : () => {
                  const fresh = collectMediaRefs(raw, records).find(
                    (r) =>
                      r.eventTag === ref.eventTag &&
                      (r.eventIndex ?? 0) === (ref.eventIndex ?? 0) &&
                      r.objeIndex === ref.objeIndex,
                  );
                  return fresh?.crop ? [{ crop: fresh.crop, label: recordCropLabel(refCtx.dataset, raw) }] : [];
                }
            : undefined,
          title: ref.title || basename(ref.file),
          // When editable, the form replaces the static rows; otherwise show them.
          meta: onEditMedia ? undefined : metaRows,
          edit: onEditMedia
            ? {
                file: ref.file,
                context: eventLabel,
                initial: {
                  title: ref.title ?? "",
                  date: ref.date ?? "",
                  place: ref.place ?? "",
                  description: ref.description ?? "",
                },
                onSave: (fields) => onEditMedia(ref, fields),
                crop: ref.crop,
                onSaveCrop:
                  refCtx?.onEditMediaCrop && mediaKindOf(ref.file) === "image"
                    ? (crop) => refCtx.onEditMediaCrop!(ref, crop)
                    : undefined,
              }
            : undefined,
          details:
            refCtx && xref
              ? (close, onHoverCrop, refreshKey) => (
                  <MediaReferencedBy
                    dataset={refCtx.dataset}
                    mediaXref={xref}
                    onNavigate={(id) => { close(); refCtx.onNavigate(id); }}
                    onHoverCrop={onHoverCrop}
                    refreshKey={refreshKey}
                  />
                )
              : undefined,
        });
      }
      openItems(items, startIndex, focusEdit);
    },
    [resolveFile, t, openItems],
  );

  return (
    <MediaViewerContext.Provider value={{ openItems, openPerson }}>
      {children}
      {request && (
        <MediaViewerOverlay
          items={request.items}
          startIndex={request.index}
          focusEdit={request.focusEdit}
          onClose={() => setRequest(null)}
        />
      )}
    </MediaViewerContext.Provider>
  );
}

/** Editable info-panel form for a photo's descriptive fields. Seeded from
 *  `seed` (the latest saved values, falling back to the photo's initial ones);
 *  remounted per photo by the overlay so each starts from its own values.
 *  Like the Edit-mode fields, each field auto-commits on blur (a no-op commit
 *  when nothing changed is filtered out by the edit/undo layer). */
function MediaInfoEditor({
  edit,
  seed,
  onSaved,
  autoFocus,
  t,
}: {
  edit: MediaEdit;
  seed: MediaEditFields;
  onSaved: (fields: MediaEditFields) => void;
  autoFocus: boolean;
  t: (key: string) => string;
}) {
  const [fields, setFields] = useState<MediaEditFields>(seed);
  const set = (key: keyof MediaEditFields) => (value: string) => setFields((f) => ({ ...f, [key]: value }));
  const commit = () => { onSaved(fields); edit.onSave(fields); };
  const blurOnEnter = (e: ReactKeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.currentTarget.blur(); };
  return (
    <div className="media-lightbox-edit">
      <div className="media-lightbox-file" title={edit.file}>
        {basename(edit.file)}
        {edit.context && <span className="media-lightbox-context"> · {edit.context}</span>}
      </div>
      <label className="media-edit-field">
        <span>{t("media.field.title")}</span>
        <input className="edit-input" autoFocus={autoFocus} value={fields.title} onChange={(e) => set("title")(e.target.value)} onBlur={commit} onKeyDown={blurOnEnter} />
      </label>
      <label className="media-edit-field">
        <span>{t("media.field.date")}</span>
        <input className="edit-input" value={fields.date} onChange={(e) => set("date")(e.target.value)} onBlur={commit} onKeyDown={blurOnEnter} />
      </label>
      <label className="media-edit-field">
        <span>{t("media.field.place")}</span>
        <input className="edit-input" value={fields.place} onChange={(e) => set("place")(e.target.value)} onBlur={commit} onKeyDown={blurOnEnter} />
      </label>
      <label className="media-edit-field">
        <span>{t("media.field.description")}</span>
        <textarea className="edit-input" rows={3} value={fields.description} onChange={(e) => set("description")(e.target.value)} onBlur={commit} />
      </label>
    </div>
  );
}

/** The lightbox image plus, when the photo carries GEDCOM 7 crop regions, dashed
 *  boxes (each with a name label) marking the people in it. Nothing shows by
 *  default: hovering a "referenced by" name shows that one person's box, and
 *  hovering/touching the image reveals everyone. The wrapper shrink-wraps the
 *  `object-fit: contain` image (which auto-sizes to its natural aspect ratio, so
 *  no letterboxing inside the element), letting boxes be positioned as plain
 *  percentages of the natural pixel dimensions. */
function MediaStage({
  url,
  kind,
  title,
  hoverMark,
  allCrops,
  cropEdit,
}: {
  url: string;
  kind?: "image" | "pdf";
  title?: string;
  /** A single person's box to show — set while a name in the "referenced by"
   *  list is hovered. Takes precedence over the reveal-all overlay. */
  hoverMark: CropMark | null;
  /** Every tagged person on this photo; revealed (with names) on image hover/touch. */
  allCrops: CropMark[];
  /** Crop-marking mode: dragging on the image draws the record's region (in
   *  natural pixels) into `draft`; the overlay's controls save or discard it. */
  cropEdit?: { draft: CropRegion | null; onDraft: (crop: CropRegion | null) => void };
}) {
  // Natural pixel size, captured on load; cleared while a new image loads so a
  // stale size from the previous photo can't briefly misposition a box.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // Hovering/touching the image reveals every tagged person's box with its name.
  const [revealing, setRevealing] = useState(false);
  useEffect(() => { setNatural(null); setRevealing(false); }, [url]);

  // Region → percentage box of the image (which fills the wrapper exactly).
  const box = (c: CropRegion): CSSProperties => ({
    left: `${(c.left / natural!.w) * 100}%`,
    top: `${(c.top / natural!.h) * 100}%`,
    width: `${(c.width / natural!.w) * 100}%`,
    height: `${(c.height / natural!.h) * 100}%`,
  });

  // Anchor of an in-progress crop drag, in natural image pixels.
  const dragAnchor = useRef<{ x: number; y: number } | null>(null);

  const canReveal = !cropEdit && allCrops.length > 0;
  // A hovered name shows just that person; otherwise an image hover reveals all.
  const marks = cropEdit ? [] : hoverMark ? [hoverMark] : revealing ? allCrops : [];

  // A PDF renders in the browser's built-in viewer; crop regions don't apply.
  if (kind === "pdf") {
    return <iframe className="media-lightbox-doc" src={url} title={title ?? ""} />;
  }

  // The wrapper shrink-wraps the image, so its client rect maps 1:1 onto the
  // natural pixel space the CROP tags use.
  const toNatural = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * natural!.w;
    const y = ((e.clientY - rect.top) / rect.height) * natural!.h;
    return { x: Math.max(0, Math.min(natural!.w, x)), y: Math.max(0, Math.min(natural!.h, y)) };
  };
  const draftFrom = (anchor: { x: number; y: number }, p: { x: number; y: number }): CropRegion => ({
    left: Math.min(anchor.x, p.x),
    top: Math.min(anchor.y, p.y),
    width: Math.abs(p.x - anchor.x),
    height: Math.abs(p.y - anchor.y),
  });

  return (
    <div
      className={`person-media-cropwrap ${cropEdit ? "crop-editing" : ""}`}
      onMouseEnter={canReveal ? () => setRevealing(true) : undefined}
      onMouseLeave={canReveal ? () => setRevealing(false) : undefined}
      onTouchStart={canReveal ? () => setRevealing((v) => !v) : undefined}
      onPointerDown={cropEdit && natural ? (e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragAnchor.current = toNatural(e);
        cropEdit.onDraft(null);
      } : undefined}
      onPointerMove={cropEdit && natural ? (e) => {
        if (!dragAnchor.current) return;
        cropEdit.onDraft(draftFrom(dragAnchor.current, toNatural(e)));
      } : undefined}
      onPointerUp={cropEdit && natural ? (e) => {
        if (!dragAnchor.current) return;
        const draft = draftFrom(dragAnchor.current, toNatural(e));
        dragAnchor.current = null;
        // A click without a real drag clears instead of leaving a sliver.
        cropEdit.onDraft(draft.width >= 4 && draft.height >= 4 ? draft : null);
      } : undefined}
    >
      <img
        src={url}
        className="person-media-full"
        alt={title ?? ""}
        draggable={false}
        onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      />
      {natural && marks.map((m, i) => (
        <div key={i} className="photo-crop-box" style={box(m.crop)}>
          <span className="photo-crop-name" title={m.label}>{m.label}</span>
        </div>
      ))}
      {natural && cropEdit?.draft && (
        <div className="photo-crop-box photo-crop-draft" style={box(cropEdit.draft)} />
      )}
    </div>
  );
}

function MediaViewerOverlay({
  items,
  startIndex,
  focusEdit,
  onClose,
}: {
  items: MediaItem[];
  startIndex: number;
  focusEdit: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(startIndex);
  // Saved field values per photo, so navigating away and back shows the latest
  // edits rather than the values captured when the viewer opened.
  const [edits, setEdits] = useState<Record<number, MediaEditFields>>({});
  const multiple = items.length > 1;
  const current = items[Math.min(index, items.length - 1)];
  // Person hovered in the "referenced by" list — shows that one person's box on
  // the image. Reset whenever the active photo changes so it can't bleed across
  // photos. (By default no boxes are drawn; see MediaStage.)
  const [hoverMark, setHoverMark] = useState<CropMark | null>(null);
  // Crop-marking mode: the in-progress rectangle, plus per-photo values already
  // saved this viewing so the button label/remove option stay current (the
  // items themselves are built once, when the viewer opens).
  const [cropEditing, setCropEditing] = useState(false);
  const [cropDraft, setCropDraft] = useState<CropRegion | null>(null);
  const [cropSaved, setCropSaved] = useState<Record<number, CropRegion | null>>({});
  // Bumped on every crop save/remove: re-runs the live `getAllCrops` read and
  // MediaReferencedBy's memo, so the new box shows without reopening the viewer.
  const [cropRefresh, setCropRefresh] = useState(0);
  useEffect(() => { setHoverMark(null); setCropEditing(false); setCropDraft(null); }, [index]);
  const effectiveCrop = current.edit ? (index in cropSaved ? cropSaved[index] : current.edit.crop) : undefined;
  // Memoized so hover-driven re-renders don't rescan the records; the deps are
  // the photo itself and the crop-edit counter.
  const allCrops = useMemo(
    () => (current.getAllCrops ? current.getAllCrops() : current.allCrops ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cropRefresh is the in-place-mutation trigger
    [current, cropRefresh],
  );
  // Autofocus the edit form's first field only on the add-flow open — never on
  // tray navigation or plain "expand from Edit". Consumed after the first render
  // so even returning to the start photo won't refocus.
  const [allowFocus, setAllowFocus] = useState(focusEdit);
  useEffect(() => { if (allowFocus) setAllowFocus(false); }, [allowFocus]);

  // Esc closes; arrows step (with wraparound) when there's more than one photo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      // Don't hijack arrow keys while typing in the edit form — let them move
      // the text cursor instead of stepping photos.
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowLeft") setIndex((i) => (i - 1 + items.length) % items.length);
      else if (e.key === "ArrowRight") setIndex((i) => (i + 1) % items.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items.length, onClose]);

  const hasInfo = current.edit || current.title || (current.meta && current.meta.length > 0) || current.details;

  return (
    <div
      className={`person-media-overlay ${multiple ? "has-tray" : ""}`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("media.enlarged")}
    >
      <button className="person-media-close" onClick={onClose} aria-label={t("help.close")}>
        ✕
      </button>
      {multiple && (
        <button
          className="person-media-nav person-media-prev"
          onClick={(e) => { e.stopPropagation(); setIndex((index - 1 + items.length) % items.length); }}
          aria-label={t("media.prev")}
        >
          ‹
        </button>
      )}
      <div className="media-lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="person-media-stage">
          <MediaStage
            url={current.url}
            kind={current.kind}
            title={current.title}
            hoverMark={hoverMark}
            allCrops={allCrops}
            cropEdit={cropEditing ? { draft: cropDraft, onDraft: setCropDraft } : undefined}
          />
        </div>
        {hasInfo && (
          <div className="media-lightbox-info">
            {current.edit ? (
              <>
                <MediaInfoEditor
                  key={index}
                  edit={current.edit}
                  seed={edits[index] ?? current.edit.initial}
                  onSaved={(f) => setEdits((p) => ({ ...p, [index]: f }))}
                  autoFocus={allowFocus}
                  t={t}
                />
                {current.edit.onSaveCrop && current.kind !== "pdf" && (
                  <div className="media-crop-controls">
                    {!cropEditing ? (
                      <button
                        type="button"
                        className="tree-open-btn"
                        onClick={() => { setCropDraft(effectiveCrop ?? null); setCropEditing(true); }}
                      >
                        ⛶ {t(effectiveCrop ? "media.crop.change" : "media.crop.add")}
                      </button>
                    ) : (
                      <>
                        <div className="media-crop-hint">{t("media.crop.hint")}</div>
                        <div className="media-crop-buttons">
                          <button
                            type="button"
                            className="tree-open-btn"
                            disabled={!cropDraft}
                            onClick={() => {
                              current.edit!.onSaveCrop!(cropDraft);
                              setCropSaved((p) => ({ ...p, [index]: cropDraft }));
                              setCropRefresh((v) => v + 1);
                              setCropEditing(false);
                            }}
                          >
                            {t("media.crop.save")}
                          </button>
                          {effectiveCrop && (
                            <button
                              type="button"
                              className="tree-open-btn"
                              onClick={() => {
                                current.edit!.onSaveCrop!(null);
                                setCropSaved((p) => ({ ...p, [index]: null }));
                                setCropDraft(null);
                                setCropRefresh((v) => v + 1);
                                setCropEditing(false);
                              }}
                            >
                              {t("media.crop.remove")}
                            </button>
                          )}
                          <button
                            type="button"
                            className="tree-open-btn"
                            onClick={() => { setCropEditing(false); setCropDraft(null); }}
                          >
                            {t("media.crop.cancel")}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                {current.title && <div className="media-lightbox-caption">{current.title}</div>}
                {current.meta && current.meta.length > 0 && (
                  <dl className="media-lightbox-meta">
                    {current.meta.map((row, i) => (
                      <div key={i}>
                        <dt>{row.label}</dt>
                        <dd>{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </>
            )}
            {current.details?.(onClose, setHoverMark, cropRefresh)}
          </div>
        )}
      </div>
      {multiple && (
        <button
          className="person-media-nav person-media-next"
          onClick={(e) => { e.stopPropagation(); setIndex((index + 1) % items.length); }}
          aria-label={t("media.next")}
        >
          ›
        </button>
      )}
      {multiple && (
        <div className="person-media-tray" onClick={(e) => e.stopPropagation()}>
          {items.map((it, i) => (
            <button
              key={i}
              className={`person-media-tray-thumb ${i === index ? "active" : ""}`}
              onClick={() => setIndex(i)}
              aria-current={i === index}
            >
              {it.kind === "pdf" ? (
                <span className="person-media-tray-doc" aria-hidden="true">📄</span>
              ) : (
                <img src={it.url} alt="" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
