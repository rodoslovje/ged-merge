import { Fragment } from "react";
import type { RelativeCell, RelativePair } from "../review/types";
import { linkKey } from "../normalize/links";
import { sexClass } from "./sex";

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
  otherLinks,
  linkIcons,
  otherLinkIcons,
}: {
  text: string;
  links?: string[];
  person?: PersonLinks;
  /** The other side's links, to highlight ones in `links` that would be added. */
  otherLinks?: string[];
  /** Inline link icons shown alongside the text (for event-attached links). */
  linkIcons?: string[];
  /** The other side's inline link icons, to highlight new ones. */
  otherLinkIcons?: string[];
}) {
  if (links && links.length > 0) {
    const otherKeys = otherLinks && new Set(otherLinks.map(linkKey));
    return (
      <span className="links">
        {links.map((url, i) => (
          <a
            key={i}
            href={linkHref(url)}
            target="_blank"
            rel="noopener noreferrer"
            className={otherKeys && !otherKeys.has(linkKey(url)) ? "link-icon link-new" : "link-icon"}
            title={url}
          >
            🔗
          </a>
        ))}
      </span>
    );
  }
  if (linkIcons && linkIcons.length > 0) {
    const otherIconKeys = otherLinkIcons && new Set(otherLinkIcons.map(linkKey));
    return (
      <>
        {renderLines(text, person)}
        <span className="links">
          {linkIcons.map((url, i) => (
            <a
              key={i}
              href={linkHref(url)}
              target="_blank"
              rel="noopener noreferrer"
              className={otherIconKeys && !otherIconKeys.has(linkKey(url)) ? "link-icon link-new" : "link-icon"}
              title={url}
            >
              🔗
            </a>
          ))}
        </span>
      </>
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

/** One side's link behaviour for a relative cell (no per-line `refs` needed). */
export type RelativePerson = Pick<PersonLinks, "linkable" | "onNavigate">;

/**
 * Renders an aligned relatives list (children, partners) as a two-column grid:
 * each pair occupies one grid row, so the same person stays lined up across the
 * master and incoming columns even when a name wraps to several lines. The
 * bold/muted emphasis follows the field's chosen side, like single-value rows.
 */
export function RelativeGrid({
  pairs,
  masterChosen,
  incomingChosen,
  masterPerson,
  incomingPerson,
}: {
  pairs: RelativePair[];
  masterChosen: boolean;
  incomingChosen: boolean;
  masterPerson: RelativePerson;
  incomingPerson: RelativePerson;
}) {
  const renderCell = (cell: RelativeCell | undefined, person: RelativePerson) => {
    if (!cell || !cell.text) return " ";
    let content: React.ReactNode = cell.text;
    if (cell.name) {
      content = (
        <span className={`person-label ${sexClass(cell.sex)}`}>
          <span className="person-name">{cell.name}</span>
          {cell.years && <span className="person-years gm-data">{cell.years}</span>}
        </span>
      );
    }
    return renderLine(content, cell.id, person);
  };

  return (
    <div className="rel-grid">
      {pairs.map((p, i) => (
        <Fragment key={i}>
          <div
            className={`rel-cell f-val gm-data${masterChosen ? " chosen" : ""}`}
            title={p.master?.title}
          >
            {renderCell(p.master, masterPerson)}
          </div>
          <div
            className={`rel-cell rel-incoming f-val gm-data${incomingChosen ? " chosen" : ""}`}
            title={p.incoming?.title}
          >
            {renderCell(p.incoming, incomingPerson)}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function renderLine(line: React.ReactNode, id: string | undefined, person?: PersonLinks | RelativePerson) {
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
export function linkHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}
