import { useEffect, useRef, useState } from "react";
import type { Dataset, GedNode } from "../gedcom/types";
import { objeInfoOf } from "../gedcom/source";
import { useMediaFolder } from "./MediaFolderContext";
import { basename, MEDIA_ACCEPT, mediaKindOf, sameMediaFile } from "./mediaPath";
import type { Translate } from "../locales/i18n";

/** A photo chosen in the picker: its folder-relative path plus, when the file
 *  is already backed by a shared top-level `OBJE`, that record's xref (so
 *  shared-mode adds reuse it instead of creating a duplicate). */
export interface PickedMedia {
  path: string;
  existingXref?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (photos: PickedMedia[]) => void;
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

/** Index local `OBJE` files (top-level and inline) by basename, keeping every
 *  reference (with its stored path) rather than one winner per name — two
 *  different photos named `scan1.jpg` in different subfolders must each find
 *  their own record, never each other's. Also keeps the OBJE's title +
 *  description so the picker filter can search them. */
function referencedByBasename(records: GedNode[]): Map<string, Array<{ xref?: string; meta: string; file: string }>> {
  const map = new Map<string, Array<{ xref?: string; meta: string; file: string }>>();
  const visit = (node: GedNode) => {
    if (node.tag === "OBJE") {
      const info = objeInfoOf(node);
      if (info.file && !info.url) {
        const key = basename(info.file).toLowerCase();
        const meta = [info.title, info.description].filter(Boolean).join(" ");
        const list = map.get(key) ?? map.set(key, []).get(key)!;
        // Top-level (xref'd) records first, so shared-mode reuse targets them.
        if (node.xref) list.unshift({ xref: node.xref, meta, file: info.file });
        else list.push({ meta, file: info.file });
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
export function AddMediaDialog({ isOpen, onClose, onAdd, dataset, t }: Props) {
  const { folderName, canReferenceFiles, openFolder, listMediaFiles, resolveFile, canImportFiles, importFile } = useMediaFolder();
  const [loading, setLoading] = useState(false);
  const [images, setImages] = useState<FolderImage[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  // Bumped by Refresh to re-walk the folder (handle mode picks up files copied
  // in while the dialog is open).
  const [reloadKey, setReloadKey] = useState(0);
  // Hidden file input backing "Import from disk…" (Chrome/Edge only).
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [importError, setImportError] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setSelected(new Set());
    setQuery("");
    setImportError(false);
    setLoading(true);
    let cancelled = false;
    (async () => {
      // Recompute the referenced-files index on every open: dataset.records is
      // mutated in place (stable reference), so a photo added to another person
      // this session must still re-classify here as "Already in your file".
      const referenced = referencedByBasename(dataset.records);
      const paths = await listMediaFiles();
      const urls = await Promise.all(paths.map((p) => resolveFile(p)));
      if (cancelled) return;
      const items: FolderImage[] = [];
      for (let i = 0; i < paths.length; i++) {
        const url = urls[i];
        if (!url) continue;
        // Of the records sharing this basename, only one whose stored path
        // names this very file counts — never a same-named file elsewhere.
        const ref = (referenced.get(basename(paths[i]).toLowerCase()) ?? []).find((r) => sameMediaFile(r.file, paths[i]));
        const meta = ref?.meta || undefined;
        const searchText = [paths[i], meta].filter(Boolean).join(" ").toLowerCase();
        items.push({ path: paths[i], url, existing: ref !== undefined, existingXref: ref?.xref, meta, searchText });
      }
      items.sort((a, b) => a.path.localeCompare(b.path));
      setImages(items);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [isOpen, listMediaFiles, resolveFile, dataset.records, reloadKey]);

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
    const picked: PickedMedia[] = [...selected]
      .map((path) => byPath.get(path))
      .filter((im): im is FolderImage => !!im)
      .map((im) => ({ path: im.path, existingXref: im.existingXref }));
    if (picked.length) onAdd(picked);
    onClose();
  };

  // Handle mode re-walks the folder live; filemap mode (Firefox/Brave) has only
  // a static snapshot, so a real rescan means re-picking the folder — which
  // rebuilds the file list and re-runs the load effect (listMediaFiles changes).
  const handleRefresh = () => {
    if (canReferenceFiles) setReloadKey((k) => k + 1);
    else void openFolder();
  };

  /** Copy files chosen from anywhere on disk into the media folder, then add
   *  them straight to the record. Failures keep the dialog open with a hint. */
  const handleImport = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const picked: PickedMedia[] = [];
    let failed = false;
    for (const file of Array.from(files)) {
      const rel = await importFile(file);
      if (rel) picked.push({ path: rel });
      else failed = true;
    }
    if (picked.length) onAdd(picked);
    if (failed) setImportError(true);
    else onClose();
  };

  const q = query.trim().toLowerCase();
  const matches = (im: FolderImage) => !q || im.searchText.includes(q);
  const newImages = images.filter((im) => !im.existing && matches(im));
  const existingImages = images.filter((im) => im.existing && matches(im));

  const grid = (items: FolderImage[]) => (
    <div className="add-media-grid">
      {items.map((im) => (
        <button
          key={im.path}
          type="button"
          className={`add-media-cell ${selected.has(im.path) ? "selected" : ""}`}
          title={im.meta ? `${im.path}\n${im.meta}` : im.path}
          onClick={() => toggle(im.path)}
        >
          {mediaKindOf(im.path) === "pdf" ? (
            <span className="add-media-thumb add-media-doc" aria-hidden="true">📄</span>
          ) : (
            <img src={im.url} alt="" className="add-media-thumb" />
          )}
          <span className="add-media-name">{basename(im.path)}</span>
        </button>
      ))}
    </div>
  );

  // One section ("New"/"Existing"), its photos grouped by subfolder: the
  // folder's own files first (no heading), then each subfolder under a heading.
  const section = (label: string, items: FolderImage[]) => (
    <>
      <div className="add-media-section">{label}</div>
      {groupBySubfolder(items).map(({ folder, items: groupItems }) => (
        <div key={folder || "(root)"}>
          {folder && <div className="add-media-subfolder">{folder}</div>}
          {grid(groupItems)}
        </div>
      ))}
    </>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal add-media-dialog" role="dialog" aria-modal="true" aria-label={t("addMedia.title")} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t("addMedia.title")}</h2>
          <div className="name-search-wrap add-media-search">
            <input
              type="text"
              className="name-search"
              placeholder={t("addMedia.search")}
              title={t("addMedia.searchTooltip")}
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
        <div className="modal-body add-media-body">
          {loading ? (
            <div className="add-media-empty">{t("addMedia.loading")}</div>
          ) : (
            <>
              {/* With no filter, the "New" section always shows — explaining how
                  to add images when there are none. Under a filter it's hidden
                  when empty, and a "no matches" hint covers an empty result. */}
              {newImages.length > 0 ? (
                section(t("addMedia.new"), newImages)
              ) : !q ? (
                <>
                  <div className="add-media-section">{t("addMedia.new")}</div>
                  <div className="add-source-hint">{t("addMedia.newHint", { folder: folderName ?? "" })}</div>
                </>
              ) : null}
              {existingImages.length > 0 && section(t("addMedia.existing"), existingImages)}
              {q && newImages.length === 0 && existingImages.length === 0 && (
                <div className="add-media-empty">{t("addMedia.noMatches")}</div>
              )}
            </>
          )}
        </div>
        <div className="add-media-footer">
          {canImportFiles && (
            <>
              <input
                ref={importInputRef}
                type="file"
                accept={MEDIA_ACCEPT}
                multiple
                style={{ display: "none" }}
                onChange={(e) => { void handleImport(e.target.files); e.target.value = ""; }}
              />
              <button
                className="tree-open-btn add-media-import"
                title={t("addMedia.importTooltip")}
                onClick={() => importInputRef.current?.click()}
              >
                {t("addMedia.import")}
              </button>
            </>
          )}
          {importError && <span className="add-media-import-error">{t("media.importFailed")}</span>}
          <button className="tree-open-btn add-media-refresh" onClick={handleRefresh}>
            {t("addMedia.refresh")}
          </button>
          <button className="tree-open-btn" onClick={onClose}>{t("addMedia.cancel")}</button>
          <button className="tree-open-btn" disabled={selected.size === 0} onClick={handleAdd}>
            {t("addMedia.add", { count: selected.size })}
          </button>
        </div>
      </div>
    </div>
  );
}
