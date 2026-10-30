import { useEffect, useMemo, useRef, useState } from "react";
import { linkGlyph, linkHref, linkTooltip, mediaLinkTooltip } from "../FieldValue";
import { tipProps } from "../IconTip";
import { useTranslation } from "react-i18next";
import type { GedEvent, GedNode, GeoCoord, SourceCitation } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { LDS_ORDINANCE_TAGS, ORDINANCE_STATUSES, customEventLabel, customEventTooltip, isOccurrenceFlag, vendorEventTooltip } from "../../gedcom/eventTags";
import type { RecordPatch } from "../historyTypes";
import { canWriteEventAssociation, type EventFieldUpdate } from "../../gedcom/edit";
import { SourceRefs } from "../SourceRef";
import { EventGlyph, eventMenuLabel } from "../EventGlyph";
import { termsHref } from "../TagLinks";
import { ClearableTextarea } from "./ClearableInput";
import { isTallNoteList, NOTE_CHIP_CH, NotesEditor } from "./NotesEditor";
import { useAssoc } from "./AssocContext";
import { EventAssociates } from "./EventAssociates";
import { SuggestInput } from "./SuggestInput";
import { usePlaceLookup } from "./PlaceLookupContext";
import type { PlaceProposal } from "../../geo/placeProposal";
import { placeCollator } from "../../gedcom/place";
import { DATE_DISPLAY_WORDS } from "../dateDisplayFormat";
import { useSettingsSlice } from "../SettingsContext";
import { DateInput } from "./DateInput";
import { joinDateTime, splitDateTime } from "../../gedcom/dateTime";
import { dateEntryVersion } from "./DateEntryContext";
import { sortDateTag } from "../../gedcom/sortDate";
import { translationLine } from "../../gedcom/translation";
import { EventCoordPicker } from "./EventCoordPicker";
import { useField } from "./useField";
import { SECONDARY_VALUE_EVENT_TAGS, VALUE_EVENT_TAGS } from "./editConstants";
import { placeAddrCoordKey, placeCombosOf, placeKey, type Suggestions, type TagSuggestions } from "./fieldSuggestions";
import { DropdownMenu } from "../DropdownMenu";
import { altShiftLabel } from "../../keyboard/shortcuts";
import type { SourceDialogTarget } from "./types";
import { harvestedLinksOf, linkEditing } from "./LinksEditor";
import { linkKey } from "../../normalize/links";
import { eventRowUpdate } from "./eventRowUpdate";
import { AddressStructure } from "./AddressStructure";
import { eventHasAddressStructure as hasAddressStructure } from "../../gedcom/address";
import { writeAgeValue } from "../../gedcom/ageValue";

/** A family event's spouse age fields: the label each shows, and its tooltip. */
export interface SpouseAgeLabels {
  husband: { label: string; title: string };
  wife: { label: string; title: string };
}

/** Sentinel `<option>` values for the action entries at the end of the
 * event-type dropdown (distinct from any real tag). */
const COPY_OPTION = "__copy_event__";
const REMOVE_OPTION = "__remove_event__";

/** What a field completes from on a tag the file has never written — one
 *  shared object, so a row of empty fields doesn't allocate a map each. */
const EMPTY_SUGGESTIONS: Suggestions = { suggestions: [], canonical: new Map() };
const NO_CANONICAL = EMPTY_SUGGESTIONS.canonical;

/**
 * The event's name led by its genealogy mark. The mark and the first word are
 * kept in one unbreakable piece: a mark is an atomic inline, so the line may
 * break straight after it, and a name too long for the label slot would
 * otherwise leave the mark stranded on the line above its own event.
 */
function markedLabel(tag: string | undefined, text: string, t: Translate) {
  if (!tag) return text;
  const at = text.indexOf(" ");
  return (
    <>
      <span className="edit-event-label-lead">
        <EventGlyph tag={tag} t={t} />
        {at < 0 ? text : text.slice(0, at)}
      </span>
      {at < 0 ? null : text.slice(at)}
    </>
  );
}

const DATE_DISPLAY_KEYS = ["dateDisplay"] as const;

/** Editable date/place/address/links for a single event (individual or
 * family), e.g. `1 BIRT` or `1 MARR`. */
export function EventFieldsRow({
  ev,
  label,
  tag,
  t,
  commitField,
  onRemove,
  onCopy,
  onChangeTag,
  tagGroups,
  tagLabel,
  onAddSource,
  onEditSource,
  onOpenSourceDialog,
  onOpenMediaLink,
  autoFocusLead,
  focusLeadNonce,
  openDetailMenuNonce,
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
  mergeHighlight,
  mergeIncomingSources,
  mergeIncomingPageImages,
  mergeKeyBase,
  forcedKeyBase,
  resolvedSessionFields,
  eventNodeId,
  eventNode,
  personId,
  materializedEventIds,
  age,
  spouseAgeLabels,
}: {
  ev: GedEvent | undefined;
  label: string;
  tag?: string;
  t: Translate;
  commitField: (update: EventFieldUpdate, extraPatches?: RecordPatch[]) => void;
  onRemove?: () => void;
  /** When set, the dropdown offers "Copy event to…" above the remove entry —
   * opening the target picker for this event. Only rows backed by a real event
   * node get it (there's nothing to copy from a merge suggestion). */
  onCopy?: () => void;
  /** When set (together with `tagGroups`), the type label becomes a dropdown
   * so the user can change this event's tag in place (e.g. turn an
   * Occupation into an Education event). */
  onChangeTag?: (newTag: string) => void;
  /** Options for the type-change dropdown — grouped under an `<optgroup>`
   * when `labelKey` is given (individual events), or shown as a flat list
   * otherwise (family events, which have too few tags to need grouping). */
  tagGroups?: readonly { labelKey?: string; tags: readonly string[] }[];
  /** Names a tag in the type-change dropdown its own way (a family's
   *  household events — see `familyEventLabel`). */
  tagLabel?: (tag: string, t: Translate) => string;
  onAddSource: () => void;
  onEditSource?: (index: number) => void;
  onOpenSourceDialog: (target: SourceDialogTarget) => void;
  /** Opens the media-link dialog for one of `ev.mediaLinks` — bound to this
   * event's node by the parent, like `onEditSource`. */
  onOpenMediaLink?: (url: string) => void;
  /** Focus the row's lead input on mount — the date, on every kind of event —
   * so a freshly added event can be typed into immediately. */
  autoFocusLead?: boolean;
  /** Increment to focus the lead input of an already-mounted row — the
   * always-present Birth row, which quick-add targets instead of duplicating
   * (autoFocusLead only fires on mount). */
  focusLeadNonce?: number;
  /** Increment to open this row's "+ Detail" menu from outside it — ⌥⇧D
   * pressed with the keyboard in no event row lands on the first one. */
  openDetailMenuNonce?: number;
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
  /** Attested FORM per place (see FieldSuggestions.placeForms). */
  placeForms: Map<string, string>;
  /** Coordinate for a specific place+address pair (the house). */
  pairCoords: Map<string, GeoCoord>;
  mergeHighlight?: Map<string, string>;
  /** Field key (e.g. "BIRT.sources") → incoming source citations the merge will add. */
  mergeIncomingSources?: Map<string, SourceCitation[]>;
  /** Key base -> the cited pages' images a confirmed merge will link on this
   *  event beside its citations — previewed read-only until the merge is saved. */
  mergeIncomingPageImages?: Map<string, string[]>;
  mergeKeyBase?: string;
  /** Stable per-event identity (e.g. the raw node's `nodeId`) used to look up
   * the session "this field was edited from a merge" markers in
   * `resolvedSessionFields`. Distinct from `mergeKeyBase`, which is a volatile
   * positional key (e.g. "RESI.1") that can be reassigned to a different event
   * as same-tag events reshuffle. Falls back to `mergeKeyBase`/`tag` for
   * callers whose key base is already stable (e.g. family events). */
  forcedKeyBase?: string;
  resolvedSessionFields?: Set<string>;
  /** This event's stable `nodeId`, matched against `materializedEventIds`. */
  eventNodeId?: number;
  /** The event's own raw node — the container an association is written on.
   *  Absent for a row backed by no real node (a merge suggestion), where the
   *  associates render read-only. */
  eventNode?: GedNode;
  /** The record this row belongs to, so its own person is never offered as
   *  their own godparent. */
  personId?: string;
  /** `nodeId`s of events materialized this session from a merge suggestion;
   * every field of such an event renders bold (it's all new vs the saved
   * main), independently of `resolvedSessionFields`. */
  materializedEventIds?: Set<number>;
  /** Age badges shown after the date ("Show ages" setting) — the person's age
   * at this event, or one glyph-tagged badge per spouse/parent (e.g. "♂32"
   * "♀28"), each with its own tooltip. */
  age?: { text: string; title: string }[];
  /** Set on a family event's row: its stated ages are each spouse's
   *  (`HUSB`/`WIFE` → `AGE`), not one of the event's own, and these name them. */
  spouseAgeLabels?: SpouseAgeLabels;
}) {
  const { i18n } = useTranslation();
  // A generic `EVEN`/`FACT` wears its descriptive `TYPE` as the event label
  // ("Civil Partnership"), so it reads like any built-in event — the label's
  // tooltip is what says it's custom. The TYPE itself is edited in an
  // always-shown "Title" extra, and the tag's own line value (`1 EVEN <v>`,
  // `1 FACT <v>`) in the "Value" extra, the description GEDCOM 7 gives it.
  const isEven = tag === "EVEN" || tag === "FACT";
  const showValue = isEven || (tag !== undefined && VALUE_EVENT_TAGS.has(tag));
  // A residence's value is supplementary, not its headline (see
  // `SECONDARY_VALUE_EVENT_TAGS`): the row still leads with the date, and the
  // value rides on the extras line like the agency or the cause. A custom
  // event's value is too, since its name is the TYPE.
  const valueIsExtra = showValue && tag !== undefined && (isEven || SECONDARY_VALUE_EVENT_TAGS.has(tag));

  // Compute merge values before hooks so they can be used as initial state.
  const kBase = mergeKeyBase ?? tag ?? "";
  const dateMergeVal = mergeHighlight?.get(`${kBase}.date`);
  const valueMergeVal = showValue ? mergeHighlight?.get(`${kBase}.value`) : undefined;
  const placeMergeVal = mergeHighlight?.get(`${kBase}.place`);
  const addrMergeVal = mergeHighlight?.get(`${kBase}.addr`);
  const noteMergeVal = mergeHighlight?.get(`${kBase}.note`);
  const agencyMergeVal = mergeHighlight?.get(`${kBase}.agency`);
  const typeMergeVal = mergeHighlight?.get(`${kBase}.type`);
  const causeMergeVal = mergeHighlight?.get(`${kBase}.cause`);
  const templeMergeVal = mergeHighlight?.get(`${kBase}.temple`);
  const statusMergeVal = mergeHighlight?.get(`${kBase}.status`);
  const ageMergeVal = mergeHighlight?.get(`${kBase}.age`);
  const husbandAgeMergeVal = mergeHighlight?.get(`${kBase}.husbage`);
  const wifeAgeMergeVal = mergeHighlight?.get(`${kBase}.wifeage`);
  const sourcesMergeVal = mergeIncomingSources?.get(`${kBase}.sources`);
  const pageImagesMergeVal = mergeIncomingPageImages?.get(`${kBase}.sources`);

  // A field just materialized from a merge suggestion via a direct edit keeps
  // showing dirty/bold across the row's one-time "extra"→"main" remount.
  // Keyed by the *stable* `forcedKeyBase` (not the volatile `kBase`) so the
  // marker stays attached to the same physical event when same-tag events
  // reshuffle their merge key bases.
  const fBase = forcedKeyBase ?? kBase;
  // A whole event materialized this session from an incoming suggestion is new
  // vs the saved main, so every field is a change — force them all bold,
  // regardless of per-field merge resolution (which can be cleared/recomputed).
  const eventForced = eventNodeId !== undefined && (materializedEventIds?.has(eventNodeId) ?? false);
  const dateForced = eventForced || (resolvedSessionFields?.has(`${fBase}.date`) ?? false);
  const valueForced = eventForced || (resolvedSessionFields?.has(`${fBase}.value`) ?? false);
  const placeForced = eventForced || (resolvedSessionFields?.has(`${fBase}.place`) ?? false);
  const addrForced = eventForced || (resolvedSessionFields?.has(`${fBase}.addr`) ?? false);
  const noteForced = eventForced || (resolvedSessionFields?.has(`${fBase}.note`) ?? false);
  const agencyForced = eventForced || (resolvedSessionFields?.has(`${fBase}.agency`) ?? false);
  const typeForced = eventForced || (resolvedSessionFields?.has(`${fBase}.type`) ?? false);
  const causeForced = eventForced || (resolvedSessionFields?.has(`${fBase}.cause`) ?? false);
  const templeForced = eventForced || (resolvedSessionFields?.has(`${fBase}.temple`) ?? false);
  const statusForced = eventForced || (resolvedSessionFields?.has(`${fBase}.status`) ?? false);
  // An LDS ordinance's temple and status are offered on the ordinances alone:
  // on any other event the two would be lines no standard defines.
  const isOrdinance = tag !== undefined && LDS_ORDINANCE_TAGS.has(tag);
  const ageForced = eventForced || (resolvedSessionFields?.has(`${fBase}.age`) ?? false);
  const husbandAgeForced = eventForced || (resolvedSessionFields?.has(`${fBase}.husbage`) ?? false);
  const wifeAgeForced = eventForced || (resolvedSessionFields?.has(`${fBase}.wifeage`) ?? false);
  // Family rows remount on a real retag (see the `FamilyEventRow` call
  // sites), so the freshly-mounted row can't tell a real retag from this
  // tag having always been here — `markFamilyTagRetagged` flags it instead.
  const tagForced = resolvedSessionFields?.has(`${fBase}.tag`) ?? false;

  // The registers behind the place and address fields; null outside the Edit
  // view, where the fields stay file-only.
  const lookup = usePlaceLookup();
  // A bare `Y` (`1 DEAT Y`) only says the event happened: the field shows it
  // empty, and an empty field writes the flag back rather than erasing it.
  const flagOnly = !isEven && isOccurrenceFlag(ev?.value);
  const valueField = useField(flagOnly ? "" : ev?.value ?? "", valueMergeVal);
  // The date field carries the event's time of day after its date.
  const dateField = useField(joinDateTime(ev?.date?.raw ?? "", ev?.time), dateMergeVal);
  // Dates in words run longer, so the date slot widens for them.
  const { dateDisplay } = useSettingsSlice(DATE_DISPLAY_KEYS);
  const placeField = useField(ev?.place?.raw ?? "", placeMergeVal);
  // The coordinate this event actually carries (PLAC.MAP). Read from the model,
  // not the edited text, so it reflects what is in the file.
  const coord = ev?.place?.coord;
  // Whether the file uses coordinates at all: between them the two maps cover
  // every PLAC that carries a MAP (one for events with an address, one for those
  // without), so both empty means the file has none anywhere. A file that does
  // not use locations should not carry a pin on every event row — coordinates
  // are introduced there through Tools → Geocode places, and once the first one
  // lands the pins appear and can refine the rest.
  const fileUsesCoords = placeCoords.size > 0 || pairCoords.size > 0;
  // The address field edits the ADDR's own line. Where the ADDR also carries
  // labelled lines, `address` is their join when the line is empty — those
  // live in the structure panel below, not in this field.
  const addrField = useField((ev?.addressParts ? ev.addressLine : ev?.address?.raw) ?? "", addrMergeVal);
  // The address as the coordinate knows it: the line, else the joined lines.
  const addrForCoord = addrField.value.trim() ? addrField.value : ev?.addressParts && !ev.addressLine ? ev.address?.raw ?? "" : "";
  // The labelled lines open on their own when the event has any; otherwise
  // they wait to be asked for, so a one-line address stays one line.
  const hasStructure = hasAddressStructure(ev);
  const [addrOpen, setAddrOpen] = useState(hasStructure);
  const addrStructureKey = JSON.stringify([ev?.addressParts, ev?.phone, ev?.email, ev?.fax]);

  // Known place+address pairs for the place field's combo suggestions —
  // typing an address there fills both fields in one go.
  const placeCombos = useMemo(() => placeCombosOf(placeToAddrs, placeCanonical), [placeToAddrs, placeCanonical]);

  /**
   * The coordinate the file already uses for a place (and address), so choosing
   * an existing value brings its position along instead of leaving the new event
   * unplaced. The pair's own house coordinate wins over the settlement's.
   */
  const knownCoord = (place: string, addr: string): GeoCoord | undefined => {
    const trimmed = place.trim();
    if (!trimmed) return undefined;
    return (addr.trim() ? pairCoords.get(placeAddrCoordKey(trimmed, addr)) : undefined) ?? placeCoords.get(placeKey(trimmed));
  };

  /**
   * The coordinate half of a commit that sets the place and/or address.
   *
   * A coordinate already on the event is left alone while the place stays the
   * same — it may be the house's own, more precise than anything the file knows
   * for the settlement, and refining the address must never quietly coarsen it.
   * The moment the place actually changes, though, that coordinate describes
   * somewhere else: the file's position for the new place takes over, and when
   * the file has none the old one is dropped rather than left pointing at the
   * village the event just moved away from.
   *
   * One exception within an unchanged place: when the *address* changes and the
   * file has a pin for the exact new place+address pair, that pin takes over —
   * the event moved to a house whose position the file knows, and keeping the
   * old coordinate would leave it pointing at the house it just left. With no
   * pin for the new pair the coordinate stays (it may be settlement-level,
   * which another address in the same place doesn't invalidate).
   */
  const coordUpdate = (place: string, addr: string): { coord?: GeoCoord | null } => {
    const moved = placeKey(place.trim()) !== placeKey((ev?.place?.raw ?? "").trim());
    if (coord && !moved) {
      const oldAddr = (ev?.address?.raw ?? "").trim().toLowerCase();
      const newAddr = addr.trim().toLowerCase();
      const pairPin =
        newAddr && newAddr !== oldAddr ? pairCoords.get(placeAddrCoordKey(place, addr)) : undefined;
      return pairPin ? { coord: pairPin } : {};
    }
    const known = knownCoord(place, addr);
    if (known) return { coord: known };
    return coord ? { coord: null } : {};
  };

  /**
   * The FORM half of a commit that sets the place: the schema the file already
   * writes for that very place, so choosing an existing value brings its levels
   * along the way {@link coordUpdate} brings its position. Nothing is inferred
   * here — a place the file has never labelled simply gets no FORM, and the
   * write path drops a leftover one only once it no longer fits.
   */
  const formUpdate = (place: string): { placeForm?: string } => {
    const known = placeForms.get(placeKey(place.trim()));
    return known ? { placeForm: known } : {};
  };

  /** Combo pick fills both fields in one commit — shared by both hosts. */
  const pickCombo = (place: string, addr: string) => {
    placeField.set(place);
    addrField.set(addr);
    commitAll({ place, address: addr, ...coordUpdate(place, addr), ...formUpdate(place) });
  };
  /**
   * A register's offer for a place the file has never written: its jurisdiction
   * chain (already shaped to this file's layout), the house address when the
   * address register answered, and the coordinate the register puts it at —
   * written in one commit, so it is a single undo step.
   *
   * The coordinate comes along unconditionally, unlike {@link knownCoord}'s: it
   * is this place's own, not a neighbouring event's, so it cannot coarsen
   * anything — and an event whose coordinate was already set is not the case
   * that reaches here (the place is being typed).
   */
  const pickProposal = (proposal: PlaceProposal) => {
    placeField.set(proposal.plac);
    if (proposal.addr) addrField.set(proposal.addr);
    commitAll({
      place: proposal.plac,
      ...(proposal.addr ? { address: proposal.addr } : {}),
      coord: proposal.coord,
      ...(proposal.govId ? { govId: proposal.govId } : {}),
      ...(proposal.form ? { placeForm: proposal.form } : {}),
    });
  };
  /**
   * The same offer picked from the **address** field, where the register is
   * being asked *where* a house stands, not what to call it. The address a row
   * already holds is the user's own wording — "Olševek 1 / 2 (pd Pilar)" names
   * two houses and the farm on them, which no register line will ever say — so
   * it survives being placed, and so does a place that is already written.
   * Text is filled only where the field is empty, or replaced where the two
   * differ by nothing but spelling (the register's diacritics are worth
   * having). The coordinate always comes along: it is what the offer was
   * picked for. A place kept as the file writes it keeps its own id and FORM
   * too — those describe the chain that stayed, not the one that was offered.
   */
  const pickAddrProposal = (proposal: PlaceProposal) => {
    // What to write, or undefined to keep what the field already says.
    const adopt = (own: string, offered: string | undefined) =>
      !own.trim() || (offered && placeCollator.compare(own.trim(), offered) === 0) ? offered : undefined;
    const place = adopt(placeField.value, proposal.plac);
    const addr = adopt(addrField.value, proposal.addr);
    if (place) placeField.set(place);
    if (addr) addrField.set(addr);
    commitAll({
      coord: proposal.coord,
      ...(place
        ? {
            place,
            ...(proposal.govId ? { govId: proposal.govId } : {}),
            ...(proposal.form ? { placeForm: proposal.form } : {}),
          }
        : {}),
      ...(addr ? { address: addr } : {}),
    });
  };
  // The address field's combos: pairs at other places (this place's own
  // addresses are already its plain suggestions), so an address lookup there
  // can move place+address together.
  const addrCombos = useMemo(
    () => placeCombos.filter((cb) => placeKey(cb.place) !== placeKey(placeField.value)),
    [placeCombos, placeField.value],
  );
  const noteField = useField(ev?.note ?? "", noteMergeVal);
  // NotesEditor seeds its own state from these once; remount it when the event's
  // notes change underneath (a commit rebuilds the record, undo/redo replaces
  // it) so it shows what the record now holds rather than what it was handed.
  const noteEditorKey = (ev?.noteRefs ?? []).map((r) => `${r.xref ?? ""}:${r.text}:${r.private ? 1 : 0}`).join("|");
  const agencyField = useField(ev?.agency ?? "", agencyMergeVal);
  const typeField = useField(ev?.type ?? "", typeMergeVal);
  const causeField = useField(ev?.cause ?? "", causeMergeVal);
  const templeField = useField(ev?.temple ?? "", templeMergeVal);
  const statusField = useField(ev?.status ?? "", statusMergeVal);
  const ageField = useField(ev?.age ?? "", ageMergeVal);
  const husbandAgeField = useField(ev?.husbandAge ?? "", husbandAgeMergeVal);
  const wifeAgeField = useField(ev?.wifeAge ?? "", wifeAgeMergeVal);
  // The sort date has no merge row of its own: it is a hint for ordering,
  // carried with the event it sorts, never a fact to choose between.
  const sortDateField = useField(ev?.sortDate?.raw ?? "", undefined);
  // The row stays mounted (same stable key) when its tag changes via
  // `onChangeTag`, so — unlike `useField` — track dirtiness against the tag
  // this row mounted with, not against `ev`'s own value (there's no GedEvent
  // field to compare against).
  const initialTagRef = useRef(tag);
  const tagDirty = tag !== undefined && tag !== initialTagRef.current;
  // Only the event's own WWW/URL-tag links are editable. Links from the
  // event's own OBJE children (`ev.mediaLinks`) are removable via the
  // media-link dialog. The rest of `ev.links` is harvested — URLs living in
  // note text: rewriting those as WWW lines would duplicate them, and
  // "removing" one would be a no-op (the chip reappears on the next
  // rebuild), so they render as read-only chips below.
  const [links, setLinks] = useState<string[]>(ev?.editableLinks ?? []);
  const mediaLinks = ev?.mediaLinks ?? [];
  const harvestedLinks = harvestedLinksOf(ev?.links, [...(ev?.editableLinks ?? []), ...mediaLinks]);
  // The page images the merge will link here, minus any the event already has
  // (`linkPageMedia` never adds a page twice, and neither should the preview).
  const previewPageImages = (pageImagesMergeVal ?? []).filter(
    (url) => !mediaLinks.some((have) => linkKey(have) === linkKey(url)),
  );
  // Secondary fields the user chose to add via the "+ Detail" menu on a sparse
  // event (they start empty). `focusKey` moves focus to the one just added.
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  // The field the caret is in stays shown though its last character is
  // deleted: hidden, it would drop the focus to the page, where the next ⌫
  // is Back.
  const [focusedDetail, setFocusedDetail] = useState<string | null>(null);
  // Bumped by "+ Detail › Note" to open one more empty chip in the note list.
  const [noteAddTrigger, setNoteAddTrigger] = useState(0);
  // Bumped by ⌥⇧D to open the "+ Detail" menu from wherever the keyboard is.
  const [addDetailNonce, setAddDetailNonce] = useState(0);
  const lastOpenDetailNonce = useRef(openDetailMenuNonce);
  useEffect(() => {
    if (openDetailMenuNonce === undefined || openDetailMenuNonce === lastOpenDetailNonce.current) return;
    lastOpenDetailNonce.current = openDetailMenuNonce;
    setAddDetailNonce((n) => n + 1);
  }, [openDetailMenuNonce]);
  /** True while "+ Add › Association" has this row's person picker open. */
  const [assocPicking, setAssocPicking] = useState(false);
  // Editing the people an event names needs the Edit view's file and dialect
  // (see AssocContext); the merge's read-only rows have neither and offer none.
  // A 5.5.x file has no event-level `ASSO` at all, so there the row offers none
  // either and the person's own record is where one goes — the panel under the
  // event list. Associations such a file already carries here still show and
  // still edit; only writing a new one is refused.
  const assocApi = useAssoc();
  const canAssoc = !!assocApi && !!eventNode && canWriteEventAssociation(assocApi.version);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // EVEN remaps the Agency slot to its line value; every other event keeps the
  // normal value/agency mapping.
  const agencySlotField = agencyField;
  const agencySlotForced = agencyForced;
  const agencySlotLabel = t("event.agency", { event: label });

  // What the value and the type fields complete from: this tag's own values,
  // and nobody else's — the occupations for an Occupation, the words other
  // marriages call themselves for a marriage's type. A tag the file has never
  // written yet has nothing to offer, which is the empty pair.
  const valueSuggestions = (tag && tagSuggestions.values.get(tag)) || EMPTY_SUGGESTIONS;
  const typeSuggestions = (tag && tagSuggestions.types.get(tag)) || EMPTY_SUGGESTIONS;
  // The list is short and the field is often empty (an occupation is typed into
  // a fresh row), so it opens on focus the way the cause's does.
  const valueCompletion = { ...valueSuggestions, offerAllWhenEmpty: true };

  // EVEN's TYPE doubles as its display label; while it has one, the label
  // column shows it in place of the generic "Event"/"Fact". A type a program
  // wrote in its own namespace reads as its registry name instead — the raw
  // value stays in the Title field, which is the data the user edits.
  const customName = isEven
    ? customEventLabel(typeField.value.trim() || ev?.type?.trim(), t, i18n.language)
    : "";

  // Only value events (OCCU/EDUC/RETI) expose a Title slot (their line value).
  // Plain events have none — their TYPE lives in the extras-line Type field
  // instead; EVEN edits its TYPE there too, relabelled "Title" and always
  // shown (a custom event is named by it).
  const hasTitle = !isEven && showValue && !valueIsExtra;

  // Sizes a flowing field to its content (in `ch`) so short values like "fsd"
  // don't each claim a full-width column — that content-sizing is what lets the
  // place and the secondary fields pack onto one wrapped line and only spill to
  // a second row when they genuinely don't fit. The floor keeps an empty or
  // short field a sensible typing target rather than a token-sized box; the +4
  // (not a snug +2) leaves the ~2.5ch the input reserves for its × button.
  const chW = (v: string, max = 40) => ({ width: `${Math.min(max, Math.max(12, v.trim().length + 4))}ch` });
  // Notes can be multi-line, so size them to the widest line, not the whole
  // string's length (which would over-widen a stack of short lines). The floor
  // is generous — notes are prose, and a freshly added one should offer a
  // sentence's worth of room, not a token-sized box.
  const noteW = (v: string, max = 50) => {
    const longest = v.split("\n").reduce((m, line) => Math.max(m, line.length), 0);
    return { width: `${Math.min(max, Math.max(18, longest + 4))}ch` };
  };

  // Compact layout: a field with no value (and not showing an incoming merge
  // value) is collapsed to zero height/width at rest and only revealed when the
  // event row is hovered or focused. The primary line carries the near-universal
  // Date + Place (or the value, for value-events); every other populated field
  // flows together on a wrapped "extras" line below, so a typical event with a
  // couple of extra fields lands on two rows instead of a rigid three-row grid
  // full of holes. Incoming merge suggestions count as "shown" (their value is
  // displayed even before it's written), so they never hide.
  const optCls = (shown: boolean) => (shown ? "" : " ev-collapsed");
  // The date is the event's anchor, so ordinary date/place events always show it
  // (it's also where a brand-new event is typed). Place and every other field
  // are content-driven: shown only when they have a value (or an incoming merge
  // value, or the user adds them), so an event without a place reserves no empty
  // slot. Value-events (OCCU/EDUC/RETI/EVEN) lead with their value instead.
  const primaryLine = !hasTitle;
  // Every event leads with its date, value-events included. Their value used to
  // take the lead slot and their date stayed hidden until it had one, so the
  // first field on an Occupation sat where the date sits on every other row —
  // the columns did not line up and neither did the typing.
  const dateShown = true;
  // A custom EVEN/FACT is named by its TYPE, so its Title field always shows.
  const typeShown = isEven || Boolean(typeField.value.trim()) || typeField.isMerge;
  const valueExtraShown = valueIsExtra && (Boolean(valueField.value.trim()) || valueField.isMerge);
  const placeShown = Boolean(placeField.value.trim()) || placeField.isMerge;
  const addrShown = Boolean(addrField.value.trim()) || addrField.isMerge || hasStructure;
  const ageShown = Boolean(ageField.value.trim()) || ageField.isMerge;
  const husbandAgeShown = Boolean(husbandAgeField.value.trim()) || husbandAgeField.isMerge;
  const wifeAgeShown = Boolean(wifeAgeField.value.trim()) || wifeAgeField.isMerge;
  const agencyShown = Boolean(agencySlotField.value.trim()) || agencySlotField.isMerge;
  const causeShown = Boolean(causeField.value.trim()) || causeField.isMerge;
  const templeShown = Boolean(templeField.value.trim()) || templeField.isMerge;
  const statusShown = Boolean(statusField.value.trim()) || statusField.isMerge;
  const sortDateShown = Boolean(sortDateField.value.trim());
  const noteShown = Boolean(noteField.value.trim()) || noteField.isMerge;
  const sourcesShown =
    Boolean(ev?.sources?.length) || Boolean(sourcesMergeVal?.length) || Boolean(previewPageImages.length) || links.length > 0 || mediaLinks.length > 0 || harvestedLinks.length > 0;
  // A field renders when it has content OR the user added it from the "+ Detail"
  // menu. Empty, un-added fields stay hidden — no more revealing every empty
  // field on hover, which read as a crowded row of blank labelled inputs.
  const kept = (key: string) => revealed.has(key) || focusedDetail === key;
  const show = {
    date: dateShown || kept("date"),
    value: valueExtraShown || kept("value"),
    place: placeShown || kept("place"),
    addr: addrShown || kept("addr"),
    type: typeShown || kept("type"),
    agency: agencyShown || kept("agency"),
    cause: causeShown || kept("cause"),
    temple: templeShown || kept("temple"),
    status: statusShown || kept("status"),
    age: ageShown || kept("age"),
    husbandAge: husbandAgeShown || kept("husbandAge"),
    wifeAge: wifeAgeShown || kept("wifeAge"),
    sortDate: sortDateShown || kept("sortDate"),
    note: noteShown || kept("note"),
    assoc: Boolean(ev?.associations?.length) || revealed.has("assoc"),
  };
  // Fields offered by the "+ Detail" menu: source is always addable; the rest
  // only while not already showing. Place/address adapt to the event kind
  // (ordinary events show Place on the primary line, so only Address is offered).
  const addable: { key: string; label: string }[] = [
    ...(valueIsExtra ? [{ key: "value", label: t("event.colValue") }] : []),
    { key: "place", label: t("event.colPlace") },
    { key: "addr", label: t("event.colAddr") },
    { key: "agency", label: t("event.colAgency") },
    { key: "source", label: t("event.colLink") },
    { key: "type", label: isEven ? t("event.colTitle") : t("event.colType") },
    { key: "cause", label: t("event.colCause") },
    ...(isOrdinance ? [{ key: "temple", label: t("event.colTemple") }, { key: "status", label: t("event.colStatus") }] : []),
    { key: "note", label: t("event.colNote") },
    // Like a source, always offered: an event names as many godparents and
    // witnesses as the register does, so "already shown" is no reason to stop.
    ...(canAssoc ? [{ key: "assoc", label: t("assoc.add") }] : []),
    // Rarely used, so last: the age a record states (each spouse's on a family
    // event) and a sort date for an event whose own date is missing or words.
    ...(spouseAgeLabels
      ? [
          { key: "husbandAge", label: spouseAgeLabels.husband.label },
          { key: "wifeAge", label: spouseAgeLabels.wife.label },
        ]
      : [{ key: "age", label: t("event.colAge") }]),
    { key: "sortDate", label: t("event.colSortDate") },
  ].filter((f) => f.key === "source" || f.key === "assoc" || !show[f.key as keyof typeof show]);

  /**
   * The fields a typical event is filled in, in the order they are typed: an
   * event that leads with a value (Occupation, Title) starts there, every other
   * starts at its date, and the place follows either. Enter walks this chain,
   * revealing the next field on the way — the usual date and place are typed
   * straight through, with no trip to the "+ Add" menu, and Enter past the last
   * of them lands on the "+ Detail" chip — from where the menu opens with Enter
   * again, so an address or a cause is added without touching the mouse.
   */
  const entryChain = primaryLine ? ["date", "place"] : ["date", "value", "place"];

  /** Focus this row's "+ Detail" chip — the step after the chain's last field,
   *  and after any detail added from the menu. False when the row has no
   *  detail left to offer, leaving Enter to mean what it usually does. */
  function focusAddDetail(): boolean {
    const chip = rootRef.current?.querySelector<HTMLElement>("button.edit-event-addfield");
    if (!chip) return false;
    chip.focus();
    return true;
  }

  /** Move to the field after `key` in the entry chain, or to the "+ Detail"
   *  chip once the chain is done (which is also where a field outside the
   *  chain — an added address, a cause — leads). */
  function advanceEntry(key: string): boolean {
    const at = entryChain.indexOf(key);
    const next = at === -1 ? undefined : entryChain[at + 1];
    if (!next) return focusAddDetail();
    setRevealed((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    setFocusKey(next);
    return true;
  }

  /** Enter in a chain field steps to the next one. `preventDefault` both stops
   *  the form-wide "Enter commits and blurs" rule from firing instead and
   *  marks the key as spoken for. */
  const entryKeyDown = (key: string) => (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (advanceEntry(key)) e.preventDefault();
  };

  function addDetail(key: string) {
    if (key === "source") {
      onAddSource();
      return;
    }
    setRevealed((prev) => new Set(prev).add(key));
    // "Add note" on an event that already has one means *another* note, so the
    // list opens a fresh chip rather than putting the cursor in the first.
    if (key === "note") setNoteAddTrigger((n) => n + 1);
    // Likewise an association: the entry opens the person picker rather than
    // focusing the associates already on the row.
    else if (key === "assoc") setAssocPicking(true);
    else setFocusKey(key);
  }

  // Move focus into a field the moment it's added from the "+ Detail" menu, so
  // the whole flow stays on the keyboard. The fields are always in the DOM (just
  // CSS-hidden until shown), so `autoFocus` wouldn't fire on reveal — focus it
  // imperatively once the reveal has committed.
  useEffect(() => {
    if (!focusKey) return;
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-detail="${focusKey}"] input, [data-detail="${focusKey}"] textarea, [data-detail="${focusKey}"] [contenteditable], input[data-detail="${focusKey}"]`,
    );
    el?.focus();
    setFocusKey(null);
  }, [focusKey]);

  // Quick-add targeting this already-mounted row (the Birth row): each nonce
  // bump focuses the lead input. The ref guard skips the mount run, so a row
  // remounting on person switch doesn't steal focus for a stale bump.
  const seenFocusNonce = useRef(focusLeadNonce ?? 0);
  useEffect(() => {
    if (!focusLeadNonce || focusLeadNonce === seenFocusNonce.current) return;
    seenFocusNonce.current = focusLeadNonce;
    rootRef.current
      ?.querySelector<HTMLInputElement>("input.edit-event-date")
      ?.focus();
  }, [focusLeadNonce, primaryLine]);

  // The event-type label becomes a dropdown when the tag can be reassigned
  // and/or the event copied or removed — the latter two via "Copy event to…" /
  // "Remove this event" entries appended to the end of the list.
  const showSelect = Boolean(tag) && (Boolean(onChangeTag && tagGroups) || Boolean(onCopy) || Boolean(onRemove));
  // A non-standard event tag (NOBI, _MILT …) with a page that explains it
  // stands at the row's right edge as the link to that page — apart from the
  // label, which picks the event's type, so the label drops its "(NOBI)".
  const tagTerms = tag ? termsHref(tag) : undefined;
  const tagSuffix = tagTerms && tag ? ` (${tag})` : undefined;
  if (tagSuffix && label.endsWith(tagSuffix)) label = label.slice(0, -tagSuffix.length);

  function fieldCls(base: string, isMerge: boolean, isDirty: boolean) {
    if (isMerge) return `${base} edit-input--merge`;
    if (isDirty) return `${base} edit-input--dirty`;
    return base;
  }

  const { openEditLink } = linkEditing(
    links,
    setLinks,
    (next) => commitField({ links: next }),
    (cite, extraPatches, remaining, pageObjeXref) =>
      commitField({ links: remaining, addSource: { ...cite, pageObjeXref } }, extraPatches),
    onOpenSourceDialog,
  );

  /**
   * Commit this row's fields together, not just the one that changed — see
   * {@link eventRowUpdate} for which ones are sent. Every field's blur (and
   * the place/addr autocomplete's blur-commit) routes through here
   * unconditionally, including a field the user never touched.
   */
  function commitAll(override: Partial<EventFieldUpdate>) {
    // A typed date reaches here already in the file's style: the date field
    // writes it so as it is left, and hands the written value in `override`.
    const update = eventRowUpdate(
      {
        date: dateField, value: valueField, place: placeField, address: addrField,
        note: noteField, agency: agencyField, type: typeField, cause: causeField,
        temple: templeField, status: statusField,
        age: ageField, husbandAge: husbandAgeField, wifeAge: wifeAgeField, sortDate: sortDateField,
      },
      override,
      flagOnly,
      ev?.value,
    );
    if (!update) return;
    // The field's "5 MAR 1850 14:30" is two things in the file: the DATE, and
    // the TIME under it — a time taken off the field is removed from the file.
    if (update.date !== undefined) {
      const { date, time } = splitDateTime(update.date);
      update.date = date;
      update.time = time ?? "";
    }
    // An age is typed loosely ("25", "child") and written in the file's own
    // grammar — 5.5.1 keeps its keywords, 7.0 turns one into a bound and a
    // PHRASE (see `writeAgeValue`).
    const version = assocApi?.version ?? "unknown";
    if (update.age !== undefined) {
      const written = writeAgeValue(update.age, version);
      update.age = written.value;
      if (written.phrase) update.agePhrase = written.phrase;
    }
    if (update.husbandAge !== undefined) update.husbandAge = writeAgeValue(update.husbandAge, version).value;
    if (update.wifeAge !== undefined) update.wifeAge = writeAgeValue(update.wifeAge, version).value;
    commitField(update);
  }

  /**
   * A secondary field on the flowing "extras" line: a small label + a
   * content-sized input that completes from what the file already writes in
   * that same field. Hidden when empty and not added; shown once it has a
   * value or the user picks it from the "+ Detail" menu. Hosts the Address,
   * Type, Agency, Cause and Residence-value fields — the Place field renders
   * inline in the body below, because it carries the coordinate pin too.
   *
   * Every one of them is the same autocomplete over a different list: places
   * and addresses reach the registers as well (`lookup`) and fill each other
   * in pairs (`combos`), while a type, an agency or a cause completes from the
   * file alone.
   */
  function extraField(
    key: string,
    labelText: string,
    shown: boolean,
    field: ReturnType<typeof useField>,
    forced: boolean,
    title: string,
    opts: {
      suggestions: string[];
      canonical: Map<string, string>;
      commit: (val: string) => void;
      /** Extra class on the input, where the field's width rule needs one. */
      cls?: string;
      /** Offer the list on focus — for the short per-field lists (see
       *  SuggestInput's own prop). */
      offerAllWhenEmpty?: boolean;
      combos?: { place: string; addr: string }[];
      onPickCombo?: (place: string, addr: string) => void;
      lookup?: {
        onLookup?: (query: string) => Promise<PlaceProposal[]>;
        lookupNote?: string;
        onPickProposal?: (proposal: PlaceProposal) => void;
      };
      /** Rendered after the input, inside the field's own span. */
      after?: React.ReactNode;
    },
  ) {
    return (
      <span key={key} data-detail={key} className={"edit-event-extra" + optCls(shown)}>
        <span className="edit-event-extra-label">{labelText}</span>
        {/* No pin of its own here: the event's coordinate pin already stands
            between the place and the address, and two in a row read as two
            different marks. */}
        <SuggestInput
          value={field.value}
          suggestions={opts.suggestions}
          canonical={opts.canonical}
          combos={opts.combos}
          // The address field, whose pair list is the only route to another
          // settlement, matches a typed place name too. A field with no pairs
          // at all (the agency) has nothing to match that way.
          matchCombosByPlace={!!opts.combos}
          addresses={!!opts.combos}
          offerAllWhenEmpty={opts.offerAllWhenEmpty}
          isDirty={field.isDirty || forced}
          isMerge={field.isMerge}
          className={"edit-input" + (opts.cls ? ` ${opts.cls}` : "")}
          wrapClassName="edit-event-extra-field"
          wrapStyle={chW(field.value)}
          // An extra is normally on screen only because it has content, so its
          // name lives in the hover label and the tooltip. Added from the
          // "+ Add" menu it arrives empty, and a blank unlabelled box says
          // nothing — so it names itself until something is typed, the way the
          // date and the value inputs do.
          placeholder={labelText}
          title={title}
          onChange={field.set}
          onCommit={opts.commit}
          onClear={() => { field.clear(); opts.commit(""); }}
          onPickCombo={opts.onPickCombo}
          {...opts.lookup}
        />
        {opts.after}
      </span>
    );
  }

  /** An age field: typed loosely, shown back as written in the file's grammar
   *  the moment it is left, the way a date is. */
  function ageExtra(
    key: "age" | "husbandAge" | "wifeAge",
    labelText: string,
    field: ReturnType<typeof useField>,
    forced: boolean,
    title: string,
  ) {
    return extraField(key, labelText, show[key], field, forced, title, {
      ...EMPTY_SUGGESTIONS,
      cls: "edit-event-age-input",
      commit: (val) => {
        field.set(writeAgeValue(val, assocApi?.version ?? "unknown").value);
        commitAll({ [key]: val });
      },
    });
  }

  /**
   * The row's own keys.
   *
   * ⌥⇧N, ⌥⇧S and ⌥⇧D belong to the event the keyboard is in: a note, a source
   * or a detail added while typing a burial is the burial's, not the person's.
   * Handled here so the row's own closures do the work, and marked handled —
   * EditView's window listener runs afterwards and stands down for the person.
   *
   * Enter continues the entry walk from the fields that have no handler of
   * their own (the place, and every detail added from the menu): each one leads
   * to the "+ Detail" chip, so the row is filled in without reaching for the
   * mouse. Only this row's text fields — the coordinate picker inside it reads
   * Enter as "take this coordinate".
   */
  function onRowKeyDown(e: React.KeyboardEvent) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey) return;
    if (e.altKey && e.shiftKey) {
      if (e.code === "KeyN") {
        e.preventDefault();
        addDetail("note");
      } else if (e.code === "KeyS") {
        e.preventDefault();
        onAddSource();
      } else if (e.code === "KeyD") {
        e.preventDefault();
        setAddDetailNonce((n) => n + 1);
      }
      return;
    }
    if (e.key !== "Enter" || e.altKey || e.shiftKey) return;
    const el = e.target as HTMLElement;
    if (el.tagName !== "INPUT" || !el.classList.contains("edit-input")) return;
    const key = el.closest("[data-detail]")?.getAttribute("data-detail");
    if (key && advanceEntry(key)) e.preventDefault();
  }

  /* A note that stands more than a line tall — several notes, a note of
   * several lines, or one too long for its chip — goes beside the field
   * group rather than into its wrapping flow: under the fields it added its
   * whole height to the row, while beside them the fields fold at no cost. A
   * one-line note stays in the flow, where it reads on after the fields.
   * Judged on the committed notes, not the draft being typed, so a row does
   * not re-lay itself out under the cursor. */
  // A merge-proposed note keeps its single field while it is typed into, not
  // only while it still reads as proposed: swapping the field for the list on
  // the first keystroke took the caret with it, and the next ⌫ went Back.
  const noteProposed = noteMergeVal !== undefined;
  const noteTall = noteProposed
    ? noteMergeVal.includes("\n") || noteMergeVal.length > NOTE_CHIP_CH
    : isTallNoteList(ev?.noteRefs ?? []);
  const noteEl = (
      <span data-detail="note" className={"edit-event-extra edit-event-extra--note" + optCls(show.note)}>
        <span className="edit-event-extra-label">{t("event.colNote")}</span>
        {/* An event may carry any number of notes, and one the editor cannot
            see is one it can lose. They read as chips, each with its own 🔒,
            exactly like a person's own notes.

            The single field stays for the one case the list cannot serve: a
            merge proposing a note. That value is a suggestion attached to
            this field — accepted by committing, discarded by clearing — and
            the list has no such state. Once the merge is resolved the row is
            rebuilt from the record and the list takes over again. */}
        {noteProposed ? (
          <ClearableTextarea
            wrapClassName="edit-event-extra-field"
            wrapStyle={noteW(noteField.value)}
            className={fieldCls("edit-input edit-event-note", noteField.isMerge, noteField.isDirty || noteForced)}
            value={noteField.value}
            title={t("event.note", { event: label })}
            rows={1}
            onChange={noteField.onChange}
            onBlur={() => commitAll({})}
            onClear={() => { noteField.clear(); commitAll({ note: "" }); }}
          />
        ) : (
          <NotesEditor
            key={noteEditorKey}
            notes={ev?.noteRefs ?? []}
            addTrigger={noteAddTrigger}
            t={t}
            onCommit={(refs) => commitAll({ noteRefs: refs })}
          />
        )}
      </span>
  );

  return (
    <div
      className="edit-event"
      ref={rootRef}
      onKeyDown={onRowKeyDown}
      onFocus={(e) => setFocusedDetail((e.target as HTMLElement).closest("[data-detail]")?.getAttribute("data-detail") ?? null)}
      onBlur={() => setFocusedDetail(null)}
    >
      {/* The fields wrap among themselves inside this group, and the note stands
          beside the group rather than under it: a note of seven lines used to
          push the whole event a line down and then sit alone below the fields,
          where the fields folding into two lines beside it cost nothing. */}
      <div className="edit-event-main">
      {/* Column 1: event-type label with the expand toggle beside it. When the
       * tag can be reassigned and/or the event removed, the label becomes an
       * app-styled menu — type choices (if any) plus "Copy event to…" /
       * "Remove this event" entries at the end. */}
      <div className="edit-event-type-row">
        {showSelect ? (
          <DropdownMenu
            className={fieldCls("edit-event-label edit-event-label--select", false, tagDirty || tagForced)}
            title={onChangeTag ? t("edit.changeEventType") : onCopy ? t("edit.copyEvent") : t("edit.removeEvent")}
            current={onChangeTag ? tag : undefined}
            groups={[
              ...(onChangeTag && tagGroups
                ? tagGroups.map((g) => ({
                    label: g.labelKey ? t(g.labelKey) : undefined,
                    items: g.tags.map((tg) => ({ value: tg, label: eventMenuLabel(tg, t, tagLabel?.(tg, t)) })),
                  }))
                : []),
              ...(onCopy || onRemove
                ? [{
                    items: [
                      ...(onCopy ? [{ value: COPY_OPTION, label: t("edit.copyEvent") }] : []),
                      ...(onRemove ? [{ value: REMOVE_OPTION, label: t("edit.removeEvent") }] : []),
                    ],
                  }]
                : []),
            ]}
            onSelect={(v) => {
              if (v === COPY_OPTION) onCopy?.();
              else if (v === REMOVE_OPTION) onRemove?.();
              else if (onChangeTag && v !== tag) onChangeTag(v);
            }}
            trigger={
              <>
                {markedLabel(tag, customName || label, t)}
                <span className="edit-event-type-caret" aria-hidden="true">▾</span>
              </>
            }
          />
        ) : (
          <div
            className={fieldCls("edit-event-label", false, tagDirty || tagForced)}
            title={
              isEven
                ? customEventTooltip(typeField.value.trim() || ev?.type?.trim(), t, i18n.language)
                  ?? t("event.customTooltip", { tag: tag ?? "EVEN" })
                : tag
                  ? vendorEventTooltip(tag, t, i18n.language)
                  : undefined
            }
          >
            {markedLabel(tag, customName || label, t)}
          </div>
        )}
      </div>

      {/* Leading item 2: the date — the input fills its fixed slot (text kept
       * right-aligned so the years line up in a column); the age badge follows
       * outside the slot so it never changes the date's position or size. The
       * slot is the field's own wrapper, which knows how long the date is.
       * A typed date is written in the file's style as the field is left,
       * and that written value is what the row commits. */}
        <DateInput
          wrapClassName={"edit-event-date-cell" + (dateDisplay === DATE_DISPLAY_WORDS ? " is-words" : "") + optCls(show.date)}
          data-detail="date"
          className={fieldCls("edit-input edit-event-date", dateField.isMerge, dateField.isDirty || dateForced)}
          value={dateField.value}
          placeholder={t("event.colDate")}
          label={t("event.date", { event: label })}
          autoFocus={autoFocusLead}
          onChange={dateField.set}
          onKeyDown={entryKeyDown("date")}
          onBlur={(date) => commitAll({ date })}
          withTime
          onClear={() => { dateField.clear(); commitAll({ date: "" }); }}
        />
      {/* A GEDCOM 7 date's own wording (DATE.PHRASE) reads beside the value it
          words; an edit of the date keeps it. */}
      {ev?.date?.phrase && (
        <span className="edit-event-age gm-data edit-event-date-phrase" title={t("event.datePhrase")}>
          {ev.date.phrase}
        </span>
      )}
      {age && (
        <span className="edit-event-age gm-data">
          {age.map((a, i) => (
            <span key={i} title={a.title}>{a.text}</span>
          ))}
        </span>
      )}

      {/* Body: the primary field (Place, or the value for value-events) plus
       * every populated secondary field flow together here and wrap only when
       * they don't fit — so a short extra like a cause rides on the first row
       * beside the place instead of claiming a near-empty second row. */}
      <div className="edit-event-body">
        {/* Value-events lead with their value (its own click target, always
         * shown); ordinary events lead with the date, already rendered above. */}
        {!primaryLine && (
          /* An occupation, a religion, an education: the value *is* the event,
             and the file writes the same handful of them over and over, so the
             field completes from this tag's own values and offers them the
             moment it is entered. Enter still walks on to the place — the
             dropdown only takes the key while one of its rows is highlighted. */
          <SuggestInput
            dataDetail="value"
            value={valueField.value}
            suggestions={valueSuggestions.suggestions}
            canonical={valueSuggestions.canonical}
            offerAllWhenEmpty
            isDirty={valueField.isDirty || valueForced}
            isMerge={valueField.isMerge}
            className="edit-input edit-event-value"
            wrapClassName="edit-event-primary"
            wrapStyle={chW(valueField.value, 60)}
            placeholder={t("event.colTitle")}
            title={label}
            onChange={valueField.set}
            onCommit={(val) => commitAll({ value: val })}
            onClear={() => { valueField.clear(); commitAll({ value: "" }); }}
          />
        )}
        {/* Place — the same everywhere: unlabelled (a place reads as a place) and
         * shown only when it has content, so no event reserves an empty slot. */}
        <span data-detail="place" className={"edit-event-extra edit-event-extra--place" + optCls(show.place)}>
          <SuggestInput
            value={placeField.value}
            suggestions={placeSuggestions}
            canonical={placeCanonical}
            combos={placeCombos}
            isDirty={placeField.isDirty || placeForced}
            isMerge={placeField.isMerge}
            className="edit-input edit-event-place"
            wrapClassName="edit-event-extra-field"
            wrapStyle={chW(placeField.value, 60)}
            // The row's own place field is rendered here rather than through
            // `extraPlace`, so it needs the same self-naming placeholder: added
            // from the "+ Add" menu it arrives empty like any other extra.
            placeholder={t("event.colPlace")}
            // The place's translations (GEDCOM 7 TRAN) ride on its hover.
            title={[t("event.place", { event: label }), ...(ev?.place?.translations ?? []).map((tr) => translationLine(tr.value, tr.lang))].join("\n")}
            onChange={placeField.set}
            onCommit={(val) => {
              // Picking (or typing) a place the file already knows brings its
              // coordinate and its FORM along, so the event is placed and
              // described without a second step — and moving to a place it
              // doesn't know clears the old position.
              commitAll({ place: val, ...coordUpdate(val, addrField.value), ...formUpdate(val) });
            }}
            onClear={() => { placeField.clear(); commitAll({ place: "" }); }}
            onPickCombo={pickCombo}
            onPickProposal={pickProposal}
            // A place is looked up on its own; with online lookups off the
            // imported gazetteer still answers, so the search stays offered.
            onLookup={lookup ? (query) => lookup.search(query) : undefined}
            lookupNote={lookup && !lookup.online ? t("event.place.lookup.offlineOnly") : undefined}
          />
          {/* This event's own coordinate: a pin showing whether it has one, and
           *  opening the per-event picker. Here rather than only in the Tools
           *  list because the same place value may be coordinated on one event
           *  and not another — and because the Tools list only offers places
           *  *missing* a coordinate, so a settlement-pinned place whose address
           *  could be pinned at the house has no row there. */}
          {(fileUsesCoords || coord) && (
          <EventCoordPicker
            place={placeField.value}
            address={addrForCoord}
            coord={coord}
            title={label}
            // What the file already knows for this place / this exact address,
            // so the picker can propose it without any lookup.
            fileCoord={placeCoords.get(placeKey(placeField.value))}
            filePairCoord={
              addrForCoord.trim() ? pairCoords.get(placeAddrCoordKey(placeField.value, addrForCoord)) : undefined
            }
            onPick={(c) => commitAll({ coord: c })}
            onClear={() => commitAll({ coord: null })}
          />
          )}
        </span>
        {extraField("addr", t("event.colAddr"), show.addr, addrField, addrForced, t("event.addr", { event: label }), {
          suggestions: placeToAddrs.get(placeKey(placeField.value)) ?? [],
          canonical: addrCanonical,
          cls: "edit-event-addr",
          combos: addrCombos,
          onPickCombo: pickCombo,
          commit: (val) => commitAll({ address: val, ...coordUpdate(placeField.value, val) }),
          lookup: {
            // An address is looked up inside the event's place — and only online:
            // house numbers are in the address registers, never in an imported
            // gazetteer, so with the opt-in off the row says why instead of
            // offering a search that could not answer.
            onLookup: lookup?.online ? (query) => lookup.searchAddress(placeField.value, query) : undefined,
            lookupNote: lookup && !lookup.online ? t("tools.geocode.downloadNeedsOptIn") : undefined,
            onPickProposal: pickAddrProposal,
          },
          // The address's labelled lines and contact details, folded away
          // behind the field until asked for (or until the event has some).
          after: (
            <button
              type="button"
              className="edit-addr-toggle"
              aria-expanded={addrOpen}
              {...tipProps(t(addrOpen ? "event.addrPartsHide" : "event.addrPartsShow"))}
              onClick={() => setAddrOpen((o) => !o)}
            >
              {addrOpen ? "▴" : "▾"}
            </button>
          ),
        })}
        {show.addr && addrOpen && (
          <AddressStructure
            key={addrStructureKey}
            ev={ev}
            label={label}
            t={t}
            commit={(update) => commitAll(update)}
          />
        )}
        {spouseAgeLabels ? (
          <>
            {ageExtra("husbandAge", spouseAgeLabels.husband.label, husbandAgeField, husbandAgeForced, spouseAgeLabels.husband.title)}
            {ageExtra("wifeAge", spouseAgeLabels.wife.label, wifeAgeField, wifeAgeForced, spouseAgeLabels.wife.title)}
          </>
        ) : (
          ageExtra("age", t("event.colAge"), ageField, ageForced, t("event.ageTitle", { event: label }))
        )}
        {/* The tag's own line value, for events that lead with the date instead
            of it (RESI) — otherwise it is the primary field rendered above. */}
        {valueIsExtra && extraField("value", t("event.colValue"), show.value, valueField, valueForced, t("event.value", { event: label }), {
          ...valueCompletion,
          cls: "edit-event-value",
          commit: (val) => commitAll({ value: val }),
        })}
        {extraField(
          "type",
          isEven ? t("event.colTitle") : t("event.colType"),
          show.type,
          typeField,
          typeForced,
          isEven ? t("event.customTooltip", { tag: tag ?? "EVEN" }) : t("event.type", { event: label }),
          {
            // The same few words over and over — a marriage is "civil" or
            // "cerkvena", a custom event is the kind of event it is — and per
            // tag, since none of them mean anything on another kind of event.
            suggestions: typeSuggestions.suggestions,
            canonical: typeSuggestions.canonical,
            cls: "edit-event-type",
            offerAllWhenEmpty: true,
            commit: (val) => commitAll({ type: val }),
          },
        )}
        {/* The agency completes from the ones the file already names — a tree
            keeps returning to the same handful of parishes and offices. */}
        {extraField("agency", t("event.colAgency"), show.agency, agencySlotField, agencySlotForced, agencySlotLabel, {
          suggestions: agencySuggestions,
          canonical: agencyCanonical,
          commit: (val: string) => commitAll({ agency: val }),
          cls: "edit-event-agency",
        })}
        {/* The cause completes from the ones the file already names, and offers
            them as soon as the field is entered: a register's deaths run on a
            few repeated causes, and the exact wording of one already recorded
            is the wording this one wants too. */}
        {extraField("cause", t("event.colCause"), show.cause, causeField, causeForced, t("event.cause", { event: label }), {
          suggestions: causeSuggestions,
          canonical: causeCanonical,
          cls: "edit-event-cause",
          offerAllWhenEmpty: true,
          commit: (val) => commitAll({ cause: val }),
        })}
        {/* An ordinance's temple and status. The status offers the standard's
            values that both GEDCOM versions spell alike; a status that changes
            is dated today on its own line (see `applyOrdinanceStatus`). */}
        {isOrdinance && extraField("temple", t("event.colTemple"), show.temple, templeField, templeForced, t("event.temple", { event: label }), {
          suggestions: [],
          canonical: NO_CANONICAL,
          commit: (val) => commitAll({ temple: val }),
        })}
        {isOrdinance && extraField("status", t("event.colStatus"), show.status, statusField, statusForced, t("event.status", { event: label }), {
          suggestions: ORDINANCE_STATUSES,
          canonical: NO_CANONICAL,
          offerAllWhenEmpty: true,
          commit: (val) => commitAll({ status: val }),
        })}
        {/* The sort date (GEDCOM 7 SDATE): where the event belongs in the list
            when its own date is missing or only words. Typed like any date,
            and written with the tag the file's version has for it. */}
        <span data-detail="sortDate" className={"edit-event-extra" + optCls(show.sortDate)}>
          <span className="edit-event-extra-label">{t("event.colSortDate")}</span>
          <DateInput
            className={fieldCls("edit-input edit-event-sortdate", false, sortDateField.isDirty)}
            wrapClassName="edit-event-extra-field"
            value={sortDateField.value}
            placeholder={t("event.colSortDate")}
            label={t("event.sortDate", { event: label })}
            onChange={sortDateField.set}
            onBlur={(sortDate) => commitAll({ sortDate, sortDateTag: sortDateTag(dateEntryVersion()) })}
            onClear={() => { sortDateField.clear(); commitAll({ sortDate: "" }); }}
          />
        </span>
        {/* Sources and links lead the note: the note is a textarea that grows to
            as many lines as it holds, and after it the icons ended up alone at
            the foot of a tall row, far from the event they belong to. */}
        <span className={"edit-event-extra edit-event-extra--sources" + optCls(sourcesShown)}>
          {/* Labelled like every other field on the row — a bare 📖 between the
              agency and the note said nothing about what it opens. Same wording
              as the add-detail menu's entry for this field. */}
          <span className="edit-event-extra-label">{t("event.colLink")}</span>
          {ev?.sources?.length || sourcesMergeVal?.length ? (
            <SourceRefs t={t} mainSources={ev?.sources} incomingSources={sourcesMergeVal} onEdit={onEditSource} />
          ) : null}
          {/* Like the citation icons: the chip opens a dialog, so a
              hover-revealed ↗ beside it opens the URL directly. */}
          {links.map((link, i) => (
            <span key={i} className="source-ref-wrap">
              <button
                type="button"
                className={`${linkGlyph(link).cls} edit-link-icon`}
                {...tipProps(linkTooltip(link, t, ""), { edit: true, href: linkHref(link), heading: link, kind: t("source.kindLink") })}
                onClick={() => openEditLink(i)}
              >
                {linkGlyph(link).icon}
              </button>
              <a className="source-ref-open" href={linkHref(link)} target="_blank" rel="noopener noreferrer" {...tipProps(linkTooltip(link, t, t("edit.openLink")))}>
                ↗
              </a>
            </span>
          ))}
          {/* Always the generic 🔗, never the site glyph — beside a ⛪ source
              citation a second ⛪ read as another citation, when this is only
              a media link. */}
          {mediaLinks.map((link) => (
            <span key={`media-${link}`} className="source-ref-wrap">
              <button
                type="button"
                className="link-icon edit-link-icon"
                {...tipProps(mediaLinkTooltip(link, t, ev?.mediaTitles?.[link]), { edit: true, href: linkHref(link), heading: ev?.mediaTitles?.[link] ?? link, kind: t("source.kindMedia") })}
                onClick={() => onOpenMediaLink?.(link)}
              >
                🔗
              </button>
              <a className="source-ref-open" href={linkHref(link)} target="_blank" rel="noopener noreferrer" {...tipProps(linkTooltip(link, t, t("edit.openLink")))}>
                ↗
              </a>
            </span>
          ))}
          {harvestedLinks.map((link) => (
            <a
              key={link}
              className={linkGlyph(link).cls}
              href={linkHref(link)}
              target="_blank"
              rel="noreferrer"
              {...tipProps(linkTooltip(link, t, t("edit.harvestedLink")), { heading: link })}
            >
              {linkGlyph(link).icon}
            </a>
          ))}
          {/* The cited page's image the merge will link here — the same generic
              🔗 the saved link becomes, tinted as incoming until then. */}
          {previewPageImages.map((link) => (
            <a
              key={`merge-media-${link}`}
              className="link-icon link-new"
              href={linkHref(link)}
              target="_blank"
              rel="noopener noreferrer"
              {...tipProps(mediaLinkTooltip(link, t), { heading: link, kind: t("source.kindMedia") })}
            >
              🔗
            </a>
          ))}
        </span>
        {/* The people this event names — godparents, witnesses, the officiant.
            They belong to the event, not to the person, so they are edited
            here, beside its date and place. */}
        {(show.assoc || assocPicking) && (
          <span data-detail="assoc" className={"edit-event-extra edit-event-extra--assoc" + optCls(true)}>
            <span className="edit-event-extra-label">{t("assoc.heading")}</span>
            <EventAssociates
              associations={ev?.associations ?? []}
              container={eventNode}
              ownerId={personId ?? ""}
              t={t}
              picking={assocPicking}
              onDonePicking={() => setAssocPicking(false)}
            />
          </span>
        )}
        {!noteTall && noteEl}
        {/* Add a source / place / note / other detail without keeping every empty
         * field on screen — the menu offers only the ones not already shown. */}
        {addable.length > 0 && (
          <DropdownMenu
            className="edit-event-addfield"
            title={t("edit.addDetailTooltip", { key: altShiftLabel("D") })}
            groups={[{ items: addable.map((f) => ({ value: f.key, label: f.label })) }]}
            onSelect={addDetail}
            trigger={<>+ {t("edit.addDetail")}</>}
            openNonce={addDetailNonce}
          />
        )}
      </div>
      </div>
      {noteTall && noteEl}
      {tagTerms && (
        <a className="edit-event-tag tag-terms-link" href={tagTerms} target="_blank" rel="noopener" title={t("tools.validate.struct.terms")}>
          {tag}
          <span className="edit-event-tag-info" aria-hidden="true">ⓘ</span>
        </a>
      )}
    </div>
  );
}
