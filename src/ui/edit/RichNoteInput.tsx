import React, { forwardRef, useEffect, useRef } from "react";
import type { Translate } from "../../locales/i18n";
import { isHtmlNote, noteDocHasFormatting, noteDocToText, noteToDoc, parseNoteHtml, serializeNoteHtml } from "../../gedcom/noteHtml";
import { linkHref } from "../FieldValue";

/**
 * A note chip that shows its text formatted — paragraphs, links, bold words,
 * a pasted register table — and edits it in place, with a small toolbar for
 * bold/italic/underline, lists and links.
 *
 * The text handed back on every edit follows one rule: a note the file keeps
 * as HTML is written back as clean minimal HTML (its `style=`/`dir=`
 * boilerplate gone), a plain-text note stays plain text unless formatting is
 * applied to it. A note that is never typed into is never handed back at all,
 * so its bytes stay exactly as loaded.
 *
 * The box is uncontrolled (the browser owns the DOM while typing); the
 * formatting model is read out of it after each edit and written into it
 * whenever `text` changes from outside while the box is not focused.
 */
export const RichNoteInput = forwardRef<
  HTMLDivElement,
  {
    text: string;
    onInput: (text: string) => void;
    onBlur: () => void;
    onClear: () => void;
    /** The 🔒 at the left edge, mirroring the × clear button. */
    leading?: React.ReactNode;
    className?: string;
    wrapClassName?: string;
    wrapStyle?: React.CSSProperties;
    placeholder: string;
    title: string;
    t: Translate;
  }
>(function RichNoteInput({ text, onInput, onBlur, onClear, leading, className, wrapClassName, wrapStyle, placeholder, title, t }, ref) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  // Once a note is HTML it stays HTML for the rest of the session, even if
  // every bold word is removed again — the file's other notes are HTML too.
  const htmlRef = useRef(isHtmlNote(text));
  if (isHtmlNote(text)) htmlRef.current = true;

  useEffect(() => {
    const el = innerRef.current;
    if (!el || document.activeElement === el) return;
    const html = serializeNoteHtml(noteToDoc(text));
    if (el.innerHTML !== html) el.innerHTML = html;
  }, [text]);

  function readBack(): void {
    const el = innerRef.current;
    if (!el) return;
    const doc = parseNoteHtml(el.innerHTML);
    const next = htmlRef.current || noteDocHasFormatting(doc) ? serializeNoteHtml(doc) : noteDocToText(doc);
    if (noteDocHasFormatting(doc)) htmlRef.current = true;
    onInput(next);
  }

  function exec(command: string, value?: string): void {
    innerRef.current?.focus();
    document.execCommand(command, false, value);
    readBack();
  }

  function link(): void {
    const el = innerRef.current;
    const sel = window.getSelection();
    if (!el || !sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    const selected = sel.toString().trim();
    const url = window.prompt(t("edit.noteLinkPrompt"), /^(?:https?:\/\/|www\.)/i.test(selected) ? selected : "");
    el.focus();
    sel.removeAllRanges();
    sel.addRange(range);
    if (url === null) return;
    const href = url.trim();
    if (!href) exec("unlink");
    else if (range.collapsed) exec("insertHTML", `<a href="${escapeAttr(linkHref(href))}">${escapeText(href)}</a>`);
    else exec("createLink", linkHref(href));
  }

  // One Tab stop for the whole toolbar — the first tool — and ←/→ between the
  // tools, so leaving a note by Tab is not six presses longer than it was.
  const tool = (label: string, key: string, run: () => void, cls?: string, first = false) => (
    <button
      type="button"
      className={`note-tool${cls ? ` ${cls}` : ""}`}
      title={t(key)}
      tabIndex={first ? 0 : -1}
      // mousedown is swallowed to keep the box's selection and focus; the
      // action is the click, so Enter on a focused tool applies it too (exec
      // refocuses the box, which brings its last selection back).
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        const tools = Array.from(
          (e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(".note-tool")) ?? [],
        );
        const at = tools.indexOf(e.currentTarget);
        const next = tools[at + (e.key === "ArrowRight" ? 1 : -1)];
        if (!next) return;
        e.preventDefault();
        next.focus();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className={`clearable-wrap clearable-wrap--textarea clearable-wrap--rich${leading ? " clearable-wrap--leading" : ""}${wrapClassName ? ` ${wrapClassName}` : ""}`} style={wrapStyle}>
      {leading}
      <div
        ref={(el) => {
          innerRef.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        className={`note-rich${className ? ` ${className}` : ""}`}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label={title}
        title={title}
        data-placeholder={placeholder}
        onInput={readBack}
        onBlur={onBlur}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            innerRef.current?.blur();
          }
        }}
        onClick={(e) => {
          // A click on a link places the caret; ⌘/Ctrl-click follows it.
          const a = (e.target as HTMLElement).closest("a");
          if (a && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            window.open(a.href, "_blank", "noopener,noreferrer");
          }
        }}
      />
      {text ? (
        <button
          type="button"
          className="input-clear"
          tabIndex={-1}
          title={`Clear ${title.toLowerCase()}`}
          onMouseDown={(e) => {
            e.preventDefault(); // keep the box focused so onBlur fires with the cleared value
            onClear();
          }}
        >
          ×
        </button>
      ) : null}
      <span className="note-toolbar" role="toolbar">
        {tool("B", "edit.noteBold", () => exec("bold"), "note-tool--b", true)}
        {tool("I", "edit.noteItalic", () => exec("italic"), "note-tool--i")}
        {tool("U", "edit.noteUnderline", () => exec("underline"), "note-tool--u")}
        {tool("•", "edit.noteList", () => exec("insertUnorderedList"))}
        {tool("1.", "edit.noteNumbered", () => exec("insertOrderedList"))}
        {tool("🔗", "edit.noteLink", link)}
      </span>
    </div>
  );
});

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
