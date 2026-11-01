import { useFormatOverrides, useTargetFormat } from "../TargetFormatContext";
import { Fragment, memo, type CSSProperties } from "react";
import { altLabel, altShiftLabel, keyHint } from "../../keyboard/shortcuts";
import { familySiblings } from "../../gedcom/familyNav";
import { sexClass } from "../sex";
import { YearsText } from "../YearsText";
import { isApproximate, lifespanApproxOf } from "../../gedcom/lifespan";
import { displayDate } from "../../gedcom/dateDisplay";
import { useTranslation } from "react-i18next";
import type { Dataset, Family, GedNode, Individual, SourceCitation, GeoCoord } from "../../gedcom/types";
import { isSameSexCouple } from "../../gedcom/couple";
import { childrenByBirth } from "../../gedcom/familySort";
import type { Translate } from "../../locales/i18n";
import type { MatchDecisionStatus } from "../../review/types";
import { firstChild } from "../../gedcom/node";
import { FAM_HOUSEHOLD_TAGS, customEventLabel, famEventNodes, familyEventLabel } from "../../gedcom/eventTags";
import { coupleAgesDisplay, lifespanTooltipOf, lifespanWithAge } from "../../gedcom/age";
import type { TagSuggestions } from "./fieldSuggestions";
import { kinshipInfo, kinshipTooltip as kinshipTooltipText, lineageClass } from "../../match/kinship";
import {
  addFamilyEventNode,
  attachSourceCitation,
  canWriteFamilyAssociation,
  linkPageMedia,
  FAM_CHILD_ORDER,
  removeFamilyEvent,
  setFamilyLinks,
  recordLinkTag,
  setFamilyNotes,
  impossibleRelatives,
} from "../../gedcom/edit";
import { MARRIAGE_SYMBOL } from "../../chart/nodeDisplay";
import { useNameOf, useSettingsSlice } from "../SettingsContext";
import { PersonCard } from "../PersonCard";
import type { MediaRefContext } from "../MediaViewer";
import { RelativePickerCard } from "./RelativePickerCard";
import { AddEventSelect } from "./AddEventSelect";
import { AddNoEventSelect, NoEventsRow } from "./NoEventsRow";
import { addNegativeAssertion, NO_FAM_EVENT_TAGS, removeNegativeAssertion } from "../../gedcom/negative";
import { PrivateToggle } from "./PrivateToggle";
import { detectPrivacyStyle, setPrivateFlag } from "../../gedcom/private";
import { FamilyEventRow } from "./FamilyEventRow";
import { NotesEditor } from "./NotesEditor";
import { assocMoveTargets, RecordAssociates } from "./AssociatesPanel";
import { useAssoc } from "./AssocContext";
import { harvestedLinksOf, LinksEditor } from "./LinksEditor";
import { nodeId } from "./nodeId";
import { FAMILY_EVENT_TAGS, familyEventHasMergeData, offersEventTag } from "./editConstants";
import type { FamilyCommit, OpenEditSource, OpenMediaLink, SourceDialogTarget } from "./types";
import type { RecordMergePreview } from "../../merge/recordPreview";
import type { PendingRelativeLink } from "../../merge/materialize";
import type { RecordPatch } from "../historyTypes";

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

/** The people a relative picker leaves out: anyone the connect would refuse
 *  (see {@link impossibleRelatives}), so an impossible pick is never offered. */
function blockedRelatives(dataset: Dataset, personId: string, kind: RelativeKind, fam: Family | undefined): ReadonlySet<string> | undefined {
  const person = dataset.individuals.get(personId);
  return person ? impossibleRelatives(dataset, person, kind, fam) : undefined;
}

/**
 * The slot for a union that does not exist yet: a lone "+ Add Partner" card
 * after the last spouse family, opening the same picker an empty family
 * shows. Rendered only when every existing family already names a partner —
 * a partnerless family's own card is the place to fill that one, so this
 * block always means "start another family".
 */
export function NewUnionSection({
  personId,
  dataset,
  t,
  pickingSlot,
  setPickingSlot,
  connectRelative,
  addRelative,
}: Pick<SharedSectionProps, "personId" | "dataset" | "t" | "pickingSlot" | "setPickingSlot" | "connectRelative" | "addRelative">) {
  const pickerOpen = pickingSlot?.kind === "partner" && pickingSlot.fam === undefined;
  return (
    <div className="edit-family edit-family-new">
      <div className="edit-family-header">
        <div className="person-card-role">{t("field.partners")}</div>
        <div className="edit-family-card-row">
          {pickerOpen ? (
            <RelativePickerCard
              individuals={dataset.individuals}
              excludeId={personId}
              excludeIds={blockedRelatives(dataset, personId, "partner", undefined)}
              onPickExisting={(id) => connectRelative("partner", id, undefined)}
              onAddNew={(typed) => { setPickingSlot(null); addRelative("partner", undefined, typed); }}
              onCancel={() => setPickingSlot(null)}
              t={t}
            />
          ) : (
            <PersonCard placeholder={t("edit.addPartner")} addTitle={keyHint(t("edit.addPartner"), altShiftLabel("P"))} onAdd={() => setPickingSlot({ kind: "partner", fam: undefined })} />
          )}
        </div>
      </div>
    </div>
  );
}

/** The preferences this file reads — subscribed field by field, so an
 *  unrelated one changing leaves it alone (see useSettingsSlice). */
const SETTINGS_KEYS = ["showAge", "showKinship"] as const;

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
  addRelative: (kind: RelativeKind, fam?: Family, typedName?: string) => void;
  handleDetachSpouseRole: (fam: Family, role: "HUSB" | "WIFE", confirmMsg: string) => void;
  /** Unlink a child from a family — a child card in the spouse band, and this
   *  person from a parent family that records no parents at all. */
  handleDetachChild: (fam: Family, childId: string, confirmMsg: string) => void;
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

/** A relative a confirmed merge links on save, previewed where they will be. */
function PendingCard({ link, roleLabel, dataset, navigate, cardRefCtx }: {
  link: PendingRelativeLink;
  roleLabel?: string;
  dataset: Dataset;
  navigate: (id: string) => void;
  cardRefCtx?: MediaRefContext;
}) {
  return (
    <PersonCard
      individual={dataset.individuals.get(link.id)}
      roleLabel={roleLabel}
      onSelect={navigate}
      pending={{ unconfirmed: link.unconfirmed }}
      records={dataset.records}
      refCtx={cardRefCtx}
    />
  );
}

// ── Parents band ─────────────────────────────────────────────────────────────

interface ParentFamilyGroupProps extends SharedSectionProps {
  /** The parent family — undefined renders the empty add-parents slots. */
  fam: Family | undefined;
  /** The person's own record, rebuilt on each of their edits: their box in the
   *  siblings row shows their name and dates. Unused directly — it exists for
   *  the memo's prop comparison. */
  self: Individual;
  /** Parents a confirmed merge links into this family on save (see
   *  `previewRelativeLinks`), shown in their empty slots. */
  pending?: PendingRelativeLink[];
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
  handleDetachChild,
  cardRefCtx,
  decisionStatusById,
  changedPersonIds,
  startId,
  startPersonName,
  pending,
}: ParentFamilyGroupProps) {
  const settings = useSettingsSlice(SETTINGS_KEYS);
  // Only for the language — `t` arrives as a prop. Subscribing here also keeps
  // the memo honest when the language changes.
  const { i18n } = useTranslation();
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
  const pendingFather = !fam?.husband ? pending?.find((l) => l.role === "father") : undefined;
  const pendingMother = !fam?.wife ? pending?.find((l) => l.role === "mother") : undefined;
  // Read-only glimpse of what binds the parents, shown between the two cards —
  // editable on either parent's own page. Just the one event: the marriage, or
  // failing that whatever stands in for it (a civil partnership, an
  // engagement…). An untyped generic `EVEN` only says "Event", so it is skipped.
  const datedCoupleEvents = fam?.events.filter(
    (ev) => FAMILY_EVENT_TAGS.includes(ev.tag) && !FAM_HOUSEHOLD_TAGS.has(ev.tag) && (ev.date || ev.place),
  ) ?? [];
  const coupleEvent =
    datedCoupleEvents.find((ev) => ev.tag === "MARR") ??
    datedCoupleEvents.find((ev) => ev.tag !== "EVEN" || !!ev.type);
  const coupleEventLabel = !coupleEvent
    ? ""
    : (coupleEvent.tag === "EVEN" && customEventLabel(coupleEvent.type, t, i18n.language))
      || familyEventLabel(coupleEvent.tag, t);
  const couplePlace = coupleEvent?.place ? coupleEvent.place.parts[0] || coupleEvent.place.raw : undefined;
  const coupleAges = settings.showAge && coupleEvent?.date && fam
    ? coupleAgesDisplay(
        fam.husband ? dataset.individuals.get(fam.husband) : undefined,
        fam.wife ? dataset.individuals.get(fam.wife) : undefined,
        coupleEvent.date,
        sameSexParents
          ? { husband: t("event.age.partner"), wife: t("event.age.partner") }
          : { husband: t("event.age.husband"), wife: t("event.age.wife") },
        t,
      )
    : undefined;

  return (
    <div className="edit-parent-group">
      {fatherPickerOpen && !fam?.husband ? (
        <RelativePickerCard
          roleLabel={fatherLabel}
          individuals={dataset.individuals}
          excludeId={personId}
          excludeIds={blockedRelatives(dataset, personId, "father", fam)}
          onPickExisting={(id) => connectRelative("father", id, fam)}
          onAddNew={(typed) => { setPickingSlot(null); addRelative("father", fam, typed); }}
          onCancel={() => setPickingSlot(null)}
          t={t}
        />
      ) : pendingFather ? (
        <PendingCard link={pendingFather} roleLabel={fatherLabel} dataset={dataset} navigate={navigate} cardRefCtx={cardRefCtx} />
      ) : (
        <PersonCard
          individual={fam?.husband ? dataset.individuals.get(fam.husband) : undefined}
          roleLabel={fatherLabel}
          placeholder={t("edit.addFather")} addTitle={keyHint(t("edit.addFather"), altShiftLabel("F"))}
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
      {coupleEvent && (
        <div className="edit-parent-fam-events">
          <span
            className="edit-parent-fam-event"
            title={`${coupleEventLabel}: ${[coupleEvent.date && displayDate(coupleEvent.date), coupleEvent.place?.raw].filter(Boolean).join(", ")}`}
          >
            <span>
              {coupleEvent.tag === "MARR" ? MARRIAGE_SYMBOL : coupleEventLabel}
              {coupleEvent.date && (
                <>
                  {" "}
                  <span className={"gm-data" + (isApproximate(coupleEvent.date) ? " gm-approx" : "")}>{displayDate(coupleEvent.date)}</span>
                </>
              )}
              {coupleAges && (
                <> <span className="gm-data edit-event-age">
                  {coupleAges.map((a, j2) => (
                    <span key={j2} title={a.title}>{a.text}</span>
                  ))}
                </span></>
              )}
            </span>
            {couplePlace && <span className="gm-data">{couplePlace}</span>}
          </span>
        </div>
      )}
      {motherPickerOpen && !fam?.wife ? (
        <RelativePickerCard
          roleLabel={motherLabel}
          individuals={dataset.individuals}
          excludeId={personId}
          excludeIds={blockedRelatives(dataset, personId, "mother", fam)}
          onPickExisting={(id) => connectRelative("mother", id, fam)}
          onAddNew={(typed) => { setPickingSlot(null); addRelative("mother", fam, typed); }}
          onCancel={() => setPickingSlot(null)}
          t={t}
        />
      ) : pendingMother ? (
        <PendingCard link={pendingMother} roleLabel={motherLabel} dataset={dataset} navigate={navigate} cardRefCtx={cardRefCtx} />
      ) : (
        <PersonCard
          individual={fam?.wife ? dataset.individuals.get(fam.wife) : undefined}
          roleLabel={motherLabel}
          placeholder={t("edit.addMother")} addTitle={keyHint(t("edit.addMother"), altShiftLabel("M"))}
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
      {/* A parent family that names no parent at all says nothing — it is
          usually a leftover second `FAMC` from an import or a merge. Neither
          parent card can carry the detach button (there is nobody on them), so
          the family gets its own, which unlinks this person from it (and drops
          the `FAM` record itself unless other children remain). */}
      {fam && !fam.husband && !fam.wife && (
        <button
          type="button"
          className="person-card-detach edit-parent-detach"
          title={t("edit.detachParentFamilyTooltip")}
          onClick={() => handleDetachChild(fam, personId, t("edit.detachParentFamilyConfirm"))}
        >
          &minus;
        </button>
      )}
      {fam && <SiblingsRow fam={fam} personId={personId} dataset={dataset} t={t} navigate={navigate} sameSexParents={sameSexParents} />}
    </div>
  );
});

/**
 * The person's siblings under one parent family: the family's own children by
 * birth with the person marked in their place, then each parent's children
 * from other unions as half-siblings. One click opens a sibling; ⌥←/→ keep
 * walking the family's own run (familyStepTarget). Absent for an only child.
 */
function SiblingsRow({ fam, personId, dataset, t, navigate, sameSexParents }: {
  fam: Family;
  personId: string;
  dataset: Dataset;
  t: Translate;
  navigate: (id: string) => void;
  sameSexParents: boolean;
}) {
  const settings = useSettingsSlice(SETTINGS_KEYS);
  const formatName = useNameOf();
  const { full, half } = familySiblings(dataset, fam.id, personId);
  if (full.length <= 1 && half.length === 0) return null;

  const chip = (id: string, title?: string, isHalf = false) => {
    const indi = dataset.individuals.get(id);
    if (!indi) return null;
    const self = id === personId;
    const lifespan = lifespanWithAge(indi, settings.showAge);
    const body = (
      <>
        <span className="person-name edit-sibling-name">
          <span className="edit-sibling-name-text">{formatName(indi)}</span>
          {isHalf && <span className="edit-sibling-half">½</span>}
        </span>
        {lifespan && <span className="person-years gm-data"><YearsText text={lifespan} approx={lifespanApproxOf(indi)} /></span>}
      </>
    );
    return self ? (
      <div key={id} className={`edit-sibling self ${sexClass(indi.sex)}`} aria-current="true" title={t("edit.siblings.self")}>{body}</div>
    ) : (
      <button
        key={id}
        type="button"
        className={`edit-sibling ${sexClass(indi.sex)}${isHalf ? " half" : ""}`}
        title={[formatName(indi), title ?? lifespanTooltipOf(indi, settings.showAge, t)].filter(Boolean).join(" · ")}
        onClick={() => navigate(id)}
      >
        {body}
      </button>
    );
  };
  const halfTitle = (id: string, otherParentId: string | undefined) => {
    const sex = dataset.individuals.get(id)?.sex;
    const kin = t(sex === "M" ? "kinship.halfBrother" : sex === "F" ? "kinship.halfSister" : "timeline.role.halfsibling");
    const other = otherParentId && dataset.individuals.get(otherParentId);
    return other ? `${kin} · ${t("edit.siblings.otherParent", { name: formatName(other) })}` : kin;
  };

  // One width for every box and the "other family" label: the longest name
  // (a half-sibling's ½ counts), in ch; CSS caps it at a parent card's width.
  const nameLength = (id: string) => {
    const indi = dataset.individuals.get(id);
    return indi ? formatName(indi).length : 0;
  };
  const longest = Math.max(
    ...full.map(nameLength),
    ...half.flatMap((g) => g.siblings.map((s) => nameLength(s.id) + 3)),
  );

  return (
    <div className="edit-siblings">
      <div className="person-card-role" title={keyHint(t("shortcuts.item.goSibling"), `${altLabel("←")} ${altLabel("→")}`)}>
        {t("edit.siblings.title")}
      </div>
      <div className="edit-sibling-row" style={{ "--sibling-name-ch": longest } as CSSProperties}>
        {full.map((id) => chip(id))}
        {half.map((group) => (
          <Fragment key={group.via}>
            <span className="edit-sibling-group">
              {sameSexParents
                ? t("edit.siblings.viaParent")
                : t(group.via === "husband" ? "edit.siblings.viaFather" : "edit.siblings.viaMother")}
            </span>
            {group.siblings.map((s) => chip(s.id, halfTitle(s.id, s.otherParentId), true))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// ── Spouse-family band ───────────────────────────────────────────────────────

interface FamilySectionProps extends SharedSectionProps {
  /** The spouse family — undefined renders the empty add-partner/child slots. */
  fam: Family | undefined;
  commitFamily: FamilyCommit;
  openEditSource: OpenEditSource;
  openMediaLink: OpenMediaLink;
  onOpenSourceDialog: (target: SourceDialogTarget | null) => void;
  onAddFamNote: (famId: string) => void;
  markFamilyTagRetagged: (keyBase: string, newTag: string) => void;
  dismissExtraEvent: (keyBase: string) => void;
  /** Open the "Copy event to…" picker for one of this family's events. */
  onCopyFamilyEvent: (fam: Family, node: GedNode, label: string) => void;
  famMergeKeyBase: string | undefined;
  /** What a confirmed merge will write into the family record itself — its
   *  notes, private flag and "did not happen" statements. */
  mergePreview?: RecordMergePreview;
  /** Write a previewed `fam.<id>.<field>` row into the family record now,
   *  returning undo patches (see `useMergeOverlay`). */
  takeMergeField: (raw: GedNode, key: string) => RecordPatch[];
  /** Leave a previewed row out of the save. */
  skipMergeField: (key: string) => void;
  /** The partner and children a confirmed merge links into this family on
   *  save (see `previewRelativeLinks`). */
  pending?: PendingRelativeLink[];
  mergeHighlight: Map<string, string>;
  mergeIncomingSources: Map<string, SourceCitation[]>;
  /** Plain links a confirmed merge will add, keyed by row — the family's own
   *  are under `<famKey>.links`, an event's under that event's sources row. */
  mergeIncomingLinks: Map<string, string[]>;
  /** Page images the incoming citations bring with them — see FamilyEventRow. */
  mergeIncomingPageImages: Map<string, string[]>;
  resolvedSessionFields: Set<string>;
  placeSuggestions: string[];
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
  agencySuggestions: string[];
  agencyCanonical: Map<string, string>;
  causeSuggestions: string[];
  causeCanonical: Map<string, string>;
  tagSuggestions: TagSuggestions;
  /** Coordinate the file already uses for a place (settlement-level). */
  placeCoords: Map<string, GeoCoord>;
  placeForms: Map<string, string>;
  /** Coordinate for a specific place+address pair (the house). */
  pairCoords: Map<string, GeoCoord>;
  pendingFocusFamEventKey: string | null;
  setPendingFocusFamEventKey: (key: string | null) => void;
  famNoteAddCount: number | undefined;
  mergeGen: number;
  /** Bumped when a shared top-level SOUR/OBJE record changes via another
   *  owner's edit — folded into the media tray's key so it re-reads metadata. */
}

/**
 * The people a family's own record names — the witnesses at the wedding, the
 * priest who married them — as against the ones named on one of its events.
 *
 * 7.0 only, because 5.5.1 puts `ASSO` on a person and nowhere else: in a 5.5.x
 * file a witness goes on a spouse's record instead, and this offers nothing. One
 * such a file already carries is still shown and still editable — a file's own
 * words are never hidden, whatever dialect it claims.
 */
function FamilyAssociates({ fam, t }: { fam: Family; t: Translate }) {
  const api = useAssoc();
  const associations = fam.associations ?? [];
  const canAdd = !!api && canWriteFamilyAssociation(api.version);
  if (!associations.length && !canAdd) return null;
  return (
    <div className="edit-record-section edit-assoc">
      <RecordAssociates
        record={fam.raw}
        ownerId={fam.id}
        associations={associations}
        canAdd={canAdd}
        moveTargets={assocMoveTargets(famEventNodes(fam.raw), t)}
        t={t}
      />
    </div>
  );
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
  openMediaLink,
  onOpenSourceDialog,
  onAddFamNote,
  markFamilyTagRetagged,
  dismissExtraEvent,
  onCopyFamilyEvent,
  famMergeKeyBase,
  mergePreview,
  takeMergeField,
  skipMergeField,
  pending,
  mergeHighlight,
  mergeIncomingSources,
  mergeIncomingLinks,
  mergeIncomingPageImages,
  resolvedSessionFields,
  placeSuggestions,
  placeToAddrs,
  placeCanonical,
  addrCanonical,
  agencySuggestions,
  agencyCanonical,
  causeSuggestions,
  causeCanonical,
  tagSuggestions,
  placeCoords,
  placeForms,
  pairCoords,
  pendingFocusFamEventKey,
  setPendingFocusFamEventKey,
  famNoteAddCount,
  mergeGen,
}: FamilySectionProps) {
  const settings = useSettingsSlice(SETTINGS_KEYS);
  const formatOverrides = useFormatOverrides();
  const { eventOffer } = useTargetFormat();
  const formatName = useNameOf();
  const personName = (id: string | undefined): string => {
    if (!id) return "";
    const indi = dataset.individuals.get(id);
    return indi ? formatName(indi) : id;
  };
  const cardKinship = (id: string | undefined) => kinshipChips(dataset, settings.showKinship, startId, startPersonName, t, id);
  const cardDecision = (id: string | undefined) => decisionChips(decisionStatusById, changedPersonIds, t, id);

  // What a confirmed merge will add to the family record itself — its own
  // citations, the links that stay links, and the pages those citations name.
  const famLinksKey = `${famMergeKeyBase ?? `fam.${fam?.id}`}.links`;
  const famLinksMerge = {
    sources: mergeIncomingSources.get(famLinksKey),
    links: mergeIncomingLinks.get(famLinksKey),
    pageImages: mergeIncomingPageImages.get(famLinksKey),
  };
  /** Take / leave out one of the family's own previewed rows (`notes`, …). */
  const famMergeActions = (field: string) => {
    const key = `${famMergeKeyBase}.${field}`;
    return {
      onTake: () => {
        if (!fam) return;
        const patches: RecordPatch[] = [];
        commitFamily(fam, (f) => { patches.push(...takeMergeField(f.raw, key)); }, patches);
      },
      onSkip: () => skipMergeField(key),
    };
  };

  const partnerId = fam && (fam.husband === personId ? fam.wife : fam.husband);
  const partnerRole = fam && (fam.husband === personId ? "WIFE" : "HUSB");
  const partnerName = personName(partnerId ?? undefined);
  const shownFamilyTags = FAMILY_EVENT_TAGS.filter(
    (tag) => fam?.events.some((e) => e.tag === tag) || familyEventHasMergeData(famMergeKeyBase, tag, mergeHighlight, mergeIncomingSources),
  );
  const emptyFamilyTags = FAMILY_EVENT_TAGS.filter(
    (tag) => !shownFamilyTags.includes(tag) && offersEventTag(tag, "FAM", eventOffer),
  );
  const partnerPickerOpen = pickingSlot?.kind === "partner" && pickingSlot.fam === fam;
  const pendingPartner = !partnerId ? pending?.find((l) => l.role === "partner") : undefined;
  const childPickerOpen = pickingSlot?.kind === "child" && pickingSlot.fam === fam;

  return (
    // The id is on the element so a keyboard shortcut can tell which family the
    // cursor is in, and add a child (or a partner) to that one.
    <div className="edit-family" data-fam-id={fam?.id}>
      <div className="edit-family-header">
        <div className="person-card-role">{t("field.partners")}</div>
        <div className="edit-family-card-row">
          {partnerPickerOpen && !partnerId ? (
            <RelativePickerCard
              individuals={dataset.individuals}
              excludeId={personId}
              excludeIds={blockedRelatives(dataset, personId, "partner", fam)}
              onPickExisting={(id) => connectRelative("partner", id, fam)}
              onAddNew={(typed) => { setPickingSlot(null); addRelative("partner", fam, typed); }}
              onCancel={() => setPickingSlot(null)}
              t={t}
            />
          ) : pendingPartner ? (
            <PendingCard link={pendingPartner} dataset={dataset} navigate={navigate} cardRefCtx={cardRefCtx} />
          ) : (
            <PersonCard
              individual={partnerId ? dataset.individuals.get(partnerId) : undefined}
              placeholder={t("edit.addPartner")} addTitle={keyHint(t("edit.addPartner"), altShiftLabel("P"))}
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
              labelOf={familyEventLabel}
              onAdd={(tag) => { commitFamily(fam, (f) => addFamilyEventNode(f, tag)); setPendingFocusFamEventKey(`${fam.id}-${tag}`); }}
            />
          )}
          {fam && (
            <AddNoEventSelect
              assertions={fam.noEvents ?? []}
              offer={NO_FAM_EVENT_TAGS}
              recordedTags={new Set(fam.events.map((e) => e.tag))}
              t={t}
              tooltip={t("edit.noEvent.addFamilyTooltip")}
              onAdd={(tag) => commitFamily(fam, (f) => addNegativeAssertion(f.raw, tag, dataset.version))}
            />
          )}
          {fam && (
            <PrivateToggle
              on={!!fam.private}
              merge={mergePreview?.private}
              t={t}
              target={t("edit.privateTarget.family")}
              onToggle={() => mergePreview?.private
                ? famMergeActions("private").onSkip()
                : commitFamily(fam, (f) =>
                  setPrivateFlag(f.raw, !f.private, formatOverrides.privacy ?? detectPrivacyStyle(dataset.records), dataset.records))}
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
        </div>
      </div>
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
            openMediaLink={openMediaLink}
            onOpenSourceDialog={onOpenSourceDialog}
            autoFocusLead={pendingFocusFamEventKey === `${fam.id}-${tag}`}
            onRemove={hasRealEvent ? () => commitFamily(fam, (f) => removeFamilyEvent(f, tag)) : () => dismissExtraEvent(`${famMergeKeyBase ?? `fam.${fam.id}`}.${tag}`)}
            onCopy={eventNode ? () => onCopyFamilyEvent(fam, eventNode, familyEventLabel(tag, t)) : undefined}
            onRetag={(newTag) => markFamilyTagRetagged(famMergeKeyBase ?? `fam.${fam.id}`, newTag)}
            placeSuggestions={placeSuggestions}
            placeToAddrs={placeToAddrs}
            placeCanonical={placeCanonical}
            addrCanonical={addrCanonical}
            agencySuggestions={agencySuggestions}
            agencyCanonical={agencyCanonical}
            causeSuggestions={causeSuggestions}
            causeCanonical={causeCanonical}
            tagSuggestions={tagSuggestions}
            placeCoords={placeCoords}
            placeForms={placeForms}
            pairCoords={pairCoords}
            mergeHighlight={mergeHighlight}
            mergeIncomingSources={mergeIncomingSources}
            mergeIncomingPageImages={mergeIncomingPageImages}
            famMergeKeyBase={famMergeKeyBase}
            resolvedSessionFields={resolvedSessionFields}
            individuals={dataset.individuals}
          />
        );
      })}
      {fam && (
        <NoEventsRow
          assertions={fam.noEvents ?? []}
          t={t}
          onRemove={(tag) => commitFamily(fam, (f) => removeNegativeAssertion(f.raw, tag))}
          merge={mergePreview?.noEvents && { assertions: mergePreview.noEvents, ...famMergeActions("noEvents") }}
        />
      )}
      <div className="edit-children-wrap">
        <div className="person-card-role">{t("field.children")}</div>
        <div className="edit-children">
          {fam && childrenByBirth(fam, dataset.individuals).map((childId) => {
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
          {pending?.filter((l) => l.role === "child").map((l) => (
            <PendingCard key={`pending-${l.id}`} link={l} dataset={dataset} navigate={navigate} cardRefCtx={cardRefCtx} />
          ))}
          {childPickerOpen ? (
            <RelativePickerCard
              individuals={dataset.individuals}
              excludeId={personId}
              excludeIds={blockedRelatives(dataset, personId, "child", fam)}
              onPickExisting={(id) => connectRelative("child", id, fam)}
              onAddNew={(typed) => { setPickingSlot(null); addRelative("child", fam, typed); }}
              onCancel={() => setPickingSlot(null)}
              t={t}
            />
          ) : (
            <PersonCard placeholder={t("edit.addChild")} addTitle={keyHint(t("edit.addChild"), altShiftLabel("C"))} onAdd={() => setPickingSlot({ kind: "child", fam })} />
          )}
        </div>
      </div>
      {fam && <FamilyAssociates fam={fam} t={t} />}
      {fam && ((fam.links ?? []).length > 0 || (fam.sources ?? []).length > 0 || (famLinksMerge.links?.length ?? 0) > 0 || (famLinksMerge.sources?.length ?? 0) > 0) && (
        <div className="edit-record-section">
          <LinksEditor
            key={`flinks-${fam.id}-${undoVersion}-${mergeGen}`}
            links={fam.editableLinks ?? []}
            harvestedLinks={harvestedLinksOf(fam.links, [...(fam.editableLinks ?? []), ...(fam.mediaLinks ?? [])])}
            mediaLinks={fam.mediaLinks ?? []}
            sources={fam.sources ?? []}
            incomingLinks={famLinksMerge.links}
            incomingSources={famLinksMerge.sources}
            incomingPageImages={famLinksMerge.pageImages}
            sectionLabel={t("field.sources")}
            t={t}
            onCommit={(links) => commitFamily(fam, (f) => setFamilyLinks(f, links, recordLinkTag(dataset.records, f.raw, formatOverrides)))}
            onAddSource={() => onOpenSourceDialog({ kind: "family", fam })}
            onEditSource={(idx) => openEditSource(fam.raw, idx, { kind: "family", fam })}
            onOpenSourceDialog={onOpenSourceDialog}
            onAttachSource={({ sourceXref, page, quay }, extraPatches, links, pageObjeXref) =>
              commitFamily(fam, (f) => {
                attachSourceCitation(f.raw, sourceXref, page, FAM_CHILD_ORDER, quay);
                linkPageMedia(f.raw, pageObjeXref, FAM_CHILD_ORDER);
                setFamilyLinks(f, links, recordLinkTag(dataset.records, f.raw, formatOverrides));
              }, extraPatches)
            }
            onOpenMediaLink={(url) => openMediaLink(fam.raw, { kind: "family", fam }, url)}
          />
        </div>
      )}
      {fam && (
        <div className="edit-record-section">
          <NotesEditor
            key={`fnotes-${fam.id}-${undoVersion}-${noteGen ?? 0}-${mergeGen}`}
            notes={fam.noteRefs ?? []}
            addTrigger={famNoteAddCount}
            incoming={mergePreview?.notes && { ...mergePreview.notes, ...famMergeActions("notes") }}
            t={t}
            onCommit={(refs) => commitFamily(fam, (f, notes) => setFamilyNotes(notes, f, refs))}
          />
        </div>
      )}
    </div>
  );
});

/**
 * A family a confirmed merge makes on save — a partner the main file already
 * holds, with any children it links there — previewed read-only below the
 * person's own families.
 */
export function PendingFamilyGroup({ links, dataset, t, navigate, cardRefCtx }: {
  links: PendingRelativeLink[];
  dataset: Dataset;
  t: Translate;
  navigate: (id: string) => void;
  cardRefCtx?: MediaRefContext;
}) {
  const partner = links.find((l) => l.role === "partner");
  const children = links.filter((l) => l.role === "child");
  return (
    <div className="edit-family edit-family--pending">
      <div className="edit-family-header">
        <div className="person-card-role">{t("edit.pendingFamily")}</div>
        <div className="edit-family-card-row">
          {partner && <PendingCard link={partner} dataset={dataset} navigate={navigate} cardRefCtx={cardRefCtx} />}
        </div>
      </div>
      {children.length > 0 && (
        <div className="edit-children-wrap">
          <div className="person-card-role">{t("field.children")}</div>
          <div className="edit-children">
            {children.map((l) => (
              <PendingCard key={l.id} link={l} dataset={dataset} navigate={navigate} cardRefCtx={cardRefCtx} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
