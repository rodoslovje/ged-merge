/**
 * Rich-text notes.
 *
 * Several programs (MyHeritage above all, but also Gramps, Family Historian,
 * Geneanet and RootsMagic exports) keep a note's text as HTML: paragraphs,
 * links, the odd bold word, and — pasted whole from Matricula or Word — tables
 * and mountains of `style=` boilerplate. GEDCOM 5.5.1 has no marker for it, so
 * the markup is recognized from the text itself.
 *
 * This module is pure (no DOM) so it runs in the worker too. It parses such a
 * note into a small formatting model that keeps only what a reader cares about
 * (paragraphs, headings, lists, tables, links, bold/italic/underline) and
 * throws away everything else (`style`, `class`, `dir`, Word's `<o:p>`; images
 * become links). From the model come both renderings: the plain text the
 * compare table, reports and search use, and the clean minimal HTML an edited
 * note is written back as.
 */

export type NoteInline =
  | { t: "text"; text: string }
  | { t: "br" }
  | { t: "b" | "i" | "u"; kids: NoteInline[] }
  | { t: "a"; href: string; kids: NoteInline[] };

export interface NoteCell {
  header: boolean;
  kids: NoteInline[];
}

export type NoteBlock =
  | { t: "p"; kids: NoteInline[] }
  | { t: "h"; level: number; kids: NoteInline[] }
  | { t: "list"; ordered: boolean; items: NoteInline[][] }
  | { t: "table"; rows: NoteCell[][] };

export interface NoteDoc {
  blocks: NoteBlock[];
}

/** An opening tag of a kind only HTML would carry. The allowlist keeps a note
 *  whose text says "<unknown>" or "<private>" (a placeholder, not markup) plain;
 *  `\b` keeps `<p` from matching `<private>`. */
const HTML_NOTE_RE = /<(?:p|br|a|b|i|u|em|strong|div|ul|ol|li|h[1-6]|table|tr|td|th|span|blockquote|img)\b[^<>]*>/i;

/** Whether the note's text is HTML markup rather than plain text. */
export function isHtmlNote(text: string): boolean {
  return HTML_NOTE_RE.test(text);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  scaron: "š", Scaron: "Š", ccaron: "č", Ccaron: "Č", zcaron: "ž", Zcaron: "Ž",
  ndash: "–", mdash: "—", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  bdquo: "„", sbquo: "‚", hellip: "…", bull: "•", middot: "·", deg: "°", plusmn: "±", times: "×",
  divide: "÷", euro: "€", copy: "©", reg: "®", trade: "™", sect: "§", para: "¶", frac12: "½",
  frac14: "¼", frac34: "¾", sup2: "²", sup3: "³", iexcl: "¡", iquest: "¿", shy: "", zwnj: "", zwj: "",
  ensp: " ", emsp: " ", thinsp: " ",
  auml: "ä", Auml: "Ä", ouml: "ö", Ouml: "Ö", uuml: "ü", Uuml: "Ü", szlig: "ß",
  aacute: "á", Aacute: "Á", eacute: "é", Eacute: "É", iacute: "í", Iacute: "Í", oacute: "ó", Oacute: "Ó",
  uacute: "ú", Uacute: "Ú", agrave: "à", Agrave: "À", egrave: "è", Egrave: "È", igrave: "ì", ograve: "ò",
  ugrave: "ù", acirc: "â", ecirc: "ê", icirc: "î", ocirc: "ô", ucirc: "û", atilde: "ã", ntilde: "ñ",
  Ntilde: "Ñ", otilde: "õ", ccedil: "ç", Ccedil: "Ç", aring: "å", Aring: "Å", oslash: "ø", Oslash: "Ø",
  aelig: "æ", AElig: "Æ", yacute: "ý", yuml: "ÿ", eth: "ð", thorn: "þ",
};

/** Decode HTML character references (`&scaron;`, `&#039;`, `&#x161;`).
 *  Unknown names are left as written. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body] ?? m;
  });
}

/** Tags whose whole content is dropped (Word's conditional `<xml>` blob,
 *  stylesheets). */
const DROP_CONTENT = ["xml", "style", "script", "head", "title"];
/** Block-level containers: each opens a fresh paragraph. */
const PARAGRAPH_TAGS = new Set(["p", "div", "blockquote", "pre", "center", "section", "article", "hr", "h1", "h2", "h3", "h4", "h5", "h6"]);
/** Tags that only ever wrapped a run of text; their formatting is dropped. */
const TRANSPARENT_TAGS = new Set([
  "span", "font", "bdo", "bdi", "small", "big", "sup", "sub", "mark", "abbr", "cite", "code", "tt", "kbd",
  "label", "s", "strike", "del", "ins", "q", "dfn", "var", "samp", "time", "nobr", "wbr", "body", "html",
  "meta", "link", "o:p", "thead", "tbody", "tfoot", "caption", "colgroup", "col", "dl", "dt", "dd", "figure",
  "figcaption", "header", "footer", "nav", "main", "aside",
]);
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:\s[^<>]*)?)\s*\/?>/g;
/** Whitespace as HTML sees it, the no-break space included. */
const WS_RE = /[\s ]+/g;
const LEADING_WS_RE = /^[\s ]+/;
const TRAILING_WS_RE = /[\s ]+$/;

interface Token {
  close: boolean;
  tag: string;
  attrs: string;
}

function attrValue(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  if (!m) return undefined;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "").trim();
}

/** Only web and mail addresses make a link; anything else stays text. */
export function isLinkHref(href: string): boolean {
  return /^(?:https?:\/\/|mailto:|www\.)/i.test(href);
}

type Format = { t: "b" | "i" | "u"; kids: NoteInline[] } | { t: "a"; href: string; kids: NoteInline[] };

function isContainer(k: NoteInline): k is Format {
  return k.t === "a" || k.t === "b" || k.t === "i" || k.t === "u";
}

/** Strip whitespace and line breaks from one edge of an inline run, looking
 *  into formatting containers; empty containers go with them. */
function trimEdge(kids: NoteInline[], end: "start" | "end"): void {
  while (kids.length) {
    const idx = end === "start" ? 0 : kids.length - 1;
    const k = kids[idx];
    if (k.t === "text") {
      k.text = k.text.replace(end === "start" ? LEADING_WS_RE : TRAILING_WS_RE, "");
      if (k.text) return;
      kids.splice(idx, 1);
    } else if (k.t === "br") kids.splice(idx, 1);
    else if (isContainer(k)) {
      trimEdge(k.kids, end);
      if (k.kids.length) return;
      kids.splice(idx, 1);
    } else return;
  }
}

/**
 * Parse an HTML note into the formatting model. Tolerant of everything the
 * corpus throws at it: unclosed tags, formatting spanning paragraphs, nested
 * tables, tags it has never heard of (those stay as text, like the
 * `<unknown>` placeholder).
 */
export function parseNoteHtml(html: string): NoteDoc {
  // Comments and Word's conditional blobs first — they can hold anything.
  let src = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of DROP_CONTENT) {
    src = src.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");
  }
  // A note with only inline formatting (a bold word in otherwise plain text)
  // keeps its line breaks; once there are block tags, whitespace is HTML's.
  const blockLayout = /<(?:p|div|br|li|h[1-6]|table|tr|ul|ol|blockquote|hr|pre)\b/i.test(src);

  const blocks: NoteBlock[] = [];
  let para: NoteInline[] = [];
  let heading = 0;
  let formats: Format[] = [];
  let list: { ordered: boolean; items: NoteInline[][] } | null = null;
  let listDepth = 0;
  let table: NoteCell[][] | null = null;
  let tableDepth = 0;
  let row: NoteCell[] | null = null;
  let cell: NoteCell | null = null;

  const target = (): NoteInline[] => (formats.length ? formats[formats.length - 1].kids : para);

  /** Close the paragraph being written, handing it to its container. */
  function flush(): void {
    formats = [];
    trimEdge(para, "start");
    trimEdge(para, "end");
    const kids = para;
    const level = heading;
    para = [];
    heading = 0;
    if (!kids.length) return;
    if (cell) {
      if (cell.kids.length) cell.kids.push({ t: "br" });
      cell.kids.push(...kids);
    } else if (list) {
      const item = list.items[list.items.length - 1];
      if (item) {
        if (item.length) item.push({ t: "br" });
        item.push(...kids);
      } else list.items.push(kids);
    } else if (level) blocks.push({ t: "h", level, kids });
    else blocks.push({ t: "p", kids });
  }

  function pushText(text: string): void {
    if (!text) return;
    const dest = target();
    const last = dest[dest.length - 1];
    if (last && last.t === "text") last.text += text;
    else dest.push({ t: "text", text });
  }

  function addText(raw: string): void {
    const text = decodeEntities(raw);
    if (blockLayout) {
      pushText(text.replace(WS_RE, " "));
      return;
    }
    // Inline-only note: newlines are the author's own line breaks.
    text.split("\n").forEach((line, i) => {
      if (i > 0) flush();
      pushText(line);
    });
  }

  function openFormat(f: Format): void {
    target().push(f);
    formats.push(f);
  }

  function closeFormat(kind: Format["t"]): void {
    for (let i = formats.length - 1; i >= 0; i--) {
      if (formats[i].t === kind) {
        formats = formats.slice(0, i);
        return;
      }
    }
  }

  function toggleFormat(tok: Token, kind: "b" | "i" | "u"): void {
    if (tok.close) closeFormat(kind);
    else openFormat({ t: kind, kids: [] });
  }

  function endRow(): void {
    cell = null;
    if (row && table) {
      if (row.length) table.push(row);
      row = null;
    }
  }

  function endTable(): void {
    if (!table) return;
    endRow();
    const rows = table.filter((r) => r.some((c) => c.kids.length));
    if (rows.length) blocks.push({ t: "table", rows });
    table = null;
  }

  function endList(): void {
    if (!list) return;
    if (table) {
      // A list inside a table cell flattens into the cell's text.
      const dest = cell ?? row?.[row.length - 1];
      if (dest) {
        for (const item of list.items) {
          if (dest.kids.length) dest.kids.push({ t: "br" });
          dest.kids.push(...item);
        }
      }
    } else if (list.items.length) blocks.push({ t: "list", ordered: list.ordered, items: list.items });
    list = null;
  }

  function handle(tok: Token): void {
    const tag = tok.tag.toLowerCase();
    if (tag === "br") {
      if (para.length || formats.length) target().push({ t: "br" });
      return;
    }
    if (PARAGRAPH_TAGS.has(tag)) {
      flush();
      const h = /^h([1-6])$/.exec(tag);
      if (h && !tok.close) heading = Number(h[1]);
      return;
    }
    if (tag === "b" || tag === "strong") return toggleFormat(tok, "b");
    if (tag === "i" || tag === "em") return toggleFormat(tok, "i");
    if (tag === "u") return toggleFormat(tok, "u");
    if (tag === "a") {
      if (tok.close) {
        closeFormat("a");
        return;
      }
      const href = attrValue(tok.attrs, "href") ?? "";
      if (isLinkHref(href)) openFormat({ t: "a", href, kids: [] });
      return;
    }
    if (tag === "img") {
      // A picture the note embeds from the web becomes a link to it — the app
      // is local-only and must not fetch third-party images on its own.
      const src = attrValue(tok.attrs, "src") ?? "";
      if (!isLinkHref(src)) return;
      const label = attrValue(tok.attrs, "alt") || attrValue(tok.attrs, "title") || src.replace(/^.*\//, "").replace(/\?.*$/, "");
      target().push({ t: "a", href: src, kids: [{ t: "text", text: label }] });
      return;
    }
    if (tag === "ul" || tag === "ol") {
      flush();
      if (tok.close) {
        if (listDepth > 0) listDepth--;
        if (listDepth === 0) endList();
      } else {
        if (listDepth === 0) list = { ordered: tag === "ol", items: [] };
        listDepth++;
      }
      return;
    }
    if (tag === "li") {
      flush();
      if (!tok.close && list) list.items.push([]);
      return;
    }
    if (tag === "table") {
      flush();
      if (tok.close) {
        if (tableDepth > 0) tableDepth--;
        if (tableDepth === 0) endTable();
      } else {
        if (tableDepth === 0) table = [];
        tableDepth++;
      }
      return;
    }
    if (tag === "tr") {
      flush();
      if (table) {
        endRow();
        if (!tok.close) row = [];
      }
      return;
    }
    if (tag === "td" || tag === "th") {
      flush();
      if (!table) return;
      if (!row) row = [];
      if (tok.close) cell = null;
      else {
        cell = { header: tag === "th", kids: [] };
        row.push(cell);
      }
      return;
    }
    if (TRANSPARENT_TAGS.has(tag)) return;
    // An unrecognized tag is a placeholder in the author's own text.
    addText(`<${tok.close ? "/" : ""}${tok.tag}${tok.attrs}>`);
  }

  let last = 0;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(src); m; m = TAG_RE.exec(src)) {
    if (m.index > last) addText(src.slice(last, m.index));
    handle({ close: m[1] === "/", tag: m[2], attrs: m[3] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < src.length) addText(src.slice(last));
  flush();
  endList();
  endTable();
  return { blocks };
}

/** The text of an inline run, links rendered as `label (url)` when the label
 *  is not the address itself. */
export function inlinesToText(kids: NoteInline[]): string {
  let out = "";
  for (const k of kids) {
    if (k.t === "text") out += k.text;
    else if (k.t === "br") out += "\n";
    else if (k.t === "a") {
      const label = inlinesToText(k.kids);
      const same = label.replace(/\/$/, "") === k.href.replace(/\/$/, "");
      out += same || !label ? k.href : `${label} (${k.href})`;
    } else out += inlinesToText(k.kids);
  }
  return out;
}

/** Plain text of a parsed note: one line per paragraph, `• ` list items,
 *  a two-cell header/value table row as `Header: value`. */
export function noteDocToText(doc: NoteDoc): string {
  const lines: string[] = [];
  for (const b of doc.blocks) {
    if (b.t === "p" || b.t === "h") lines.push(inlinesToText(b.kids));
    else if (b.t === "list") b.items.forEach((item, i) => lines.push(`${b.ordered ? `${i + 1}.` : "•"} ${inlinesToText(item)}`));
    else {
      for (const r of b.rows) {
        const cells = r.map((c) => inlinesToText(c.kids).replace(/\n/g, " "));
        lines.push(r.length === 2 && r[0].header && !r[1].header ? `${cells[0]}: ${cells[1]}` : cells.join(" | "));
      }
    }
  }
  return lines.join("\n");
}

/** Plain text of a note, whether it was written as HTML or not. */
export function noteToText(text: string): string {
  return isHtmlNote(text) ? noteDocToText(parseNoteHtml(text)) : text;
}

/** The formatting model of a plain-text note: one paragraph per line. */
export function textToNoteDoc(text: string): NoteDoc {
  return {
    blocks: text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => ({ t: "p", kids: [{ t: "text", text: line }] })),
  };
}

/** The model of any note, whichever way it is written. */
export function noteToDoc(text: string): NoteDoc {
  return isHtmlNote(text) ? parseNoteHtml(text) : textToNoteDoc(text);
}

/** Whether the model carries any formatting a plain-text note can't hold
 *  (a paragraph-and-line-break-only note is plain text with newlines). */
export function noteDocHasFormatting(doc: NoteDoc): boolean {
  const inlineHas = (kids: NoteInline[]): boolean => kids.some((k) => k.t !== "text" && k.t !== "br");
  return doc.blocks.some((b) => b.t !== "p" || inlineHas(b.kids));
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

function inlinesToHtml(kids: NoteInline[]): string {
  return kids
    .map((k) => {
      if (k.t === "text") return escapeText(k.text);
      if (k.t === "br") return "<br>";
      if (k.t === "a") return `<a href="${escapeAttr(k.href)}">${inlinesToHtml(k.kids)}</a>`;
      return `<${k.t}>${inlinesToHtml(k.kids)}</${k.t}>`;
    })
    .join("");
}

/** Minimal clean HTML for the model — what an edited note is written back
 *  as: one block per line, no attributes but a link's `href`. */
export function serializeNoteHtml(doc: NoteDoc): string {
  return doc.blocks
    .map((b) => {
      if (b.t === "p") return `<p>${inlinesToHtml(b.kids)}</p>`;
      if (b.t === "h") return `<h${b.level}>${inlinesToHtml(b.kids)}</h${b.level}>`;
      if (b.t === "list") {
        const tag = b.ordered ? "ol" : "ul";
        return `<${tag}>${b.items.map((item) => `<li>${inlinesToHtml(item)}</li>`).join("")}</${tag}>`;
      }
      return `<table>${b.rows
        .map((r) => `<tr>${r.map((c) => (c.header ? `<th>${inlinesToHtml(c.kids)}</th>` : `<td>${inlinesToHtml(c.kids)}</td>`)).join("")}</tr>`)
        .join("")}</table>`;
    })
    .join("\n");
}
