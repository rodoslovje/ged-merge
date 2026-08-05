import type { Translate } from "../../locales/i18n";
import { eventDisplayLabel } from "../../gedcom/eventTags";
import { AddEventSelect } from "./AddEventSelect";

/**
 * The row that adds an event, sitting under the event list it adds to — the way
 * "+ Add child" sits under the children. The one-click events configured in
 * Settings come first, in their configured order (digits 1–9 mirror them), and
 * the "+ Add event" menu closes the row for everything else.
 *
 * An event a person can only have one of and already has keeps its button: it
 * jumps to the row that holds it rather than writing a second one, and says so
 * in its tooltip. Removing the button would cost that, and would shift every
 * button after it out from under its digit.
 */
export function EventAddRow({
  groups,
  t,
  onAddEvent,
  quickEventTags,
  addEventMenuNonce,
  /** Tags the person already carries, for the quick buttons that lead to them
   *  instead of adding. */
  recordedTags,
}: {
  groups: { labelKey: string; tags: string[] }[];
  t: Translate;
  onAddEvent: (tag: string) => void;
  quickEventTags?: string[];
  /** Increment to open the "+ Add event" menu (the 0 key shortcut). */
  addEventMenuNonce?: number;
  recordedTags: Set<string>;
}) {
  const quick = quickEventTags ?? [];
  return (
    <div className="edit-event-add-row">
      {quick.map((tag, i) => {
        const recorded = recordedTags.has(tag);
        const event = eventDisplayLabel(tag, t);
        return (
          <button
            key={tag}
            type="button"
            className={"edit-name-chip edit-name-chip-add" + (recorded ? " edit-name-chip--recorded" : "")}
            title={
              recorded
                ? t("edit.quickAdd.goTo", { event, key: i + 1 })
                : t("edit.quickAdd.tooltip", { event, key: i + 1 })
            }
            onClick={() => onAddEvent(tag)}
          >
            {recorded ? event : `+ ${event}`}
          </button>
        );
      })}
      <AddEventSelect
        groups={groups}
        label={t("edit.addEvent")}
        tooltip={t("edit.addEventTooltip")}
        t={t}
        onAdd={onAddEvent}
        className="edit-name-chip edit-name-chip-add"
        openNonce={addEventMenuNonce}
      />
    </div>
  );
}
