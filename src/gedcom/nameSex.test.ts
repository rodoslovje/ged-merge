import { describe, expect, it } from "vitest";
import { sexFromGivenName } from "./nameSex";

describe("sexFromGivenName", () => {
  it("reads the listed Slovenian names", () => {
    expect(sexFromGivenName("Janez")).toBe("M");
    expect(sexFromGivenName("Jurij")).toBe("M");
    expect(sexFromGivenName("Frančiška")).toBe("F");
    expect(sexFromGivenName("Neža")).toBe("F");
  });

  it("reads names written without diacritics", () => {
    expect(sexFromGivenName("Jozef")).toBe("M");
    expect(sexFromGivenName("Matevz")).toBe("M");
    expect(sexFromGivenName("Neza")).toBe("F");
  });

  it("calls an unlisted -a name female", () => {
    expect(sexFromGivenName("Kancijanila")).toBe("F");
    expect(sexFromGivenName("Rotija")).toBe("F");
  });

  it("keeps the male -a names male", () => {
    expect(sexFromGivenName("Matija")).toBe("M");
    expect(sexFromGivenName("Luka")).toBe("M");
    expect(sexFromGivenName("Miha")).toBe("M");
    expect(sexFromGivenName("Nikola")).toBe("M");
  });

  it("reads the German and Latin forms the older books use", () => {
    expect(sexFromGivenName("Margareth")).toBe("F");
    expect(sexFromGivenName("Agnes")).toBe("F");
    expect(sexFromGivenName("Gertrud")).toBe("F");
    expect(sexFromGivenName("Johann")).toBe("M");
    expect(sexFromGivenName("Franz")).toBe("M");
  });

  it("does not mistake a male name ending in -e or -o for a woman", () => {
    expect(sexFromGivenName("France")).toBe("M");
    expect(sexFromGivenName("Jože")).toBe("M");
    expect(sexFromGivenName("Lovro")).toBe("M");
    expect(sexFromGivenName("Miko")).toBe("M");
  });

  it("reads a multi-part given name part by part", () => {
    expect(sexFromGivenName("Elizabeta Špela")).toBe("F");
    expect(sexFromGivenName("Franc Ksaver")).toBe("M");
    expect(sexFromGivenName("Ana Marija")).toBe("F");
  });

  it("stays silent on placeholders, initials and unknown names", () => {
    expect(sexFromGivenName("")).toBeUndefined();
    expect(sexFromGivenName(undefined)).toBeUndefined();
    expect(sexFromGivenName("NN")).toBeUndefined();
    expect(sexFromGivenName("____")).toBeUndefined();
    expect(sexFromGivenName("S.")).toBeUndefined();
    expect(sexFromGivenName("Habbe")).toBeUndefined();
  });

  it("stays silent on names that are male in one tradition and female in another", () => {
    expect(sexFromGivenName("Saša")).toBeUndefined();
    expect(sexFromGivenName("Vanja")).toBeUndefined();
    expect(sexFromGivenName("Ivica")).toBeUndefined();
  });
});
