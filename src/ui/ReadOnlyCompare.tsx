import { useTranslation } from "react-i18next";
import { defaultChoice, type FieldRow } from "../review/types";
import { isMajorDifference } from "../review/fields";
import { FieldValue, LinkIcons, RelativeGrid } from "./FieldValue";
import { SourceRefs } from "./SourceRef";

/** Navigation hooks for the relative/name links in one column. */
export interface PersonNav {
  /** True when this id can be opened (i.e. it resolves in the relevant dataset). */
  linkable: (id: string) => boolean;
  /** Open the person with this id. */
  onNavigate: (id: string) => void;
}

interface Props {
  rows: FieldRow[];
  mainPerson: PersonNav;
  incomingPerson: PersonNav;
  /** Column header for the left (main) side. */
  mainLabel: string;
  /** Column header for the right (incoming) side. */
  incomingLabel: string;
  /** Table class — defaults to the compare-tree styling. */
  className?: string;
  /** Omit the header row entirely — useful when the column identities are already
   *  shown just above the table (e.g. the duplicate finder's pair row). */
  hideHeader?: boolean;
  /** Main-only: show just labels + the main column (no incoming side). Used
   *  by the Edit Tree's person panel, where there is no incoming dataset. */
  singleColumn?: boolean;
}

/**
 * Read-only two-column field comparison shared by the compare tree's detail
 * panel and the Tools duplicate finder. Renders `individualFieldRows` output
 * without any per-field choice controls; the value that would be kept (main,
 * else incoming) is shown in bold via the same `chosen` emphasis as the
 * editable Compare panel.
 */
export function ReadOnlyCompare({
  rows,
  mainPerson,
  incomingPerson,
  mainLabel,
  incomingLabel,
  className = "tree-compare-table",
  hideHeader = false,
  singleColumn = false,
}: Props) {
  const { t } = useTranslation();
  const valueCols = singleColumn ? 1 : 2;
  return (
    <table className={singleColumn ? `${className} single-col` : className}>
      {!hideHeader && (
        <thead>
          <tr>
            <th />
            <th className="compare-col compare-col-main">{mainLabel}</th>
            {!singleColumn && <th className="compare-col compare-col-incoming">{incomingLabel}</th>}
          </tr>
        </thead>
      )}
      <tbody>
        {rows.map((row) => {
          if (row.isGroupHeader) {
            const isEventHeader = !!row.isEventHeader;
            return (
              <tr key={row.key} className={isEventHeader ? "group-header-row event-header-row" : "group-header-row"}>
                <td colSpan={1 + valueCols} className={isEventHeader ? "group-header-cell event-header-cell" : "group-header-cell"} style={isEventHeader ? undefined : { textAlign: "left", paddingLeft: "10px" }} title={row.labelTitle}>
                  {row.label}
                </td>
              </tr>
            );
          }

          // Read-only: mark the value that would be kept (main, else incoming)
          // in bold — the same emphasis as the main compare screen.
          const choice = defaultChoice(row);
          // A sources row can be link-icons-only (no actual SOUR citation on
          // either side yet) — still route it through the icon rendering below
          // rather than the plain-text branch, which would print the bare URL.
          const hasSources = !!(row.mainSources || row.incomingSources || row.mainLinkIcons || row.incomingLinkIcons);
          return (
            <tr key={row.key} className={`field ${row.state}${isMajorDifference(row) ? " major" : ""}`}>
              <td className="f-label">{row.displayLabel ?? row.label}</td>
              {row.relatives ? (
                <td className="f-rel" colSpan={valueCols}>
                  <RelativeGrid
                    pairs={row.relatives}
                    // Children are opt-in, so in this read-only preview none
                    // read as taken; partners follow the row's default choice.
                    mainChosen={row.perChildChoice ? true : choice !== "incoming"}
                    incomingChosen={row.perChildChoice ? false : choice !== "main"}
                    mainPerson={mainPerson}
                    incomingPerson={incomingPerson}
                    singleColumn={singleColumn}
                  />
                </td>
              ) : hasSources ? (
                <>
                  <td className={!singleColumn && choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"}>
                    <SourceRefs t={t} mainSources={row.mainSources} />
                    {row.mainLinkIcons?.length ? <LinkIcons urls={row.mainLinkIcons} otherUrls={row.incomingLinkIcons} /> : null}
                  </td>
                  {!singleColumn && (
                    <td className={choice !== "main" ? "f-val gm-data chosen" : "f-val gm-data"}>
                      <SourceRefs t={t} mainSources={row.incomingSources} compareAgainst={row.mainSources} />
                      {row.incomingLinkIcons?.length ? <LinkIcons urls={row.incomingLinkIcons} otherUrls={row.mainLinkIcons} /> : null}
                    </td>
                  )}
                </>
              ) : (
                <>
                  <td
                    className={!singleColumn && choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"}
                    title={row.mainTitle}
                  >
                    <FieldValue
                      text={row.main}
                      links={row.mainLinks}
                      person={row.mainRefs ? { refs: row.mainRefs, ...mainPerson } : undefined}
                    />
                  </td>
                  {!singleColumn && (
                    <td
                      className={choice !== "main" ? "f-val gm-data chosen" : "f-val gm-data"}
                      title={row.incomingTitle}
                    >
                      <FieldValue
                        text={row.incoming}
                        links={row.incomingLinks}
                        otherLinks={row.mainLinks}
                        person={row.incomingRefs ? { refs: row.incomingRefs, ...incomingPerson } : undefined}
                      />
                    </td>
                  )}
                </>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
