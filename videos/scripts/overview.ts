/**
 * Video 1 (SCENARIJI.md): GED Merge — a genealogy program in your browser.
 * Opening a file, the three modes, moving around, search, undo, save preview,
 * keyboard shortcuts, settings and the User's Guide.
 *
 * Data: France Prešeren's pedigree from Peter Hawlina's tree (videos/demo/).
 * France is the file's first person, so he is the one GED Merge opens on.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import type { Scenario } from "../lib/types.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "preseren-hawlina.ged");

/** Header icon buttons, in order: search, add person, settings (labels differ per language). */
const headerIcon = (d: Director, i: number) =>
  d.page.locator(".nav-btn.icon-only:not(.undo-btn):not(.charts-open-btn):not(.shortcuts-btn)").nth(i);
const givenName = (d: Director) => d.page.locator(".edit-person .edit-name-input").first();

const scenario: Scenario = {
  id: "overview",
  episode: 1,
  title: {
    sl: "GED Merge: rodoslovni program v brskalniku — prvi koraki",
    en: "GED Merge: a genealogy program in your browser — first steps",
  },
  description: {
    sl: "Kaj je GED Merge in kako se v njem znajdete: odpiranje datoteke GEDCOM, trije načini dela, premikanje po drevesu, iskanje, razveljavitev, shranjevanje, bližnjice na tipkovnici, nastavitve in navodila. Primer: rodovnik Franceta Prešerna iz drevesa Petra Hawline.",
    en: "What GED Merge is and how to find your way around: opening a GEDCOM file, the three modes, moving through the tree, search, undo, saving, keyboard shortcuts, settings and the User's Guide. Example: France Prešeren's pedigree from Peter Hawlina's tree.",
  },
  thumbnail: {
    tag: { sl: "Prvi koraki", en: "First steps" },
    title: { sl: "Vaš *rodoslovni* program v brskalniku", en: "Your *genealogy* program in the browser" },
  },
  steps: [
    {
      say: {
        sl: "GED Merge je rodoslovni program, ki deluje v vašem brskalniku. V tem videu si ogledamo, kako je zgrajen in kako se v njem hitro znajdete.",
        en: "GED Merge is a genealogy program that runs in your browser. In this video we look at how it is laid out and how to find your way around quickly.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Rodoslovni program v brskalniku", en: "A genealogy program in your browser" },
          { sl: "Prvi koraki", en: "First steps" },
        );
      },
    },
    {
      callout: { sl: "Odprite datoteko", en: "Open a file" },
      say: {
        sl: "Na začetni strani odprete svojo datoteko GEDCOM. Datoteka ostane na vašem računalniku in se nikamor ne pošlje.",
        en: "On the start page you open your GEDCOM file. The file stays on your computer; nothing is uploaded.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(900);
        const zone = d.page.locator(".lb-drop");
        await d.highlight(zone);
        await d.point(zone);
        await d.wait(2500);
        await d.highlight(d.page.locator(".lb-free"));
      },
    },
    {
      say: {
        sl: "Če datoteke še nimate, začnete novo drevo ali si najprej ogledate eno od vzorčnih dreves.",
        en: "If you don't have a file yet, start a new tree, or first explore one of the sample trees.",
      },
      run: async (d) => {
        const blocks = d.page.locator(".lb-samples");
        await d.scrollTo(blocks.first());
        await d.highlight(blocks.first());
        await d.point(d.page.locator(".lb-sample-row").first());
        await d.wait(1200);
        await d.highlight(blocks.nth(1));
        await d.point(d.page.locator(".lp-sample-tile").first());
      },
    },
    {
      say: {
        sl: "Odprimo rodovnik Franceta Prešerna. Program pokaže osebo z vsemi sorodniki: starše zgoraj, partnerje in otroke spodaj.",
        en: "Let's open France Prešeren's pedigree. The program shows a person with all their relatives: parents above, partners and children below.",
      },
      run: async (d) => {
        await d.highlight(null);
        const zone = d.page.locator(".lb-drop");
        await d.scrollTo(zone);
        await d.upload(zone, MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.overlay("hideCursor");
        await d.wait(1500);
        await d.snapshot();
        await d.highlight(d.page.locator(".edit-person").first());
      },
    },
    {
      callout: { sl: "Trije načini dela", en: "Three modes" },
      say: {
        sl: "GED Merge ima tri načine dela. V Urejanju urejate svoje drevo, v Združevanju ga dopolnjujete iz druge datoteke, v Orodjih pa skrbite za datoteko kot celoto.",
        en: "GED Merge has three modes. In Edit you work on your tree, in Merge you complete it from another file, and in Tools you look after the file as a whole.",
      },
      run: async (d) => {
        const tabs = d.page.locator(".seg-btn");
        await d.highlight(tabs.first().locator(".."), 4);
        for (let i = 0; i < 3; i++) {
          await d.point(tabs.nth(i));
          await d.wait(2200);
        }
      },
    },
    {
      callout: { sl: "Premikanje po drevesu", en: "Moving around" },
      say: {
        sl: "Po drevesu se premikate s klikom na sorodnika, z gumbom »Nazaj« pa se vrnete.",
        en: "You move through the tree by clicking a relative, and the Back button takes you back.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(d.page.locator(".person-card").first());
        await d.wait(1800);
        await d.click(d.page.locator(".tree-back-btn").filter({ visible: true }).first());
      },
    },
    {
      callout: { sl: "Iskanje", en: "Search" },
      say: {
        sl: "Osebo najhitreje najdete z iskanjem. Pritisnite poševnico in vpišite začetek imena. Šumniki pri tem niso potrebni.",
        en: "The quickest way to find someone is search. Press the slash key and type the start of a name; accents are optional.",
      },
      run: async (d) => {
        await d.point(headerIcon(d, 0));
        await d.wait(800);
        await d.page.keyboard.press("/");
        await d.wait(600);
        await d.page.keyboard.type("simen", { delay: 180 });
        await d.wait(1800);
        await d.page.keyboard.press("Enter");
      },
    },
    {
      callout: { sl: "Razveljavi in ponovi", en: "Undo and redo" },
      say: {
        sl: "Vsako spremembo lahko razveljavite in ponovite, z gumboma zgoraj ali s Ctrl+Z in Ctrl+Shift+Z.",
        en: "Every change can be undone and redone, with the buttons at the top or with Ctrl+Z and Ctrl+Shift+Z.",
      },
      run: async (d) => {
        const name = givenName(d);
        await d.click(name);
        await name.fill("Simon");
        await d.page.keyboard.press("Tab");
        await d.wait(900);
        const undo = d.page.locator(".undo-btn");
        await d.click(undo.first());
        await d.wait(900);
        await d.click(undo.nth(1));
      },
    },
    {
      callout: { sl: "Shranjevanje", en: "Saving" },
      say: {
        sl: "Ko shranite, GED Merge pokaže predogled sprememb in prenese novo datoteko. Izvirnika nikoli ne prepiše.",
        en: "When you save, GED Merge shows a preview of the changes and downloads a new file. It never overwrites the original.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".app-head-actions .export-btn"));
        await d.wait(6500);
        // Close the preview without saving, then take the demo edit back.
        await d.page.keyboard.press("Escape");
        await d.page.locator(".preview-actions").waitFor({ state: "hidden" });
        await d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await d.page.keyboard.press("Control+z");
      },
    },
    {
      callout: { sl: "Bližnjice na tipkovnici", en: "Keyboard shortcuts" },
      say: {
        sl: "Gumb z vprašajem ali tipka vprašaj odpre seznam bližnjic na tipkovnici. Na vrhu so bližnjice za zaslon, na katerem ste, spodaj pa vse druge: za navigacijo, urejanje, odločitve pri združevanju in diagrame. Večino dela lahko opravite brez miške, seznam pa si lahko natisnete na en list A4.",
        en: "The question-mark button, or the question-mark key, opens the list of keyboard shortcuts. At the top are the shortcuts for the screen you are on, below them all the others: navigation, editing, merge decisions and charts. You can do most of your work without the mouse, and the list prints on a single A4 page.",
      },
      run: async (d) => {
        await d.point(d.page.locator(".shortcuts-btn"));
        // The key, not a click: right after the save preview closes the header
        // is still settling. Blur first, or "?" is typed into a field.
        await d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await d.page.keyboard.press("?");
        const modal = d.page.locator(".shortcuts-modal");
        await modal.waitFor({ timeout: 5000 });
        await d.overlay("hideCursor");
        await d.wait(3500);
        // Page through the list so every group is on screen once.
        for (let i = 0; i < 4; i++) {
          await modal.evaluate((m) => {
            const scroller = [m, ...m.querySelectorAll<HTMLElement>("*")].find((e) => e.scrollHeight > e.clientHeight + 4);
            scroller?.scrollBy({ top: scroller.clientHeight * 0.8, behavior: "smooth" });
          });
          await d.wait(2600);
        }
        await d.page.keyboard.press("Escape");
      },
    },
    {
      say: {
        sl: "Z Alt in puščicami se premikate k staršem, otrokom in sorojencem.",
        en: "Alt and the arrow keys take you to parents, children and siblings.",
      },
      run: async (d) => {
        await d.overlay("hideCursor");
        await d.page.locator(".edit-person").first().click({ position: { x: 900, y: 12 } });
        await d.wait(600);
        await d.page.keyboard.press("Alt+ArrowUp");
        await d.wait(1600);
        await d.page.keyboard.press("Alt+ArrowDown");
      },
    },
    {
      callout: { sl: "Nastavitve", en: "Settings" },
      say: {
        sl: "V Nastavitvah izberete jezik, temo ter način prikaza imen in datumov.",
        en: "In Settings you choose the language, the theme, and how names and dates are shown.",
      },
      run: async (d) => {
        await d.click(headerIcon(d, 2));
        await d.wait(600);
        await d.highlight(d.page.locator(".modal").first(), 4);
        await d.wait(3500);
        await d.highlight(null);
        await d.page.keyboard.press("Escape");
      },
    },
    {
      callout: { sl: "Navodila za uporabo", en: "User's Guide" },
      say: {
        sl: "Podrobna navodila v slovenščini in angleščini najdete v nogi vsake strani.",
        en: "Detailed instructions in English and Slovenian are linked at the bottom of every page.",
      },
      run: async (d) => {
        const guide = d.page.locator(".app-footer-link").nth(2);
        await d.highlight(guide, 6);
        await d.point(guide);
      },
    },
    {
      callout: null,
      say: {
        sl: "GED Merge je vaš rodoslovni program v brskalniku. V njem urejate drevo, ga dopolnjujete iz drugih datotek ter rišete diagrame in zemljevide. Je brezplačen, ne potrebuje računa, najdete pa ga na naslovu gedmerge.com.",
        en: "GED Merge is your genealogy program in the browser. You edit your tree, complete it from other files, and draw charts and maps. It is free, needs no account, and you will find it at gedmerge.com.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.overlay("hideCursor");
        await d.card(
          { sl: "Brezplačno · brez računa · v brskalniku", en: "Free · no account · in your browser" },
          { sl: "GED Merge — vaš rodoslovni program", en: "GED Merge — your genealogy program" },
          { sl: "gedmerge.com", en: "gedmerge.com" },
        );
      },
    },
  ],
};

export default scenario;
