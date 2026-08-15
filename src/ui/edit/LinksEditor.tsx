import { useState } from "react";
import type { SourceCitation } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import type { RecordPatch } from "../historyTypes";
import { SourceRefs } from "../SourceRef";
import { linkHref, linkTooltip } from "../FieldValue";
import { siteIconForUrl } from "../../tools/sourceReshape";
import { linkKey } from "../../normalize/links";
import type { SourceDialogTarget } from "./types";

/** The harvested (read-only) remainder of a record's or event's links:
 * everything the projection gathered that no editable link tag carries — URLs
 * living in note text or shared media records. Rewriting those as WWW lines
 * would duplicate them, and "removing" one would be a no-op (the chip
 * reappears on the next rebuild), so the editors must never offer that. */
export function harvestedLinksOf(all: string[] | undefined, editable: string[] | undefined): string[] {
  return (all ?? []).filter((l) => !(editable ?? []).some((e) => e.toLowerCase() === l.toLowerCase()));
}

/**
 * The link-chip editing plumbing shared by the record-level editor below and
 * the event rows (EventFieldsRow): committing a changed list, and opening a
 * chip in the Edit Source dialog with its rename/remove/promote continuations.
 * One implementation on purpose — the editable-vs-harvested split was fixed
 * here once already, and a second copy is where such fixes get lost.
 */
export function linkEditing(
  links: string[],
  setLinks: (next: string[]) => void,
  commit: (next: string[]) => void,
  promote: (sourceXref: string, page: string | undefined, extraPatches: RecordPatch[], remaining: string[]) => void,
  onOpenSourceDialog: (target: SourceDialogTarget) => void,
) {
  const commitLinks = (next: string[]) => {
    setLinks(next);
    commit(next.map((l) => l.trim()).filter(Boolean));
  };
  /** Links have been merged into Sources in the UI: clicking a legacy link's
   * icon opens the same Edit Source dialog, prefilled with just its URL. */
  const openEditLink = (index: number) =>
    onOpenSourceDialog({
      kind: "edit-link",
      url: links[index],
      commitRename: (url) => commitLinks(links.map((l, i) => (i === index ? url : l))),
      commitRemove: () => commitLinks(links.filter((_, i) => i !== index)),
      commitPromote: (sourceXref, page, extraPatches) => {
        const remaining = links.filter((_, i) => i !== index);
        setLinks(remaining);
        promote(sourceXref, page, extraPatches, remaining);
      },
    });
  return { commitLinks, openEditLink };
}

/** A list of single-line link inputs, each removable. When `sectionLabel` is
 * provided it renders its own header row with the label and an add button. */
export function LinksEditor({
  links: initialLinks,
  harvestedLinks,
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
  /** Read-only links from note text / shared media (see {@link harvestedLinksOf}). */
  harvestedLinks?: string[];
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

  const { openEditLink } = linkEditing(links, setLinks, onCommit, onAttachSource, onOpenSourceDialog);

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
          title={linkTooltip(link, t)}
          onClick={() => openEditLink(i)}
        >
          {siteIconForUrl(link) ?? "🔗"}
        </button>
      ))}
      {(harvestedLinks ?? []).map((url) => (
        <a
          key={`harvested-${url}`}
          href={linkHref(url)}
          target="_blank"
          rel="noopener noreferrer"
          className="link-icon"
          title={linkTooltip(url, t, `${url}\n${t("edit.harvestedLink")}`)}
        >
          {siteIconForUrl(url) ?? "🔗"}
        </a>
      ))}
      {previewLinks.map((url, i) => (
        <a
          key={`merge-${i}`}
          href={linkHref(url)}
          target="_blank"
          rel="noopener noreferrer"
          className="link-icon link-new"
          title={linkTooltip(url, t)}
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
