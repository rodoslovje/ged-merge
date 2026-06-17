import React, { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Family, GedEvent, Individual, Sex } from "../gedcom/types";
import type { Translate } from "../locales/i18n";
import { datesTooltipOf, lifespanOf } from "../gedcom/lifespan";
import { ADDITIONAL_NAME_TYPES, defaultHomeId, displayName, nameTypeLabel, primaryName } from "../match/relatives";
import { kinshipLabel } from "../match/kinship";
import { INDI_EVENT_TAGS } from "../gedcom/builder";
import { dateToSortKey, individualFieldRows, orderedEventTags } from "../review/fields";
import { defaultChoice, type CandidateDecision } from "../review/types";
import {
  addAdditionalName,
  addChild,
  addEventNode,
  addFamilyEventNode,
  addParent,
  addPartner,
  detachChildFromFamily,
  detachSpouseRole,
  rebuildFamily,
  rebuildIndividual,
  removeAdditionalName,
  removeEventAtIndex,
  restoreEvent,
  removeIndividual,
  setAdditionalName,
  setEventField,
  setEventFieldAtIndex,
  setFamilyEventField,

  setFamilyNotes,
  setIndividualLinks,
  setName,
  setNickname,
  setNotes,
  setSex,
  type EventFieldUpdate,
} from "../gedcom/edit";
import { sexClass } from "./sex";
import { HomePersonSelector } from "./HomePersonSelector";
import { PersonCard } from "./PersonCard";

// Assign a monotonically increasing integer to each GedNode object so React
// keys remain stable across insertions and removals of sibling events.
const _nodeIds = new WeakMap<object, number>();
let _nextNodeId = 0;
function nodeId(node: object): number {
  if (!_nodeIds.has(node)) _nodeIds.set(node, _nextNodeId++);
  return _nodeIds.get(node)!;
}

interface Props {
  dataset: Dataset;
  fileName: string;
  /** Seeds the initial selection (the Merge-mode home person, if set). */
  homeId?: string;
  /** Called to change (or clear) the home person. */
  changeHome: (id: string | undefined) => void;
  /** Called whenever the dataset is mutated so the parent can track which records changed. */
  onDirty: (type: "individual" | "family", id: string) => void;
  /** Open the edit tree rooted on the currently selected person. */
  onShowTree: (id: string) => void;
  /** Navigate to this person when it changes (used by the save dialog person links). */
  navigateToId?: string;
  /** When set, shows a Merge button to switch to merge mode. Called with the current person's ID. */
  onMerge?: (currentPersonId: string) => void;
  /** Returns true when the given person ID has a match in the merge list. */
  canMerge?: (id: string) => boolean;
  /** Merge decisions — used to preview incoming values for confirmed matches. */
  decisions?: Map<string, CandidateDecision>;
  /** The incoming dataset — needed to resolve confirmed match incoming values. */
  compareDataset?: Dataset;
}

/** Event tags that carry a direct text value on the tag line (e.g. `1 OCCU Farmer`). */
const VALUE_EVENT_TAGS = new Set(["OCCU", "EDUC", "RETI"]);

/** Groups for the "Add event" dropdown — BIRT is always shown so it's excluded. */
const INDIVIDUAL_EVENT_GROUPS = [
  { labelKey: "eventGroup.earlyLife", tags: ["BAPM", "CHR", "CONF", "ADOP", "FCOM"] },
  { labelKey: "eventGroup.career",    tags: ["OCCU", "EDUC", "RETI"] },
  { labelKey: "eventGroup.residence", tags: ["RESI", "EMIG", "IMMI", "NATU", "CENS"] },
  { labelKey: "eventGroup.estate",    tags: ["WILL", "PROB"] },
  { labelKey: "eventGroup.death",     tags: ["DEAT", "BURI", "CREM"] },
] as const;

/** Family events that are hidden until explicitly added (marriage is always shown). */
const FAMILY_HIDDEN_EVENT_TAGS = ["ENGA", "SEPA", "DIV"];

/** A mutation applied to the selected person's raw record, then rebuilt and
 * re-rendered. */
type Commit = (mutate: (indi: Individual) => void) => void;

/** A mutation applied to a family's raw record, then rebuilt and
 * re-rendered. */
type FamilyCommit = (fam: Family, mutate: (fam: Family) => void) => void;

interface PlaceSuggestions {
  placeSuggestions: string[];
  /** Canonical place key → sorted unique address strings seen at that place. */
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
}

function placeKey(raw: string): string {
  return raw.trim().split(",").map((p) => p.trim().toLowerCase()).join("|");
}

/** Collect all unique PLAC and ADDR values from a dataset and build canonical
 * maps (most-frequent casing wins) for normalize-on-blur. */
function buildPlaceSuggestions(dataset: Dataset): PlaceSuggestions {
  const placeForms = new Map<string, Map<string, number>>();
  const addrForms = new Map<string, Map<string, number>>();
  // placeKey → addrRaw → count
  const placeAddrForms = new Map<string, Map<string, number>>();

  function addValue(forms: Map<string, Map<string, number>>, raw: string) {
    const r = raw.trim();
    if (!r) return;
    const key = placeKey(r);
    const m = forms.get(key) ?? new Map<string, number>();
    m.set(r, (m.get(r) ?? 0) + 1);
    forms.set(key, m);
  }

  function addEventValues(placeRaw: string | undefined, addrRaw: string | undefined) {
    if (placeRaw) addValue(placeForms, placeRaw);
    if (addrRaw) addValue(addrForms, addrRaw);
    if (placeRaw && addrRaw) {
      const pk = placeKey(placeRaw);
      const ar = addrRaw.trim();
      if (ar) {
        const m = placeAddrForms.get(pk) ?? new Map<string, number>();
        m.set(ar, (m.get(ar) ?? 0) + 1);
        placeAddrForms.set(pk, m);
      }
    }
  }

  for (const indi of dataset.individuals.values()) {
    for (const ev of indi.events) addEventValues(ev.place?.raw, ev.address?.raw);
  }
  for (const fam of dataset.families.values()) {
    for (const ev of fam.events) addEventValues(ev.place?.raw, ev.address?.raw);
  }

  function build(forms: Map<string, Map<string, number>>): { suggestions: string[]; canonical: Map<string, string> } {
    const canonical = new Map<string, string>();
    const suggestions: string[] = [];
    for (const [key, m] of forms) {
      let best = "";
      let bestCount = 0;
      for (const [form, count] of m) {
        if (count > bestCount) { best = form; bestCount = count; }
      }
      canonical.set(key, best);
      suggestions.push(best);
    }
    suggestions.sort();
    return { suggestions, canonical };
  }

  const place = build(placeForms);
  const addr = build(addrForms);

  const placeToAddrs = new Map<string, string[]>();
  for (const [pk, m] of placeAddrForms) {
    placeToAddrs.set(pk, [...m.keys()].sort());
  }

  return {
    placeSuggestions: place.suggestions,
    placeToAddrs,
    placeCanonical: place.canonical,
    addrCanonical: addr.canonical,
  };
}

/** Width (in `ch`) that fits `value` (or, while empty, `placeholder`)
 * without the input growing/shrinking awkwardly as the user types — used to
 * keep name fields compact instead of stretching to fill the row. */
function fieldWidth(value: string, placeholder: string): string {
  const len = value.length > 0 ? value.length : placeholder.length;
  return `${Math.max(len, 3) + 2}ch`;
}

/** Edit mode's person view: parents on top, the selected person in the
 * center, partners + children on the bottom. The center panel is editable;
 * relatives navigate on click. */
export function EditView({ dataset, fileName, homeId, changeHome, onDirty, onShowTree, navigateToId, onMerge, canMerge, decisions, compareDataset }: Props) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => homeId ?? defaultHomeId(dataset) ?? dataset.individuals.keys().next().value,
  );
  const [history, setHistory] = useState<string[]>([]);
  // Bumped after every edit to force a re-render — the dataset is mutated
  // in place, so React has no other signal that `person` changed.
  const [tick, setTick] = useState(0);
  const focusNextName = useRef(false);
  // Whether the user has clicked "+ Add link" or "+ Add note" for the current person.
  const [linksAdded, setLinksAdded] = useState(false);
  const [notesAdded, setNotesAdded] = useState(false);
  // Trigger counters to add a note to a specific family (keyed by family ID).
  const [famNoteAdd, setFamNoteAdd] = useState<Record<string, number>>({});

  function navigate(id: string) {
    if (!id || id === selectedId) return;
    if (selectedId) setHistory((h) => [...h, selectedId]);
    setLinksAdded(false);
    setNotesAdded(false);
    setSelectedId(id);
  }

  useEffect(() => {
    if (navigateToId) navigate(navigateToId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigateToId]);

  function goBack() {
    setHistory((h) => {
      if (h.length === 0) return h;
      setSelectedId(h[h.length - 1]);
      return h.slice(0, -1);
    });
  }

  const person = selectedId ? dataset.individuals.get(selectedId) : undefined;

  /** Merge preview data for the currently selected person's confirmed match. */
  const mergeData = useMemo(() => {
    const empty = {
      mergeHighlight: new Map<string, string>(),
      /** master person.events overall index → field key base aligned with orderedEventTags. */
      masterMergeKeyBases: new Map<number, string>(),
      /** master person.events overall index → sort key from incoming date, when master has no date. */
      masterMergeSortKeys: new Map<number, number>(),
      /** Incoming-only events with no master counterpart (BIRT excluded — always shown). */
      extraMergeEvents: [] as { tag: string; keyBase: string; sortKey: number }[],
    };
    if (!decisions || !compareDataset || !person) return empty;
    for (const [key, dec] of decisions) {
      if (dec.status !== "confirmed") continue;
      const parts = key.split(":");
      if (parts.length !== 3 || parts[0] !== "individual" || parts[1] !== person.id) continue;
      const incoming = compareDataset.individuals.get(parts[2]);
      if (!incoming) continue;

      // Field key → incoming value for all fields the merge will add/change.
      const rows = individualFieldRows(t, person, incoming, dataset, compareDataset);
      const mergeHighlight = new Map<string, string>();
      for (const row of rows) {
        if (row.isGroupHeader || !row.incoming) continue;
        if (row.state === "agree" || row.state === "master-only") continue;
        const choice = dec.fields[row.key] ?? defaultChoice(row);
        if (choice !== "master") mergeHighlight.set(row.key, row.incoming);
      }

      // Map master overall event index → the key base that orderedEventTags assigned to it.
      // This handles multi-instance keys (e.g. "RESI.0") that arise when incoming has more
      // events of the same tag, or when a same-tag pair scores too low to be merged.
      const mByTagIndices = new Map<string, number[]>();
      person.events.forEach((ev, i) => {
        const arr = mByTagIndices.get(ev.tag) ?? [];
        arr.push(i);
        mByTagIndices.set(ev.tag, arr);
      });
      const masterMergeKeyBases = new Map<number, string>();
      const masterMergeSortKeys = new Map<number, number>();
      const extraMergeEvents: { tag: string; keyBase: string; sortKey: number }[] = [];
      const EVENT_SUBS = ["date", "place", "addr", "value"] as const;

      // Index incoming events by tag for sort key lookup.
      const cByTag = new Map<string, typeof incoming.events>();
      incoming.events.forEach((ev) => {
        const arr = cByTag.get(ev.tag) ?? [];
        arr.push(ev);
        cByTag.set(ev.tag, arr);
      });

      for (const inst of orderedEventTags(person, incoming)) {
        const keyBase = inst.multi ? `${inst.tag}.${inst.keyIdx}` : inst.tag;
        if (inst.masterIdx >= 0) {
          const overallIdx = mByTagIndices.get(inst.tag)?.[inst.masterIdx];
          if (overallIdx !== undefined) {
            masterMergeKeyBases.set(overallIdx, keyBase);
            // When master has no date, use incoming date for sort so the row stays in
            // the right chronological position (e.g. after committing only a place).
            if (!person.events[overallIdx]?.date && inst.compareIdx >= 0) {
              const sk = dateToSortKey(cByTag.get(inst.tag)?.[inst.compareIdx]?.date);
              if (sk !== 0) masterMergeSortKeys.set(overallIdx, sk);
            }
          }
        } else if (inst.tag !== "BIRT") {
          // Incoming-only event — show only if there is merge data for it.
          // BIRT is always shown in its own row so exclude it from extras.
          if (EVENT_SUBS.some((s) => mergeHighlight.has(`${keyBase}.${s}`))) {
            const incomingEv = inst.compareIdx >= 0 ? cByTag.get(inst.tag)?.[inst.compareIdx] : undefined;
            extraMergeEvents.push({ tag: inst.tag, keyBase, sortKey: dateToSortKey(incomingEv?.date) });
          }
        }
      }

      return { mergeHighlight, masterMergeKeyBases, masterMergeSortKeys, extraMergeEvents };
    }
    return empty;
  }, [decisions, compareDataset, person, dataset, t, tick]);

  const { mergeHighlight, masterMergeKeyBases, masterMergeSortKeys, extraMergeEvents } = mergeData;

  const commit: Commit = (mutate) => {
    if (!person) return;
    mutate(person);
    rebuildIndividual(dataset, person);
    onDirty("individual", person.id);
    setTick((v) => v + 1);
  };

  const commitFamily: FamilyCommit = (fam, mutate) => {
    mutate(fam);
    rebuildFamily(dataset, fam);
    onDirty("family", fam.id);
    setTick((v) => v + 1);
  };

  function addRelative(kind: "father" | "mother" | "partner" | "child", fam?: Family) {
    if (!person) return;
    const added =
      kind === "partner"
        ? addPartner(dataset, person, fam)
        : kind === "child"
          ? addChild(dataset, person, fam)
          : addParent(dataset, person, fam, kind);

    // Pre-fill surname from family context
    let defaultSurname: string | undefined;
    if (kind === "child") {
      // Inherit from the father of the family the child was added to
      const childFam = added.childOf.map((id) => dataset.families.get(id)).find((f) => f?.husband);
      const father = childFam?.husband ? dataset.individuals.get(childFam.husband) : undefined;
      defaultSurname = (father ? primaryName(father)?.surname : undefined) || undefined;
    } else if (kind === "father") {
      defaultSurname = primaryName(person)?.surname || undefined;
    }
    if (defaultSurname) {
      setName(added, { surname: defaultSurname });
      rebuildIndividual(dataset, added);
    }

    onDirty("individual", person.id);
    onDirty("individual", added.id);
    focusNextName.current = true;
    navigate(added.id);
  }

  function personName(id: string | undefined): string {
    if (!id) return "";
    const indi = dataset.individuals.get(id);
    return indi ? (primaryName(indi)?.full ?? id) : id;
  }

  function handleDetachSpouseRole(fam: Family, role: "HUSB" | "WIFE", confirmMsg: string) {
    if (!window.confirm(confirmMsg)) return;
    const indiId = role === "HUSB" ? fam.husband : fam.wife;
    detachSpouseRole(dataset, fam, role);
    onDirty("family", fam.id);
    if (indiId) onDirty("individual", indiId);
    setTick((v) => v + 1);
  }

  function handleDetachChild(fam: Family, childId: string, confirmMsg: string) {
    if (!window.confirm(confirmMsg)) return;
    detachChildFromFamily(dataset, fam, childId);
    onDirty("family", fam.id);
    onDirty("individual", childId);
    setTick((v) => v + 1);
  }

  function handleDeletePerson() {
    if (!person) return;
    const name = primaryName(person)?.full ?? person.id;
    if (!window.confirm(t("edit.deletePersonConfirm", { name }))) return;
    const personId = person.id;
    const affectedFamilies = [...person.spouseOf, ...person.childOf];
    removeIndividual(dataset, person);
    onDirty("individual", personId);
    affectedFamilies.forEach((fid) => onDirty("family", fid));
    const nextId =
      history.filter((id) => id !== personId).pop() ??
      dataset.individuals.keys().next().value;
    setHistory((prev) => prev.filter((id) => id !== personId));
    setLinksAdded(false);
    setNotesAdded(false);
    setSelectedId(nextId);
    setTick((v) => v + 1);
  }

  if (!person) {
    return (
      <div className="section open edit-view">
        <div className="section-body">
          <p className="gm-file master gm-data">{fileName}</p>
          <p className="muted">{t("edit.empty")}</p>
        </div>
      </div>
    );
  }

  const parentFamilies = person.childOf
    .map((famId) => dataset.families.get(famId))
    .filter((f): f is NonNullable<typeof f> => !!f);

  const spouseFamilies = person.spouseOf
    .map((famId) => dataset.families.get(famId))
    .filter((f): f is NonNullable<typeof f> => !!f);

  const { placeSuggestions, placeToAddrs, placeCanonical, addrCanonical } = useMemo(
    () => buildPlaceSuggestions(dataset),
    [dataset],
  );

  const lifespan = lifespanOf(person);
  const kinship = homeId
    ? kinshipLabel(dataset, homeId, selectedId!, t)
    : undefined;
  const homePersonName = homeId
    ? displayName(primaryName(dataset.individuals.get(homeId)!))
    : undefined;
  const kinshipTooltip = kinship && homePersonName
    ? t("kinship.tooltip", { kinship, name: homePersonName })
    : undefined;

  function cardKinship(id: string | undefined): { kinship?: string; kinshipTooltip?: string } {
    if (!homeId || !id) return {};
    const k = kinshipLabel(dataset, homeId, id, t);
    return {
      kinship: k,
      kinshipTooltip: k && homePersonName ? t("kinship.tooltip", { kinship: k, name: homePersonName }) : undefined,
    };
  }

  return (
    <div className="section open edit-view">
      <div className="section-body">
        <div className="edit-toolbar">
          <button className="tree-open-btn" onClick={goBack} disabled={history.length === 0}>
            ← {t("edit.back")}
          </button>
          <HomePersonSelector
            individuals={dataset.individuals}
            homeId={selectedId}
            onChange={navigate}
            placeholder={t("edit.selectPerson")}
            tooltip={t("edit.selectPerson")}
            icon="search"
          />
          <HomePersonSelector
            individuals={dataset.individuals}
            homeId={homeId}
            onChange={changeHome}
            onClear={() => changeHome(undefined)}
          />
          <div className="toolbar-end">
            <button
              className="tree-open-btn"
              onClick={() => selectedId && onShowTree(selectedId)}
              title={t("edit.tree.tooltip")}
            >
              {t("edit.tree.button")}
            </button>
            {onMerge && selectedId && canMerge?.(selectedId) && (
              <button
                className="tree-open-btn"
                onClick={() => onMerge(selectedId)}
                title={t("edit.mergeTooltip")}
              >
                {t("edit.mergeButton")}
              </button>
            )}
          </div>
        </div>

        <div className="edit-parents">
          {(parentFamilies.length ? parentFamilies : [undefined]).map((fam, i) => {
            const fatherName = personName(fam?.husband);
            const motherName = personName(fam?.wife);
            return (
              <div className="edit-parent-group" key={fam?.id ?? `empty-${i}`}>
                <PersonCard
                  individual={fam?.husband ? dataset.individuals.get(fam.husband) : undefined}
                  roleLabel={t("field.father")}
                  placeholder={t("edit.addFather")}
                  onSelect={navigate}
                  onAdd={() => addRelative("father", fam)}
                  onRemove={fam?.husband ? () => handleDetachSpouseRole(fam, "HUSB", t("edit.detachRoleConfirm", { name: fatherName, role: t("field.father") })) : undefined}
                  removeTooltip={fam?.husband ? t("edit.detachRoleTooltip", { name: fatherName, role: t("field.father") }) : undefined}
                  {...cardKinship(fam?.husband)}
                />
                <div className="edit-connector-h" />
                <PersonCard
                  individual={fam?.wife ? dataset.individuals.get(fam.wife) : undefined}
                  roleLabel={t("field.mother")}
                  placeholder={t("edit.addMother")}
                  onSelect={navigate}
                  onAdd={() => addRelative("mother", fam)}
                  onRemove={fam?.wife ? () => handleDetachSpouseRole(fam, "WIFE", t("edit.detachRoleConfirm", { name: motherName, role: t("field.mother") })) : undefined}
                  removeTooltip={fam?.wife ? t("edit.detachRoleTooltip", { name: motherName, role: t("field.mother") }) : undefined}
                  {...cardKinship(fam?.wife)}
                />
              </div>
            );
          })}
        </div>

        <div className="edit-connector-v" />

        <div className="edit-person">
          <NameEditor
            key={`name-${person.id}`}
            person={person}
            t={t}
            lifespan={lifespan}
            commit={commit}
            focusOnMount={focusNextName.current}
            onMounted={() => { focusNextName.current = false; }}
            mergeHighlight={mergeHighlight}
          />
          <SexToggle key={`sex-${person.id}`} person={person} t={t} commit={commit} onDelete={handleDeletePerson} kinship={kinship} kinshipTooltip={kinshipTooltip} />
          <OtherNamesEditor
            key={`names-${person.id}`}
            person={person}
            t={t}
            commit={commit}
            emptyEventGroups={INDIVIDUAL_EVENT_GROUPS as unknown as { labelKey: string; tags: string[] }[]}
            onAddEvent={(tag) => commit((indi) => addEventNode(indi, tag))}
            showAddLink={!linksAdded && !(person.links ?? []).length}
            onAddLink={() => setLinksAdded(true)}
            showAddNote={!notesAdded && !(person.notes ?? []).length}
            onAddNote={() => setNotesAdded(true)}
          />
          <EventList
            key={person.id}
            person={person}
            t={t}
            commit={commit}
            placeSuggestions={placeSuggestions}
            placeToAddrs={placeToAddrs}
            placeCanonical={placeCanonical}
            addrCanonical={addrCanonical}
            mergeHighlight={mergeHighlight}
            masterMergeKeyBases={masterMergeKeyBases}
            masterMergeSortKeys={masterMergeSortKeys}
            extraMergeEvents={extraMergeEvents}
          />
          {((person.links ?? []).length > 0 || linksAdded) && (
            <div className="edit-record-section">
              <LinksEditor
                key={`rlinks-${person.id}`}
                links={person.links ?? []}
                addOnMount={linksAdded && !(person.links ?? []).length}
                sectionLabel={t("field.links")}
                label={t("field.links")}
                t={t}
                onCommit={(links) => commit((indi) => setIndividualLinks(indi, links))}
              />
            </div>
          )}
          {((person.notes ?? []).length > 0 || notesAdded) && (
            <div className="edit-record-section">
              <NotesEditor
                key={`notes-${person.id}`}
                notes={person.notes ?? []}
                addOnMount={notesAdded && !(person.notes ?? []).length}
                sectionLabel={t("field.notes")}
                t={t}
                onCommit={(notes) => commit((indi) => setNotes(indi, notes))}
              />
            </div>
          )}
        </div>

        <div className="edit-families">
          {(spouseFamilies.length ? spouseFamilies : [undefined]).map((fam, i) => {
            const partnerId = fam && (fam.husband === person.id ? fam.wife : fam.husband);
            const partnerRole = fam && (fam.husband === person.id ? "WIFE" : "HUSB");
            const partnerName = personName(partnerId ?? undefined);
            const shownFamilyTags = FAMILY_HIDDEN_EVENT_TAGS.filter(
              (tag) => fam?.events.some((e) => e.tag === tag),
            );
            const emptyFamilyTags = FAMILY_HIDDEN_EVENT_TAGS.filter(
              (tag) => !shownFamilyTags.includes(tag),
            );
            return (
              <div className="edit-family" key={fam?.id ?? `empty-${i}`}>
                <div className="edit-family-header">
                  <div className="person-card-role">{t("field.partners")}</div>
                  <div className="edit-family-card-row">
                    <PersonCard
                      individual={partnerId ? dataset.individuals.get(partnerId) : undefined}
                      placeholder={t("edit.addPartner")}
                      onSelect={navigate}
                      onAdd={() => addRelative("partner", fam)}
                      onRemove={fam && partnerId && partnerRole ? () => handleDetachSpouseRole(fam, partnerRole, t("edit.detachPartnerConfirm", { name: partnerName })) : undefined}
                      removeTooltip={fam && partnerId ? t("edit.detachPartnerTooltip", { name: partnerName }) : undefined}
                      {...cardKinship(partnerId)}
                    />
                    {fam && (
                      <AddEventSelect
                        tags={emptyFamilyTags}
                        label={t("edit.addFamilyEvent")}
                        t={t}
                        onAdd={(tag) => commitFamily(fam, (f) => addFamilyEventNode(f, tag))}
                      />
                    )}
                    {fam && (
                      <button
                        type="button"
                        className="edit-name-chip edit-name-chip-add"
                        title={t("edit.addNoteTooltip")}
                        onClick={() => setFamNoteAdd((prev) => ({ ...prev, [fam.id]: (prev[fam.id] ?? 0) + 1 }))}
                      >
                        + {t("edit.addNote")}
                      </button>
                    )}
                  </div>
                </div>
                {fam && <FamilyEventRow fam={fam} tag="MARR" t={t} commit={commitFamily} placeSuggestions={placeSuggestions} placeToAddrs={placeToAddrs} placeCanonical={placeCanonical} addrCanonical={addrCanonical} />}
                {fam && shownFamilyTags.map((tag) => (
                  <FamilyEventRow key={tag} fam={fam} tag={tag} t={t} commit={commitFamily} placeSuggestions={placeSuggestions} placeToAddrs={placeToAddrs} placeCanonical={placeCanonical} addrCanonical={addrCanonical} />
                ))}
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
                        />
                      );
                    })}
                    <PersonCard placeholder={t("edit.addChild")} onAdd={() => addRelative("child", fam)} />
                  </div>
                </div>
                {fam && (
                  <div className="edit-record-section">
                    <NotesEditor
                      key={`fnotes-${fam.id}`}
                      notes={fam.notes ?? []}
                      addTrigger={famNoteAdd[fam.id]}
                      t={t}
                      onCommit={(notes) => commitFamily(fam, (f) => setFamilyNotes(f, notes))}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Input with an × button at the right edge to clear its value.
 * The clear button only appears when the field is non-empty.
 * `wrapStyle` is applied to the wrapper div (e.g. to set a ch-based width). */
const ClearableInput = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & {
    onClear: () => void;
    wrapStyle?: React.CSSProperties;
    wrapClassName?: string;
  }
>(function ClearableInput({ value, onClear, wrapStyle, wrapClassName, className, ...rest }, ref) {
  return (
    <div
      className={`clearable-wrap${wrapClassName ? ` ${wrapClassName}` : ""}`}
      style={wrapStyle}
    >
      <input ref={ref} className={className} value={value} {...rest} />
      {value ? (
        <button
          type="button"
          className="input-clear"
          tabIndex={-1}
          title={rest.title ? `${rest.title ? "Clear " + rest.title.toLowerCase() : "Clear"}` : "Clear"}
          onMouseDown={(e) => {
            e.preventDefault(); // keep input focused so onBlur fires with the cleared value
            onClear();
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
});

/** Canonical lookup: given raw user input, return the canonical casing form if
 * it matches an existing entry in the map, otherwise return the input trimmed. */
function applyCanonical(raw: string, canonical: Map<string, string>): string {
  const key = raw.trim().split(",").map((p) => p.trim().toLowerCase()).join("|");
  return canonical.get(key) ?? raw.trim();
}

/** A text input with dropdown autocomplete from a pre-built suggestion list.
 * When the user selects a suggestion or blurs, the canonical form is applied. */
function PlaceAutocomplete({
  value,
  suggestions,
  canonical,
  isDirty,
  isMerge,
  className,
  placeholder,
  title,
  onChange,
  onCommit,
  onClear,
}: {
  value: string;
  suggestions: string[];
  canonical: Map<string, string>;
  isDirty: boolean;
  isMerge?: boolean;
  className?: string;
  placeholder?: string;
  title?: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return [];
    return suggestions.filter((s) => s.toLowerCase().includes(q)).slice(0, 8);
  }, [value, suggestions]);

  const showDropdown = open && filtered.length > 0;

  function selectSuggestion(suggestion: string) {
    onChange(suggestion);
    onCommit(suggestion);
    setOpen(false);
    setHighlighted(-1);
  }

  function handleBlur(e: React.FocusEvent) {
    if (containerRef.current?.contains(e.relatedTarget as Node)) return;
    setOpen(false);
    setHighlighted(-1);
    const norm = applyCanonical(value, canonical);
    if (norm !== value) onChange(norm);
    onCommit(norm);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && highlighted >= 0 && showDropdown) {
      e.preventDefault();
      selectSuggestion(filtered[highlighted]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setHighlighted(-1);
    }
  }

  return (
    <div ref={containerRef} className="place-autocomplete-wrap" onBlur={handleBlur}>
      <ClearableInput
        className={`${isMerge ? "edit-input--merge " : isDirty ? "edit-input--dirty " : ""}${className ?? ""}`}
        value={value}
        placeholder={placeholder}
        title={title}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHighlighted(-1); }}
        onFocus={() => { if (value.trim()) setOpen(true); }}
        onKeyDown={handleKeyDown}
        onBlur={() => {}}
        onClear={() => { onClear(); setOpen(false); }}
      />
      {showDropdown && (
        <ul className="place-suggestions" role="listbox">
          {filtered.map((s, i) => (
            <li
              key={s}
              role="option"
              aria-selected={i === highlighted}
              className={i === highlighted ? "place-suggestion place-suggestion--hi" : "place-suggestion"}
              onMouseDown={(e) => { e.preventDefault(); selectSuggestion(s); }}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Editable given/surname fields for the primary name, plus the lifespan. */
function NameEditor({
  person,
  t,
  lifespan,
  commit,
  focusOnMount,
  onMounted,
  mergeHighlight,
}: {
  person: Individual;
  t: Translate;
  lifespan?: string;
  commit: Commit;
  focusOnMount?: boolean;
  onMounted?: () => void;
  mergeHighlight?: Map<string, string>;
}) {
  const primary = primaryName(person);
  // Stable merge values from first render (component is keyed per person)
  const givenMergeInit = useRef(mergeHighlight?.get("given"));
  const surnameMergeInit = useRef(mergeHighlight?.get("surname"));
  const [given, setGiven] = useState(givenMergeInit.current ?? primary?.given ?? "");
  const [surname, setSurname] = useState(surnameMergeInit.current ?? primary?.surname ?? "");
  const givenRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusOnMount) givenRef.current?.focus();
    onMounted?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commitName(nextGiven: string, nextSurname: string) {
    commit((indi) => setName(indi, { given: nextGiven, surname: nextSurname }));
  }

  const givenIsMerge = givenMergeInit.current !== undefined && given === givenMergeInit.current;
  const surnameIsMerge = surnameMergeInit.current !== undefined && surname === surnameMergeInit.current;

  return (
    <div className="edit-name-row" title={datesTooltipOf(person)}>
      <ClearableInput
        ref={givenRef}
        className={`edit-input edit-name-input ${sexClass(person.sex)}${givenIsMerge ? " edit-input--merge" : ""}`}
        wrapStyle={{ width: fieldWidth(given, t("field.given")) }}
        value={given}
        placeholder={t("field.given")}
        title={t("field.given")}
        onChange={(e) => setGiven(e.target.value)}
        onBlur={() => commitName(given, surname)}
        onClear={() => { setGiven(""); commitName("", surname); }}
      />
      <ClearableInput
        className={`edit-input edit-name-input ${sexClass(person.sex)}${surnameIsMerge ? " edit-input--merge" : ""}`}
        wrapStyle={{ width: fieldWidth(surname, t("field.surname")) }}
        value={surname}
        placeholder={t("field.surname")}
        title={t("field.surname")}
        onChange={(e) => setSurname(e.target.value)}
        onBlur={() => commitName(given, surname)}
        onClear={() => { setSurname(""); commitName(given, ""); }}
      />
      {lifespan && <span className="person-years gm-data">{lifespan}</span>}
    </div>
  );
}

const SEX_OPTIONS: Sex[] = ["M", "F", "U"];

/** M/F/U toggle for the individual's `SEX` line. */
const SEX_GLYPHS: Record<string, string> = { M: "♂", F: "♀", U: "?" };

function SexToggle({ person, t, commit, onDelete, kinship, kinshipTooltip }: { person: Individual; t: Translate; commit: Commit; onDelete: () => void; kinship?: string; kinshipTooltip?: string }) {
  return (
    <div className="edit-sex-row">
      {kinship && <span className="person-kinship" title={kinshipTooltip}>{kinship}</span>}
      <select
        className={`sex-select ${sexClass(person.sex)}`}
        value={person.sex}
        onChange={(e) => commit((indi) => setSex(indi, e.target.value as Sex))}
      >
        {SEX_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {SEX_GLYPHS[s]} {t(`sex.${s}`)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="edit-delete-btn"
        title={t("edit.deletePersonTooltip")}
        onClick={onDelete}
      >
        🗑
      </button>
    </div>
  );
}

/** Nickname plus any further `NAME` records (married/maiden/aka/…), shown as
 * chips that turn into editable fields on click, plus a single "+ Add name"
 * button and an "+ Add event" dropdown to append events from the same row. */
function OtherNamesEditor({
  person,
  t,
  commit,
  emptyEventGroups,
  onAddEvent,
  showAddLink,
  onAddLink,
  showAddNote,
  onAddNote,
}: {
  person: Individual;
  t: Translate;
  commit: Commit;
  emptyEventGroups: { labelKey: string; tags: string[] }[];
  onAddEvent: (tag: string) => void;
  showAddLink: boolean;
  onAddLink: () => void;
  showAddNote: boolean;
  onAddNote: () => void;
}) {
  const [editing, setEditing] = useState<"nick" | number | null>(null);
  const primary = primaryName(person);
  const extraNames = person.names.slice(1);
  const hasNamesContent = editing !== null || !!primary?.nickname || extraNames.length > 0;

  const addNameBtn = (
    <button
      type="button"
      className="edit-name-chip edit-name-chip-add"
      title={t("edit.addNameTooltip")}
      onClick={() => {
        commit((indi) => addAdditionalName(indi, "aka"));
        setEditing(extraNames.length);
      }}
    >
      + {t("edit.addName")}
    </button>
  );

  return (
    <div className="edit-other-names">
      {/* Names row — only shown when there are names or editing */}
      {hasNamesContent && (
        <div className="edit-other-names-row">
          {editing === "nick" ? (
            <NicknameEditor person={person} t={t} commit={commit} onDone={() => setEditing(null)} />
          ) : primary?.nickname ? (
            <button type="button" className="edit-name-chip" onClick={() => setEditing("nick")}>
              {primary.nickname}
              <span className="muted"> ({nameTypeLabel("nick", t)})</span>
            </button>
          ) : null}
          {extraNames.map((n, i) =>
            editing === i ? (
              <NameVariantEditor key={i} person={person} index={i} t={t} commit={commit} onDone={() => setEditing(null)} />
            ) : (
              <button type="button" className="edit-name-chip" key={i} onClick={() => setEditing(i)}>
                {displayName(n)}
                {n.type && <span className="muted"> ({nameTypeLabel(n.type, t)})</span>}
              </button>
            ),
          )}
          {addNameBtn}
        </div>
      )}
      {/* Action chips row — always present */}
      <div className="edit-other-names-row edit-other-names-actions">
        {!hasNamesContent && addNameBtn}
        <AddEventSelect
          groups={emptyEventGroups}
          label={t("edit.addEvent")}
          t={t}
          onAdd={onAddEvent}
          className="edit-name-chip edit-name-chip-add add-chip-select"
        />
        {showAddLink && (
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("edit.addLinkTooltip")}
            onClick={onAddLink}
          >
            + {t("edit.addLink")}
          </button>
        )}
        {showAddNote && (
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("edit.addNoteTooltip")}
            onClick={onAddNote}
          >
            + {t("edit.addNote")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Inline-editable nickname (the primary name's `NICK` sub-tag). */
function NicknameEditor({
  person,
  t,
  commit,
  onDone,
}: {
  person: Individual;
  t: Translate;
  commit: Commit;
  onDone: () => void;
}) {
  const [value, setValue] = useState(primaryName(person)?.nickname ?? "");

  return (
    <span className="edit-name-chip edit-name-chip-editing">
      <ClearableInput
        className="edit-input edit-name-variant-input"
        wrapStyle={{ width: fieldWidth(value, t("nametype.nick")) }}
        value={value}
        placeholder={t("nametype.nick")}
        title={t("nametype.nick")}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => commit((indi) => setNickname(indi, value))}
        onClear={() => { setValue(""); commit((indi) => setNickname(indi, "")); }}
      />
      <button
        type="button"
        className="edit-link-remove"
        title={t("edit.removeName")}
        onClick={() => {
          commit((indi) => setNickname(indi, ""));
          setValue("");
          onDone();
        }}
      >
        ×
      </button>
    </span>
  );
}

/** Inline-editable given/surname/type for an additional `NAME` record
 * (married/maiden/aka/…) — see `setAdditionalName` for indexing. */
function NameVariantEditor({
  person,
  index,
  t,
  commit,
  onDone,
}: {
  person: Individual;
  index: number;
  t: Translate;
  commit: Commit;
  onDone: () => void;
}) {
  const name = person.names[index + 1];
  const [given, setGiven] = useState(name?.given ?? "");
  const [surname, setSurname] = useState(name?.surname ?? "");

  function commitFields(nextGiven: string, nextSurname: string) {
    commit((indi) => setAdditionalName(indi, index, { given: nextGiven, surname: nextSurname }));
  }

  const ref = useRef<HTMLSpanElement>(null);

  return (
    <span
      ref={ref}
      className="edit-name-chip edit-name-chip-editing"
      onBlur={(e) => { if (!ref.current?.contains(e.relatedTarget as Node)) onDone(); }}
    >
      <ClearableInput
        className="edit-input edit-name-variant-input"
        wrapStyle={{ width: fieldWidth(given, t("field.given")) }}
        value={given}
        placeholder={t("field.given")}
        title={t("field.given")}
        autoFocus
        onChange={(e) => setGiven(e.target.value)}
        onBlur={() => commitFields(given, surname)}
        onClear={() => { setGiven(""); commitFields("", surname); }}
      />
      <ClearableInput
        className="edit-input edit-name-variant-input"
        wrapStyle={{ width: fieldWidth(surname, t("field.surname")) }}
        value={surname}
        placeholder={t("field.surname")}
        title={t("field.surname")}
        onChange={(e) => setSurname(e.target.value)}
        onBlur={() => commitFields(given, surname)}
        onClear={() => { setSurname(""); commitFields(given, ""); }}
      />
      <select
        className="edit-input edit-name-type-select"
        value={name?.type ?? "aka"}
        title={t("field.nameType")}
        onChange={(e) => commit((indi) => setAdditionalName(indi, index, { type: e.target.value }))}
      >
        {ADDITIONAL_NAME_TYPES.map((opt) => (
          <option key={opt} value={opt}>
            {nameTypeLabel(opt, t)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="edit-link-remove"
        title={t("edit.removeName")}
        onClick={() => {
          commit((indi) => removeAdditionalName(indi, index));
          onDone();
        }}
      >
        ×
      </button>
    </span>
  );
}

/** Display order for extra merge events (tags not yet in master) and secondary event sort key. */
const EXTRA_EVENT_ORDER = [
  "BAPM", "CHR", "CONF", "ADOP", "FCOM",
  "OCCU", "EDUC", "RETI",
  "RESI", "EMIG", "IMMI", "NATU", "CENS",
  "WILL", "PROB",
  "DEAT", "BURI", "CREM",
];

/** Events grid: BIRT always first (creates on commit), then all other events
 * in person.events order — multiple occurrences of the same tag are supported.
 * When mergeHighlight is set, merge-highlighted fields are shown and extra incoming-only
 * events are appended at the end. */
function EventList({
  person,
  t,
  commit,
  placeSuggestions,
  placeToAddrs,
  placeCanonical,
  addrCanonical,
  mergeHighlight,
  masterMergeKeyBases,
  masterMergeSortKeys,
  extraMergeEvents,
}: {
  person: Individual;
  t: Translate;
  commit: Commit;
  placeSuggestions: string[];
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
  mergeHighlight?: Map<string, string>;
  /** master person.events[i] → field key base aligned with orderedEventTags. */
  masterMergeKeyBases?: Map<number, string>;
  /** master person.events[i] → sort key from incoming date, when master has no date. */
  masterMergeSortKeys?: Map<number, number>;
  /** Incoming-only events, each carrying a date-based sort key for interleaving. */
  extraMergeEvents?: { tag: string; keyBase: string; sortKey: number }[];
}) {
  type Snapshot = { date?: string; place?: string; address?: string; value?: string; links?: string[] };
  type DeletedSnap = {
    tag: string; label: string; mergeKeyBase: string; stableKey: number;
    snapshot: Snapshot; sortKey: number; tagPos: number;
  };
  const [deletedSnaps, setDeletedSnaps] = useState<DeletedSnap[]>([]);

  function handleRemove(
    ev: GedEvent | undefined, tag: string, label: string, mergeKeyBase: string,
    stableKey: number, sortKey: number, tagPos: number, removeAction: () => void,
  ) {
    setDeletedSnaps((prev) => [...prev, {
      tag, label, mergeKeyBase, stableKey, sortKey, tagPos,
      snapshot: {
        date: ev?.date?.raw, place: ev?.place?.raw,
        address: ev?.address?.raw, value: ev?.value, links: ev?.links,
      },
    }]);
    removeAction();
  }

  const birtEv = person.events.find((e) => e.tag === "BIRT");

  // Fallback key bases when no merge is active (master-only count-based naming).
  const tagCount = new Map<string, number>();
  person.events.forEach((ev) => tagCount.set(ev.tag, (tagCount.get(ev.tag) ?? 0) + 1));
  const tagIdx = new Map<string, number>();
  const eventKeyBases: string[] = person.events.map((ev) => {
    const idx = tagIdx.get(ev.tag) ?? 0;
    tagIdx.set(ev.tag, idx + 1);
    return (tagCount.get(ev.tag) ?? 0) > 1 ? `${ev.tag}.${idx}` : ev.tag;
  });
  const birtOriginalIdx = person.events.findIndex((e) => e.tag === "BIRT");
  const birtMergeKeyBase = birtOriginalIdx >= 0
    ? (masterMergeKeyBases?.get(birtOriginalIdx) ?? eventKeyBases[birtOriginalIdx])
    : "BIRT";

  // Unified sorted list: master non-BIRT events interleaved with incoming-only extra events
  // and any stricken-through deleted events (rendered in-place).
  type MasterRow  = { kind: "master";  ev: GedEvent; i: number; mergeKeyBase: string; stableKey: number };
  type ExtraRow   = { kind: "extra";   tag: string; keyBase: string };
  type DeletedRow = { kind: "deleted"; tag: string; label: string; mergeKeyBase: string; stableKey: number; snapshot: Snapshot };
  type AnyRow     = (MasterRow | ExtraRow | DeletedRow) & { sortKey: number; tagPos: number };

  // Raw event nodes in the same order as person.events — used for stable WeakMap keys.
  const rawEventNodes = person.raw.children.filter((c) => INDI_EVENT_TAGS.has(c.tag));

  const allRows: AnyRow[] = [
    ...person.events
      .map((ev, i) => ({ ev, i }))
      .filter(({ ev }) => ev.tag !== "BIRT")
      .map(({ ev, i }): AnyRow => ({
        kind: "master",
        ev, i,
        mergeKeyBase: masterMergeKeyBases?.get(i) ?? eventKeyBases[i],
        stableKey: nodeId(rawEventNodes[i] ?? ev),
        sortKey: masterMergeSortKeys?.get(i) ?? dateToSortKey(ev.date),
        tagPos: EXTRA_EVENT_ORDER.indexOf(ev.tag),
      })),
    ...(extraMergeEvents ?? []).map(({ tag, keyBase, sortKey }): AnyRow => ({
      kind: "extra",
      tag, keyBase,
      sortKey,
      tagPos: EXTRA_EVENT_ORDER.indexOf(tag),
    })),
    ...deletedSnaps.map((d): AnyRow => ({
      kind: "deleted",
      tag: d.tag, label: d.label, mergeKeyBase: d.mergeKeyBase,
      stableKey: d.stableKey, snapshot: d.snapshot,
      sortKey: d.sortKey, tagPos: d.tagPos,
    })),
  ];
  allRows.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
    const pa = a.tagPos === -1 ? 999 : a.tagPos;
    const pb = b.tagPos === -1 ? 999 : b.tagPos;
    return pa - pb;
  });

  return (
    <div className="edit-events">
      <div className="edit-event-head">
        <span />
        <span>{t("event.colDate")}</span>
        <span>{t("event.colPlace")}</span>
        <span>{t("event.colAddr")}</span>
        <span>{t("event.colLink")}</span>
      </div>
      <EventFieldsRow
        key={`${person.id}-BIRT`}
        ev={birtEv}
        label={t("event.BIRT")}
        tag="BIRT"
        t={t}
        commitField={(update) => commit((indi) => setEventField(indi, "BIRT", update))}
        onRemove={birtOriginalIdx >= 0 ? () => handleRemove(
          birtEv, "BIRT", t("event.BIRT"), birtMergeKeyBase,
          nodeId(rawEventNodes[birtOriginalIdx] ?? {}),
          masterMergeSortKeys?.get(birtOriginalIdx) ?? dateToSortKey(birtEv?.date),
          EXTRA_EVENT_ORDER.indexOf("BIRT"),
          () => commit((indi) => removeEventAtIndex(indi, birtOriginalIdx)),
        ) : undefined}
        placeSuggestions={placeSuggestions}
        placeToAddrs={placeToAddrs}
        placeCanonical={placeCanonical}
        addrCanonical={addrCanonical}
        mergeHighlight={mergeHighlight}
        mergeKeyBase={birtMergeKeyBase}
      />
      {allRows.map((row) =>
        row.kind === "master" ? (
          <EventFieldsRow
            key={`ev-${row.stableKey}`}
            ev={row.ev}
            label={t(`event.${row.ev.tag}`)}
            tag={row.ev.tag}
            t={t}
            commitField={(update) => commit((indi) => setEventFieldAtIndex(indi, row.i, update))}
            onRemove={() => handleRemove(
              row.ev, row.ev.tag, t(`event.${row.ev.tag}`), row.mergeKeyBase,
              row.stableKey, row.sortKey, row.tagPos,
              () => commit((indi) => removeEventAtIndex(indi, row.i)),
            )}
            placeSuggestions={placeSuggestions}
            placeToAddrs={placeToAddrs}
            placeCanonical={placeCanonical}
            addrCanonical={addrCanonical}
            mergeHighlight={mergeHighlight}
            mergeKeyBase={row.mergeKeyBase}
          />
        ) : row.kind === "extra" ? (
          <EventFieldsRow
            key={`${person.id}-merge-${row.keyBase}`}
            ev={undefined}
            label={t(`event.${row.tag}`)}
            tag={row.tag}
            t={t}
            commitField={(update) => commit((indi) => setEventField(indi, row.tag, update))}
            placeSuggestions={placeSuggestions}
            placeToAddrs={placeToAddrs}
            placeCanonical={placeCanonical}
            addrCanonical={addrCanonical}
            mergeHighlight={mergeHighlight}
            mergeKeyBase={row.keyBase}
          />
        ) : (
          <div key={`del-${row.stableKey}`} className="edit-event edit-event--deleted">
            <div className="edit-event-label">{row.label}</div>
            <div className="clearable-wrap">
              <span className="edit-input edit-event-date">{row.snapshot.date ?? ""}</span>
            </div>
            <div className="place-autocomplete-wrap">
              <span className="edit-input edit-event-place">{row.snapshot.place ?? ""}</span>
            </div>
            <div className="place-autocomplete-wrap">
              <span className="edit-input edit-event-addr">{row.snapshot.address ?? ""}</span>
            </div>
            <div className="edit-event-actions">
              <button
                type="button"
                className="edit-event-undo"
                title={t("edit.undoRemove")}
                onClick={() => {
                  commit((indi) => restoreEvent(indi, row.tag, row.snapshot));
                  setDeletedSnaps((prev) => prev.filter((d) => d.stableKey !== row.stableKey));
                }}
              >
                ↩
              </button>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

/** Any family event row (MARR, DIV, ENGA, SEPA, …) by tag. */
function FamilyEventRow({
  fam, tag, t, commit,
  placeSuggestions, placeToAddrs, placeCanonical, addrCanonical,
}: {
  fam: Family; tag: string; t: Translate; commit: FamilyCommit;
  placeSuggestions: string[];
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
}) {
  const ev = fam.events.find((e) => e.tag === tag);
  const label = t(`event.${tag}`);

  return (
    <EventFieldsRow
      ev={ev}
      label={label}
      t={t}
      commitField={(update) => commit(fam, (f) => setFamilyEventField(f, tag, update))}
      placeSuggestions={placeSuggestions}
      placeToAddrs={placeToAddrs}
      placeCanonical={placeCanonical}
      addrCanonical={addrCanonical}
    />
  );
}

/** Dropdown chip that adds an event tag from a list of available tags.
 * Resets to the placeholder after selection. */
function AddEventSelect({
  tags,
  groups,
  label,
  t,
  onAdd,
  className = "add-chip add-chip-select",
}: {
  tags?: string[];
  groups?: { labelKey: string; tags: string[] }[];
  label: string;
  t: Translate;
  onAdd: (tag: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState("");
  const hasAny = tags?.length || groups?.some((g) => g.tags.length);
  if (!hasAny) return null;
  return (
    <label className={className}>
      + {label}
      <select
        className="add-chip-select-inner"
        value={value}
        onChange={(e) => {
          const tag = e.target.value;
          setValue("");
          if (tag) onAdd(tag);
        }}
      >
        <option value="" />
        {groups
          ? groups.map((g) => (
              <optgroup key={g.labelKey} label={t(g.labelKey)}>
                {g.tags.map((tag) => (
                  <option key={tag} value={tag}>{t(`event.${tag}`)}</option>
                ))}
              </optgroup>
            ))
          : tags?.map((tag) => (
              <option key={tag} value={tag}>{t(`event.${tag}`)}</option>
            ))}
      </select>
    </label>
  );
}

function useField(initial: string, mergeInitial?: string) {
  const effectiveInitial = mergeInitial ?? initial;
  const [value, setValue] = useState(effectiveInitial);
  const init = useRef(effectiveInitial);
  return {
    value,
    /** True when the current value still equals the unedited merge-incoming value. */
    isMerge: mergeInitial !== undefined && value === mergeInitial,
    isDirty: value !== init.current,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value),
    set: setValue,
    clear: () => setValue(""),
  };
}

/** Editable date/place/address/links for a single event (individual or
 * family), e.g. `1 BIRT` or `1 MARR`. */
function EventFieldsRow({
  ev,
  label,
  tag,
  t,
  commitField,
  onRemove,
  placeSuggestions,
  placeToAddrs,
  placeCanonical,
  addrCanonical,
  mergeHighlight,
  mergeKeyBase,
}: {
  ev: GedEvent | undefined;
  label: string;
  tag?: string;
  t: Translate;
  commitField: (update: EventFieldUpdate) => void;
  onRemove?: () => void;
  placeSuggestions: string[];
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
  mergeHighlight?: Map<string, string>;
  mergeKeyBase?: string;
}) {
  const showValue = tag !== undefined && VALUE_EVENT_TAGS.has(tag);

  // Compute merge values before hooks so they can be used as initial state.
  const kBase = mergeKeyBase ?? tag ?? "";
  const dateMergeVal = mergeHighlight?.get(`${kBase}.date`);
  const valueMergeVal = showValue ? mergeHighlight?.get(`${kBase}.value`) : undefined;
  const placeMergeVal = mergeHighlight?.get(`${kBase}.place`);
  const addrMergeVal = mergeHighlight?.get(`${kBase}.addr`);

  const valueField = useField(ev?.value ?? "", valueMergeVal);
  const dateField = useField(ev?.date?.raw ?? "", dateMergeVal);
  const placeField = useField(ev?.place?.raw ?? "", placeMergeVal);
  const addrField = useField(ev?.address?.raw ?? "", addrMergeVal);
  const [links, setLinks] = useState<string[]>(ev?.links ?? []);

  function fieldCls(base: string, isMerge: boolean, isDirty: boolean) {
    if (isMerge) return `${base} edit-input--merge`;
    if (isDirty) return `${base} edit-input--dirty`;
    return base;
  }

  function commitLinks(next: string[]) {
    setLinks(next);
    commitField({ links: next.map((l) => l.trim()).filter(Boolean) });
  }

  return (
    <div className={showValue ? "edit-event edit-event--has-value" : "edit-event"}>
      <div className="edit-event-label">{label}</div>
      <ClearableInput
        className={fieldCls("edit-input edit-event-date", dateField.isMerge, dateField.isDirty)}
        value={dateField.value}
        placeholder={t("event.date", { event: label })}
        title={t("event.date", { event: label })}
        onChange={dateField.onChange}
        onBlur={() => commitField({ date: dateField.value })}
        onClear={() => { dateField.clear(); commitField({ date: "" }); }}
      />
      {showValue && (
        <ClearableInput
          className={fieldCls("edit-input edit-event-value", valueField.isMerge, valueField.isDirty)}
          value={valueField.value}
          placeholder={label}
          title={label}
          onChange={valueField.onChange}
          onBlur={() => commitField({ value: valueField.value })}
          onClear={() => { valueField.clear(); commitField({ value: "" }); }}
        />
      )}
      <PlaceAutocomplete
        value={placeField.value}
        suggestions={placeSuggestions}
        canonical={placeCanonical}
        isDirty={placeField.isDirty}
        isMerge={placeField.isMerge}
        className="edit-input edit-event-place"
        placeholder={t("event.place", { event: label })}
        title={t("event.place", { event: label })}
        onChange={placeField.set}
        onCommit={(val) => commitField({ place: val })}
        onClear={() => { placeField.clear(); commitField({ place: "" }); }}
      />
      <PlaceAutocomplete
        value={addrField.value}
        suggestions={placeToAddrs.get(placeKey(placeField.value)) ?? []}
        canonical={addrCanonical}
        isDirty={addrField.isDirty}
        isMerge={addrField.isMerge}
        className="edit-input edit-event-addr"
        placeholder={t("event.addr", { event: label })}
        title={t("event.addr", { event: label })}
        onChange={addrField.set}
        onCommit={(val) => commitField({ address: val })}
        onClear={() => { addrField.clear(); commitField({ address: "" }); }}
      />
      <div className="edit-event-actions">
        <button
          type="button"
          className="edit-link-add"
          onClick={() => setLinks((prev) => [...prev, ""])}
        >
          + {t("edit.addLink")}
        </button>
        {onRemove && (
          <button
            type="button"
            className="edit-event-remove"
            title={t("edit.removeEvent")}
            onClick={onRemove}
          >
            ×
          </button>
        )}
      </div>
      {links.map((link, i) => (
        <div className="edit-event-link-row" key={i}>
          {link.trim() && (
            <a
              className="edit-link-open"
              href={link.trim()}
              target="_blank"
              rel="noopener noreferrer"
              title={t("edit.openLink")}
            >
              ↗
            </a>
          )}
          <div className="edit-link-input-wrap">
            <input
              className="edit-input edit-link-input"
              value={link}
              placeholder={t("event.link", { event: label })}
              title={t("event.link", { event: label })}
              onChange={(e) => setLinks((prev) => prev.map((l, idx) => (idx === i ? e.target.value : l)))}
              onBlur={() => commitLinks(links)}
            />
            <button
              type="button"
              className="edit-link-remove"
              title={t("edit.removeLink")}
              onClick={() => commitLinks(links.filter((_, idx) => idx !== i))}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Multi-line notes attached to a person or family record. */
function NotesEditor({
  notes: initialNotes,
  addOnMount,
  addTrigger,
  sectionLabel,
  t,
  onCommit,
}: {
  notes: string[];
  addOnMount?: boolean;
  addTrigger?: number;
  sectionLabel?: string;
  t: Translate;
  onCommit: (notes: string[]) => void;
}) {
  const [notes, setNotes] = useState(() => addOnMount ? [...initialNotes, ""] : initialNotes);
  const prevTrigger = useRef(addTrigger ?? 0);
  useEffect(() => {
    if ((addTrigger ?? 0) > prevTrigger.current) {
      setNotes((prev) => [...prev, ""]);
    }
    prevTrigger.current = addTrigger ?? 0;
  }, [addTrigger]);

  function commitNotes(next: string[]) {
    setNotes(next);
    onCommit(next.map((n) => n.trim()).filter(Boolean));
  }

  return (
    <div className="edit-notes">
      {sectionLabel && (
        <div className="edit-record-label-row">
          <span className="edit-record-label">{sectionLabel}</span>
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("edit.addNoteTooltip")}
            onClick={() => setNotes((prev) => [...prev, ""])}
          >
            + {t("edit.addNote")}
          </button>
        </div>
      )}
      {notes.map((note, i) => (
        <div className="edit-note-row" key={i}>
          <textarea
            className="edit-input edit-note-input"
            value={note}
            placeholder={t("field.notes")}
            rows={2}
            onChange={(e) => setNotes((prev) => prev.map((n, idx) => (idx === i ? e.target.value : n)))}
            onBlur={() => commitNotes(notes)}
          />
          <button
            type="button"
            className="edit-link-remove"
            title={t("edit.removeNote")}
            onClick={() => commitNotes(notes.filter((_, idx) => idx !== i))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** A list of single-line link inputs, each removable. When `sectionLabel` is
 * provided it renders its own header row with the label and an add button. */
function LinksEditor({
  links: initialLinks,
  addOnMount,
  sectionLabel,
  label,
  t,
  onCommit,
}: {
  links: string[];
  addOnMount?: boolean;
  sectionLabel?: string;
  label: string;
  t: Translate;
  onCommit: (links: string[]) => void;
}) {
  const [links, setLinks] = useState(() => addOnMount ? [...initialLinks, ""] : initialLinks);

  function commitLinks(next: string[]) {
    setLinks(next);
    onCommit(next.map((l) => l.trim()).filter(Boolean));
  }

  return (
    <div className="edit-links">
      {sectionLabel && (
        <div className="edit-record-label-row">
          <span className="edit-record-label">{sectionLabel}</span>
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("edit.addLinkTooltip")}
            onClick={() => setLinks((prev) => [...prev, ""])}
          >
            + {t("edit.addLink")}
          </button>
        </div>
      )}
      {links.map((link, i) => (
        <div className="edit-link-row" key={i}>
          {link.trim() && (
            <a
              className="edit-link-open"
              href={link.trim()}
              target="_blank"
              rel="noopener noreferrer"
              title={t("edit.openLink")}
            >
              ↗
            </a>
          )}
          <div className="edit-link-input-wrap">
            <input
              className="edit-input edit-link-input"
              value={link}
              placeholder={t("event.link", { event: label })}
              title={t("event.link", { event: label })}
              onChange={(e) => setLinks((prev) => prev.map((l, idx) => (idx === i ? e.target.value : l)))}
              onBlur={() => commitLinks(links)}
            />
            <button
              type="button"
              className="edit-link-remove"
              title={t("edit.removeLink")}
              onClick={() => commitLinks(links.filter((_, idx) => idx !== i))}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
