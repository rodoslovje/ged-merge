import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { GedNode } from "../gedcom/types";
import { cropOf, isPointer, looksLikeUrl, objeNodesFor, type CropRegion } from "../gedcom/source";
import { useMediaFolder } from "./MediaFolderContext";
import { useTranslation } from "react-i18next";
import { useMediaViewer, type MediaItem, type MediaRefContext } from "./MediaViewer";
import { collectMediaRefs, type MediaAddress, type MediaRef } from "../gedcom/media";
import { mediaKindOf } from "./mediaPath";

/** Edit-mode controls for a record's media tray. When supplied, the tray always
 *  renders (even with no photos), each thumb gains a delete affordance and can
 *  be dragged to reorder, and a trailing "+" placeholder adds a photo. */
export interface MediaEditControls {
  /** Add a new photo (open the picker / prompt for a media folder). */
  onAdd: () => void;
  /** Delete the media at this address (record- or event-level `OBJE`). */
  onDelete: (addr: MediaAddress) => void;
  /** Move a record-level photo from one `OBJE` child index to another.
   *  Event-level media keep their event's position and aren't reorderable. */
  onReorder: (fromObjeIndex: number, toObjeIndex: number) => void;
}

interface Props {
  raw: GedNode;
  records: GedNode[];
  /** When set, the viewer's info panel lists the records citing each shared
   *  photo and links into Edit (see {@link MediaRefContext}). */
  refCtx?: MediaRefContext;
  /** When set, the tray is editable (add / delete / reorder); see {@link MediaEditControls}. */
  editable?: MediaEditControls;
}

/** The first local *image* from a person's OBJE links (with the link's crop
 *  region, when marked), or null — the profile-photo pick for cards and chart
 *  nodes, which render in `<img>` (so a PDF, previewable only in the viewer,
 *  is skipped here). */
export function collectFirstImage(raw: GedNode, records: GedNode[]): { file: string; crop?: CropRegion } | null {
  const objeNodes = objeNodesFor(records);
  for (const child of raw.children) {
    if (child.tag !== "OBJE") continue;
    const val = child.value?.trim();
    const objeNode = val && isPointer(val) ? objeNodes.get(val) : child;
    const file = objeNode?.children.find((c) => c.tag === "FILE")?.value?.trim();
    // The crop lives on the link node (`child`), not the shared record.
    if (file && !looksLikeUrl(file) && mediaKindOf(file) === "image") return { file, crop: cropOf(child) };
  }
  return null;
}

/** Returns the first local image path from a person's OBJE links, or null. */
export function collectFirstFilePath(raw: GedNode, records: GedNode[]): string | null {
  return collectFirstImage(raw, records)?.file ?? null;
}

/** An `<img>` cover-fitted so that just `crop` (in source-image pixels) fills a
 *  `size`×`size` box — the person's marked region of a group photo becomes
 *  their thumbnail. Falls back to a plain cover fit until the natural image
 *  size is known; offsets are clamped so the box never shows past the edges. */
export function CroppedImg({
  url,
  crop,
  size,
  className,
  style,
}: {
  url: string;
  crop: CropRegion;
  size: number;
  /** Class for the wrapper box (reuse the thumb class the plain `<img>` had). */
  className?: string;
  style?: CSSProperties;
}) {
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  let imgStyle: CSSProperties;
  if (nat) {
    const scale = Math.max(size / crop.width, size / crop.height);
    const clampOffset = (centered: number, min: number) => Math.min(0, Math.max(min, centered));
    const left = clampOffset(size / 2 - (crop.left + crop.width / 2) * scale, size - nat.w * scale);
    const top = clampOffset(size / 2 - (crop.top + crop.height / 2) * scale, size - nat.h * scale);
    imgStyle = { position: "absolute", left, top, width: nat.w * scale, height: nat.h * scale, maxWidth: "none" };
  } else {
    imgStyle = { width: size, height: size, objectFit: "cover" };
  }
  return (
    <span
      className={className}
      style={{ position: "relative", display: "block", overflow: "hidden", width: size, height: size, ...style }}
    >
      <img
        src={url}
        alt=""
        style={imgStyle}
        onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      />
    </span>
  );
}

/** Thumbnail strip for a person — each opens the shared full viewer at its
 *  index. With `editable` set it also renders delete/reorder controls and a
 *  trailing "+" to add another photo. Renders nothing when the person has no
 *  photos; the empty-state "add photo" affordance is a chip in EditView's
 *  actions row instead. */
export function PersonMedia({ raw, records, refCtx, editable }: Props) {
  const { folderName, resolveFile } = useMediaFolder();
  const { openPerson } = useMediaViewer();
  const { t } = useTranslation();
  // Resolved photos keep their full media ref so edit ops re-find the right
  // node even when some refs don't resolve (file missing from the folder).
  const [items, setItems] = useState<{ url: string; ref: MediaRef }[]>([]);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  const refs = useMemo(() => collectMediaRefs(raw, records), [raw, records]);

  useEffect(() => {
    if (!folderName || refs.length === 0) {
      setItems([]);
      return;
    }
    let cancelled = false;
    Promise.all(refs.map((r) => resolveFile(r.file))).then((results) => {
      if (cancelled) return;
      setItems(
        refs
          .map((r, i) => ({ url: results[i], ref: r }))
          .filter((x): x is { url: string; ref: MediaRef } => x.url !== null),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [folderName, refs, resolveFile]);

  // With no photos to show, the tray renders nothing — even when editable: the
  // "add media" affordance for an empty record lives as a chip in the actions
  // row (see EditView), so the tray only appears once there are photos.
  if (items.length === 0) return null;

  // Reordering only makes sense among the record's own OBJE children; media
  // that lives under an event stays with its event.
  const reorderable = (i: number) => !!editable && !items[i].ref.eventTag;
  const drop = (toTrayIndex: number) => {
    if (!editable || dragFrom === null || dragFrom === toTrayIndex || !reorderable(toTrayIndex)) return;
    editable.onReorder(items[dragFrom].ref.objeIndex, items[toTrayIndex].ref.objeIndex);
    setDragFrom(null);
  };

  return (
    <div className="person-media">
      {items.map((item, i) => {
        const { ref } = item;
        const eventLabel = ref.eventTag ? t(`event.${ref.eventTag}`, { defaultValue: ref.eventTag }) : undefined;
        return (
        <span
          key={`${ref.eventTag ?? ""}.${ref.eventIndex ?? 0}.${ref.objeIndex}`}
          className="person-media-item"
          draggable={reorderable(i)}
          onDragStart={reorderable(i) ? () => setDragFrom(i) : undefined}
          onDragOver={reorderable(i) ? (e) => e.preventDefault() : undefined}
          onDrop={reorderable(i) ? () => drop(i) : undefined}
          onDragEnd={reorderable(i) ? () => setDragFrom(null) : undefined}
        >
          <button
            type="button"
            className="person-media-btn"
            title={eventLabel ? `${t("media.enlarge")} · ${eventLabel}` : t("media.enlarge")}
            onClick={() => openPerson(raw, records, i, refCtx)}
          >
            {mediaKindOf(ref.file) === "pdf" ? (
              <span className="person-media-thumb person-media-doc" aria-hidden="true">📄</span>
            ) : ref.crop ? (
              <CroppedImg url={item.url} crop={ref.crop} size={64} className="person-media-thumb" />
            ) : (
              <img src={item.url} className="person-media-thumb" alt="" />
            )}
            {ref.crop && (
              <span className="person-media-crop-badge" title={t("media.cropRegion")} aria-hidden="true">
                ⛶
              </span>
            )}
          </button>
          {editable && (
            <button
              type="button"
              className="person-media-delete"
              title={t("media.delete")}
              onClick={() => editable.onDelete(ref)}
            >
              ✕
            </button>
          )}
        </span>
        );
      })}
      {editable && (
        <button
          type="button"
          className="person-media-add"
          title={t("media.add")}
          onClick={editable.onAdd}
        >
          +
        </button>
      )}
    </div>
  );
}

/** Small profile photo for PersonCard — shows the first local photo (the
 *  person's marked region when the link carries a crop); opens the shared
 *  viewer (with the person's full photo set) on click. */
export function CardPhoto({ raw, records, refCtx }: { raw: GedNode; records: GedNode[]; refCtx?: MediaRefContext }) {
  const { folderName, resolveFile } = useMediaFolder();
  const { openPerson } = useMediaViewer();
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const first = useMemo(() => collectFirstImage(raw, records), [raw, records]);

  useEffect(() => {
    if (!folderName || !first) { setUrl(null); return; }
    let cancelled = false;
    resolveFile(first.file).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [folderName, first, resolveFile]);

  if (!url) return null;
  // A span (not a button): CardPhoto renders inside the PersonCard <button>,
  // and nesting interactive elements is invalid. stopPropagation keeps a photo
  // click from also selecting the card.
  const open = () => openPerson(raw, records, 0, refCtx);
  return (
    <span
      role="button"
      tabIndex={0}
      className="card-photo-btn"
      title={t("media.enlarge")}
      onClick={(e) => { e.stopPropagation(); open(); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); open(); }
      }}
    >
      {first?.crop ? (
        <CroppedImg url={url} crop={first.crop} size={46} className="card-photo" />
      ) : (
        <img src={url} className="card-photo" alt="" />
      )}
    </span>
  );
}

/** Photo thumbnail for a tree node — each node manages its own async resolution.
 *  Rendered via <foreignObject> + <img> (not SVG <image>) so it reuses the same
 *  reliable HTML image path as the rest of the app. Clicking opens the shared
 *  viewer with that record's full photo set. */
export function TreeNodePhoto({
  node,
  mainRecords,
  compareRecords,
  mainRefCtx,
  compareRefCtx,
  x,
  y,
  size,
}: {
  node: { main?: { raw: GedNode }; incoming?: { raw: GedNode } };
  mainRecords: GedNode[];
  compareRecords?: GedNode[];
  /** Referenced-by/navigation context for a main-side photo (see {@link MediaRefContext}). */
  mainRefCtx?: MediaRefContext;
  /** Referenced-by/navigation context for a compare-side photo. */
  compareRefCtx?: MediaRefContext;
  x: number;
  y: number;
  size: number;
}) {
  const { folderName, resolveFile } = useMediaFolder();
  const { openPerson } = useMediaViewer();
  const [url, setUrl] = useState<string | null>(null);

  const source = useMemo(() => {
    if (node.main?.raw) {
      const first = collectFirstImage(node.main.raw, mainRecords);
      if (first) return { ...first, raw: node.main.raw, records: mainRecords, refCtx: mainRefCtx };
    }
    if (node.incoming?.raw && compareRecords) {
      const first = collectFirstImage(node.incoming.raw, compareRecords);
      if (first) return { ...first, raw: node.incoming.raw, records: compareRecords, refCtx: compareRefCtx };
    }
    return null;
  }, [node, mainRecords, compareRecords, mainRefCtx, compareRefCtx]);

  useEffect(() => {
    if (!folderName || !source) { setUrl(null); return; }
    let cancelled = false;
    resolveFile(source.file).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [folderName, source, resolveFile]);

  if (!url || !source) return null;
  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    openPerson(source.raw, source.records, 0, source.refCtx);
  };
  return (
    <foreignObject x={x} y={y} width={size} height={size}>
      {source.crop ? (
        <span style={{ display: "block", cursor: "zoom-in" }} onClick={open}>
          <CroppedImg url={url} crop={source.crop} size={size} style={{ borderRadius: 5 }} />
        </span>
      ) : (
        <img
          src={url}
          alt=""
          style={{ width: size, height: size, objectFit: "cover", borderRadius: 5, display: "block", cursor: "zoom-in" }}
          onClick={open}
        />
      )}
    </foreignObject>
  );
}

/** One photo in a Sources-tree gallery: its local file plus the caption and
 *  info-panel details shown when it's the active image in the viewer. */
export interface MediaGalleryItem {
  file: string;
  title?: string;
  meta?: MediaItem["meta"];
  details?: MediaItem["details"];
}

/** Inline media marker used in the Sources tree: renders the resolved local
 *  thumbnail in place of the `icon`, falling back to the icon when the file
 *  can't be resolved. Clicking opens the shared viewer; when a `gallery` of the
 *  sibling photos at the same level is given, the viewer shows the full tray and
 *  prev/next navigation, starting on this photo (`index`). */
export function MediaThumb({
  file,
  icon,
  caption,
  meta,
  details,
  gallery,
  index = 0,
}: {
  file: string;
  icon: string;
  /** Caption headline shown beside the enlarged image. */
  caption?: string;
  /** Descriptive caption rows for the info panel (single-photo open only). */
  meta?: MediaItem["meta"];
  /** Record metadata + referencing-records list for the info panel.
   *  Receives a `close` callback so links can dismiss the viewer on navigate. */
  details?: MediaItem["details"];
  /** Sibling photos at the same tree level, for a navigable tray. When given,
   *  clicking opens the whole gallery (resolving each file on demand) starting
   *  at `index`, instead of just this one photo. */
  gallery?: MediaGalleryItem[];
  /** This photo's position within `gallery`. */
  index?: number;
}) {
  const { folderName, resolveFile } = useMediaFolder();
  const { openItems } = useMediaViewer();
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!folderName || !file) { setUrl(null); return; }
    let cancelled = false;
    resolveFile(file).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [folderName, file, resolveFile]);

  // Open the full sibling tray (resolving every file) when a gallery is given —
  // even a one-photo gallery, so its caption/details still show — else just this
  // one already-resolved photo. Unresolvable siblings are dropped, and the start
  // index is shifted to keep this photo active.
  const open = async () => {
    if (gallery && gallery.length > 0) {
      const resolved = await Promise.all(gallery.map((g) => resolveFile(g.file)));
      const items: MediaItem[] = [];
      let start = 0;
      for (let i = 0; i < gallery.length; i++) {
        const u = resolved[i];
        if (!u) continue;
        if (i === index) start = items.length;
        items.push({
          url: u,
          kind: mediaKindOf(gallery[i].file) === "pdf" ? "pdf" : "image",
          title: gallery[i].title,
          meta: gallery[i].meta,
          details: gallery[i].details,
        });
      }
      openItems(items, start);
    } else if (url) {
      openItems([{ url, kind: mediaKindOf(file) === "pdf" ? "pdf" : "image", title: caption, meta, details }]);
    }
  };

  if (!url) return <>{icon}</>;
  return (
    <button
      type="button"
      className="tools-media-thumb-btn"
      title={t("media.enlarge")}
      onClick={(e) => { e.stopPropagation(); open(); }}
    >
      {mediaKindOf(file) === "pdf" ? (
        <span className="tools-media-thumb tools-media-doc" aria-hidden="true">📄</span>
      ) : (
        <img src={url} className="tools-media-thumb" alt="" />
      )}
    </button>
  );
}
