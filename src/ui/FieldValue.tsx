/**
 * Renders one compare-table field value: a row of link icons when it carries
 * attached links, otherwise its (possibly multi-line) text. Shared by the
 * Compare panel and the Compare-tree node popover so the two can't drift.
 */
export function FieldValue({ text, links }: { text: string; links?: string[] }) {
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
  return <>{renderLines(text)}</>;
}

/**
 * A possibly multi-line value (e.g. children/partners), one item per line.
 * Blank lines keep full height (a non-breaking space) so a relative and its
 * aligned counterpart in the other column stay on the same row.
 */
function renderLines(text: string) {
  if (!text.includes("\n")) return text;
  return text.split("\n").map((line, i) => (
    <div key={i} className="val-line">
      {line || " "}
    </div>
  ));
}

/** Ensure scheme-less links (e.g. "www.example.com") get an absolute href. */
function linkHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}
