import type { Translate } from "../../locales/i18n";
import { DropdownMenu, type DropdownGroup } from "../DropdownMenu";
import { eventMenuLabel } from "../EventGlyph";

/** Dropdown chip that adds an event tag from a list of available tags. */
export function AddEventSelect({
  tags,
  groups,
  label,
  tooltip,
  t,
  onAdd,
  className = "add-chip",
  openNonce,
  labelOf,
}: {
  tags?: string[];
  groups?: { labelKey: string; tags: string[] }[];
  label: string;
  tooltip?: string;
  t: Translate;
  onAdd: (tag: string) => void;
  className?: string;
  /** Increment to open the menu from a keyboard shortcut (see DropdownMenu). */
  openNonce?: number;
  /** Names a tag in the menu its own way — a family's household events read
   *  as the couple's (see `familyEventLabel`). */
  labelOf?: (tag: string, t: Translate) => string;
}) {
  const item = (tag: string) => ({ value: tag, label: eventMenuLabel(tag, t, labelOf?.(tag, t)) });
  const menuGroups: DropdownGroup[] = groups
    ? groups
        .filter((g) => g.tags.length)
        .map((g) => ({
          label: t(g.labelKey),
          items: g.tags.map(item),
        }))
    : [{ items: (tags ?? []).map(item) }];
  if (!menuGroups.some((g) => g.items.length)) return null;
  return (
    <DropdownMenu
      groups={menuGroups}
      onSelect={onAdd}
      trigger={<>+ {label}</>}
      className={className}
      title={tooltip}
      openNonce={openNonce}
    />
  );
}
