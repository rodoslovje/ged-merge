import { memo } from "react";
import type { Dataset, Family, Sex, SourceCitation } from "../../gedcom/types";
import { isSameSexCouple } from "../../gedcom/couple";
import type { Translate } from "../../locales/i18n";
import type { MatchDecisionStatus } from "../../review/types";
import { firstChild } from "../../gedcom/node";
import { collectMediaRefs } from "../../gedcom/media";
import { coupleAgesDisplay } from "../../gedcom/age";
import { kinshipInfo, kinshipTooltip as kinshipTooltipText, lineageClass } from "../../match/kinship";
import {
  addFamilyEventNode,
  attachSourceCitation,
  FAM_CHILD_ORDER,
  removeFamilyEvent,
  reorderMedia,
  setFamilyLinks,
  setFamilyNotes,
} from "../../gedcom/edit";
import { MARRIAGE_SYMBOL } from "../../chart/nodeDisplay";
import { useNameOf, useSettings } from "../SettingsContext";
import { PersonCard } from "../PersonCard";
import { PersonMedia } from "../PersonMedia";
import type { MediaRefContext } from "../MediaViewer";
import type { MediaAddress } from "../../gedcom/media";
import { RelativePickerCard } from "./RelativePickerCard";
import { AddEventSelect } from "./AddEventSelect";
import { PrivateToggle } from "./PrivateToggle";
import { detectPrivacyStyle, setPrivateFlag } from "../../gedcom/private";
import { FamilyEventRow } from "./FamilyEventRow";
import { NotesEditor } from "./NotesEditor";
import { LinksEditor } from "./LinksEditor";
import { nodeId } from "./nodeId";
import { FAMILY_HIDDEN_EVENT_TAGS, familyEventHasMergeData } from "./editConstants";
import type { FamilyCommit, MediaOwner, OpenEditSource, SourceDialogTarget } from "./types";

/**
 * The two relative bands of the Edit view — a parents group (top) and a
 * spouse-family panel (bottom) — extracted into `React.memo` components so a
 * keystroke-commit on the person's own fields (which bumps EditView's `tick`)
 * no longer re-renders every family grid, kinship badge, and media tray.
 *
 * The memo works off object identity: `rebuildIndividual`/`rebuildFamily`
 * replace exactly the edited record's typed object, so an untouched `fam` (and
 * the relatives' `Individual`s inside) keeps its reference across ticks. All
 * function props are identity-stable (`useStableHandler` in EditView).
 * `relationsGen` covers what identity can't: a structural edit elsewhere in
 * the graph that changes these cards' kinship path to the start person.
 */

type RelativeKind = "father" | "mother" | "partner" | "child";
export type PickingSlot = { kind: RelativeKind; fam: Family | undefined } | null;

/** Kinship badge props for a relative card (mirrors the person header's). */
function kinshipChips(
  dataset: Dataset,
  showKinship: boolean,
  startId: string | undefined,
  startPersonName: string | undefined,
  t: Translate,
  id: string | undefined,
): { kinship?: string; kinshipTooltip?: string; kinshipLineage?: string } {
  if (!showKinship || !startId || !id) return {};
  const info = kinshipInfo(dataset, startId, id, t);
  if (!info) return {};
  return {
    kinship: info.label,
    kinshipLineage: lineageClass(info.lineage),
    kinshipTooltip: startPersonName ? kinshipTooltipText(info, startPersonName, t) : undefined,
  };
}

/** Status chips for a relative card: its merge decision (C/D/R) and/or an "M"
 *  chip when its main record has unsaved edits — mirroring the tree nodes. */
function decisionChips(
  decisionStatusById: Map<string, Exclude<MatchDecisionStatus, "undecided">>,
  changedPersonIds: Set<string>,
  t: Translate,
  id: string | undefined,
): { decisionStatus?: Exclude<MatchDecisionStatus, "undecided">; decisionLetter?: string; decisionTooltip?: string; modified?: boolean; modifiedLetter?: string; modifiedTooltip?: string } {
  const modified = !!id && changedPersonIds.has(id);
  const modifiedProps = modified ? { modified, modifiedLetter: t("edit.tree.modified").charAt(0), modifiedTooltip: t("edit.tree.modified") } : {};
  const status = id ? decisionStatusById.get(id) : undefined;
  if (!status) return modifiedProps;
  const tooltip = t(`status.${status}`);
  return { decisionStatus: status, decisionLetter: tooltip.charAt(0), decisionTooltip: tooltip, ...modifiedProps };
}

/** Props shared by both sections: identity-stable handlers + chip data. */
interface SharedSectionProps {
  personId: string;
  dataset: Dataset;
  t: Translate;
  navigate: (id: string) => void;
  pickingSlot: PickingSlot;
  setPickingSlot: (slot: PickingSlot) => void;
  connectRelative: (kind: RelativeKind, existingId: string, fam?: Family) => void;
  addRelative: (kind: RelativeKind, fam?: Family, sexOverride?: Sex) => void;
  handleDetachSpouseRole: (fam: Family, role: "HUSB" | "WIFE", confirmMsg: string) => void;
  cardRefCtx: MediaRefContext;
  decisionStatusById: Map<string, Exclude<MatchDecisionStatus, "undecided">>;
  changedPersonIds: Set<string>;
  startId?: string;
  startPersonName?: string;
  /** Bumped on structural edits so kinship badges recompute even when this
   *  section's own family object didn't change. Unused directly — it exists
   *  for the memo's prop comparison. */
  relationsGen: number;
  undoVersion: number;
  /** Bumped when a shared NOTE record changes via another owner's edit, so
   *  this section's note chips remount and re-read the shared text. */
  noteGen?: number;
}

// ── Parents band ─────────────────────────────────────────────────────────────

interface ParentFamilyGroupProps extends SharedSectionProps {
  /** The parent family — undefined renders the empty add-parents slots. */
  fam: Family | undefined;
}

export const ParentFamilyGroup = memo(function ParentFamilyGroup({
  fam,
  personId,
  dataset,
  t,
  navigate,
  pickingSlot,
  setPickingSlot,
  connectRelative,
  addRelative,
  handleDetachSpouseRole,
  cardRefCtx,
  decisionStatusById,
  changedPersonIds,
  startId,
  startPersonName,
}: ParentFamilyGroupProps) {
  const { settings } = useSettings();
  const formatName = useNameOf();
  const personName = (id: string | undefined): string => {
    if (!id) return "";
    const indi = dataset.individuals.get(id);
    return indi ? formatName(indi) : id;
  };
  const cardKinship = (id: string | undefined) => kinshipChips(dataset, settings.showKinship, startId, startPersonName, t, id);
  const cardDecision = (id: string | undefined) => decisionChips(decisionStatusById, changedPersonIds, t, id);

  const fatherName = personName(fam?.husband);
  const motherName = personName(fam?.wife);
  // Same-sex couples have no "Father"/"Mother" split — label both slots
  // neutrally as "Parent". Opposite-sex (or unknown) keeps the familiar terms.
  const sameSexParents = isSameSexCouple(
    fam?.husband ? dataset.individuals.get(fam.husband) : undefined,
    fam?.wife ? dataset.individuals.get(fam.wife) : undefined,
  );
  const fatherLabel = sameSexParents ? t("field.parent") : t("field.father");
  const motherLabel = sameSexParents ? t("field.parent") : t("field.mother");
  const fatherPickerOpen = pickingSlot?.kind === "father" && pickingSlot.fam === fam;
  const motherPickerOpen = pickingSlot?.kind === "mother" && pickingSlot.fam === fam;
  // Read-only glimpse of the parents' couple events (marriage, divorce, …),
  // shown on the connector between the two cards — editable on either
  // parent's own page.
  const coupleEvents = fam?.events.filter(
    (ev) => (ev.tag === "MARR" || FAMILY_HIDDEN_EVENT_TAGS.includes(ev.tag)) && (ev.date || ev.place),
  ) ?? [];

  return (
    <div className="edit-parent-group">
      {fatherPickerOpen && !fam?.husband ? (
        <RelativePickerCard
          roleLabel={fatherLabel}
          individuals={dataset.individuals}
          excludeId={personId}
          onPickExisting={(id) => connectRelative("father", id, fam)}
          onAddNew={(sex) => { setPickingSlot(null); addRelative("father", fam, sex); }}
          onCancel={() => setPickingSlot(null)}
          t={t}
        />
      ) : (
        <PersonCard
          individual={fam?.husband ? dataset.individuals.get(fam.husband) : undefined}
          roleLabel={fatherLabel}
          placeholder={t("edit.addFather")}
          onSelect={navigate}
          onAdd={() => setPickingSlot({ kind: "father", fam })}
          onRemove={fam?.husband ? () => handleDetachSpouseRole(fam, "HUSB", t("edit.detachRoleConfirm", { name: fatherName, role: fatherLabel })) : undefined}
          removeTooltip={fam?.husband ? t("edit.detachRoleTooltip", { name: fatherName, role: fatherLabel }) : undefined}
          {...cardKinship(fam?.husband)}
          {...cardDecision(fam?.husband)}
          records={dataset.records}
          refCtx={cardRefCtx}
        />
      )}
      <div className={`edit-connector-h ${coupleEvents.length ? "has-events" : ""}`}>
        {coupleEvents.length > 0 && (
          <div className="edit-parent-fam-events">
            {coupleEvents.map((ev, j) => {
              const place = ev.place ? ev.place.parts[0] || ev.place.raw : undefined;
              const coupleAges = settings.showAge && ev.date && fam
                ? coupleAgesDisplay(
                    fam.husband ? dataset.individuals.get(fam.husband) : undefined,
                    fam.wife ? dataset.individuals.get(fam.wife) : undefined,
                    ev.date,
                    sameSexParents
                      ? { husband: t("event.age.partner"), wife: t("event.age.partner") }
                      : { husband: t("event.age.husband"), wife: t("event.age.wife") },
                    t,
                  )
                : undefined;
              return (
                <span
                  className="edit-parent-fam-event"
                  key={`${ev.tag}-${j}`}
                  title={`${t(`event.${ev.tag}`)}: ${[ev.date?.raw, ev.place?.raw].filter(Boolean).join(", ")}`}
                >
                  <span>
                    {ev.tag === "MARR" ? MARRIAGE_SYMBOL : t(`event.${ev.tag}`)}
                    {ev.date && <> <span className="gm-data">{ev.date.raw}</span></>}
                    {coupleAges && (
                      <> <span className="gm-data edit-event-age">
                        {coupleAges.map((a, j2) => (
                          <span key={j2} title={a.title}>{a.text}</span>
                        ))}
                      </span></>
                    )}
                  </span>
                  {place && <span className="gm-data">{place}</span>}
                </span>
              );
            })}
          </div>
        )}
      </div>
      {motherPickerOpen && !fam?.wife ? (
        <RelativePickerCard
          roleLabel={motherLabel}
          individuals={dataset.individuals}
          excludeId={personId}
          onPickExisting={(id) => connectRelative("mother", id, fam)}
          onAddNew={(sex) => { setPickingSlot(null); addRelative("mother", fam, sex); }}
          onCancel={() => setPickingSlot(null)}
          t={t}
        />
      ) : (
        <PersonCard
          individual={fam?.wife ? dataset.individuals.get(fam.wife) : undefined}
          roleLabel={motherLabel}
          placeholder={t("edit.addMother")}
          onSelect={navigate}
          onAdd={() => setPickingSlot({ kind: "mother", fam })}
          onRemove={fam?.wife ? () => handleDetachSpouseRole(fam, "WIFE", t("edit.detachRoleConfirm", { name: motherName, role: motherLabel })) : undefined}
          removeTooltip={fam?.wife ? t("edit.detachRoleTooltip", { name: motherName, role: motherLabel }) : undefined}
          {...cardKinship(fam?.wife)}
          {...cardDecision(fam?.wife)}
          records={dataset.records}
          refCtx={cardRefCtx}
        />
      )}
    </div>
  );
});

// ── Spouse-family band ───────────────────────────────────────────────────────

interface FamilySectionProps extends SharedSectionProps {
  /** The spouse family — undefined renders the empty add-partner/child slots. */
  fam: Family | undefined;
  commitFamily: FamilyCommit;
  openEditSource: OpenEditSource;
  onOpenSourceDialog: (target: SourceDialogTarget | null) => void;
  handleDetachChild: (fam: Family, childId: string, confirmMsg: string) => void;
  onAddFamNote: (famId: string) => void;
  handleAddMedia: (owner: MediaOwner) => void;
  handleDeleteMedia: (owner: MediaOwner, addr: MediaAddress) => void;
  mediaCtxFor: (owner: MediaOwner) => MediaRefContext;
  markFamilyTagRetagged: (keyBase: string, newTag: string) => void;
  dismissExtraEvent: (keyBase: string) => void;
  famMergeKeyBase: string | undefined;
  mergeHighlight: Map<string, string>;
  mergeIncomingSources: Map<string, SourceCitation[]>;
  resolvedSessionFields: Set<string>;
  placeSuggestions: string[];
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
  pendingFocusFamEventKey: string | null;
  setPendingFocusFamEventKey: (key: string | null) => void;
  famNoteAddCount: number | undefined;
  mergeGen: number;
  /** Bumped when a shared top-level SOUR/OBJE record changes via another
   *  owner's edit — folded into the media tray's key so it re-reads metadata. */
  mediaGen: number;
}

export const FamilySection = memo(function FamilySection({
  fam,
  personId,
  dataset,
  t,
  navigate,
  pickingSlot,
  setPickingSlot,
  connectRelative,
  addRelative,
  handleDetachSpouseRole,
  handleDetachChild,
  cardRefCtx,
  decisionStatusById,
  changedPersonIds,
  startId,
  startPersonName,
  undoVersion,
  noteGen,
  commitFamily,
  openEditSource,
  onOpenSourceDialog,
  onAddFamNote,
  handleAddMedia,
  handleDeleteMedia,
  mediaCtxFor,
  markFamilyTagRetagged,
  dismissExtraEvent,
  famMergeKeyBase,
  mergeHighlight,
  mergeIncomingSources,
  resolvedSessionFields,
  placeSuggestions,
  placeToAddrs,
  placeCanonical,
  addrCanonical,
  pendingFocusFamEventKey,
  setPendingFocusFamEventKey,
  famNoteAddCount,
  mergeGen,
  mediaGen,
}: FamilySectionProps) {
  const { settings } = useSettings();
  const formatName = useNameOf();
  const personName = (id: string | undefined): string => {
    if (!id) return "";
    const indi = dataset.individuals.get(id);
    return indi ? formatName(indi) : id;
  };
  const cardKinship = (id: string | undefined) => kinshipChips(dataset, settings.showKinship, startId, startPersonName, t, id);
  const cardDecision = (id: string | undefined) => decisionChips(decisionStatusById, changedPersonIds, t, id);

  const partnerId = fam && (fam.husband === personId ? fam.wife : fam.husband);
  const partnerRole = fam && (fam.husband === personId ? "WIFE" : "HUSB");
  const partnerName = personName(partnerId ?? undefined);
  const shownFamilyTags = FAMILY_HIDDEN_EVENT_TAGS.filter(
    (tag) => fam?.events.some((e) => e.tag === tag) || familyEventHasMergeData(famMergeKeyBase, tag, mergeHighlight, mergeIncomingSources),
  );
  const emptyFamilyTags = FAMILY_HIDDEN_EVENT_TAGS.filter(
    (tag) => !shownFamilyTags.includes(tag),
  );
  const partnerPickerOpen = pickingSlot?.kind === "partner" && pickingSlot.fam === fam;
  const childPickerOpen = pickingSlot?.kind === "child" && pickingSlot.fam === fam;

  return (
    <div className="edit-family">
      <div className="edit-family-header">
        <div className="person-card-role">{t("field.partners")}</div>
        <div className="edit-family-card-row">
          {partnerPickerOpen && !partnerId ? (
            <RelativePickerCard
              individuals={dataset.individuals}
              excludeId={personId}
              onPickExisting={(id) => connectRelative("partner", id, fam)}
              onAddNew={() => { setPickingSlot(null); addRelative("partner", fam); }}
              onCancel={() => setPickingSlot(null)}
              t={t}
            />
          ) : (
            <PersonCard
              individual={partnerId ? dataset.individuals.get(partnerId) : undefined}
              placeholder={t("edit.addPartner")}
              onSelect={navigate}
              onAdd={() => setPickingSlot({ kind: "partner", fam })}
              onRemove={fam && partnerId && partnerRole ? () => handleDetachSpouseRole(fam, partnerRole, t("edit.detachPartnerConfirm", { name: partnerName })) : undefined}
              removeTooltip={fam && partnerId ? t("edit.detachPartnerTooltip", { name: partnerName }) : undefined}
              {...cardKinship(partnerId)}
              {...cardDecision(partnerId)}
              records={dataset.records}
              refCtx={cardRefCtx}
            />
          )}
          {fam && (
            <AddEventSelect
              tags={emptyFamilyTags}
              label={t("edit.addFamilyEvent")}
              tooltip={t("edit.addFamilyEventTooltip")}
              t={t}
              onAdd={(tag) => { commitFamily(fam, (f) => addFamilyEventNode(f, tag)); setPendingFocusFamEventKey(`${fam.id}-${tag}`); }}
            />
          )}
          {fam && (
            <PrivateToggle
              on={!!fam.private}
              t={t}
              onToggle={() => commitFamily(fam, (f) =>
                setPrivateFlag(f.raw, !f.private, settings.formatOverrides.privacy ?? detectPrivacyStyle(dataset.records), dataset.records))}
            />
          )}
          {fam && (
            <button
              type="button"
              className="edit-name-chip edit-name-chip-add"
              title={t("edit.addNoteTooltip")}
              onClick={() => onAddFamNote(fam.id)}
            >
              + {t("edit.addNote")}
            </button>
          )}
          {fam && !(fam.links ?? []).length && !(fam.sources ?? []).length && (
            <button
              type="button"
              className="edit-name-chip edit-name-chip-add"
              title={t("edit.addLink")}
              onClick={() => onOpenSourceDialog({ kind: "family", fam })}
            >
              + {t("edit.addLink")}
            </button>
          )}
          {fam && collectMediaRefs(fam.raw, dataset.records).length === 0 && (
            <button
              type="button"
              className="edit-name-chip edit-name-chip-add"
              title={t("media.add")}
              onClick={() => handleAddMedia({ kind: "family", fam })}
            >
              + {t("media.add")}
            </button>
          )}
        </div>
      </div>
      {fam && (
        <PersonMedia
          // fam.raw is mutated in place, so remount whenever this family was
          // rebuilt (fresh `Family` identity → fresh nodeId) or a shared OBJE
          // record changed via another owner's edit (mediaGen), to re-read the
          // OBJE children (resolved files are blob-cached).
          key={`fam-media-${fam.id}-${nodeId(fam)}-${mediaGen}-${undoVersion}`}
          raw={fam.raw}
          records={dataset.records}
          refCtx={mediaCtxFor({ kind: "family", fam })}
          editable={{
            onAdd: () => handleAddMedia({ kind: "family", fam }),
            onDelete: (addr) => handleDeleteMedia({ kind: "family", fam }, addr),
            onReorder: (from, to) => commitFamily(fam, (f) => reorderMedia(f.raw, from, to)),
          }}
        />
      )}
      {fam && (() => {
        const marrNode = firstChild(fam.raw, "MARR");
        return (
          <FamilyEventRow
            key={`${fam.id}-MARR-${marrNode ? nodeId(marrNode) : "empty"}-${undoVersion}-${mergeGen}`}
            fam={fam}
            tag="MARR"
            t={t}
            commit={commitFamily}
            openEditSource={openEditSource}
            onOpenSourceDialog={onOpenSourceDialog}
            onRemove={marrNode ? () => commitFamily(fam, (f) => removeFamilyEvent(f, "MARR")) : undefined}
            onRetag={(newTag) => markFamilyTagRetagged(famMergeKeyBase ?? `fam.${fam.id}`, newTag)}
            placeSuggestions={placeSuggestions}
            placeToAddrs={placeToAddrs}
            placeCanonical={placeCanonical}
            addrCanonical={addrCanonical}
            mergeHighlight={mergeHighlight}
            mergeIncomingSources={mergeIncomingSources}
            famMergeKeyBase={famMergeKeyBase}
            resolvedSessionFields={resolvedSessionFields}
            individuals={dataset.individuals}
          />
        );
      })()}
      {fam && shownFamilyTags.map((tag) => {
        const eventNode = firstChild(fam.raw, tag);
        const hasRealEvent = eventNode !== undefined;
        return (
          <FamilyEventRow
            // Re-keyed on the underlying node's identity (not just `undoVersion`)
            // so that retagging this event away (via the type-change dropdown)
            // unmounts this row instead of leaving its local field state (date,
            // place, …) stale once `ev` silently becomes undefined underneath it.
            key={`${fam.id}-${tag}-${eventNode ? nodeId(eventNode) : "empty"}-${undoVersion}-${mergeGen}`}
            fam={fam}
            tag={tag}
            t={t}
            commit={commitFamily}
            openEditSource={openEditSource}
            onOpenSourceDialog={onOpenSourceDialog}
            autoFocusDate={pendingFocusFamEventKey === `${fam.id}-${tag}`}
            onRemove={hasRealEvent ? () => commitFamily(fam, (f) => removeFamilyEvent(f, tag)) : () => dismissExtraEvent(`${famMergeKeyBase ?? `fam.${fam.id}`}.${tag}`)}
            onRetag={(newTag) => markFamilyTagRetagged(famMergeKeyBase ?? `fam.${fam.id}`, newTag)}
            placeSuggestions={placeSuggestions}
            placeToAddrs={placeToAddrs}
            placeCanonical={placeCanonical}
            addrCanonical={addrCanonical}
            mergeHighlight={mergeHighlight}
            mergeIncomingSources={mergeIncomingSources}
            famMergeKeyBase={famMergeKeyBase}
            resolvedSessionFields={resolvedSessionFields}
            individuals={dataset.individuals}
          />
        );
      })}
      <div className="edit-children-wrap">
        <div className="person-card-role">{t("field.children")}</div>
        <div className="edit-children">
          {fam?.children.map((childId) => {
            const childName = personName(childId);
            return (
              <PersonCard
                key={childId}
                individual={dataset.individuals.get(childId)}
                placeholder={t("edit.unknown")}
                onSelect={navigate}
                onRemove={() => handleDetachChild(fam, childId, t("edit.detachChildConfirm", { name: childName }))}
                removeTooltip={t("edit.detachChildTooltip", { name: childName })}
                {...cardKinship(childId)}
                {...cardDecision(childId)}
                records={dataset.records}
                refCtx={cardRefCtx}
              />
            );
          })}
          {childPickerOpen ? (
            <RelativePickerCard
              individuals={dataset.individuals}
              excludeId={personId}
              onPickExisting={(id) => connectRelative("child", id, fam)}
              onAddNew={() => { setPickingSlot(null); addRelative("child", fam); }}
              onCancel={() => setPickingSlot(null)}
              t={t}
            />
          ) : (
            <PersonCard placeholder={t("edit.addChild")} onAdd={() => setPickingSlot({ kind: "child", fam })} />
          )}
        </div>
      </div>
      {fam && ((fam.links ?? []).length > 0 || (fam.sources ?? []).length > 0) && (
        <div className="edit-record-section">
          <LinksEditor
            key={`flinks-${fam.id}-${undoVersion}`}
            links={fam.links ?? []}
            sources={fam.sources ?? []}
            sectionLabel={t("field.sources")}
            t={t}
            onCommit={(links) => commitFamily(fam, (f) => setFamilyLinks(f, links))}
            onAddSource={() => onOpenSourceDialog({ kind: "family", fam })}
            onEditSource={(idx) => openEditSource(fam.raw, idx, { kind: "family", fam })}
            onOpenSourceDialog={onOpenSourceDialog}
            onAttachSource={(sourceXref, page, extraPatches, links) =>
              commitFamily(fam, (f) => { attachSourceCitation(f.raw, sourceXref, page, FAM_CHILD_ORDER); setFamilyLinks(f, links); }, extraPatches)
            }
          />
        </div>
      )}
      {fam && (
        <div className="edit-record-section">
          <NotesEditor
            key={`fnotes-${fam.id}-${undoVersion}-${noteGen ?? 0}`}
            notes={fam.noteRefs ?? []}
            addTrigger={famNoteAddCount}
            t={t}
            onCommit={(refs) => commitFamily(fam, (f, notes) => setFamilyNotes(notes, f, refs))}
          />
        </div>
      )}
    </div>
  );
});
