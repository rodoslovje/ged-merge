import { describe, expect, it } from "vitest";
import type { Translate } from "../locales/i18n";
import { entryCell, entryLine, type PersonWords } from "./text";

const t: Translate = (key, o) => (key === "calendar.couple" ? `${o?.a} & ${o?.b}` : key);
const people: Record<string, { name: string; given: string; surname?: string; kinship?: string }> = {
  a: { name: "Ana Novak", given: "Ana", surname: "Novak", kinship: "Sister" },
  b: { name: "Marko Horvat", given: "Marko", surname: "Horvat" },
  c: { name: "Eva", given: "Eva" },
};
const words: PersonWords = {
  name: (id) => people[id].name,
  given: (id) => people[id].given,
  surname: (id) => people[id].surname,
  kinship: (id) => people[id].kinship,
  sex: () => undefined,
};

describe("entryCell", () => {
  const birthday = { kind: "birthday" as const, day: 3, ids: ["a"], years: 37 };
  it("names a day's person as chosen, the age after", () => {
    expect(entryCell(t, words, birthday, { names: "given", age: true })).toBe("Ana 37");
    expect(entryCell(t, words, birthday, { names: "initial", age: true })).toBe("Ana N. 37");
    expect(entryCell(t, words, birthday, { names: "full", age: false })).toBe("Ana Novak");
  });

  it("keeps the given name alone when there is no surname to abbreviate", () => {
    expect(entryCell(t, words, { kind: "birthday", day: 1, ids: ["c"] }, { names: "initial", age: true })).toBe("Eva");
  });

  it("names both partners of an anniversary", () => {
    const e = { kind: "anniversary" as const, day: 8, ids: ["b", "a"], years: 10 };
    expect(entryCell(t, words, e, { names: "initial", age: true })).toBe("Marko H. & Ana N. 10");
  });
});

describe("entryLine", () => {
  it("gives the full name and kinship, the years only when asked", () => {
    const e = { kind: "birthday" as const, day: 3, ids: ["a"], years: 37 };
    expect(entryLine(t, words, e, { names: "given", age: true })).toBe("Ana Novak, sister (37)");
    expect(entryLine(t, words, e, { names: "given", age: false })).toBe("Ana Novak, sister");
  });
});
