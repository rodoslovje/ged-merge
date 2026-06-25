import { useEffect, useMemo, useState } from "react";
import type { GedNode } from "../gedcom/types";
import { isPointer } from "../gedcom/source";
import { useMediaFolder } from "./MediaFolderContext";
import { useTranslation } from "react-i18next";

interface Props {
  raw: GedNode;
  records: GedNode[];
}

function looksLikeUrl(v: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(v);
}

/** Returns the first local file path from a person's OBJE links, or null. */
export function collectFirstFilePath(raw: GedNode, records: GedNode[]): string | null {
  for (const child of raw.children) {
    if (child.tag !== "OBJE") continue;
    const val = child.value?.trim();
    let file: string | undefined;
    if (val && isPointer(val)) {
      const objeRec = records.find((r) => r.xref === val && r.tag === "OBJE");
      file = objeRec?.children.find((c) => c.tag === "FILE")?.value?.trim();
    } else {
      file = child.children.find((c) => c.tag === "FILE")?.value?.trim();
    }
    if (file && !looksLikeUrl(file)) return file;
  }
  return null;
}

function collectFilePaths(raw: GedNode, records: GedNode[]): string[] {
  const paths: string[] = [];
  for (const child of raw.children) {
    if (child.tag !== "OBJE") continue;
    const val = child.value?.trim();
    let file: string | undefined;
    if (val && isPointer(val)) {
      const objeRec = records.find((r) => r.xref === val && r.tag === "OBJE");
      if (objeRec) {
        const fc = objeRec.children.find((c) => c.tag === "FILE");
        file = fc?.value?.trim();
      }
    } else {
      const fc = child.children.find((c) => c.tag === "FILE");
      file = fc?.value?.trim();
    }
    if (file && !looksLikeUrl(file)) paths.push(file);
  }
  return paths;
}

export function PersonPhotos({ raw, records }: Props) {
  const { folderName, resolveFile } = useMediaFolder();
  const { t } = useTranslation();
  const [urls, setUrls] = useState<string[]>([]);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const filePaths = useMemo(() => collectFilePaths(raw, records), [raw, records]);

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
          onClick={() => setLightbox(url)}
        >
          <img src={url} className="person-photo-thumb" alt="" />
        </button>
      ))}
      {lightbox && (
        <div
          className="person-photo-overlay"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-modal="true"
          aria-label={t("photo.enlarged")}
        >
          <img
            src={lightbox}
            className="person-photo-full"
            alt=""
            onClick={(e) => e.stopPropagation()}
          />
          <button
            className="person-photo-close"
            onClick={() => setLightbox(null)}
            aria-label={t("help.close")}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

/** Small profile photo for PersonCard — resolves and shows the first local photo. */
export function CardPhoto({ raw, records }: { raw: GedNode; records: GedNode[] }) {
  const { folderName, resolveFile } = useMediaFolder();
  const [url, setUrl] = useState<string | null>(null);
  const firstPath = useMemo(() => collectFirstFilePath(raw, records), [raw, records]);

  useEffect(() => {
    if (!folderName || !firstPath) { setUrl(null); return; }
    let cancelled = false;
    resolveFile(firstPath).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [folderName, firstPath, resolveFile]);

  if (!url) return null;
  return <img src={url} className="card-photo" alt="" />;
}

/** Photo thumbnail for a tree node — each node manages its own async resolution.
 *  Rendered via <foreignObject> + <img> (not SVG <image>) so it reuses the same
 *  reliable HTML image path as the rest of the app. */
export function TreeNodePhoto({
  node,
  masterRecords,
  compareRecords,
  x,
  y,
  size,
}: {
  node: { master?: { raw: GedNode }; incoming?: { raw: GedNode } };
  masterRecords: GedNode[];
  compareRecords?: GedNode[];
  x: number;
  y: number;
  size: number;
}) {
  const { folderName, resolveFile } = useMediaFolder();
  const [url, setUrl] = useState<string | null>(null);

  const firstPath = useMemo(() => {
    if (node.master?.raw) {
      const p = collectFirstFilePath(node.master.raw, masterRecords);
      if (p) return p;
    }
    if (node.incoming?.raw && compareRecords) {
      return collectFirstFilePath(node.incoming.raw, compareRecords);
    }
    return null;
  }, [node, masterRecords, compareRecords]);

  useEffect(() => {
    if (!folderName || !firstPath) { setUrl(null); return; }
    let cancelled = false;
    resolveFile(firstPath).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [folderName, firstPath, resolveFile]);

  if (!url) return null;
  return (
    <foreignObject x={x} y={y} width={size} height={size}>
      <img
        src={url}
        alt=""
        style={{ width: size, height: size, objectFit: "cover", borderRadius: 5, display: "block" }}
      />
    </foreignObject>
  );
}

/** Inline thumbnail used in the Sources tree — async-resolves a single local file. */
export function MediaThumb({ file }: { file: string }) {
  const { folderName, resolveFile } = useMediaFolder();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!folderName || !file) { setUrl(null); return; }
    let cancelled = false;
    resolveFile(file).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [folderName, file, resolveFile]);

  if (!url) return null;
  return <img src={url} className="tools-media-thumb" alt="" />;
}
