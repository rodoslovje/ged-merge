import { EVENT_GLYPHS, GENERIC_EVENT_GLYPH, eventDisplayLabel, orderedEventTags } from "../gedcom/eventTags";
import type { Translate } from "../locales/i18n";

/**
 * The classic genealogy mark for one event type — ⚭ a marriage, † a death, *
 * a birth (see `EVENT_GLYPHS`). Drawn in a slot of its own width so a column
 * of rows lines up whatever each row's event is, and muted: the mark says what
 * kind of event this is, it is not the row's subject.
 *
 * `named` decides whether the mark carries the event's name for a screen
 * reader. Beside a label that already says "Marriage" it must not (the reader
 * would hear it twice), and it is marked decorative; standing alone after a
 * person's name, the name is the only thing it says, so it is read out.
 */
export function EventGlyph({ tag, t, named = false }: { tag: string; t: Translate; named?: boolean }) {
  const glyph = EVENT_GLYPHS[tag] ?? GENERIC_EVENT_GLYPH;
  const name = eventDisplayLabel(tag, t);
  return (
    <span
      className={"event-glyph" + (glyph === "*" ? " event-glyph--high" : "")}
      title={name}
      {...(named ? { role: "img", "aria-label": name } : { "aria-hidden": true })}
    >
      {glyph}
    </span>
  );
}

/**
 * The marks for a set of event types, in life-cycle order and each kind drawn
 * once — what a name in a place worklist wears to say which of that person's
 * events happened there ("Marija Oblak ⚭ †"). Renders nothing for an empty
 * set, so a caller can pass what it has.
 */
export function EventGlyphs({ tags, t }: { tags: readonly string[]; t: Translate }) {
  const ordered = orderedEventTags(tags);
  if (ordered.length === 0) return null;
  return (
    <span className="event-glyphs">
      {ordered.map((tag) => (
        <EventGlyph key={tag} tag={tag} t={t} named />
      ))}
    </span>
  );
}
