import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GedNode } from "../gedcom/types";
import { isPointer, objeInfoOf, objeNodesFor } from "../gedcom/source";
import { mediaUsedBy } from "../tools/sources";
import { PersonLink } from "./PersonLink";
import { useMediaFolder } from "./MediaFolderContext";

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
}

/**
 * Lets the info panel show a shared media object's "referenced by" list (and
 * navigate to a citing record) when a person's photo is opened in Edit. Omitted
 * where no Edit navigation target exists (e.g. trees).
 */
export interface PhotoRefContext {
  dataset: Dataset;
  onNavigate: (id: string) => void;
}

interface PhotoViewerCtx {
  /** Open the viewer with already-resolved items. */
  openItems(items: PhotoItem[], startIndex?: number): void;
  /** Resolve a person/record's local photos, then open the viewer. */
  openPerson(raw: GedNode, records: GedNode[], startIndex?: number, refCtx?: PhotoRefContext): void;
}

const PhotoViewerContext = createContext<PhotoViewerCtx>({
  openItems: () => {},
  openPerson: () => {},
});

export function usePhotoViewer() {
  return useContext(PhotoViewerContext);
}

// ── Person/record photo collection ─────────────────────────────────────────

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

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
}

/** Local file, title, and descriptive content for one OBJE node, or null when
 *  it's a URL/has no file. Reuses the shared OBJE parser; keeps only nodes whose
 *  `FILE` is a local filename (a displayable photo), dropping URL-only links. */
function objePhotoRef(objeNode: GedNode): Omit<PhotoRef, "xref"> | null {
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
  for (const child of raw.children) {
    if (child.tag !== "OBJE") continue;
    const val = child.value?.trim();
    const xref = val && isPointer(val) ? val : undefined;
    const objeNode = xref ? objeNodes.get(xref) : child;
    if (!objeNode) continue;
    const ref = objePhotoRef(objeNode);
    if (ref) refs.push({ ...ref, xref });
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
  const [request, setRequest] = useState<{ items: PhotoItem[]; index: number } | null>(null);

  const openItems = useCallback((items: PhotoItem[], startIndex = 0) => {
    if (items.length === 0) return;
    setRequest({ items, index: Math.max(0, Math.min(startIndex, items.length - 1)) });
  }, []);

  const openPerson = useCallback(
    async (raw: GedNode, records: GedNode[], startIndex = 0, refCtx?: PhotoRefContext) => {
      const refs = collectPhotoRefs(raw, records);
      if (refs.length === 0) return;
      const resolved = await Promise.all(refs.map((r) => resolveFile(r.file)));
      const items: PhotoItem[] = [];
      for (let i = 0; i < refs.length; i++) {
        const url = resolved[i];
        if (!url) continue;
        const ref = refs[i];
        const { xref } = ref;
        items.push({
          url,
          title: ref.title || basename(ref.file),
          meta: mediaMetaRows(ref, t),
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
      openItems(items, startIndex);
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
          onClose={() => setRequest(null)}
        />
      )}
    </PhotoViewerContext.Provider>
  );
}

function PhotoViewerOverlay({
  items,
  startIndex,
  onClose,
}: {
  items: PhotoItem[];
  startIndex: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(startIndex);
  const multiple = items.length > 1;
  const current = items[Math.min(index, items.length - 1)];

  // Esc closes; arrows step (with wraparound) when there's more than one photo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") setIndex((i) => (i - 1 + items.length) % items.length);
      else if (e.key === "ArrowRight") setIndex((i) => (i + 1) % items.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items.length, onClose]);

  const hasInfo = current.title || (current.meta && current.meta.length > 0) || current.details;

  return (
    <div
      className="person-photo-overlay"
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
          {multiple && (
            <div className="person-photo-tray">
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
        {hasInfo && (
          <div className="media-lightbox-info">
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
    </div>
  );
}
