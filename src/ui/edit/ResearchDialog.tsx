import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ResearchFields } from "../../gedcom/edit";
import { ALL_EVENT_TAGS, eventDisplayLabel } from "../../gedcom/eventTags";
import { childText } from "../../gedcom/node";
import { noteToText } from "../../gedcom/noteHtml";
import { RESEARCH_KINDS, type ResearchKind } from "../../gedcom/research";
import type { Dataset, GedNode } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { DropdownMenu } from "../DropdownMenu";
import { linkHref } from "../FieldValue";
import { Segmented } from "../Segmented";
import { useNameOf } from "../SettingsContext";
import { SourceDialogShell } from "../source/SourceDialogShell";
import { RelativePickerCard } from "./RelativePickerCard";
import { RichNoteInput } from "./RichNoteInput";
import { RESEARCH_ICON } from "./ResearchContext";
import type { NewResearchMedia, ResearchDraft, ResearchTarget } from "./researchEdit";
import { AddMediaDialog } from "../AddMediaDialog";
import { useMediaFolder } from "../MediaFolderContext";
import { basename } from "../mediaPath";
import { useFormatOverrides } from "../TargetFormatContext";
import { objeInfoOf } from "../../gedcom/source";
import { recordLookup } from "../../gedcom/node";
import { writeVersionOf } from "../../normalize/formatOverrides";

const WHOLE = "record";

/**
 * The research note's dialog, for a new note and an existing one alike: what
 * kind of note it is, its text and links, whether it is settled, and the
 * people and events it is filed under. Nothing is written until Save, which
 * hands the whole edit over as one step.
 */
export function ResearchDialog({
  draft,
  dataset,
  t,
  onClose,
  onSave,
  onRemove,
  onNavigate,
}: {
  draft: ResearchDraft;
  dataset: Dataset;
  t: Translate;
  onClose: () => void;
  /** `newMedia`: files picked here that the file has no media record for yet. */
  onSave: (fields: ResearchFields, targets: ResearchTarget[], newMedia?: NewResearchMedia) => void;
  /** Delete the note; absent for one not saved yet. */
  onRemove?: () => void;
  /** Open a person the note is filed under. */
  onNavigate: (personId: string) => void;
}) {
  const nameOf = useNameOf();
  const [kind, setKind] = useState<ResearchKind>(draft.fields.kind);
  const [done, setDone] = useState(draft.fields.done);
  const [text, setText] = useState(draft.fields.text);
  // One empty row always follows the links, so another is typed without a button.
  const [links, setLinks] = useState<string[]>([...draft.fields.links, ""]);
  const [targets, setTargets] = useState<ResearchTarget[]>(draft.targets);
  const [picking, setPicking] = useState(false);
  // The note's media: records it already points at, and files picked here —
  // a picked file gets its record when the note is saved, not before.
  const [media, setMedia] = useState<{ xref?: string; path?: string }[]>(() => draft.fields.media.map((xref) => ({ xref })));
  const [mediaPicker, setMediaPicker] = useState(false);
  const { folderName, openFolder } = useMediaFolder();
  const version = writeVersionOf(useFormatOverrides());
  // The file's records by xref, built only for a note that has media to name.
  const hasMediaRecords = media.some((m) => m.xref);
  const recordOf = useMemo(() => (hasMediaRecords ? recordLookup(dataset.records) : undefined), [hasMediaRecords, dataset]);
  const mediaLabel = (m: { xref?: string; path?: string }): string => {
    if (m.path) return basename(m.path);
    const record = m.xref ? recordOf?.(m.xref) : undefined;
    const info = record ? objeInfoOf(record) : undefined;
    return info?.title || (info?.file ? basename(info.file) : m.xref ?? "");
  };
  const textRef = useRef<HTMLDivElement>(null);
  useEffect(() => { textRef.current?.focus(); }, []);
  // Escape in the person search puts the search away, not the whole dialog:
  // caught on the search's own element, ahead of the dialog's listener.
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pickerRef.current;
    if (!picking || !el) return;
    el.scrollIntoView({ block: "nearest" });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setPicking(false);
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [picking]);
  const stopPicking = useCallback(() => setPicking(false), []);

  const cleanLinks = links.map((l) => l.trim()).filter(Boolean);
  const canSave = !!noteToText(text).trim() || cleanLinks.length > 0 || media.length > 0;
  const save = () => {
    const files = media.filter((m) => !m.xref && m.path).map((m) => m.path!);
    onSave(
      { kind, done, text: text.trim(), links: cleanLinks, media: media.filter((m) => m.xref).map((m) => m.xref!) },
      targets,
      files.length ? { files, version } : undefined,
    );
  };

  const rawOf = (recordId: string): GedNode | undefined =>
    dataset.individuals.get(recordId)?.raw ?? dataset.families.get(recordId)?.raw;

  function recordLabel(recordId: string): string {
    const indi = dataset.individuals.get(recordId);
    if (indi) return nameOf(indi);
    const fam = dataset.families.get(recordId);
    const partners = [fam?.husband, fam?.wife].map((id) => (id ? dataset.individuals.get(id) : undefined));
    return partners.filter((p) => !!p).map((p) => nameOf(p)).join(" + ") || recordId;
  }

  /** An event as the menu names it: its kind, and its date to tell two apart. */
  function eventLabel(node: GedNode): string {
    const date = childText(node, "DATE");
    return date ? `${eventDisplayLabel(node.tag, t)} · ${date}` : eventDisplayLabel(node.tag, t);
  }

  function setTargetEvent(at: number, value: string) {
    setTargets((prev) => prev.map((target, i) =>
      i === at ? { recordId: target.recordId, ...(value === WHOLE ? {} : { eventIndex: Number(value) }) } : target));
  }

  return (
    <SourceDialogShell
      icon={RESEARCH_ICON[kind]}
      title={t(draft.id ? "research.dialog.edit" : "research.dialog.new")}
      t={t}
      onClose={onClose}
      onConfirm={canSave ? save : undefined}
      className="research-dialog"
      actions={
        <>
          {onRemove && <button className="tree-open-btn add-source-remove" onClick={onRemove}>{t("research.delete")}</button>}
          <button className="tree-open-btn" onClick={onClose}>{t("addSource.cancel")}</button>
          <button className="add-source-submit" disabled={!canSave} onClick={save}>{t("editSource.save")}</button>
        </>
      }
    >
      <div className="research-dialog-head">
        <Segmented
          label={t("research.field.kind")}
          value={kind}
          onChange={setKind}
          items={RESEARCH_KINDS.map((k) => ({ key: k, label: <>{RESEARCH_ICON[k]} {t(`research.kind.${k}`)}</> }))}
        />
        <label className="research-dialog-done">
          <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} />
          {t("research.done")}
        </label>
      </div>
      <div className="add-source-field">
        <span>{t("research.field.text")}</span>
        <RichNoteInput
          ref={textRef}
          text={text}
          onInput={setText}
          onBlur={() => {}}
          onClear={() => setText("")}
          wrapClassName="research-dialog-text"
          className="edit-input"
          placeholder=""
          title={t("research.field.text")}
          t={t}
        />
      </div>
      <div className="add-source-field">
        <span>{t("research.field.links")}</span>
        {links.map((link, i) => (
          <span key={i} className="add-source-url-wrap">
            <input
              className="edit-input"
              value={link}
              placeholder="https://"
              aria-label={t("research.field.links")}
              onChange={(e) => {
                const value = e.target.value;
                setLinks((prev) => {
                  const next = prev.map((l, at) => (at === i ? value : l));
                  return next[next.length - 1].trim() ? [...next, ""] : next;
                });
              }}
            />
            {link.trim() && (
              <a className="edit-link-open" href={linkHref(link.trim())} target="_blank" rel="noopener noreferrer" title={t("edit.openLink")}>
                ↗
              </a>
            )}
          </span>
        ))}
      </div>
      <div className="add-source-field">
        <span>{t("research.field.media")}</span>
        <span className="research-media">
          {media.map((m, i) => (
            <span key={`${m.xref ?? m.path}-${i}`} className="research-media-item">
              <span aria-hidden="true">🖼</span> {mediaLabel(m)}
              <button
                type="button"
                className="research-target-remove"
                title={t("research.removeMedia")}
                aria-label={t("research.removeMedia")}
                onClick={() => setMedia((prev) => prev.filter((_, at) => at !== i))}
              >
                ×
              </button>
            </span>
          ))}
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add research-target-add"
            title={folderName ? undefined : t("media.selectFolderPrompt")}
            onClick={() => { if (folderName) setMediaPicker(true); else void openFolder(); }}
          >
            + {t("media.add")}
          </button>
        </span>
      </div>
      <div className="add-source-field">
        <span>{t("research.field.filed")}</span>
        {targets.length === 0 && !picking && <span className="research-dialog-unfiled">{t("research.unfiledHint")}</span>}
        {targets.map((target, i) => {
          const raw = rawOf(target.recordId);
          const events = (raw?.children ?? []).map((node, at) => ({ node, at })).filter(({ node }) => ALL_EVENT_TAGS.has(node.tag));
          const current = target.eventIndex === undefined ? undefined : raw?.children[target.eventIndex];
          const isPerson = dataset.individuals.has(target.recordId);
          return (
            <span key={`${target.recordId}-${target.eventIndex ?? WHOLE}-${i}`} className="research-target">
              {isPerson ? (
                <button type="button" className="research-target-name" title={t("research.openPerson")} onClick={() => onNavigate(target.recordId)}>
                  {recordLabel(target.recordId)}
                </button>
              ) : (
                <span className="research-target-name">{recordLabel(target.recordId)}</span>
              )}
              <DropdownMenu
                className="research-target-event"
                title={t("research.targetEvent")}
                current={target.eventIndex === undefined ? WHOLE : String(target.eventIndex)}
                groups={[{
                  items: [
                    { value: WHOLE, label: t(isPerson ? "research.wholePerson" : "research.wholeFamily") },
                    ...events.map(({ node, at }) => ({ value: String(at), label: eventLabel(node) })),
                  ],
                }]}
                onSelect={(value) => setTargetEvent(i, value)}
                trigger={<>{current ? eventLabel(current) : t(isPerson ? "research.wholePerson" : "research.wholeFamily")} ▾</>}
              />
              <button
                type="button"
                className="research-target-remove"
                title={t("research.unfile")}
                aria-label={t("research.unfile")}
                onClick={() => setTargets((prev) => prev.filter((_, at) => at !== i))}
              >
                ×
              </button>
            </span>
          );
        })}
        {picking ? (
          <div ref={pickerRef}>
            <RelativePickerCard
              individuals={dataset.individuals}
              excludeId=""
              onPickExisting={(id) => {
                setPicking(false);
                setTargets((prev) => (prev.some((p) => p.recordId === id && p.eventIndex === undefined) ? prev : [...prev, { recordId: id }]));
              }}
              onCancel={stopPicking}
              t={t}
            />
          </div>
        ) : (
          <button type="button" className="edit-name-chip edit-name-chip-add research-target-add" onClick={() => setPicking(true)}>
            + {t("research.addPerson")}
          </button>
        )}
      </div>
      <AddMediaDialog
        isOpen={mediaPicker}
        onClose={() => setMediaPicker(false)}
        onAdd={(picked) =>
          setMedia((prev) => [
            ...prev,
            ...picked
              .filter((p) => !prev.some((m) => (p.existingXref ? m.xref === p.existingXref : m.path === p.path)))
              .map((p) => (p.existingXref ? { xref: p.existingXref } : { path: p.path })),
          ])
        }
        dataset={dataset}
        t={t}
      />
    </SourceDialogShell>
  );
}
