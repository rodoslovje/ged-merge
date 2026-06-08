/** A person a value line can link to: its id plus a click handler. */
export interface PersonLinks {
  /** Per-line individual ids, aligned with the lines of `text`. */
  refs?: (string | undefined)[];
  /** Whether a given id can be navigated to (e.g. is in the match list). */
  linkable: (id: string) => boolean;
  /** Navigate to the person with this id. */
  onNavigate: (id: string) => void;
}

/**
 * Renders one compare-table field value: a row of link icons when it carries
 * attached links, otherwise its (possibly multi-line) text. Relative rows can
 * pass `person` so each name becomes a button that jumps to that person. Shared
 * by the Compare panel and the Compare-tree node popover so the two can't drift.
 */
export function FieldValue({
  text,
  links,
  person,
}: {
  text: string;
  links?: string[];
  person?: PersonLinks;
}) {
  if (links && links.length > 0) {
    return (
      <span className="links">
        {links.map((url, i) => (
          <a
            key={i}
            href={linkHref(url)}
            target="_blank"
            rel="noopener noreferrer"
            className="link-icon"
            title={url}
          >
            🔗
          </a>
        ))}
      </span>
    );
  }
  return <>{renderLines(text, person)}</>;
}

/**
 * A possibly multi-line value (e.g. children/partners), one item per line.
 * Blank lines keep full height (a non-breaking space) so a relative and its
 * aligned counterpart in the other column stay on the same row. When `person`
 * is supplied, a line whose id is navigable renders as a jump-to-person button.
 */
function renderLines(text: string, person?: PersonLinks) {
  const lines = text.split("\n");
  // Single-line values (most fields, and father/mother) render inline.
  if (lines.length === 1) return renderLine(text, person?.refs?.[0], person);
  return lines.map((line, i) => (
    <div key={i} className="val-line">
      {renderLine(line, person?.refs?.[i], person)}
    </div>
  ));
}

function renderLine(line: string, id: string | undefined, person?: PersonLinks) {
  if (!line) return " ";
  if (person && id && person.linkable(id)) {
    return (
      <button type="button" className="person-link" onClick={() => person.onNavigate(id)}>
        {line}
      </button>
    );
  }
  return line;
}

/** Ensure scheme-less links (e.g. "www.example.com") get an absolute href. */
function linkHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}
