// The family calendar's paper: one stylesheet for the on-screen preview and the
// print document, so what the wizard shows is what the printer gets. Like the
// report's print sheet it is paper, not app chrome — fixed ink colours, never
// the theme's, so a dark UI still previews a white page.
//
// Every size inside a page is in `em`; the page sets the em. On screen the
// page fills its `.cal-sheet` (a size container) and the em follows the width;
// in print the page takes its paper size in millimetres and a fixed em.
// The colours come from the page's scheme (schemes.ts), set inline on it.

import type { PrintGeometry } from "./CalendarPage";

export const CALENDAR_CSS = `
.cal-sheet { container-type: inline-size; }
.cal-page {
  position: relative; box-sizing: border-box; overflow: hidden;
  width: 100%; aspect-ratio: var(--cal-ratio); font-size: calc(100cqw / var(--cal-ems));
  background: var(--paper); color: var(--ink);
  font-family: Georgia, "Times New Roman", serif; line-height: 1.25;
  display: flex; flex-direction: column;
  padding: var(--cal-pad-top, 2.4em) 2.6em 2em;
}
.cal-page * { box-sizing: border-box; }
.cal-picture { position: relative; flex: 0 0 auto; min-height: 0; }
.cal-photo { position: relative; overflow: hidden; background: var(--tint); border-radius: 0.3em; width: 100%; height: 100%; }
.cal-photo-fill, .cal-photo-fit, .cal-photo-blur { position: absolute; display: block; }
.cal-photo-fill { inset: 0; width: 100%; height: 100%; object-fit: cover; }
/* A photo of another shape: whole, on a blurred, enlarged copy of itself. */
.cal-photo-blur { left: -8%; top: -8%; width: 116%; height: 116%; object-fit: cover; filter: blur(1.4em) saturate(1.15); opacity: 0.9; }
.cal-photo-fit { inset: 0; width: 100%; height: 100%; object-fit: contain; filter: drop-shadow(0 0.2em 0.7em rgba(0,0,0,0.35)); }
.cal-collage-tidy { background: none; border-radius: 0; }
.cal-tile { position: absolute; overflow: hidden; border-radius: 0.2em; }
.cal-tile img { display: block; width: 100%; height: 100%; object-fit: cover; }
.cal-tile .cal-caption { font-size: 0.7em; padding: 0.3em 0.5em; }
.cal-collage-scattered { overflow: visible; }
.cal-print { position: absolute; background: #fff; box-shadow: 0 0.15em 0.6em rgba(0,0,0,0.3); }
.cal-print img { position: absolute; display: block; object-fit: cover; }
.cal-print-caption { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center;
  font-size: 0.72em; color: #2a2622; padding: 0 0.5em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cal-photo-empty { display: flex; align-items: center; justify-content: center; color: var(--faint); font-size: 1.1em; height: 100%; }
.cal-caption { position: absolute; left: 0; right: 0; bottom: 0; padding: 0.5em 0.8em; font-size: 0.85em;
  color: #fff; background: linear-gradient(transparent, rgba(0,0,0,0.55)); }
.cal-head { display: flex; align-items: baseline; justify-content: space-between; margin: 0.9em 0 0.5em;
  border-bottom: 0.08em solid var(--accent); padding-bottom: 0.2em; }
.cal-month { font-size: 2.3em; color: var(--accent); letter-spacing: 0.02em; }
.cal-year { font-size: 1.4em; color: var(--muted); }
.cal-grid-wrap { flex: 1 1 auto; min-height: 14em; display: flex; }
.cal-grid { width: 100%; height: 100%; border-collapse: collapse; table-layout: fixed; }
.cal-grid th { font-weight: 700; font-size: 0.75em; color: var(--accent); text-align: left; padding: 0.25em 0.4em;
  background: color-mix(in srgb, var(--accent) 12%, var(--paper)); }
.cal-grid th.cal-sun { color: var(--holiday); }
.cal-grid td { position: relative; border: 0.06em solid var(--rule); vertical-align: top; padding: 0; overflow: hidden; }
.cal-cell { position: absolute; inset: 0; padding: 0.2em 0.3em; overflow: hidden; display: flex; flex-direction: column; }
.cal-cell > * { flex: 0 0 auto; }
.cal-mems { margin-top: auto; }
.cal-entry.cal-compact { white-space: normal; overflow: visible; }
.cal-round-name { font-weight: 700; }
.cal-round-name .cal-glyph { color: var(--glyph-anniversary); }
.cal-entry.cal-more { color: var(--muted); font-weight: 700; }
.cal-grid thead th { height: 1.2em; }
.cal-grid td.cal-sat { background: color-mix(in srgb, var(--accent) 4%, var(--paper)); }
.cal-grid td.cal-sun, .cal-grid td.cal-hol { background: color-mix(in srgb, var(--holiday) 6%, var(--paper)); }
.cal-grid td.cal-blank { background: var(--tint); border-color: var(--tint); }
.cal-day { font-size: 1.05em; font-weight: 700; }
.cal-sun .cal-day, .cal-hol .cal-day { color: var(--holiday); }
.cal-holname { font-size: 0.6em; color: var(--holiday); line-height: 1.1; margin-top: 0.1em; }
/* The saints of the day, beside its number: one line, cut short where the cell is narrow. */
.cal-dayrow { display: flex; align-items: baseline; gap: 0.4em; }
.cal-saint { flex: 1 1 0; min-width: 0; text-align: right; font-size: 0.6em; color: var(--muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cal-entry { font-size: 0.62em; line-height: 1.2; margin-top: 0.15em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cal-glyph { font-weight: 700; margin-right: 0.2em; }
/* The living in the scheme's colour, the memorial days below them in dark grey. */
.cal-entry.cal-birthday, .cal-entry.cal-anniversary, .cal-entry.cal-nameday { color: var(--accent); }
.cal-entry.cal-memorial, .cal-list .cal-memorial { color: var(--remembrance); }
.cal-birthday .cal-glyph, .cal-nameday .cal-glyph { color: var(--glyph-birthday); }
.cal-anniversary .cal-glyph { color: var(--glyph-anniversary); }
.cal-memorial .cal-glyph { color: var(--glyph-memorial); }
/* Large print, for an older reader: bigger day numbers and names, wrapped. */
.cal-large .cal-day { font-size: 1.5em; }
.cal-large .cal-entry { font-size: 0.95em; font-weight: 600; white-space: normal; line-height: 1.15; }
.cal-large .cal-holname { font-size: 0.75em; }
.cal-large .cal-saint { font-size: 0.7em; }
.cal-large .cal-facts { font-size: 1em; }
/* A round birthday or a jubilee: bold, on a tint of the scheme's colour. */
.cal-entry.cal-round { font-weight: 700; background: color-mix(in srgb, var(--accent) 16%, var(--paper));
  border-radius: 0.3em; padding: 0 0.25em; margin-left: -0.25em; margin-right: -0.25em; }
.cal-list .cal-round { font-weight: 700; }
.cal-round .cal-glyph { color: var(--glyph-anniversary); }
.cal-lower { display: flex; align-items: flex-start; gap: 1.6em; margin-top: 0.8em; flex: 0 0 auto; }
.cal-lower:empty { display: none; }
/* Either one alone takes the whole width: the list in three columns, the
   moments from the past in two. */
.cal-lower > .cal-list:only-child { columns: 3; }
.cal-lower > .cal-facts:only-child { columns: 2; column-gap: 2em; }
.cal-facts:only-child h4 { column-span: all; }
.cal-facts:only-child .cal-fact { break-inside: avoid; }
.cal-lower > * { flex: 1 1 0; min-width: 0; }
.cal-list { font-size: 0.72em; columns: 2; column-gap: 1.4em; }
.cal-list div { break-inside: avoid; margin-bottom: 0.15em; }
.cal-list b { display: inline-block; min-width: 1.6em; font-weight: 700; }
.cal-facts { font-size: 0.78em; border-left: 0.15em solid var(--accent); padding-left: 0.8em; }
.cal-facts h4 { margin: 0 0 0.3em; font-size: 1em; color: var(--accent); font-weight: 700; }
.cal-fact { margin-bottom: 0.45em; }
.cal-fact-when { color: var(--muted); font-size: 0.9em; }
.cal-legend { font-size: 0.6em; color: var(--muted); margin-top: auto; padding-top: 0.6em; }
.cal-legend span + span { margin-left: 1.2em; }
.cal-foot { display: flex; justify-content: space-between; align-items: center; gap: 1em; width: 100%;
  font-family: "IBM Plex Sans", system-ui, sans-serif; font-size: 0.6em; color: var(--muted); padding-top: 0.6em; }
.cal-credit { display: inline-flex; align-items: center; gap: 0.5em; }
.cal-credit svg { width: 1.6em; height: 1.6em; }
.cal-brand { font-weight: 600; margin-left: -0.25em; }
.cal-legend + .cal-foot { padding-top: 0.3em; }
.cal-stats { width: 100%; height: 100%; display: flex; flex-direction: column; justify-content: center; gap: 0.8em;
  padding: 1.2em 1.6em; background: color-mix(in srgb, var(--accent) 7%, var(--paper)); border-radius: 0.3em; text-align: center; }
.cal-stats-title { font-size: 1.5em; color: var(--accent); }
.cal-stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(8em, 1fr)); gap: 0.6em 1em; }
.cal-stat-label { font-size: 0.72em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
.cal-stat-num { font-size: 2.2em; color: var(--accent); line-height: 1.1; }
.cal-cover .cal-stats { font-size: 1.6em; gap: 1.4em; }
.cal-stats-lines { font-size: 0.85em; color: var(--ink); display: flex; flex-direction: column; gap: 0.2em; }
.cal-cover { align-items: center; text-align: center; }
.cal-back-title { font-size: 2em; color: var(--accent); text-align: center; margin-bottom: 0.6em; }
.cal-back-body { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.cal-back-body > .cal-chart, .cal-back-body > .cal-stats, .cal-back-body > .cal-photo-empty { flex: 1 1 auto; }
.cal-overview { display: grid; grid-template-columns: repeat(auto-fill, minmax(13em, 1fr)); gap: 0.9em 1.4em; font-size: 0.78em; align-content: start; }
.cal-overview-head { color: var(--accent); font-weight: 700; border-bottom: 0.06em solid var(--rule); margin-bottom: 0.25em; }
.cal-overview-entry { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.35; }
.cal-overview-entry b { display: inline-block; min-width: 1.7em; }
.cal-overview-entry.cal-memorial { color: var(--remembrance); }
.cal-overview-entry.cal-round { font-weight: 700; }
.cal-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(8em, 1fr)); gap: 0.9em; align-content: start; }
.cal-gallery-item { margin: 0; text-align: center; }
.cal-gallery-item img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 0.3em; }
.cal-gallery-item figcaption { font-size: 0.72em; margin-top: 0.25em; line-height: 1.2; }
.cal-colophon { text-align: center; font-size: 0.8em; color: var(--muted); margin-top: 0.9em; }
.cal-signature { font-style: italic; font-size: 1.25em; color: var(--ink); margin-bottom: 0.2em; }
.cal-cover-title { font-size: 3em; color: var(--accent); margin: 0.4em 0 0.1em; }
.cal-cover-year { font-size: 2em; color: var(--muted); }
.cal-cover-name { font-size: 1.4em; margin: 0.6em 0 0.8em; }
.cal-dedication { font-size: 1.15em; color: var(--muted); margin: -0.3em 0 1em; white-space: pre-line; max-width: 80%; }
/* The givers' formatted words: their paragraphs and lists sit as plain lines. */
.cal-cover-title p, .cal-dedication p { margin: 0; }
.cal-cover-title ul, .cal-cover-title ol, .cal-dedication ul, .cal-dedication ol { margin: 0; padding: 0; list-style-position: inside; }
.cal-cover-title a, .cal-dedication a { color: inherit; }
.cal-cover .cal-picture { flex: 1 1 auto; width: 100%; }
.cal-chart { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
.cal-chart svg { width: 100%; height: 100%; }
.cal-tree { width: 100%; height: 100%; }
.cal-desk { flex-direction: row; gap: 1.6em; }
.cal-desk .cal-picture { width: 38%; height: 100%; }
.cal-desk .cal-side { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
.cal-desk .cal-head { margin-top: 0; }
`;

/** The print document's own additions: real paper, one page per sheet. Each
 *  page sits centred in a `.cal-leaf` the size of the sheet. */
export function calendarPrintCss({ sheet, page }: PrintGeometry): string {
  return `
@page { size: ${sheet.w}mm ${sheet.h}mm; margin: 0; }
html, body { margin: 0; padding: 0; }
.cal-sheet { container-type: normal; }
.cal-leaf { width: ${sheet.w}mm; height: ${sheet.h}mm; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  break-after: page; page-break-after: always; }
.cal-leaf:last-child { break-after: auto; page-break-after: auto; }
.cal-page { flex: none; width: ${page.w}mm; height: ${page.h}mm; aspect-ratio: auto; font-size: ${page.em}mm;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.cal-photo:has(.cal-photo-empty) { background: none; }
.cal-photo-empty { visibility: hidden; }
`;
}
