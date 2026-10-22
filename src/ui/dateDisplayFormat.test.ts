import { describe, expect, it } from "vitest";
import { parseDate } from "../gedcom/date";
import { dateDisplayFormatter } from "./dateDisplayFormat";

const show = (choice: string, raw: string, lang = "en") => dateDisplayFormatter(choice, () => lang)?.(parseDate(raw));

describe("dateDisplayFormatter", () => {
  it("leaves the file's own text alone by default", () => {
    expect(dateDisplayFormatter("", () => "en")).toBeNull();
  });

  it("writes dates in words in the reader's language", () => {
    expect(show("words", "ABT 5 MAR 1850")).toBe("about 5 March 1850");
    expect(show("words", "ABT 5 MAR 1850", "sl")).toBe("okoli 5. marca 1850");
  });

  it("writes dates in a chosen pattern, keeping the standard qualifier", () => {
    expect(show("DD.MM.YYYY", "5 MAR 1850")).toBe("05.03.1850");
    expect(show("DD.MM.YYYY", "ABT 5 MAR 1850")).toBe("ABT 05.03.1850");
    expect(show("YYYY-MM-DD", "BET 1850 AND 3 JUN 1860")).toBe("BET 1850 AND 1860-06-03");
    expect(show("D MMM YYYY", "05.03.1850")).toBe("5 MAR 1850");
    // A month with no day stays a month: no pattern slot is invented for it.
    expect(show("DD.MM.YYYY", "MAR 1850")).toBe("03.1850");
  });

  it("keeps the text of what no pattern can hold", () => {
    expect(show("DD.MM.YYYY", "@#DJULIAN@ 5 MAR 1700")).toBe("@#DJULIAN@ 5 MAR 1700");
    expect(show("DD.MM.YYYY", "v vojni")).toBe("v vojni");
  });
});
