import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { validateDataset } from "./validate";

const dataset = (body: string) =>
  buildDataset(parseGedcom(new TextEncoder().encode(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${body}0 TRLR\n`).buffer));

const statedAgeIssues = (body: string) =>
  validateDataset(dataset(body), 2026).issues.filter((i) => i.category === "statedAge");

describe("health check: a stated age that contradicts the birth", () => {
  it("reports an age the birth date cannot give", () => {
    const issues = statedAgeIssues(
      "0 @I1@ INDI\n1 NAME A /B/\n1 SEX M\n1 BIRT\n2 DATE 12 MAR 1828\n1 DEAT\n2 DATE 3 MAR 1890\n2 AGE 30y\n",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: "@I1@",
      severity: "warning",
      messageKey: "tools.validate.issue.statedAge",
      messageVars: { age: "30y", tag: "DEAT", date: "3 MAR 1890", birth: "12 MAR 1828", computed: "61y" },
    });
  });

  it("lets an age off by a year pass", () => {
    expect(
      statedAgeIssues("0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 12 MAR 1828\n1 DEAT\n2 DATE 3 MAR 1890\n2 AGE 62y\n"),
    ).toEqual([]);
    expect(statedAgeIssues("0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1828\n1 DEAT\n2 DATE 1890\n2 AGE 62y\n")).toEqual([]);
  });

  it("gives an approximate birth more room", () => {
    expect(statedAgeIssues("0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE ABT 1830\n1 DEAT\n2 DATE 1890\n2 AGE 62y\n")).toEqual([]);
  });

  it("checks a spouse's age on a family event and reads the keywords", () => {
    const issues = statedAgeIssues(
      "0 @I1@ INDI\n1 NAME A /B/\n1 SEX M\n1 BIRT\n2 DATE 1800\n1 FAMS @F1@\n1 BURI\n2 DATE 1806\n2 AGE INFANT\n" +
        "0 @F1@ FAM\n1 HUSB @I1@\n1 MARR\n2 DATE 1830\n2 HUSB\n3 AGE >60y\n",
    );
    expect(issues.map((i) => i.messageVars?.tag)).toEqual(["BURI", "MARR"]);
  });

  it("stays quiet without a birth date or with an unreadable age", () => {
    expect(statedAgeIssues("0 @I1@ INDI\n1 NAME A /B/\n1 DEAT\n2 DATE 1890\n2 AGE 30y\n")).toEqual([]);
    expect(
      statedAgeIssues("0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1828\n1 DEAT\n2 DATE 1890\n2 AGE about thirty\n"),
    ).toEqual([]);
  });
});
