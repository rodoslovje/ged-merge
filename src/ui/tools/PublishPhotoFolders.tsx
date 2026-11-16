import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { PHOTO_USES, photoFolderCounts, type PhotoUse } from "../../publish/photos";
import { SelectMenu } from "../DropdownMenu";

interface FolderRow {
  path: string;
  name: string;
  depth: number;
  /** Photos in it and every folder under it. */
  count: number;
  children: FolderRow[];
}

/** The media folder's folders as a tree, each with the photos under it. */
function folderTree(counts: Map<string, number>): FolderRow[] {
  const rows = new Map<string, FolderRow>();
  const roots: FolderRow[] = [];
  const rowOf = (path: string): FolderRow => {
    let row = rows.get(path);
    if (row) return row;
    const at = path.lastIndexOf("/");
    row = { path, name: at < 0 ? path : path.slice(at + 1), depth: path ? path.split("/").length - 1 : 0, count: 0, children: [] };
    rows.set(path, row);
    if (at < 0) roots.push(row);
    else rowOf(path.slice(0, at)).children.push(row);
    return row;
  };
  for (const [folder, n] of counts) {
    rowOf(folder);
    // Each folder above it counts its photos too.
    for (let p = folder; ; ) {
      rows.get(p)!.count += n;
      const at = p.lastIndexOf("/");
      if (at < 0) break;
      p = p.slice(0, at);
    }
  }
  const sort = (list: FolderRow[]) => {
    list.sort((a, b) => (a.path === "" ? -1 : b.path === "" ? 1 : a.name.localeCompare(b.name)));
    for (const r of list) sort(r.children);
  };
  sort(roots);
  return roots;
}

/**
 * Where each folder's photos go on the family website: left out, the person
 * pages, or those and the front page's strip. A folder's choice holds for the
 * folders under it unless one has its own; the folders open with ▸.
 */
export function PublishPhotoFolders({ dataset, value, onChange }: {
  dataset: Dataset;
  value: Record<string, PhotoUse>;
  onChange: (value: Record<string, PhotoUse>) => void;
}) {
  const { t } = useTranslation();
  const tree = useMemo(() => folderTree(photoFolderCounts(dataset)), [dataset]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  if (!tree.length) return null;

  const labelOf = (use: PhotoUse) => t(`tools.publish.photoUse.${use}`);
  const set = (path: string, use: PhotoUse | "") => {
    const next = { ...value };
    if (use) next[path] = use;
    else delete next[path];
    onChange(next);
  };
  const toggle = (path: string) => {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setOpen(next);
  };

  const rows: React.ReactNode[] = [];
  const walk = (list: FolderRow[], inherited: PhotoUse) => {
    for (const row of list) {
      const own = value[row.path];
      const shown = own ?? inherited;
      const expanded = open.has(row.path);
      rows.push(
        <div key={row.path} className="tools-publish-folder" style={{ paddingLeft: `${row.depth * 18}px` }}>
          {row.children.length ? (
            <button
              type="button"
              className="tools-publish-folder-toggle"
              aria-expanded={expanded}
              aria-label={t(expanded ? "tools.publish.photoFolders.hide" : "tools.publish.photoFolders.show")}
              onClick={() => toggle(row.path)}
            >
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="tools-publish-folder-toggle" aria-hidden="true" />
          )}
          <span className="tools-publish-folder-name" title={row.path || undefined}>
            {row.path ? row.name : t("tools.publish.photoFolders.root")}
          </span>
          <span className="tools-publish-folder-count">{row.count}</span>
          {/* A top-level folder's default is the strip too; one below follows
              its folder above. */}
          <SelectMenu
            className="tools-publish-folder-use"
            value={!row.depth && own === "tray" ? "" : own ?? ""}
            ariaLabel={row.path || t("tools.publish.photoFolders.root")}
            onChange={(v) => set(row.path, v as PhotoUse | "")}
            options={[
              { value: "", label: row.depth ? t("tools.publish.photoUse.inherit", { use: labelOf(inherited) }) : labelOf("tray") },
              ...PHOTO_USES.filter((u) => row.depth || u !== "tray").map((u) => ({ value: u, label: labelOf(u) })),
            ]}
          />
        </div>,
      );
      if (expanded) walk(row.children, shown);
    }
  };
  walk(tree, "tray");

  return (
    <div className="tools-publish-folders">
      <p className="tools-fix-hint">{t("tools.publish.photoFolders.hint")}</p>
      <div className="tools-publish-folder-list">{rows}</div>
    </div>
  );
}
