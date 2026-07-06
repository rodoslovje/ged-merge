import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { decisionStatusByMainId, type CandidateDecision, type MatchDecisionStatus } from "../review/types";

// Per-person working-state resolvers for chart badges, keyed by main id: the
// merge decision (C/R/D letter) and the unsaved-edit "M". Shared by every chart
// page that marks people — the tree charts draw them as circle badges, the
// timeline and report as text chips.

export interface NodeStatus {
  decisionOf: (mainId: string) => { status: Exclude<MatchDecisionStatus, "undecided">; letter: string } | undefined;
  modifiedOf: (mainId: string) => boolean;
  /** Localized first letter of "Modified", for the M badge. */
  modifiedLetter: string;
}

export function useNodeStatus(
  changedPersonIds: Set<string> | undefined,
  decisions: Map<string, CandidateDecision> | undefined,
): NodeStatus {
  const { t } = useTranslation();
  return useMemo(() => {
    const byId = decisionStatusByMainId(decisions);
    return {
      decisionOf: (mainId: string) => {
        const status = byId.get(mainId);
        return status ? { status, letter: t(`status.${status}`).charAt(0) } : undefined;
      },
      modifiedOf: (mainId: string) => !!changedPersonIds?.has(mainId),
      modifiedLetter: t("edit.tree.modified").charAt(0),
    };
  }, [changedPersonIds, decisions, t]);
}
