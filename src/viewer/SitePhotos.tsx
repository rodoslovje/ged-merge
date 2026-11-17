import { useMemo, type ReactNode } from "react";
import { MediaFolderContext } from "../ui/MediaFolderContext";
import type { PublishedTree } from "../publish/model";
import { photoSrc } from "../publish/photos";

/**
 * The family website's photos, to the app's media components: a "media
 * folder" whose files are the ones beside the page (`photos/…` in its ZIP).
 * With it the galleries, the photo viewer with its tags and the charts'
 * portraits work on the site as they do in the app. Nothing can be picked,
 * dropped or imported — the site only shows.
 */
export function SitePhotosProvider({ tree, children }: { tree: PublishedTree; children: ReactNode }) {
  const value = useMemo(() => {
    const src = new Map((tree.photos ?? []).map((p) => [p.path, photoSrc(p)]));
    const paths = new Set(src.keys());
    return {
      // Any name: what matters is that there is a folder.
      folderName: paths.size ? "photos" : null,
      openFolder: async () => {},
      clearFolder: () => {},
      // The photo's path, with its version, is its address beside the page.
      resolveFile: async (filePath: string) => src.get(filePath) ?? null,
      canReferenceFiles: false,
      listMediaFiles: async () => [...paths],
      resolveDroppedHandle: async () => null,
      canImportFiles: false,
      importFile: async () => null,
    };
  }, [tree]);
  return <MediaFolderContext.Provider value={value}>{children}</MediaFolderContext.Provider>;
}
