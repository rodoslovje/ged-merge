import { describe, expect, it } from "vitest";
import type { GedNode } from "./types";
import { addressPartNodes, addressText, eventAddressNode } from "./address";

const node = (tag: string, value?: string, children: GedNode[] = []): GedNode => ({
  level: 0,
  tag,
  ...(value !== undefined ? { value } : {}),
  children,
});

describe("eventAddressNode", () => {
  it("finds an ADDR that says anything — its line or only labelled lines", () => {
    const structured = node("ADDR", undefined, [node("ADR1", "Dunajska 5"), node("CITY", "Ljubljana")]);
    const event = node("BIRT", undefined, [node("PLAC", "Ljubljana"), node("ADDR"), structured]);
    expect(eventAddressNode(event)).toBe(structured);
    expect(addressText(eventAddressNode(event))).toBe("Dunajska 5, Ljubljana");
  });

  it("finds none on an event whose ADDR is empty", () => {
    expect(eventAddressNode(node("BIRT", undefined, [node("ADDR", " ")]))).toBeUndefined();
  });
});

describe("addressPartNodes", () => {
  it("lists the labelled lines that carry text, in file order", () => {
    const addr = node("ADDR", "Dunajska 5", [node("CITY", "Ljubljana"), node("POST", ""), node("NOTE", "x"), node("ADR1", "Dunajska 5")]);
    expect(addressPartNodes(addr).map((c) => c.tag)).toEqual(["CITY", "ADR1"]);
  });
});
