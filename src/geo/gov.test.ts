import { describe, expect, it } from "vitest";
import { parseSearchIds, parseObject, scoreObject, type GovObject } from "./gov";
import { foldToken } from "../match/text";

const SEARCH_RESPONSE =
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
  '<ns1:searchByNameResponse xmlns:ns1="http://gov.genealogy.net/ws">' +
  '<out xmlns:ns2="http://gov.genealogy.net/data" xmlns:ns3="http://gov.genealogy.net/ws">' +
  "<ns3:item>object_310010</ns3:item><ns3:item>KRANJEJN75FU</ns3:item><ns3:item> </ns3:item>" +
  "</out></ns1:searchByNameResponse></soap:Body></soap:Envelope>";

const OBJECT_RESPONSE =
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
  '<ns1:getObjectResponse xmlns:ns1="http://gov.genealogy.net/ws">' +
  '<out xmlns:ns2="http://gov.genealogy.net/data" id="object_310010" last-modification="2009-05-20T14:14:32.000+02:00">' +
  '<ns2:position lon="14.3075" lat="46.165833" type="c"/>' +
  '<ns2:name lang="deu" value="Krainburg"/>' +
  '<ns2:name lang="slo" value="Kranj"/>' +
  '<ns2:type value="146"><ns2:source ref="source_305695"><ns2:page>54</ns2:page></ns2:source></ns2:type>' +
  '<ns2:part-of ref="object_310001"/>' +
  "</out></ns1:getObjectResponse></soap:Body></soap:Envelope>";

describe("parseSearchIds", () => {
  it("extracts non-empty ids in order", () => {
    expect(parseSearchIds(SEARCH_RESPONSE)).toEqual(["object_310010", "KRANJEJN75FU"]);
  });
  it("returns nothing for an empty/foreign body", () => {
    expect(parseSearchIds("<out></out>")).toEqual([]);
  });
});

describe("parseObject", () => {
  it("reads id, position, names, type code and the superordinate refs", () => {
    const obj = parseObject(OBJECT_RESPONSE);
    expect(obj).toEqual<GovObject>({
      id: "object_310010",
      coord: { lat: 46.165833, lon: 14.3075 },
      names: [
        { lang: "deu", value: "Krainburg" },
        { lang: "slo", value: "Kranj" },
      ],
      typeCode: "146",
      // The parent is what tells same-named places apart; only the first is
      // ever resolved, but all of them are read.
      partOf: ["object_310001"],
    });
  });

  it("reads every part-of in order, and none when there are none", () => {
    const twoParents = OBJECT_RESPONSE.replace(
      '<ns2:part-of ref="object_310001"/>',
      '<ns2:part-of ref="object_1123972"/><ns2:part-of ref="object_310011"/>',
    );
    expect(parseObject(twoParents)?.partOf).toEqual(["object_1123972", "object_310011"]);
    expect(parseObject(OBJECT_RESPONSE.replace('<ns2:part-of ref="object_310001"/>', ""))?.partOf).toEqual([]);
  });

  it("returns undefined when there is no object (fault body)", () => {
    const fault =
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
      "<soap:Fault><faultstring>NoSuchObject</faultstring></soap:Fault></soap:Body></soap:Envelope>";
    expect(parseObject(fault)).toBeUndefined();
  });

  it("tolerates a name element with children (not self-closed)", () => {
    const xml =
      '<out xmlns:ns2="http://gov.genealogy.net/data" id="object_1">' +
      '<ns2:position lat="46" lon="14" type="c"/>' +
      '<ns2:name lang="slo" value="Bled"><ns2:source ref="source_9"/></ns2:name>' +
      "</out>";
    const obj = parseObject(xml);
    expect(obj?.names).toEqual([{ lang: "slo", value: "Bled" }]);
  });
});

describe("scoreObject", () => {
  const kranj = parseObject(OBJECT_RESPONSE)!;

  it("prefers the UI-language name and lists the others in the label", () => {
    const sl = scoreObject(kranj, foldToken("Kranj"), "sl");
    expect(sl?.name).toBe("Kranj");
    expect(sl?.label).toBe("Kranj · Krainburg");
    expect(sl?.govId).toBe("object_310010");
    expect(sl?.coord).toEqual({ lat: 46.165833, lon: 14.3075 });
    expect(sl?.kind).toBe("146");

    const de = scoreObject(kranj, foldToken("Krainburg"), "de");
    expect(de?.name).toBe("Krainburg");
    expect(de?.label).toBe("Krainburg · Kranj");
  });

  it("matches on any language even when the UI language name is absent", () => {
    // Searching the German exonym still finds the object; without a German UI
    // the best-matching name leads.
    const en = scoreObject(kranj, foldToken("Krainburg"), "en");
    expect(en?.name).toBe("Krainburg");
  });

  it("drops objects below the similarity floor", () => {
    expect(scoreObject(kranj, foldToken("Hamburg"), "sl")).toBeUndefined();
  });

  it("drops objects with no coordinate or no name", () => {
    expect(scoreObject({ id: "x", names: [{ lang: "slo", value: "Kranj" }] }, foldToken("Kranj"), "sl")).toBeUndefined();
    expect(scoreObject({ id: "x", coord: { lat: 46, lon: 14 }, names: [] }, foldToken("Kranj"), "sl")).toBeUndefined();
  });
});
