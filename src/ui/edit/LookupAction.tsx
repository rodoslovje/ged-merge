import { useTranslation } from "react-i18next";
import type { LookupState } from "../../geo/lookup";

/**
 * The link that runs one register's search, and what that search then has to
 * say — the three lines every list on the geocoding pages, the compliance
 * report and the coordinate panel drew for themselves, once each per service.
 *
 * The rule they share: a search that has answered puts its own button away,
 * because the answer is the list of options and asking the same service the
 * same question returns it. What differs is when that rule is suspended — an
 * answer of *nothing* is worth another press where the search could be widened,
 * and not where it could not — so the caller decides with {@link offer} rather
 * than the component guessing from the state.
 */
export type LookupKind = "rn" | "online" | "gov";

export function LookupAction({
  kind,
  state,
  onRun,
  offer,
  disabled,
  title,
  noteClass = "tools-geo-online-note",
}: {
  /** Which service — the whole set of strings hangs off it. */
  kind: LookupKind;
  state: LookupState<unknown>;
  onRun: () => void;
  /** Whether the button is on offer at all. Defaults to "not yet answered". */
  offer?: boolean;
  /** Defaults to "while this search is running"; a panel whose searches share a
   *  queue passes its own. */
  disabled?: boolean;
  title?: string;
  /** The class its notes wear, so a panel's own note style is kept. */
  noteClass?: string;
}) {
  const { t } = useTranslation();
  const show = offer ?? state.state !== "done";
  return (
    <>
      {show && (
        <button
          className="tools-issue-link"
          disabled={disabled ?? state.state === "loading"}
          {...(title ? { title } : {})}
          onClick={onRun}
        >
          {t(state.state === "loading" ? `tools.geocode.${kind}.searching` : `tools.geocode.${kind}.search`)}
        </button>
      )}
      {state.state === "error" && <span className={noteClass}>{t(`tools.geocode.${kind}.error`)}</span>}
      {state.state === "done" && !state.results.length && (
        <span className={noteClass}>{t(`tools.geocode.${kind}.none`)}</span>
      )}
    </>
  );
}
