/**
 * The on-screen layer of a tutorial video: a visible mouse pointer, a ring that
 * points at a control, a step callout, full-screen title cards, the keycaps of
 * a key being pressed and an index card of shortcuts.
 *
 * It runs inside the page (installed with `addInitScript`, so it survives a
 * reload) and lives in its own shadow root with `pointer-events: none`, so the
 * app's styles cannot reach it and it never intercepts a click. Everything in
 * this function must be self-contained: Playwright serialises it as source.
 */
export function installOverlay(): void {
  const w = window as unknown as { __gmv?: unknown };
  if (w.__gmv) return;

  const mount = () => {
    const host = document.createElement("div");
    host.id = "gm-video-overlay";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .layer { position: fixed; inset: 0; pointer-events: none; font-family: "IBM Plex Sans", system-ui, sans-serif; }
  .cursor { position: absolute; left: 0; top: 0; width: 30px; height: 30px; opacity: 0;
    transition: transform 700ms cubic-bezier(.45,.05,.3,1), opacity 250ms;
    filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
  .ripple { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
    border: 3px solid #e8a33d; opacity: 0; }
  .ripple.go { animation: ripple 500ms ease-out; }
  @keyframes ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
  .ring { position: absolute; border: 4px solid #e8a33d; border-radius: 12px; opacity: 0;
    box-shadow: 0 0 0 9999px rgba(20,30,25,.28), 0 0 18px rgba(232,163,61,.7);
    transition: left 450ms ease, top 450ms ease, width 450ms ease, height 450ms ease, opacity 300ms; }
  .callout { position: absolute; left: 28px; bottom: 28px; max-width: 46%; display: flex; gap: 12px; align-items: center;
    background: rgba(24,44,36,.92); color: #fff; padding: 12px 20px 12px 12px; border-radius: 14px;
    font-size: 21px; font-weight: 600; line-height: 1.25; box-shadow: 0 6px 24px rgba(0,0,0,.25);
    opacity: 0; transform: translateY(12px); transition: opacity 300ms, transform 300ms; }
  .callout.on { opacity: 1; transform: none; }
  .callout .n { flex: none; width: 36px; height: 36px; border-radius: 50%; background: #e8a33d; color: #1d2b25;
    display: grid; place-items: center; font-size: 19px; font-weight: 700; }
  .card { position: absolute; inset: 0; display: grid; place-items: center; text-align: center;
    background: radial-gradient(ellipse at center, #2c5a47 0%, #1b3a2e 70%); color: #fff;
    opacity: 0; transition: opacity 500ms; }
  .card.on { opacity: 1; }
  .card .k { font-size: 22px; letter-spacing: .2em; text-transform: uppercase; color: #e8c38a; margin-bottom: 18px; font-weight: 600; }
  .card h1 { font-size: 58px; margin: 0 0 18px; font-weight: 700; max-width: 80vw; }
  .card p { font-size: 26px; margin: 0; color: #d7e6de; }
  .list { position: absolute; right: 28px; bottom: 28px; width: 940px; padding: 16px 22px 6px;
    background: rgba(24,44,36,.94); color: #fff; border-radius: 16px; box-shadow: 0 6px 24px rgba(0,0,0,.3);
    opacity: 0; transform: translateY(12px); transition: opacity 300ms, transform 300ms; }
  .list.on { opacity: 1; transform: none; }
  .list h2 { margin: 0 0 10px; font-size: 20px; font-weight: 700; color: #e8c38a; }
  .list .groups { columns: 3; column-gap: 24px; }
  .list .g { break-inside: avoid; margin: 0 0 10px; }
  .list .g h3 { margin: 0 0 3px; font-size: 13px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #a9c7b8; }
  .list .g div { font-size: 17px; line-height: 1.4; white-space: nowrap; }
  .list .g div span { display: inline-block; width: 28px; }
  kbd { display: inline-block; min-width: 1.9em; padding: .12em .5em; border-radius: .32em; text-align: center;
    font-family: "IBM Plex Mono", ui-monospace, monospace; font-weight: 600; line-height: 1.35;
    background: #fdfaf3; color: #1d2b25; border: 1px solid #b9ad94; box-shadow: 0 .14em 0 #b9ad94; }
  .keys { position: absolute; right: 28px; bottom: 28px; display: flex; gap: 10px; align-items: center;
    padding: 14px 18px 18px; border-radius: 16px; background: rgba(24,44,36,.92); color: #e8c38a;
    font-size: 34px; font-weight: 700; box-shadow: 0 6px 24px rgba(0,0,0,.3);
    opacity: 0; transform: translateY(12px); transition: opacity 200ms, transform 200ms; }
  .keys.on { opacity: 1; transform: none; }
  .keys.hit kbd { animation: hit 260ms ease-out; }
  @keyframes hit { from { transform: translateY(.14em); box-shadow: 0 0 0 #b9ad94; background: #e8a33d; } to { transform: none; } }
  .sheet { position: absolute; inset: 0; display: grid; place-items: center;
    background: radial-gradient(ellipse at center, #2c5a47 0%, #1b3a2e 70%);
    opacity: 0; transition: opacity 500ms; }
  .sheet.on { opacity: 1; }
  .sheet .paper { width: 1240px; padding: 30px 40px 34px; border-radius: 10px; background: #fdfaf3; color: #1d2b25;
    box-shadow: 0 18px 50px rgba(0,0,0,.4); transform: rotate(-.6deg); }
  .sheet h2 { margin: 0 0 20px; font-size: 30px; font-weight: 700; }
  .sheet .cols { display: grid; grid-template-columns: repeat(3, 1fr); gap: 34px; }
  .sheet h3 { margin: 0 0 12px; padding-bottom: 8px; border-bottom: 2px solid #e8a33d; font-size: 17px; font-weight: 700;
    letter-spacing: .1em; text-transform: uppercase; color: #2c5a47; }
  .sheet .row { min-height: 78px; padding: 8px 0; border-bottom: 1px solid #e3dccb; font-size: 19px; line-height: 1.3;
    opacity: 0; transition: opacity 500ms; }
  .sheet .row.on { opacity: 1; }
  .sheet .row .k { font-size: 19px; font-weight: 700; color: #6b6354; margin-bottom: 5px; white-space: nowrap; }
  .sheet .row .k kbd { margin: 0 1px; }
</style>
<div class="layer">
  <div class="ring"></div>
  <div class="ripple"></div>
  <svg class="cursor" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 15 L11.5 22 L14.5 20.7 L11.6 14 L18 14 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>
  <div class="callout"><span class="n"></span><span class="t"></span></div>
  <div class="card"><div><div class="k"></div><h1></h1><p></p></div></div>
  <div class="list"><h2></h2><div class="groups"></div></div>
  <div class="sheet"><div class="paper"><h2></h2><div class="cols"></div></div></div>
  <div class="keys"></div>
</div>`;
    document.documentElement.appendChild(host);
    const $ = <T extends Element>(s: string) => root.querySelector(s) as T;
    const cursor = $<SVGElement>(".cursor");
    const ripple = $<HTMLElement>(".ripple");
    const ring = $<HTMLElement>(".ring");
    const callout = $<HTMLElement>(".callout");
    const card = $<HTMLElement>(".card");
    const list = $<HTMLElement>(".list");
    const keys = $<HTMLElement>(".keys");
    const sheet = $<HTMLElement>(".sheet");
    let keysTimer = 0;
    // "Alt+Shift+F M" → the chords "Alt+Shift+F" and "M", each key a keycap.
    const keycaps = (into: HTMLElement, text: string) => {
      for (const [i, chord] of text.split(" ").entries()) {
        if (i) into.append(" ");
        for (const [j, key] of chord.split("+").entries()) {
          if (j) into.append("+");
          const cap = document.createElement("kbd");
          cap.textContent = key;
          into.appendChild(cap);
        }
      }
    };

    w.__gmv = {
      cursor(x: number, y: number, ms: number) {
        cursor.style.transitionDuration = `${ms}ms, 250ms`;
        cursor.style.opacity = "1";
        // The arrow's tip sits at (4,2) of a 24-unit box drawn at 30px.
        cursor.style.transform = `translate(${x - 5}px, ${y - 2.5}px)`;
      },
      hideCursor() { cursor.style.opacity = "0"; },
      chrome(visible: boolean) {
        // Pointer, callout and keycaps off while a thumbnail screenshot is taken; the ring stays.
        cursor.style.visibility = callout.style.visibility = keys.style.visibility = visible ? "" : "hidden";
      },
      click(x: number, y: number) {
        ripple.style.left = `${x}px`;
        ripple.style.top = `${y}px`;
        ripple.classList.remove("go");
        void ripple.offsetWidth;
        ripple.classList.add("go");
      },
      ring(r: { x: number; y: number; width: number; height: number } | null, pad: number) {
        if (!r) { ring.style.opacity = "0"; return; }
        ring.style.left = `${r.x - pad}px`;
        ring.style.top = `${r.y - pad}px`;
        ring.style.width = `${r.width + 2 * pad}px`;
        ring.style.height = `${r.height + 2 * pad}px`;
        ring.style.opacity = "1";
      },
      callout(n: string | null, text: string | null) {
        if (!text) { callout.classList.remove("on"); return; }
        $<HTMLElement>(".callout .n").textContent = n ?? "";
        $<HTMLElement>(".callout .n").style.display = n ? "" : "none";
        $<HTMLElement>(".callout .t").textContent = text;
        callout.classList.add("on");
      },
      list(title: string | null, groups: { name: string; items: [string, string][]; column?: boolean }[]) {
        if (!title) { list.classList.remove("on"); return; }
        $<HTMLElement>(".list h2").textContent = title;
        const box = $<HTMLElement>(".list .groups");
        box.textContent = "";
        for (const g of groups) {
          const el = document.createElement("div");
          el.className = "g";
          // A group may open the next column instead of following the last one.
          if (g.column) el.style.breakBefore = "column";
          const h = document.createElement("h3");
          h.textContent = g.name;
          el.appendChild(h);
          for (const [icon, label] of g.items) {
            const row = document.createElement("div");
            const i = document.createElement("span");
            i.textContent = icon;
            row.append(i, label);
            el.appendChild(row);
          }
          box.appendChild(el);
        }
        list.classList.add("on");
      },
      keys(chord: string | null, ms: number) {
        window.clearTimeout(keysTimer);
        if (!chord) { keys.classList.remove("on"); return; }
        keys.textContent = "";
        keycaps(keys, chord);
        keys.classList.remove("hit");
        void keys.offsetWidth;
        keys.classList.add("on", "hit");
        if (ms > 0) keysTimer = window.setTimeout(() => keys.classList.remove("on"), ms);
      },
      sheet(title: string | null, groups: { name: string; rows: [string, string][] }[], shown: number) {
        if (!title) { sheet.classList.remove("on"); return; }
        $<HTMLElement>(".sheet h2").textContent = title;
        const cols = $<HTMLElement>(".sheet .cols");
        // Built once, so a later call only fades further groups in.
        if (cols.childElementCount !== groups.length) {
          cols.textContent = "";
          for (const g of groups) {
            const col = document.createElement("div");
            const h = document.createElement("h3");
            h.textContent = g.name;
            col.appendChild(h);
            for (const [chords, label] of g.rows) {
              const row = document.createElement("div");
              row.className = "row";
              const k = document.createElement("div");
              k.className = "k";
              keycaps(k, chords);
              row.append(k, label);
              col.appendChild(row);
            }
            cols.appendChild(col);
          }
          void cols.offsetWidth;
        }
        [...cols.children].forEach((col, i) => col.querySelectorAll(".row").forEach((r) => r.classList.toggle("on", i < shown)));
        sheet.classList.add("on");
      },
      card(kicker: string | null, title: string | null, line: string | null) {
        if (!title) { card.classList.remove("on"); return; }
        $<HTMLElement>(".card .k").textContent = kicker ?? "";
        $<HTMLElement>(".card h1").textContent = title;
        $<HTMLElement>(".card p").textContent = line ?? "";
        card.classList.add("on");
      },
    };
    // A title card held across a navigation (see `Director.holdCard`) is up
    // from the first paint of the new page, without fading in.
    try {
      const held = sessionStorage.getItem("gmv-card");
      if (held) {
        const [k, t, l] = JSON.parse(held) as [string | null, string | null, string | null];
        card.style.transition = "none";
        (w.__gmv as { card(k: string | null, t: string | null, l: string | null): void }).card(k, t, l);
        void card.offsetWidth;
        card.style.transition = "";
      }
    } catch { /* storage unavailable: no card to hold */ }
  };

  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}

/** What `installOverlay` puts on `window.__gmv`, for typed `page.evaluate` calls. */
export interface OverlayApi {
  cursor(x: number, y: number, ms: number): void;
  hideCursor(): void;
  chrome(visible: boolean): void;
  click(x: number, y: number): void;
  ring(r: { x: number; y: number; width: number; height: number } | null, pad: number): void;
  callout(n: string | null, text: string | null): void;
  card(kicker: string | null, title: string | null, line: string | null): void;
  /** A panel listing named groups of [icon, label] rows; a null title hides it. */
  list(title: string | null, groups: { name: string; items: [string, string][]; column?: boolean }[]): void;
  /** The key just pressed, as keycaps ("Alt+Shift+C"); gone after `ms` (0: stays), null hides it. */
  keys(chord: string | null, ms: number): void;
  /** A full-screen index card of shortcut groups, each row [chords, label]; the
   *  first `shown` groups are filled in. A null title hides it. */
  sheet(title: string | null, groups: { name: string; rows: [string, string][] }[], shown: number): void;
}
