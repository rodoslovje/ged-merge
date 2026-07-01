import type { Family, SourceCitation } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { setFamilyEventField, changeFamilyEventTag } from "../../gedcom/edit";
import { firstChild } from "../../gedcom/node";
import { EventFieldsRow } from "./EventFieldsRow";
import { familyTagChoices } from "./editConstants";
import type { FamilyCommit, OpenEditSource, SourceDialogTarget } from "./types";

/** Any family event row (MARR, DIV, ENGA, SEPA, …) by tag. */
export function FamilyEventRow({
  fam, tag, t, commit, openEditSource, onOpenSourceDialog, onRemove, onRetag, autoFocusDate,
  placeSuggestions, placeToAddrs, placeCanonical, addrCanonical,
  mergeHighlight, mergeIncomingSources, famMergeKeyBase, resolvedSessionFields,
}: {
  fam: Family; tag: string; t: Translate; commit: FamilyCommit;
  openEditSource: OpenEditSource;
  onOpenSourceDialog: (target: SourceDialogTarget) => void;
  onRemove?: () => void;
  /** Called (with the new tag) right after a type-change commit, so the
   * caller can flag the now-occupied slot as session-dirty — see
   * `resolvedSessionFields`. */
  onRetag?: (newTag: string) => void;
  autoFocusDate?: boolean;
  placeSuggestions: string[];
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
  mergeHighlight?: Map<string, string>;
  mergeIncomingSources?: Map<string, SourceCitation[]>;
  /** `fam.<id>` key base resolved against the incoming pairing (see
   * `familyMergeKeyBases`); falls back to this family's own id when there's
   * no active merge preview, which is harmless since `mergeHighlight` would
   * then be empty anyway. */
  famMergeKeyBase?: string;
  resolvedSessionFields?: Set<string>;
}) {
  const ev = fam.events.find((e) => e.tag === tag);
  const label = t(`event.${tag}`);
  const eventNode = firstChild(fam.raw, tag);
  const tagChoices = familyTagChoices(fam, tag);

  return (
    <EventFieldsRow
      ev={ev}
      label={label}
      tag={tag}
      t={t}
      commitField={(update, extraPatches) => commit(fam, (f) => setFamilyEventField(f, tag, update), extraPatches)}
      onRemove={onRemove}
      onChangeTag={tagChoices.length > 1 ? (newTag) => {
        commit(fam, (f) => changeFamilyEventTag(f, tag, newTag));
        onRetag?.(newTag);
      } : undefined}
      tagGroups={tagChoices.length > 1 ? [{ tags: tagChoices }] : undefined}
      onAddSource={() => onOpenSourceDialog({ kind: "event", commitField: (update, extraPatches) => commit(fam, (f) => setFamilyEventField(f, tag, update), extraPatches) })}
      onEditSource={eventNode ? (idx) => openEditSource(eventNode, idx, { kind: "family", fam }) : undefined}
      onOpenSourceDialog={onOpenSourceDialog}
      autoFocusDate={autoFocusDate}
      placeSuggestions={placeSuggestions}
      placeToAddrs={placeToAddrs}
      placeCanonical={placeCanonical}
      addrCanonical={addrCanonical}
      mergeHighlight={mergeHighlight}
      mergeIncomingSources={mergeIncomingSources}
      mergeKeyBase={`${famMergeKeyBase ?? `fam.${fam.id}`}.${tag}`}
      resolvedSessionFields={resolvedSessionFields}
    />
  );
}
