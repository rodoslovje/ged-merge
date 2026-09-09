import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  isHtmlNote,
  noteDocHasFormatting,
  noteToDoc,
  noteToText,
  parseNoteHtml,
  serializeNoteHtml,
  textToNoteDoc,
} from "./noteHtml";

const MYHERITAGE =
  '<p style="text-align: left;" dir="ltr">Rodil sem se 31. maja na Resavski 2 v Beogradu. Takrat sta star&scaron;a živela na Kosovski 11,</p>\n' +
  '<p style="text-align: left;" dir="ltr">za Srbsko skup&scaron;čino.</p>';

describe("isHtmlNote", () => {
  it("recognizes the tags programs write notes with", () => {
    expect(isHtmlNote(MYHERITAGE)).toBe(true);
    expect(isHtmlNote("first line<br>second")).toBe(true);
    expect(isHtmlNote('<a href="https://x.si">x</a>')).toBe(true);
  });
  it("leaves placeholder words in angle brackets alone", () => {
    expect(isHtmlNote("oče <unknown>, mati <private>")).toBe(false);
    expect(isHtmlNote("<zasebno> Novak")).toBe(false);
    expect(isHtmlNote("plain text\nwith lines")).toBe(false);
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric references, leaves unknown ones", () => {
    expect(decodeEntities("star&scaron;a &amp; o&#269;e &#x17E;ena &nbsp;x &bogus;")).toBe("starša & oče žena  x &bogus;");
  });
});

describe("noteToText", () => {
  it("renders MyHeritage paragraphs as lines with decoded characters", () => {
    expect(noteToText(MYHERITAGE)).toBe(
      "Rodil sem se 31. maja na Resavski 2 v Beogradu. Takrat sta starša živela na Kosovski 11,\nza Srbsko skupščino.",
    );
  });
  it("keeps a link's address, and a labelled link's label with it", () => {
    expect(noteToText('<p><a href="https://data.matricula-online.eu/x/?pg=235">https://data.matricula-online.eu/x/?pg=235</a></p>')).toBe(
      "https://data.matricula-online.eu/x/?pg=235",
    );
    expect(noteToText('<p>glej <a href="https://dlib.si/a">članek</a>.</p>')).toBe("glej članek (https://dlib.si/a).");
  });
  it("reads a pasted Matricula register table as header: value lines", () => {
    const html =
      '<p>krstil Porenta</p> <table class="table" style="width: 355px;"> <tbody style="box-sizing: border-box;"> ' +
      '<tr style="x"> <th style="x">Župnija/Kraj</th> <td style="x"><a style="x" href="https://data.matricula-online.eu/sl/slovenia/ljubljana/krize/">Križe</a></td> </tr> ' +
      "<tr> <th>Signatura</th> <td>03925</td> </tr> </tbody></table>";
    expect(noteToText(html)).toBe(
      "krstil Porenta\nŽupnija/Kraj: Križe (https://data.matricula-online.eu/sl/slovenia/ljubljana/krize/)\nSignatura: 03925",
    );
  });
  it("keeps the author's line breaks when only inline formatting is present", () => {
    expect(noteToText("rojen <b>doma</b>\numrl v <i>Celju</i>")).toBe("rojen doma\numrl v Celju");
  });
  it("drops Word's conditional blobs, comments and wrapper spans", () => {
    const html =
      '<!--[if gte mso 9]><xml> <o:OfficeDocumentSettings> <o:RelyOnVML/> </o:OfficeDocumentSettings></xml><![endif]-->' +
      '<p class="MsoNormal" style="margin: 0cm;"><span style="font-size: 14pt;">Anton je imel &scaron;e nezakonskega sina.<o:p></o:p></span></p>';
    expect(noteToText(html)).toBe("Anton je imel še nezakonskega sina.");
  });
  it("turns an embedded picture into a link", () => {
    expect(noteToText('<p><img style="border: none;" title="Anton" src="https://x.si/35-1.jpg?w=197&amp;h=300" alt="Anton Suhadolc" /></p>')).toBe(
      "Anton Suhadolc (https://x.si/35-1.jpg?w=197&h=300)",
    );
  });
  it("lists and headings", () => {
    expect(noteToText("<h2>Viri</h2><ul><li>prvi</li><li>drugi</li></ul><ol><li>ena</li></ol>")).toBe("Viri\n• prvi\n• drugi\n1. ena");
  });
  it("keeps an unrecognized tag as the placeholder text it is", () => {
    expect(noteToText("<p>oče <unknown>, mati &lt;private&gt;</p>")).toBe("oče <unknown>, mati <private>");
  });
  it("tolerates nested wrappers and stray breaks", () => {
    expect(noteToText("<div><p>ena</p><br><p>dva<br>tri</p></div>")).toBe("ena\ndva\ntri");
  });
  it("collapses layout whitespace but not the words", () => {
    expect(noteToText("<p>  Marija   <b>Urbanc</b>  gruntarja žena  </p>")).toBe("Marija Urbanc gruntarja žena");
  });
  it("returns plain text unchanged", () => {
    expect(noteToText("a\nb <unknown>")).toBe("a\nb <unknown>");
  });
});

describe("serializeNoteHtml", () => {
  it("writes the model back as minimal clean HTML", () => {
    const html =
      '<p style="text-align: left;" dir="ltr">Marija <strong>Urbanc</strong> &amp; <a style="color: red" href="https://x.si/?a=1&amp;b=2">x</a></p>' +
      '<p dir="ltr">drugi &lt;odstavek&gt;</p><ul><li>ena</li></ul>';
    expect(serializeNoteHtml(parseNoteHtml(html))).toBe(
      '<p>Marija <b>Urbanc</b> &amp; <a href="https://x.si/?a=1&amp;b=2">x</a></p>\n<p>drugi &lt;odstavek&gt;</p>\n<ul><li>ena</li></ul>',
    );
  });
  it("round-trips its own output", () => {
    const clean = serializeNoteHtml(parseNoteHtml(MYHERITAGE));
    expect(serializeNoteHtml(parseNoteHtml(clean))).toBe(clean);
  });
  it("tables keep header cells", () => {
    expect(serializeNoteHtml(parseNoteHtml("<table><tr><th>A</th><td>1</td></tr></table>"))).toBe("<table><tr><th>A</th><td>1</td></tr></table>");
  });
});

describe("plain-text model", () => {
  it("a plain note is paragraphs without formatting", () => {
    const doc = textToNoteDoc("first\n\nsecond");
    expect(doc.blocks).toHaveLength(2);
    expect(noteDocHasFormatting(doc)).toBe(false);
    expect(noteDocHasFormatting(noteToDoc("x <b>y</b>"))).toBe(true);
    expect(noteDocHasFormatting(parseNoteHtml("<p>a<br>b</p>"))).toBe(false);
  });
});
