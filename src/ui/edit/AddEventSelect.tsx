import type { Translate } from "../../locales/i18n";
import { eventDisplayLabel } from "../../gedcom/eventTags";
import { DropdownMenu, type DropdownGroup } from "../DropdownMenu";

/** Dropdown chip that adds an event tag from a list of available tags. */
export function AddEventSelect({
  tags,
  groups,
  label,
  tooltip,
  t,
  onAdd,
  className = "add-chip",
}: {
  tags?: string[];
  groups?: { labelKey: string; tags: string[] }[];
  label: string;
  tooltip?: string;
  t: Translate;
  onAdd: (tag: string) => void;
  className?: string;
}) {
  const menuGroups: DropdownGroup[] = groups
    ? groups
        .filter((g) => g.tags.length)
        .map((g) => ({
          label: t(g.labelKey),
          items: g.tags.map((tag) => ({ value: tag, label: eventDisplayLabel(tag, t) })),
        }))
    : [{ items: (tags ?? []).map((tag) => ({ value: tag, label: eventDisplayLabel(tag, t) })) }];
  if (!menuGroups.some((g) => g.items.length)) return null;
  return (
    <DropdownMenu
      groups={menuGroups}
      onSelect={onAdd}
      trigger={<>+ {label}</>}
      className={className}
      title={tooltip}
    />
  );
}
