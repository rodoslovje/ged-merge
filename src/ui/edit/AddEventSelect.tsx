import type { Translate } from "../../locales/i18n";
import { DropdownMenu, type DropdownGroup } from "../DropdownMenu";
import { deniedEventLabel, eventMenuLabel } from "../EventGlyph";

/** Marks a menu value as a "did not happen" pick rather than an event tag. */
const DENY = "\0no:";

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
  denyTags,
  onDeny,
}: {
  /** Events the record can be said never to have had: a last group, »Did
   *  not happen:«, after the events themselves (then headed »Event:«). */
  denyTags?: string[];
  onDeny?: (tag: string) => void;
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
    : [{ label: denyTags?.length ? t("edit.addEvent.happened") : undefined, items: (tags ?? []).map(item) }];
  if (denyTags?.length) {
    menuGroups.push({
      label: t("edit.noEvent.label"),
      items: denyTags.map((tag) => ({ value: `${DENY}${tag}`, label: deniedEventLabel(tag, t) })),
    });
  }
  if (!menuGroups.some((g) => g.items.length)) return null;
  return (
    <DropdownMenu
      groups={menuGroups.filter((g) => g.items.length)}
      onSelect={(value) => (value.startsWith(DENY) ? onDeny?.(value.slice(DENY.length)) : onAdd(value))}
      trigger={<>+ {label}</>}
      className={className}
      title={tooltip}
      openNonce={openNonce}
    />
  );
}
