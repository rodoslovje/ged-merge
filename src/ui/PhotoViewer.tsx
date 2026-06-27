import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GedNode } from "../gedcom/types";
import { isPointer, objeInfoOf, objeNodesFor } from "../gedcom/source";
import { mediaUsedBy } from "../tools/sources";
import { PersonLink } from "./PersonLink";
import { useMediaFolder } from "./MediaFolderContext";
import { basename } from "./mediaPath";

/**
 * One full-screen photo viewer shared by every part of the app (Edit, Merge,
 * Tools, trees). A single overlay is mounted by `PhotoViewerProvider`; any
 * thumbnail opens it through `usePhotoViewer()`, so the controls — enlarged
 * image, prev/next, thumbnail tray, info panel, keyboard nav — are identical
 * everywhere.
 */

/** A label/value line in the info panel. */
export interface PhotoMetaRow {
  label: string;
  value: ReactNode;
}

/** Editable descriptive fields shown as inputs in the info panel (Edit only). */
export interface PhotoEditFields {
  title: string;
  date: string;
  place: string;
  description: string;
}

/** Makes a photo's info panel editable (Edit/master context only): the current
 *  field values to seed the inputs, the file path shown read-only, and a commit
 *  callback that writes them back through the edit/undo flow. */
export interface PhotoEdit {
  file: string;
  initial: PhotoEditFields;
  onSave: (fields: PhotoEditFields) => void;
}

/** One photo plus the metadata shown beside it in the info panel. */
export interface PhotoItem {
  url: string;
  /** Caption headline (title, or a filename fallback). */
  title?: string;
  /** Key/value rows under the caption. */
  meta?: PhotoMetaRow[];
  /** Extra info block (e.g. a "referenced by" list). Receives a `close`
   *  callback so navigation links can dismiss the viewer first. */
  details?: (close: () => void) => ReactNode;
  /** When set, the info panel shows editable inputs instead of static rows. */
  edit?: PhotoEdit;
}

/**
 * Lets the info panel show a shared media object's "referenced by" list (and
 * navigate to a citing record) when a person's photo is opened in Edit. Omitted
 * where no Edit navigation target exists (e.g. trees).
 */
export interface PhotoRefContext {
  dataset: Dataset;
  onNavigate: (id: string) => void;
  /** When provided (Edit/master context), the info panel becomes editable; the
   *  callback writes a photo's fields back by its `OBJE` child index. */
  onEditMedia?: (objeIndex: number, fields: PhotoEditFields) => void;
}

interface PhotoViewerCtx {
  /** Open the viewer with already-resolved items. */
  openItems(items: PhotoItem[], startIndex?: number): void;
  /** Resolve a person/record's local photos, then open the viewer. `focusEdit`
   *  autofocuses the edit form's first field once — used by the add flow so a
   *  just-added photo is ready to caption; left off for plain viewing (tray
   *  navigation / opening from Edit) so the user decides whether to edit. */
  openPerson(raw: GedNode, records: GedNode[], startIndex?: number, refCtx?: PhotoRefContext, focusEdit?: boolean): void;
}

const PhotoViewerContext = createContext<PhotoViewerCtx>({
  openItems: () => {},
  openPerson: () => {},
});

export function usePhotoViewer() {
  return useContext(PhotoViewerContext);
}

// ── Person/record photo collection ─────────────────────────────────────────

/** The descriptive caption rows (date depicted, place, description, file) for a
 *  media object — shared by the person-photo and Sources-tree info panels so
 *  both render an identical block. Absent fields are omitted; order is fixed. */
export function mediaMetaRows(
  info: { file?: string; date?: string; place?: string; description?: string },
  t: (key: string) => string,
): PhotoMetaRow[] {
  const rows: PhotoMetaRow[] = [];
  if (info.date) rows.push({ label: t("tools.sources.mediaDate"), value: info.date });
  if (info.place) rows.push({ label: t("tools.sources.mediaPlace"), value: info.place });
  if (info.description) rows.push({ label: t("tools.sources.mediaDesc"), value: info.description });
  if (info.file) rows.push({ label: t("tools.sources.mediaFile"), value: info.file });
  return rows;
}

/** A local photo linked from a record: its file, title, descriptive content
 *  fields (date depicted, place, free-text description), and—when the OBJE is a
 *  pointer to a shared media record—that record's xref (for the "referenced by"
 *  list). */
export interface PhotoRef {
  file: string;
  title?: string;
  /** A level-1 `DATE` — the date the media depicts (not an edit timestamp). */
  date?: string;
  place?: string;
  /** Free-text description, from `_DSCR` or `NOTE`. */
  description?: string;
  /** Shared media record xref, present only for pointer-style OBJE links. */
  xref?: string;
  /** Position of this photo's `OBJE` among the record's `OBJE` children
   *  (counting URL-only ones too), so Edit-mode delete/reorder can target the
   *  right child even when some `OBJE`s aren't displayable photos. */
  objeIndex: number;
}

/** Local file, title, and descriptive content for one OBJE node, or null when
 *  it's a URL/has no file. Reuses the shared OBJE parser; keeps only nodes whose
 *  `FILE` is a local filename (a displayable photo), dropping URL-only links. */
function objePhotoRef(objeNode: GedNode): Omit<PhotoRef, "xref" | "objeIndex"> | null {
  const info = objeInfoOf(objeNode);
  if (!info.file || info.url) return null;
  return {
    file: info.file,
    title: info.title,
    date: info.date,
    place: info.place,
    description: info.description,
  };
}

/** Every local photo (file + title) linked from a record's OBJE children. */
export function collectPhotoRefs(raw: GedNode, records: GedNode[]): PhotoRef[] {
  const objeNodes = objeNodesFor(records);
  const refs: PhotoRef[] = [];
  let objeIndex = -1;
  for (const child of raw.children) {
    if (child.tag !== "OBJE") continue;
    objeIndex++;
    const val = child.value?.trim();
    const xref = val && isPointer(val) ? val : undefined;
    const objeNode = xref ? objeNodes.get(xref) : child;
    if (!objeNode) continue;
    const ref = objePhotoRef(objeNode);
    if (ref) refs.push({ ...ref, xref, objeIndex });
  }
  return refs;
}

/** The "referenced by N records" block shown in the info panel for a shared
 *  media object — the `INDI`/`FAM` records that cite it, each a link into Edit.
 *  Mirrors the Tools › Sources panel so a photo's usage is visible there too. */
export function MediaReferencedBy({
  dataset,
  mediaXref,
  onNavigate,
}: {
  dataset: Dataset;
  mediaXref: string;
  onNavigate: (id: string) => void;
}) {
  const { t } = useTranslation();
  const uses = useMemo(() => mediaUsedBy(dataset, mediaXref), [dataset, mediaXref]);
  if (uses.length === 0) return null;
  return (
    <>
      <div className="media-lightbox-uses-head">
        {t("tools.sources.referencedBy", { count: uses.length })}
      </div>
      <ul className="tools-usage">
        {uses.map((u, i) => (
          <li key={`${u.persons.map((p) => p.id).join("-")}-${i}`}>
            {u.persons.map((p, j) => (
              <span key={p.id}>
                {j > 0 && <span className="tools-usage-amp">&amp;</span>}
                <PersonLink dataset={dataset} id={p.id} fallback={p.label} onNavigate={onNavigate} />
              </span>
            ))}
          </li>
        ))}
      </ul>
    </>
  );
}

// ── Provider + overlay ──────────────────────────────────────────────────────

export function PhotoViewerProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { resolveFile } = useMediaFolder();
  const [request, setRequest] = useState<{ items: PhotoItem[]; index: number; focusEdit: boolean } | null>(null);

  const openItems = useCallback((items: PhotoItem[], startIndex = 0, focusEdit = false) => {
    if (items.length === 0) return;
    setRequest({ items, index: Math.max(0, Math.min(startIndex, items.length - 1)), focusEdit });
  }, []);

  const openPerson = useCallback(
    async (raw: GedNode, records: GedNode[], startIndex = 0, refCtx?: PhotoRefContext, focusEdit = false) => {
      const refs = collectPhotoRefs(raw, records);
      if (refs.length === 0) return;
      const resolved = await Promise.all(refs.map((r) => resolveFile(r.file)));
      const items: PhotoItem[] = [];
      for (let i = 0; i < refs.length; i++) {
        const url = resolved[i];
        if (!url) continue;
        const ref = refs[i];
        const { xref } = ref;
        const onEditMedia = refCtx?.onEditMedia;
        items.push({
          url,
          title: ref.title || basename(ref.file),
          // When editable, the form replaces the static rows; otherwise show them.
          meta: onEditMedia ? undefined : mediaMetaRows(ref, t),
          edit: onEditMedia
            ? {
                file: ref.file,
                initial: {
                  title: ref.title ?? "",
                  date: ref.date ?? "",
                  place: ref.place ?? "",
                  description: ref.description ?? "",
                },
                onSave: (fields) => onEditMedia(ref.objeIndex, fields),
              }
            : undefined,
          details:
            refCtx && xref
              ? (close) => (
                  <MediaReferencedBy
                    dataset={refCtx.dataset}
                    mediaXref={xref}
                    onNavigate={(id) => { close(); refCtx.onNavigate(id); }}
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
    <PhotoViewerContext.Provider value={{ openItems, openPerson }}>
      {children}
      {request && (
        <PhotoViewerOverlay
          items={request.items}
          startIndex={request.index}
          focusEdit={request.focusEdit}
          onClose={() => setRequest(null)}
        />
      )}
    </PhotoViewerContext.Provider>
  );
}

/** Editable info-panel form for a photo's descriptive fields. Seeded from
 *  `seed` (the latest saved values, falling back to the photo's initial ones);
 *  remounted per photo by the overlay so each starts from its own values.
 *  Like the Edit-mode fields, each field auto-commits on blur (a no-op commit
 *  when nothing changed is filtered out by the edit/undo layer). */
function PhotoInfoEditor({
  edit,
  seed,
  onSaved,
  autoFocus,
  t,
}: {
  edit: PhotoEdit;
  seed: PhotoEditFields;
  onSaved: (fields: PhotoEditFields) => void;
  autoFocus: boolean;
  t: (key: string) => string;
}) {
  const [fields, setFields] = useState<PhotoEditFields>(seed);
  const set = (key: keyof PhotoEditFields) => (value: string) => setFields((f) => ({ ...f, [key]: value }));
  const commit = () => { onSaved(fields); edit.onSave(fields); };
  const blurOnEnter = (e: ReactKeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.currentTarget.blur(); };
  return (
    <div className="media-lightbox-edit">
      <div className="media-lightbox-file" title={edit.file}>{basename(edit.file)}</div>
      <label className="media-edit-field">
        <span>{t("photo.field.title")}</span>
        <input className="edit-input" autoFocus={autoFocus} value={fields.title} onChange={(e) => set("title")(e.target.value)} onBlur={commit} onKeyDown={blurOnEnter} />
      </label>
      <label className="media-edit-field">
        <span>{t("photo.field.date")}</span>
        <input className="edit-input" value={fields.date} onChange={(e) => set("date")(e.target.value)} onBlur={commit} onKeyDown={blurOnEnter} />
      </label>
      <label className="media-edit-field">
        <span>{t("photo.field.place")}</span>
        <input className="edit-input" value={fields.place} onChange={(e) => set("place")(e.target.value)} onBlur={commit} onKeyDown={blurOnEnter} />
      </label>
      <label className="media-edit-field">
        <span>{t("photo.field.description")}</span>
        <textarea className="edit-input" rows={3} value={fields.description} onChange={(e) => set("description")(e.target.value)} onBlur={commit} />
      </label>
    </div>
  );
}

function PhotoViewerOverlay({
  items,
  startIndex,
  focusEdit,
  onClose,
}: {
  items: PhotoItem[];
  startIndex: number;
  focusEdit: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(startIndex);
  // Saved field values per photo, so navigating away and back shows the latest
  // edits rather than the values captured when the viewer opened.
  const [edits, setEdits] = useState<Record<number, PhotoEditFields>>({});
  const multiple = items.length > 1;
  const current = items[Math.min(index, items.length - 1)];
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
      className={`person-photo-overlay ${multiple ? "has-tray" : ""}`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("photo.enlarged")}
    >
      <button className="person-photo-close" onClick={onClose} aria-label={t("help.close")}>
        ✕
      </button>
      {multiple && (
        <button
          className="person-photo-nav person-photo-prev"
          onClick={(e) => { e.stopPropagation(); setIndex((index - 1 + items.length) % items.length); }}
          aria-label={t("photo.prev")}
        >
          ‹
        </button>
      )}
      <div className="media-lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="person-photo-stage">
          <img src={current.url} className="person-photo-full" alt={current.title ?? ""} />
        </div>
        {hasInfo && (
          <div className="media-lightbox-info">
            {current.edit ? (
              <PhotoInfoEditor
                key={index}
                edit={current.edit}
                seed={edits[index] ?? current.edit.initial}
                onSaved={(f) => setEdits((p) => ({ ...p, [index]: f }))}
                autoFocus={allowFocus}
                t={t}
              />
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
            {current.details?.(onClose)}
          </div>
        )}
      </div>
      {multiple && (
        <button
          className="person-photo-nav person-photo-next"
          onClick={(e) => { e.stopPropagation(); setIndex((index + 1) % items.length); }}
          aria-label={t("photo.next")}
        >
          ›
        </button>
      )}
      {multiple && (
        <div className="person-photo-tray" onClick={(e) => e.stopPropagation()}>
          {items.map((it, i) => (
            <button
              key={i}
              className={`person-photo-tray-thumb ${i === index ? "active" : ""}`}
              onClick={() => setIndex(i)}
              aria-current={i === index}
            >
              <img src={it.url} alt="" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
