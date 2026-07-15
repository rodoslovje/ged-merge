import { useState } from "react";
import type { SourceCitation } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import type { RecordPatch } from "../historyTypes";
import { SourceRefs } from "../SourceRef";
import { linkHref } from "../FieldValue";
import { siteIconForUrl } from "../../tools/sourceReshape";
import { linkKey } from "../../normalize/links";
import type { SourceDialogTarget } from "./types";

/** A list of single-line link inputs, each removable. When `sectionLabel` is
 * provided it renders its own header row with the label and an add button. */
export function LinksEditor({
  links: initialLinks,
  sources,
  incomingLinks,
  incomingSources,
  sectionLabel,
  t,
  onCommit,
  onAddSource,
  onEditSource,
  onOpenSourceDialog,
  onAttachSource,
}: {
  links: string[];
  /** Real `SOUR` citations added via "Add Source" — shown as icons alongside the legacy links. */
  sources?: SourceCitation[];
  /** Links a confirmed merge will add that aren't in `links` yet — previewed
   * read-only with an incoming-themed background until the merge is saved. */
  incomingLinks?: string[];
  /** `SOUR` citations a confirmed merge will add — previewed read-only with an
   * incoming-themed background until the merge is saved. */
  incomingSources?: SourceCitation[];
  sectionLabel?: string;
  t: Translate;
  onCommit: (links: string[]) => void;
  onAddSource: () => void;
  onEditSource: (index: number) => void;
  onOpenSourceDialog: (target: SourceDialogTarget) => void;
  /** Attaches an already-resolved `SOUR` citation and replaces the link list
   * in one commit — used when a legacy link is promoted to a real citation. */
  onAttachSource: (sourceXref: string, page: string | undefined, extraPatches: RecordPatch[], links: string[]) => void;
}) {
  const [links, setLinks] = useState(initialLinks);
  const existingKeys = new Set(links.map(linkKey));
  const previewLinks = (incomingLinks ?? []).filter((url) => !existingKeys.has(linkKey(url)));

  function commitLinks(next: string[]) {
    setLinks(next);
    onCommit(next.map((l) => l.trim()).filter(Boolean));
  }

  /** Links have been merged into Sources in the UI: clicking a legacy link's
   * icon opens the same Edit Source dialog, prefilled with just its URL. */
  function openEditLink(index: number) {
    onOpenSourceDialog({
      kind: "edit-link",
      url: links[index],
      commitRename: (url) => commitLinks(links.map((l, i) => (i === index ? url : l))),
      commitRemove: () => commitLinks(links.filter((_, i) => i !== index)),
      commitPromote: (sourceXref, page, extraPatches) => {
        const remaining = links.filter((_, i) => i !== index);
        setLinks(remaining);
        onAttachSource(sourceXref, page, extraPatches, remaining);
      },
    });
  }

  // Citation icons (real SOUR + legacy 🔗 links + incoming-merge previews) all
  // sit together so the whole sources block reads as a single row.
  const icons = (
    <>
      {((sources?.length ?? 0) > 0 || (incomingSources?.length ?? 0) > 0) && (
        <SourceRefs t={t} mainSources={sources} incomingSources={incomingSources} onEdit={onEditSource} />
      )}
      {links.map((link, i) => (
        <button
          key={i}
          type="button"
          className="link-icon edit-link-icon"
          title={link}
          onClick={() => openEditLink(i)}
        >
          {siteIconForUrl(link) ?? "🔗"}
        </button>
      ))}
      {previewLinks.map((url, i) => (
        <a
          key={`merge-${i}`}
          href={linkHref(url)}
          target="_blank"
          rel="noopener noreferrer"
          className="link-icon link-new"
          title={url}
        >
          {siteIconForUrl(url) ?? "🔗"}
        </a>
      ))}
    </>
  );

  return (
    <div className="edit-links">
      {sectionLabel ? (
        <div className="edit-record-label-row">
          <span className="edit-record-label">{sectionLabel}</span>
          {icons}
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("edit.addLinkTooltip")}
            onClick={onAddSource}
          >
            + {t("edit.addLink")}
          </button>
        </div>
      ) : (
        icons
      )}
    </div>
  );
}
