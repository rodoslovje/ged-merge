import { useEffect, useMemo, useState } from "react";
import type { GedNode } from "../gedcom/types";
import { isPointer, objeNodesFor } from "../gedcom/source";
import { useMediaFolder } from "./MediaFolderContext";
import { useTranslation } from "react-i18next";
import { collectPhotoRefs, usePhotoViewer, type PhotoItem, type PhotoRefContext } from "./PhotoViewer";

interface Props {
  raw: GedNode;
  records: GedNode[];
  /** When set, the viewer's info panel lists the records citing each shared
   *  photo and links into Edit (see {@link PhotoRefContext}). */
  refCtx?: PhotoRefContext;
}

function looksLikeUrl(v: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(v);
}

/** Returns the first local file path from a person's OBJE links, or null. */
export function collectFirstFilePath(raw: GedNode, records: GedNode[]): string | null {
  const objeNodes = objeNodesFor(records);
  for (const child of raw.children) {
    if (child.tag !== "OBJE") continue;
    const val = child.value?.trim();
    const objeNode = val && isPointer(val) ? objeNodes.get(val) : child;
    const file = objeNode?.children.find((c) => c.tag === "FILE")?.value?.trim();
    if (file && !looksLikeUrl(file)) return file;
  }
  return null;
}

/** Thumbnail strip for a person — each opens the shared full viewer at its index. */
export function PersonPhotos({ raw, records, refCtx }: Props) {
  const { folderName, resolveFile } = useMediaFolder();
  const { openPerson } = usePhotoViewer();
  const { t } = useTranslation();
  const [urls, setUrls] = useState<string[]>([]);

  const filePaths = useMemo(() => collectPhotoRefs(raw, records).map((r) => r.file), [raw, records]);

  useEffect(() => {
    if (!folderName || filePaths.length === 0) {
      setUrls([]);
      return;
    }
    let cancelled = false;
    Promise.all(filePaths.map((p) => resolveFile(p))).then((results) => {
      if (cancelled) return;
      setUrls(results.filter((u): u is string => u !== null));
    });
    return () => {
      cancelled = true;
    };
  }, [folderName, filePaths, resolveFile]);

  if (urls.length === 0) return null;

  return (
    <div className="person-photos">
      {urls.map((url, i) => (
        <button
          key={i}
          className="person-photo-btn"
          title={t("photo.enlarge")}
          onClick={() => openPerson(raw, records, i, refCtx)}
        >
          <img src={url} className="person-photo-thumb" alt="" />
        </button>
      ))}
    </div>
  );
}

/** Small profile photo for PersonCard — shows the first local photo; opens the
 *  shared viewer (with the person's full photo set) on click. */
export function CardPhoto({ raw, records, refCtx }: { raw: GedNode; records: GedNode[]; refCtx?: PhotoRefContext }) {
  const { folderName, resolveFile } = useMediaFolder();
  const { openPerson } = usePhotoViewer();
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const firstPath = useMemo(() => collectFirstFilePath(raw, records), [raw, records]);

  useEffect(() => {
    if (!folderName || !firstPath) { setUrl(null); return; }
    let cancelled = false;
    resolveFile(firstPath).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [folderName, firstPath, resolveFile]);

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
      title={t("photo.enlarge")}
      onClick={(e) => { e.stopPropagation(); open(); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); open(); }
      }}
    >
      <img src={url} className="card-photo" alt="" />
    </span>
  );
}

/** Photo thumbnail for a tree node — each node manages its own async resolution.
 *  Rendered via <foreignObject> + <img> (not SVG <image>) so it reuses the same
 *  reliable HTML image path as the rest of the app. Clicking opens the shared
 *  viewer with that record's full photo set. */
export function TreeNodePhoto({
  node,
  masterRecords,
  compareRecords,
  masterRefCtx,
  compareRefCtx,
  x,
  y,
  size,
}: {
  node: { master?: { raw: GedNode }; incoming?: { raw: GedNode } };
  masterRecords: GedNode[];
  compareRecords?: GedNode[];
  /** Referenced-by/navigation context for a master-side photo (see {@link PhotoRefContext}). */
  masterRefCtx?: PhotoRefContext;
  /** Referenced-by/navigation context for a compare-side photo. */
  compareRefCtx?: PhotoRefContext;
  x: number;
  y: number;
  size: number;
}) {
  const { folderName, resolveFile } = useMediaFolder();
  const { openPerson } = usePhotoViewer();
  const [url, setUrl] = useState<string | null>(null);

  const source = useMemo(() => {
    if (node.master?.raw) {
      const p = collectFirstFilePath(node.master.raw, masterRecords);
      if (p) return { path: p, raw: node.master.raw, records: masterRecords, refCtx: masterRefCtx };
    }
    if (node.incoming?.raw && compareRecords) {
      const p = collectFirstFilePath(node.incoming.raw, compareRecords);
      if (p) return { path: p, raw: node.incoming.raw, records: compareRecords, refCtx: compareRefCtx };
    }
    return null;
  }, [node, masterRecords, compareRecords, masterRefCtx, compareRefCtx]);

  useEffect(() => {
    if (!folderName || !source) { setUrl(null); return; }
    let cancelled = false;
    resolveFile(source.path).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [folderName, source, resolveFile]);

  if (!url || !source) return null;
  return (
    <foreignObject x={x} y={y} width={size} height={size}>
      <img
        src={url}
        alt=""
        style={{ width: size, height: size, objectFit: "cover", borderRadius: 5, display: "block", cursor: "zoom-in" }}
        onClick={(e) => { e.stopPropagation(); openPerson(source.raw, source.records, 0, source.refCtx); }}
      />
    </foreignObject>
  );
}

/** One photo in a Sources-tree gallery: its local file plus the caption and
 *  info-panel details shown when it's the active image in the viewer. */
export interface MediaGalleryItem {
  file: string;
  title?: string;
  details?: PhotoItem["details"];
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
  details,
  gallery,
  index = 0,
}: {
  file: string;
  icon: string;
  /** Caption headline shown beside the enlarged image. */
  caption?: string;
  /** Record metadata + referencing-records list for the info panel.
   *  Receives a `close` callback so links can dismiss the viewer on navigate. */
  details?: PhotoItem["details"];
  /** Sibling photos at the same tree level, for a navigable tray. When given,
   *  clicking opens the whole gallery (resolving each file on demand) starting
   *  at `index`, instead of just this one photo. */
  gallery?: MediaGalleryItem[];
  /** This photo's position within `gallery`. */
  index?: number;
}) {
  const { folderName, resolveFile } = useMediaFolder();
  const { openItems } = usePhotoViewer();
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!folderName || !file) { setUrl(null); return; }
    let cancelled = false;
    resolveFile(file).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [folderName, file, resolveFile]);

  // Open the full sibling tray (resolving every file) when a gallery is given,
  // else just this one already-resolved photo. Unresolvable siblings are
  // dropped, and the start index is shifted to keep this photo active.
  const open = async () => {
    if (gallery && gallery.length > 1) {
      const resolved = await Promise.all(gallery.map((g) => resolveFile(g.file)));
      const items: PhotoItem[] = [];
      let start = 0;
      for (let i = 0; i < gallery.length; i++) {
        const u = resolved[i];
        if (!u) continue;
        if (i === index) start = items.length;
        items.push({ url: u, title: gallery[i].title, details: gallery[i].details });
      }
      openItems(items, start);
    } else if (url) {
      openItems([{ url, title: caption, details }]);
    }
  };

  if (!url) return <>{icon}</>;
  return (
    <button
      type="button"
      className="tools-media-thumb-btn"
      title={t("photo.enlarge")}
      onClick={(e) => { e.stopPropagation(); open(); }}
    >
      <img src={url} className="tools-media-thumb" alt="" />
    </button>
  );
}
