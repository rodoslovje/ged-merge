import { describe, expect, it } from "vitest";
import type { PersonName } from "./types";
import { DEFAULT_NAME_DISPLAY, formatPersonName, type NameDisplayOptions } from "./nameDisplay";

const opts = (patch: Partial<NameDisplayOptions> = {}): NameDisplayOptions => ({
  ...DEFAULT_NAME_DISPLAY,
  ...patch,
});

const name = (patch: Partial<PersonName>): PersonName => ({ full: "", ...patch });

describe("formatPersonName", () => {
  it("reproduces the full name with default options", () => {
    const n = name({ full: "Ana Novak", given: "Ana", surname: "Novak" });
    expect(formatPersonName(n, DEFAULT_NAME_DISPLAY)).toBe("Ana Novak");
  });

  it("returns (unnamed) for a missing name", () => {
    expect(formatPersonName(undefined, DEFAULT_NAME_DISPLAY)).toBe("(unnamed)");
  });

  it("orders surname-first as 'Surname, Given'", () => {
    const n = name({ full: "Ana Novak", given: "Ana", surname: "Novak" });
    expect(formatPersonName(n, opts({ order: "surname-given" }))).toBe("Novak, Ana");
  });

  it("uppercases the surname in given-surname order", () => {
    const n = name({ full: "Ana Novak", given: "Ana", surname: "Novak" });
    expect(formatPersonName(n, opts({ uppercaseSurname: true }))).toBe("Ana NOVAK");
  });

  it("uppercases the surname in surname-given order", () => {
    const n = name({ full: "Ana Novak", given: "Ana", surname: "Novak" });
    expect(formatPersonName(n, opts({ order: "surname-given", uppercaseSurname: true }))).toBe("NOVAK, Ana");
  });

  it("appends the married surname in parentheses", () => {
    const n = name({ full: "Ana Novak", given: "Ana", surname: "Novak", married: "Kovač" });
    expect(formatPersonName(n, opts({ marriedSurname: true }))).toBe("Ana Novak (Kovač)");
  });

  it("uppercases the married surname when uppercaseSurname is on", () => {
    const n = name({ full: "Ana Novak", given: "Ana", surname: "Novak", married: "Kovač" });
    expect(formatPersonName(n, opts({ marriedSurname: true, uppercaseSurname: true }))).toBe("Ana NOVAK (KOVAČ)");
  });

  it("omits the married surname when it equals the maiden surname", () => {
    const n = name({ full: "Ana Novak", given: "Ana", surname: "Novak", married: "novak" });
    expect(formatPersonName(n, opts({ marriedSurname: true }))).toBe("Ana Novak");
  });

  it("omits the married parenthetical when there is no married surname", () => {
    const n = name({ full: "Ana Novak", given: "Ana", surname: "Novak" });
    expect(formatPersonName(n, opts({ marriedSurname: true }))).toBe("Ana Novak");
  });

  it("falls back to the full name when there is no surname to format", () => {
    const n = name({ full: "Ana", given: "Ana" });
    expect(formatPersonName(n, opts({ order: "surname-given", uppercaseSurname: true }))).toBe("Ana");
  });

  it("keeps the married surname next to the surname in surname-given order", () => {
    const n = name({ full: "Ana Novak", given: "Ana", surname: "Novak", married: "Kovač" });
    expect(formatPersonName(n, opts({ order: "surname-given", marriedSurname: true }))).toBe("Novak (Kovač), Ana");
  });

  it("combines uppercase, surname-given order and married surname", () => {
    const n = name({ full: "Ana Novak", given: "Ana", surname: "Novak", married: "Kovač" });
    expect(
      formatPersonName(n, opts({ order: "surname-given", uppercaseSurname: true, marriedSurname: true })),
    ).toBe("NOVAK (KOVAČ), Ana");
  });
});
