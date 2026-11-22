// The family calendar's paper: one stylesheet for the on-screen preview and the
// print document, so what the wizard shows is what the printer gets. Like the
// report's print sheet it is paper, not app chrome — fixed ink colours, never
// the theme's, so a dark UI still previews a white page.
//
// Every size inside a page is in `em`; the page sets the em. On screen the
// page fills its `.cal-sheet` (a size container) and the em follows the width;
// in print the page takes its paper size in millimetres and a fixed em.

export const CALENDAR_CSS = `
.cal-sheet { container-type: inline-size; }
.cal-page {
  --ink: #23201c; --muted: #6b655d; --faint: #b9b2a8; --rule: #d9d3ca;
  --accent: #2f6b55; --holiday: #b3261e; --paper: #ffffff; --tint: #f4f1ec;
  position: relative; box-sizing: border-box; overflow: hidden;
  width: 100%; aspect-ratio: var(--cal-ratio); font-size: calc(100cqw / var(--cal-ems));
  background: var(--paper); color: var(--ink);
  font-family: Georgia, "Times New Roman", serif; line-height: 1.25;
  display: flex; flex-direction: column;
  padding: var(--cal-pad-top, 2.4em) 2.6em 2em;
}
.cal-page * { box-sizing: border-box; }
.cal-photo { position: relative; overflow: hidden; background: var(--tint); border-radius: 0.3em; flex: 0 0 auto; }
.cal-photo img { display: block; width: 100%; height: 100%; object-fit: cover; }
.cal-photo-empty { display: flex; align-items: center; justify-content: center; color: var(--faint); font-size: 1.1em; height: 100%; }
.cal-caption { position: absolute; left: 0; right: 0; bottom: 0; padding: 0.5em 0.8em; font-size: 0.85em;
  color: #fff; background: linear-gradient(transparent, rgba(0,0,0,0.55)); }
.cal-head { display: flex; align-items: baseline; justify-content: space-between; margin: 0.9em 0 0.5em;
  border-bottom: 0.08em solid var(--accent); padding-bottom: 0.2em; }
.cal-month { font-size: 2.3em; color: var(--accent); letter-spacing: 0.02em; }
.cal-year { font-size: 1.4em; color: var(--muted); }
.cal-grid-wrap { flex: 1 1 auto; min-height: 14em; display: flex; }
.cal-grid { width: 100%; height: 100%; border-collapse: collapse; table-layout: fixed; }
.cal-grid th { font-weight: 400; font-size: 0.8em; color: var(--muted); text-align: left; padding: 0 0 0.3em 0.3em; }
.cal-grid th.cal-sun { color: var(--holiday); }
.cal-grid td { border: 0.06em solid var(--rule); vertical-align: top; padding: 0.2em 0.3em; overflow: hidden; }
.cal-grid thead th { height: 1.2em; }
.cal-grid td.cal-blank { background: var(--tint); border-color: var(--tint); }
.cal-day { font-size: 1.05em; font-weight: 700; }
.cal-sun .cal-day, .cal-hol .cal-day { color: var(--holiday); }
.cal-holname { font-size: 0.6em; color: var(--holiday); line-height: 1.1; margin-top: 0.1em; }
.cal-entry { font-size: 0.62em; line-height: 1.2; margin-top: 0.15em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cal-glyph { color: var(--accent); font-weight: 700; margin-right: 0.2em; }
.cal-memorial .cal-glyph { color: var(--muted); }
.cal-lower { display: flex; align-items: flex-start; gap: 1.6em; margin-top: 0.8em; flex: 0 0 auto; }
.cal-lower:empty { display: none; }
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
.cal-cover { align-items: center; text-align: center; }
.cal-cover-title { font-size: 3em; color: var(--accent); margin: 0.4em 0 0.1em; }
.cal-cover-year { font-size: 2em; color: var(--muted); }
.cal-cover-name { font-size: 1.4em; margin: 0.6em 0 0.8em; }
.cal-cover .cal-photo, .cal-cover .cal-fan { flex: 1 1 auto; width: 100%; min-height: 0; }
.cal-fan { display: flex; align-items: center; justify-content: center; }
.cal-fan svg { width: 100%; height: 100%; }
.cal-desk { flex-direction: row; gap: 1.6em; }
.cal-desk .cal-photo { width: 38%; height: 100%; }
.cal-desk .cal-side { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
.cal-desk .cal-head { margin-top: 0; }
`;

/** The print document's own additions: real paper, one page per sheet. */
export function calendarPrintCss(paper: { w: number; h: number; em: number }): string {
  return `
@page { size: ${paper.w}mm ${paper.h}mm; margin: 0; }
html, body { margin: 0; padding: 0; }
.cal-sheet { container-type: normal; }
.cal-page { width: ${paper.w}mm; height: ${paper.h}mm; aspect-ratio: auto; font-size: ${paper.em}mm;
  break-after: page; page-break-after: always; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.cal-page:last-child { break-after: auto; page-break-after: auto; }
.cal-photo:has(.cal-photo-empty) { background: none; }
.cal-photo-empty { visibility: hidden; }
`;
}
