import { afterEach, describe, expect, it } from "vitest";
import { parseDate } from "./date";
import { datesReformatted, displayDate, setDateDisplay } from "./dateDisplay";
import { narrativeSl } from "../report/lang/sl";

describe("displayDate", () => {
  afterEach(() => setDateDisplay(null));

  it("shows the file's own text by default", () => {
    expect(datesReformatted()).toBe(false);
    expect(displayDate(parseDate("ABT 5 MAR 1850"))).toBe("ABT 5 MAR 1850");
  });

  it("shows the date through an installed formatter", () => {
    setDateDisplay(narrativeSl.dateLabel);
    expect(datesReformatted()).toBe(true);
    expect(displayDate(parseDate("ABT 5 MAR 1850"))).toBe("okoli 5. marca 1850");
    expect(displayDate(parseDate("12.04.1901"))).toBe("12. aprila 1901");
  });

  it("keeps the text of a date the formatter cannot express", () => {
    setDateDisplay(narrativeSl.dateLabel);
    expect(displayDate(parseDate("v vojni"))).toBe("v vojni");
    expect(displayDate(parseDate("__.__.____"))).toBe("__.__.____");
  });
});
