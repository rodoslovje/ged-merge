import { useTranslation } from "react-i18next";
import { defaultChoice, type FieldRow } from "../review/types";
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
  masterPerson: PersonNav;
  incomingPerson: PersonNav;
  /** Column header for the left (master) side. */
  masterLabel: string;
  /** Column header for the right (incoming) side. */
  incomingLabel: string;
  /** Table class — defaults to the compare-tree styling. */
  className?: string;
  /** Omit the header row entirely — useful when the column identities are already
   *  shown just above the table (e.g. the duplicate finder's pair row). */
  hideHeader?: boolean;
}

/**
 * Read-only two-column field comparison shared by the compare tree's detail
 * panel and the Tools duplicate finder. Renders `individualFieldRows` output
 * without any per-field choice controls; the value that would be kept (master,
 * else incoming) is shown in bold via the same `chosen` emphasis as the
 * editable Compare panel.
 */
export function ReadOnlyCompare({
  rows,
  masterPerson,
  incomingPerson,
  masterLabel,
  incomingLabel,
  className = "tree-compare-table",
  hideHeader = false,
}: Props) {
  const { t } = useTranslation();
  return (
    <table className={className}>
      {!hideHeader && (
        <thead>
          <tr>
            <th />
            <th className="compare-col compare-col-master">{masterLabel}</th>
            <th className="compare-col compare-col-incoming">{incomingLabel}</th>
          </tr>
        </thead>
      )}
      <tbody>
        {rows.map((row) => {
          if (row.isGroupHeader) {
            const isEventHeader = !!row.isEventHeader;
            return (
              <tr key={row.key} className={isEventHeader ? "group-header-row event-header-row" : "group-header-row"}>
                <td colSpan={3} className={isEventHeader ? "group-header-cell event-header-cell" : "group-header-cell"} style={isEventHeader ? undefined : { textAlign: "left", paddingLeft: "10px" }}>
                  {row.label}
                </td>
              </tr>
            );
          }

          // Read-only: mark the value that would be kept (master, else incoming)
          // in bold — the same emphasis as the main compare screen.
          const choice = defaultChoice(row);
          // A sources row can be link-icons-only (no actual SOUR citation on
          // either side yet) — still route it through the icon rendering below
          // rather than the plain-text branch, which would print the bare URL.
          const hasSources = !!(row.masterSources || row.incomingSources || row.masterLinkIcons || row.incomingLinkIcons);
          return (
            <tr key={row.key} className={`field ${row.state}`}>
              <td className="f-label">{row.displayLabel ?? row.label}</td>
              {row.relatives ? (
                <td className="f-rel" colSpan={2}>
                  <RelativeGrid
                    pairs={row.relatives}
                    // Children are opt-in, so in this read-only preview none
                    // read as taken; partners follow the row's default choice.
                    masterChosen={row.perChildChoice ? true : choice !== "incoming"}
                    incomingChosen={row.perChildChoice ? false : choice !== "master"}
                    masterPerson={masterPerson}
                    incomingPerson={incomingPerson}
                  />
                </td>
              ) : hasSources ? (
                <>
                  <td className={choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"}>
                    <SourceRefs t={t} masterSources={row.masterSources} />
                    {row.masterLinkIcons?.length ? <LinkIcons urls={row.masterLinkIcons} otherUrls={row.incomingLinkIcons} /> : null}
                  </td>
                  <td className={choice !== "master" ? "f-val gm-data chosen" : "f-val gm-data"}>
                    <SourceRefs t={t} masterSources={row.incomingSources} compareAgainst={row.masterSources} />
                    {row.incomingLinkIcons?.length ? <LinkIcons urls={row.incomingLinkIcons} otherUrls={row.masterLinkIcons} /> : null}
                  </td>
                </>
              ) : (
                <>
                  <td
                    className={choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"}
                    title={row.masterTitle}
                  >
                    <FieldValue
                      text={row.master}
                      links={row.masterLinks}
                      person={row.masterRefs ? { refs: row.masterRefs, ...masterPerson } : undefined}
                    />
                  </td>
                  <td
                    className={choice !== "master" ? "f-val gm-data chosen" : "f-val gm-data"}
                    title={row.incomingTitle}
                  >
                    <FieldValue
                      text={row.incoming}
                      links={row.incomingLinks}
                      otherLinks={row.masterLinks}
                      person={row.incomingRefs ? { refs: row.incomingRefs, ...incomingPerson } : undefined}
                    />
                  </td>
                </>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
