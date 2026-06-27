import { useEffect, useState } from "react";
import type { Dataset, GedNode } from "../gedcom/types";
import { objeInfoOf } from "../gedcom/source";
import { useMediaFolder } from "./MediaFolderContext";
import { basename } from "./mediaPath";
import type { Translate } from "../locales/i18n";

/** A photo chosen in the picker: its folder-relative path plus, when the file
 *  is already backed by a shared top-level `OBJE`, that record's xref (so
 *  shared-mode adds reuse it instead of creating a duplicate). */
export interface PickedPhoto {
  path: string;
  existingXref?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (photos: PickedPhoto[]) => void;
  dataset: Dataset;
  t: Translate;
}

interface FolderImage {
  path: string;
  url: string;
  /** True when this file is already referenced by an `OBJE` somewhere. */
  existing: boolean;
  /** Top-level shared `OBJE` xref backing the file, if any. */
  existingXref?: string;
  /** The existing OBJE's title/description (original case), shown in the tooltip. */
  meta?: string;
  /** Lowercased text the filter matches against: the path plus, for existing
   *  photos, the OBJE's title/description. */
  searchText: string;
}

/** Index local `OBJE` files (top-level and inline) by basename, so a folder
 *  image can be classified as already-referenced and, when a shared record
 *  backs it, linked to that record's xref. Also keeps the OBJE's title +
 *  description so the picker filter can search them. */
function referencedByBasename(records: GedNode[]): Map<string, { xref?: string; meta: string }> {
  const map = new Map<string, { xref?: string; meta: string }>();
  const visit = (node: GedNode) => {
    if (node.tag === "OBJE") {
      const info = objeInfoOf(node);
      if (info.file && !info.url) {
        const key = basename(info.file).toLowerCase();
        const meta = [info.title, info.description].filter(Boolean).join(" ");
        const prev = map.get(key);
        // Prefer a top-level (xref'd) record so shared-mode reuse can target it.
        if (!prev || (!prev.xref && node.xref)) map.set(key, { xref: node.xref, meta });
      }
    }
    for (const child of node.children) visit(child);
  };
  records.forEach(visit);
  return map;
}

/** Group images by their containing subfolder: the folder's own files (path
 *  with no `/`) come first under the empty key, then each subfolder
 *  alphabetically. Items within a group keep their incoming (basename) order. */
function groupBySubfolder(items: FolderImage[]): { folder: string; items: FolderImage[] }[] {
  const map = new Map<string, FolderImage[]>();
  for (const im of items) {
    const segs = im.path.replace(/\\/g, "/").split("/");
    const folder = segs.slice(0, -1).join("/");
    (map.get(folder) ?? map.set(folder, []).get(folder)!).push(im);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([folder, items]) => ({ folder, items }));
}

/** Picker that lists the chosen media folder's images, split into ones not yet
 *  in the file ("New") and ones already referenced ("Existing"), and adds the
 *  selected photos to the current person. Works in both handle and filemap
 *  modes — it only references files by relative path, never writes. */
export function AddPhotoDialog({ isOpen, onClose, onAdd, dataset, t }: Props) {
  const { folderName, canReferenceFiles, openFolder, listImages, resolveFile } = useMediaFolder();
  const [loading, setLoading] = useState(false);
  const [images, setImages] = useState<FolderImage[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  // Bumped by Refresh to re-walk the folder (handle mode picks up files copied
  // in while the dialog is open).
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!isOpen) return;
    setSelected(new Set());
    setQuery("");
    setLoading(true);
    let cancelled = false;
    (async () => {
      // Recompute the referenced-files index on every open: dataset.records is
      // mutated in place (stable reference), so a photo added to another person
      // this session must still re-classify here as "Already in your file".
      const referenced = referencedByBasename(dataset.records);
      const paths = await listImages();
      const urls = await Promise.all(paths.map((p) => resolveFile(p)));
      if (cancelled) return;
      const items: FolderImage[] = [];
      for (let i = 0; i < paths.length; i++) {
        const url = urls[i];
        if (!url) continue;
        const ref = referenced.get(basename(paths[i]).toLowerCase());
        const meta = ref?.meta || undefined;
        const searchText = [paths[i], meta].filter(Boolean).join(" ").toLowerCase();
        items.push({ path: paths[i], url, existing: ref !== undefined, existingXref: ref?.xref, meta, searchText });
      }
      items.sort((a, b) => a.path.localeCompare(b.path));
      setImages(items);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [isOpen, listImages, resolveFile, dataset.records, reloadKey]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const handleAdd = () => {
    const byPath = new Map(images.map((im) => [im.path, im] as const));
    const picked: PickedPhoto[] = [...selected]
      .map((path) => byPath.get(path))
      .filter((im): im is FolderImage => !!im)
      .map((im) => ({ path: im.path, existingXref: im.existingXref }));
    if (picked.length) onAdd(picked);
    onClose();
  };

  // Handle mode re-walks the folder live; filemap mode (Firefox/Brave) has only
  // a static snapshot, so a real rescan means re-picking the folder — which
  // rebuilds the file list and re-runs the load effect (listImages changes).
  const handleRefresh = () => {
    if (canReferenceFiles) setReloadKey((k) => k + 1);
    else void openFolder();
  };

  const q = query.trim().toLowerCase();
  const matches = (im: FolderImage) => !q || im.searchText.includes(q);
  const newImages = images.filter((im) => !im.existing && matches(im));
  const existingImages = images.filter((im) => im.existing && matches(im));

  const grid = (items: FolderImage[]) => (
    <div className="add-photo-grid">
      {items.map((im) => (
        <button
          key={im.path}
          type="button"
          className={`add-photo-cell ${selected.has(im.path) ? "selected" : ""}`}
          title={im.meta ? `${im.path}\n${im.meta}` : im.path}
          onClick={() => toggle(im.path)}
        >
          <img src={im.url} alt="" className="add-photo-thumb" />
          <span className="add-photo-name">{basename(im.path)}</span>
        </button>
      ))}
    </div>
  );

  // One section ("New"/"Existing"), its photos grouped by subfolder: the
  // folder's own files first (no heading), then each subfolder under a heading.
  const section = (label: string, items: FolderImage[]) => (
    <>
      <div className="add-photo-section">{label}</div>
      {groupBySubfolder(items).map(({ folder, items: groupItems }) => (
        <div key={folder || "(root)"}>
          {folder && <div className="add-photo-subfolder">{folder}</div>}
          {grid(groupItems)}
        </div>
      ))}
    </>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal add-photo-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t("addPhoto.title")}</h2>
          <div className="name-search-wrap add-photo-search">
            <input
              type="text"
              className="name-search"
              placeholder={t("addPhoto.search")}
              title={t("addPhoto.searchTooltip")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                className="name-search-clear"
                onClick={() => setQuery("")}
                tabIndex={-1}
                aria-label={t("filter.clearSearch")}
              >
                ✕
              </button>
            )}
          </div>
          <button className="modal-close" onClick={onClose} title={t("help.close")}>×</button>
        </div>
        <div className="modal-body add-photo-body">
          {loading ? (
            <div className="add-photo-empty">{t("addPhoto.loading")}</div>
          ) : (
            <>
              {/* With no filter, the "New" section always shows — explaining how
                  to add images when there are none. Under a filter it's hidden
                  when empty, and a "no matches" hint covers an empty result. */}
              {newImages.length > 0 ? (
                section(t("addPhoto.new"), newImages)
              ) : !q ? (
                <>
                  <div className="add-photo-section">{t("addPhoto.new")}</div>
                  <div className="add-source-hint">{t("addPhoto.newHint", { folder: folderName ?? "" })}</div>
                </>
              ) : null}
              {existingImages.length > 0 && section(t("addPhoto.existing"), existingImages)}
              {q && newImages.length === 0 && existingImages.length === 0 && (
                <div className="add-photo-empty">{t("addPhoto.noMatches")}</div>
              )}
            </>
          )}
        </div>
        <div className="add-photo-footer">
          <button className="tree-open-btn add-photo-refresh" onClick={handleRefresh}>
            {t("addPhoto.refresh")}
          </button>
          <button className="tree-open-btn" onClick={onClose}>{t("addPhoto.cancel")}</button>
          <button className="tree-open-btn" disabled={selected.size === 0} onClick={handleAdd}>
            {t("addPhoto.add", { count: selected.size })}
          </button>
        </div>
      </div>
    </div>
  );
}
