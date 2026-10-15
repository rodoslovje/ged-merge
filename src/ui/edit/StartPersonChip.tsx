import { useState, type ReactNode } from "react";
import type { Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { KEY, keyHint } from "../../keyboard/shortcuts";
import { DropdownMenu, type DropdownItem } from "../DropdownMenu";
import { RelativePickerCard } from "./RelativePickerCard";
import { HomeIcon } from "../icons/HomeIcon";

/**
 * The start person's control, living where its effect shows: the kinship
 * label in Edit's name row. With a start person set, the label itself opens a
 * menu (go to them, make this person the start, choose another, clear); with
 * none set, a faint "Set start person" chip takes the label's place, so the
 * kinship feature advertises itself on every person instead of in a header
 * field. When there is no label to show (kinship hidden in Settings, or no
 * relation), a bare ⌂ carries the same menu.
 */
export function StartPersonChip({
  t,
  personId,
  startId,
  startName,
  kinship,
  kinshipLineage,
  kinshipTooltip,
  individuals,
  onChange,
  onGoToStart,
}: {
  t: Translate;
  personId: string;
  startId: string | undefined;
  startName: string | undefined;
  kinship?: string;
  kinshipLineage?: string;
  kinshipTooltip?: string;
  individuals: Map<string, Individual>;
  onChange: (id: string | undefined) => void;
  onGoToStart: () => void;
}) {
  const [choosing, setChoosing] = useState(false);

  if (choosing) {
    // The same person search the relative slots open, so its rows read at the
    // size and in the style of every other person lookup in Edit.
    return (
      <RelativePickerCard
        individuals={individuals}
        excludeId={startId ?? ""}
        onPickExisting={(id) => { setChoosing(false); onChange(id); }}
        onCancel={() => setChoosing(false)}
        t={t}
      />
    );
  }

  const isStart = startId === personId;
  const items: DropdownItem[] = [];
  if (startId && !isStart) items.push({ value: "goto", label: keyHint(t("start.chip.goto", { name: startName }), KEY.home.toUpperCase()) });
  if (!isStart) items.push({ value: "make", label: t("start.chip.makeThis") });
  items.push({ value: "choose", label: t("start.chip.choose") });
  if (startId) items.push({ value: "clear", label: t("start.clear") });

  const onSelect = (v: string) => {
    if (v === "goto") onGoToStart();
    else if (v === "make") onChange(personId);
    else if (v === "choose") setChoosing(true);
    else if (v === "clear") onChange(undefined);
  };

  let className: string;
  let trigger: ReactNode;
  let title: string;
  if (!startId) {
    className = "start-chip start-chip--unset";
    trigger = <><HomeIcon size={12} /> {t("start.chip.set")}</>;
    title = t("start.tooltip");
  } else if (kinship) {
    className = `person-kinship start-chip ${kinshipLineage ?? ""}`;
    trigger = kinship;
    title = kinshipTooltip ?? kinship;
  } else {
    className = "start-chip start-chip--icon";
    trigger = <HomeIcon size={13} />;
    title = t("start.chip.heading", { name: startName });
  }

  return (
    <DropdownMenu
      groups={[{ label: t("menu.start"), items }]}
      onSelect={onSelect}
      className={className}
      title={title}
      ariaLabel={title}
      trigger={trigger}
    />
  );
}
