import { linkHref, linkTooltip } from "../FieldValue";
import type { Translate } from "../../locales/i18n";

/**
 * The link a source (or a media record) is written from: the field, the ↗ that
 * opens the page, and — where a lookup can read that page — the button that
 * reads it again into the fields beside it.
 *
 * Both editors offer this row, and both had written it out; the ↗ in
 * particular sits in an inner wrap beside the input alone, since beside the
 * whole labelled field flex-end parked it below the input's centerline.
 */
export function SourceLinkRow({
  label,
  value,
  onChange,
  onLookUp,
  fetching,
  lookupAllowed,
  t,
  title,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Read the page behind the link again; absent where none can be read. */
  onLookUp?: () => void;
  fetching?: boolean;
  /** Whether online lookups are on — the button says so when they are not. */
  lookupAllowed?: boolean;
  t: Translate;
  /** The row's own explanation, as the label's tooltip. */
  title?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const trimmed = value.trim();
  return (
    <label className="add-source-field add-source-url-row" title={title}>
      <span>{label}</span>
      <span className="add-source-url-wrap">
        <input ref={inputRef} className="edit-input" value={value} onChange={(e) => onChange(e.target.value)} />
        {trimmed && (
          <a
            className="edit-link-open"
            href={linkHref(trimmed)}
            target="_blank"
            rel="noopener noreferrer"
            title={linkTooltip(trimmed, t, t("edit.openLink"))}
          >
            ↗
          </a>
        )}
        {onLookUp && (
          <button
            type="button"
            className="tree-open-btn add-source-refetch"
            disabled={fetching || !lookupAllowed}
            title={lookupAllowed ? t("editSource.refetchHint") : t("tools.geocode.downloadNeedsOptIn")}
            onClick={onLookUp}
          >
            {fetching && <span className="spinner" aria-hidden="true" />}
            {t("editSource.refetch")}
          </button>
        )}
      </span>
    </label>
  );
}
