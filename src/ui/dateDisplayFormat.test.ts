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

  it("writes dates in a chosen pattern, the qualifier as a sign", () => {
    expect(show("DD.MM.YYYY", "5 MAR 1850")).toBe("05.03.1850");
    expect(show("DD.MM.YYYY", "ABT 5 MAR 1850")).toBe("~05.03.1850");
    expect(show("DD.MM.YYYY", "CAL 1850")).toBe("~1850");
    expect(show("DD.MM.YYYY", "EST 1850")).toBe("~1850");
    expect(show("DD.MM.YYYY", "BEF 1850")).toBe("<1850");
    expect(show("DD.MM.YYYY", "AFT 1850")).toBe(">1850");
    expect(show("YYYY-MM-DD", "BET 1850 AND 3 JUN 1860")).toBe("1850–1860-06-03");
    expect(show("DD.MM.YYYY", "1830-1850")).toBe("1830–1850");
    // A period is not a range: FROM … TO … says how long, BET … AND … when.
    expect(show("DD.MM.YYYY", "FROM 1850 TO 1860")).toBe("1850 → 1860");
    expect(show("DD.MM.YYYY", "FROM 1850")).toBe("1850 →");
    expect(show("DD.MM.YYYY", "TO 1860")).toBe("→ 1860");
    expect(show("DD.MM.YYYY", "INT 5 MAR 1850 (na veliko noč)")).toBe("05.03.1850");
    expect(show("D MMM YYYY", "05.03.1850")).toBe("5 MAR 1850");
    // A month with no day stays a month: no pattern slot is invented for it.
    expect(show("DD.MM.YYYY", "MAR 1850")).toBe("03.1850");
  });

  it("writes the Slovenian form with a space after each dot", () => {
    expect(show("D. M. YYYY", "5 MAR 1850")).toBe("5. 3. 1850");
    expect(show("D. M. YYYY", "ABT 05.03.1850")).toBe("~5. 3. 1850");
    expect(show("D. M. YYYY", "BET 5 MAR 1850 AND 6 APR 1860")).toBe("5. 3. 1850–6. 4. 1860");
    expect(show("D. M. YYYY", "MAR 1850")).toBe("3. 1850");
    expect(show("D. M. YYYY", "1850")).toBe("1850");
  });

  it("keeps the text of what no pattern can hold", () => {
    expect(show("DD.MM.YYYY", "@#DJULIAN@ 5 MAR 1700")).toBe("@#DJULIAN@ 5 MAR 1700");
    expect(show("DD.MM.YYYY", "v vojni")).toBe("v vojni");
    expect(show("DD.MM.YYYY", "15 FEB 1699/00")).toBe("15 FEB 1699/00");
    expect(show("DD.MM.YYYY", "ABT 44 BCE")).toBe("ABT 44 BCE");
  });
});
