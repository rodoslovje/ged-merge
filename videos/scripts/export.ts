/**
 * Video 8 (SCENARIJI.md, "Možnosti diagramov, izvoz in zasebnost"): the chart
 * settings in detail — alignment, generations, the fields by each person, the
 * colour — then the exports (SVG, print on several sheets, a GEDCOM with only
 * the people drawn) and privacy: living people hidden on the chart, and the
 * Privacy tool's redacted copy of the whole file.
 *
 * Data: the settings and exports run on France Prešeren's pedigree from Peter
 * Hawlina's tree, geocoded as episode 6 leaves it (`preseren-hawlina-geo.ged`).
 * The Prešeren family has no living people, so the privacy part opens
 * `rodbina-renko.ged`, an anonymised excerpt of the author's own tree: the
 * author and his parents under their real names, every other living relative
 * under a made-up name, sex and birth date (see videos/README.md).
 *
 * The print is caught before the browser's print dialog: its frame is shown
 * full-screen instead, so the viewer sees the sheets the printer would get.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import { seriesSettingsWithMaps } from "../lib/series.ts";
import type { Scenario, Text } from "../lib/types.ts";

const DEMO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo");
const MAIN = path.join(DEMO, "preseren-hawlina-geo.ged");
const LIVING = path.join(DEMO, "rodbina-renko.ged");

/** A chart toolbar button by the start of its label (the direction buttons end in a count). */
const tool = (d: Director, re: RegExp) => d.page.locator("button").filter({ hasText: re }).filter({ visible: true }).first();
const blur = (d: Director) => d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const fit = async (d: Director) => {
  await blur(d);
  await d.page.keyboard.press("f");
  await d.wait(900);
};
const openChartSettings = async (d: Director) => {
  await d.click(d.page.locator(".chart-settings-btn").filter({ visible: true }).first());
  await d.wait(700);
};
const closePopover = async (d: Director) => {
  await d.highlight(null);
  await d.page.keyboard.press("Escape");
  await d.wait(500);
};
const setting = (d: Director, label: Text, nth = 0) =>
  d.page.locator(".chart-settings-popover button").filter({ hasText: new RegExp(`^${d.t(label)}$`) }).nth(nth);
/** Ring a settings button and click it. */
const flip = async (d: Director, label: Text, wait = 1100, nth = 0) => {
  const b = setting(d, label, nth);
  await d.highlight(b, 4);
  await d.click(b);
  await d.wait(wait);
};
/** One of the popover's groups (Usmeritev, Rodovi, Oseba, …), by position. */
const group = (d: Director, heading: Text) =>
  d.page.locator(".chart-settings-group").filter({ has: d.page.locator(".chart-settings-heading", { hasText: d.t(heading) }) }).first();

const exportBtn = (d: Director) => d.page.locator("button", { hasText: d.t({ sl: "Izvoz", en: "Export" }) }).filter({ visible: true }).first();
const exportItem = (d: Director, text: string) =>
  d.page.locator("[role=menuitem], .dd-item").filter({ visible: true }).filter({ hasText: text }).first();
const openExport = async (d: Director) => {
  await d.click(exportBtn(d));
  await d.wait(700);
};

const dialog = (d: Director) => d.page.locator(".sheet-dialog");
const dialogBtn = (d: Director, label: Text) => dialog(d).locator("button").filter({ hasText: new RegExp(`^${d.t(label)}$`) }).first();

/**
 * Let the next print show its sheets instead of opening the print dialog: the
 * hidden print frame is kept, its `print()` disarmed, and the frame laid over
 * the whole screen with the sheets side by side, scaled to fit.
 */
async function catchPrint(d: Director): Promise<void> {
  await d.page.evaluate(() => {
    new MutationObserver((muts, obs) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (!(n instanceof HTMLIFrameElement)) continue;
        obs.disconnect();
        n.addEventListener("load", () => {
          n.contentWindow!.print = () => {};
          const doc = n.contentDocument!;
          const sheets = [...doc.querySelectorAll<HTMLElement>(".gm-sheet")];
          const w = sheets[0]?.offsetWidth || 800;
          const h = sheets[0]?.offsetHeight || 1100;
          const W = innerWidth, H = innerHeight, gap = 0.04;
          // The column count that lets the sheets come out largest.
          let best = { zoom: 0, cols: 1 };
          for (let cols = 1; cols <= sheets.length; cols++) {
            const rows = Math.ceil(sheets.length / cols);
            const zoom = Math.min(W / (cols * w * (1 + gap) + w * gap), H / (rows * h * (1 + gap) + h * gap)) * 0.9;
            if (zoom > best.zoom) best = { zoom, cols };
          }
          const st = doc.createElement("style");
          st.textContent = `html{background:#3f4441}
            body{display:grid;grid-template-columns:repeat(${best.cols},${w}px);gap:${h * gap}px;justify-content:center;align-content:center;min-height:${H / best.zoom}px;zoom:${best.zoom}}
            .gm-sheet{background:#fff;box-shadow:0 ${h * 0.01}px ${h * 0.04}px rgba(0,0,0,.5)}`;
          doc.head.appendChild(st);
          n.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:2147483000;visibility:visible;";
        });
      }
    }).observe(document.body, { childList: true });
  });
}

const closePrint = (d: Director) => d.page.evaluate(() => document.querySelectorAll("iframe[aria-hidden]").forEach((f) => f.remove()));

const scenario: Scenario = {
  id: "export",
  episode: 8,
  settings: seriesSettingsWithMaps,
  title: {
    sl: "GED Merge: nastavitve diagrama, tisk na več listov in zasebnost živih oseb",
    en: "GED Merge: chart settings, printing on several sheets and privacy for living people",
  },
  description: {
    sl: "Kako v GED Merge prilagodite diagram (usmeritev, rodovi, podatki ob osebi, barve), ga izvozite kot sliko SVG, natisnete na več listov ali izvozite kot datoteko GEDCOM samo z narisanimi osebami, in kako pred deljenjem prikrijete žive osebe — na diagramu in v celi datoteki. Primer: rodovnik Franceta Prešerna iz drevesa Petra Hawline in anonimiziran izsek iz drevesa avtorja GED Merge.",
    en: "How to adjust a chart in GED Merge (alignment, generations, details by each person, colours), export it as an SVG image, print it on several sheets or export a GEDCOM file with only the people drawn — and how to hide living people before you share, on the chart and in the whole file. Example: France Prešeren's pedigree from Peter Hawlina's tree, and an anonymised excerpt of the GED Merge author's own tree.",
  },
  thumbnail: {
    tag: { sl: "Izvoz", en: "Export" },
    title: { sl: "Natisnite *drevo* na več listov", en: "Print your *tree* on several sheets" },
  },
  steps: [
    {
      say: {
        sl: "Diagram lahko prilagodite, natisnete ali pošljete drugim. V tem videu pokažemo, kako — in kako pri tem zaščitite žive osebe.",
        en: "You can adjust a chart, print it, or share it with others. In this video we show how — and how to protect living people while you do.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Možnosti diagramov, izvoz in zasebnost", en: "Chart options, export and privacy" },
          { sl: "Prilagodite, natisnite in delite drevo", en: "Adjust, print and share your tree" },
        );
      },
    },
    {
      say: {
        sl: "Odprimo rodovnik pesnika Franceta Prešerna in njegovo drevo prednikov.",
        en: "Let's open the pedigree of the poet France Prešeren, and his ancestor tree.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(700);
        await d.upload(d.page.locator(".lb-drop"), MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(800);
        await d.click(d.page.locator(".charts-open-btn"));
        await d.page.locator(".charts-kind").waitFor();
        await d.click(tool(d, /^(Predniki|Ancestors)\d/));
        await fit(d);
      },
    },
    {
      callout: { sl: "Nastavitve diagrama", en: "Chart settings" },
      say: {
        sl: "Vse možnosti so pod gumbom »Diagram«. Drevo lahko teče od leve proti desni ali od zgoraj navzdol.",
        en: "All the options are under the Chart button. The tree can run from left to right, or from top to bottom.",
      },
      run: async (d) => {
        await openChartSettings(d);
        await flip(d, { sl: "Zgoraj → spodaj", en: "Top → Bottom" }, 2500);
        await flip(d, { sl: "Levo → desno", en: "Left → Right" }, 600);
      },
    },
    {
      say: {
        sl: "Pri velikem drevesu omejite število rodov. Z znakom minus skrajšate drevo za en rod, z znakom plus ga spet podaljšate.",
        en: "With a large tree, limit the number of generations. The minus sign drops one generation, and the plus sign brings it back.",
      },
      run: async (d) => {
        const rows = group(d, { sl: "Rodovi", en: "Generations" });
        const fewer = rows.locator("button").first();
        const more = rows.locator("button").last();
        await d.highlight(rows, 4);
        for (let i = 0; i < 3; i++) {
          await d.click(fewer);
          await d.wait(700);
        }
        await d.wait(1500);
        for (let i = 0; i < 3; i++) {
          await d.click(more);
          await d.wait(500);
        }
      },
    },
    {
      say: {
        sl: "Pod »Oseba« izberete, kaj se izpiše ob vsaki osebi: življenjska doba, starost, kraj in sorodstvo do izhodiščne osebe. Vklopimo še kraje.",
        en: "Under Person you choose what is written by each person: the lifespan, the age, the place and the kinship to the start person. Let's switch on the places too.",
      },
      run: async (d) => {
        await d.highlight(group(d, { sl: "Oseba", en: "Person" }), 4);
        await d.wait(3500);
        await flip(d, { sl: "Kraj", en: "Place" }, 1500);
        await closePopover(d);
        await fit(d);
      },
    },
    {
      callout: { sl: "Barva", en: "Colour" },
      say: {
        sl: "Barva lahko nekaj pove. Po rodovih so osebe istega rodu iste barve. Po stoletju vidite, kdaj so predniki živeli, po kraju rojstva pa, od kod izhajajo. Legenda spodaj pove, kaj pomeni katera barva.",
        en: "Colour can tell you something. By generation, people of one generation share a colour. By century you see when the ancestors lived, and by birthplace where they came from. The legend below says what each colour means.",
      },
      run: async (d) => {
        await openChartSettings(d);
        await flip(d, { sl: "Rod", en: "Generation" }, 2200);
        await flip(d, { sl: "Stoletje", en: "Century" }, 2200);
        await flip(d, { sl: "Kraj rojstva", en: "Birth place" }, 1500);
        await closePopover(d);
        await d.highlight(d.page.locator(".chart-legend").filter({ visible: true }).first(), 6);
        await d.wait(2500);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Izvoz", en: "Export" },
      say: {
        sl: "Gumb »Izvoz« ponudi tri možnosti. Slika SVG ostane ostra pri vsaki velikosti, zato je primerna za objavo ali za nadaljnje urejanje v risarskem programu.",
        en: "The Export button offers three choices. An SVG image stays sharp at any size, so it suits publishing, or further editing in a drawing program.",
      },
      run: async (d) => {
        await openExport(d);
        const svg = exportItem(d, "SVG");
        await d.highlight(svg.locator(".."), 4);
        await d.wait(2500);
        await d.highlight(svg, 4);
        await d.point(svg);
        // The pick waits until the SVG image has been talked about.
        await d.untilSaid();
        await d.highlight(null);
        await d.click(svg);
      },
    },
    {
      say: {
        sl: "Za tisk izberite PDF. Najprej izberete papir in usmerjenost, nato velikost tiska. Če je drevo za en list preširoko, se razreže na več listov.",
        en: "To print, choose PDF. First pick the paper and its orientation, then the print size. A tree too wide for one sheet is cut across several sheets.",
      },
      run: async (d) => {
        await openExport(d);
        await d.click(exportItem(d, "PDF"));
        await dialog(d).waitFor();
        await d.wait(800);
        await d.click(dialogBtn(d, { sl: "A3", en: "A3" }));
        await d.wait(1200);
        await d.click(dialogBtn(d, { sl: "A4", en: "A4" }));
        await d.click(dialogBtn(d, { sl: "Ležeče", en: "Landscape" }));
        await d.click(dialogBtn(d, { sl: "Velika", en: "Large" }));
        await d.highlight(dialog(d).locator(".sheet-dialog-count"), 6);
        await d.wait(1500);
      },
    },
    {
      say: {
        sl: "Tako dobimo štiri liste formata A4. Veja, ki ne gre na list, se nadaljuje na svojem listu, številka v krogcu pa pove, kje se diagram nadaljuje.",
        en: "That gives four A4 sheets. A branch that does not fit on a sheet continues on a sheet of its own, and a number in a circle shows where the chart carries on.",
      },
      run: async (d) => {
        await d.highlight(null);
        await catchPrint(d);
        await d.click(dialogBtn(d, { sl: "Natisni", en: "Print" }));
        await d.page.locator("iframe[aria-hidden]").waitFor({ state: "visible" });
        await d.overlay("hideCursor");
        await d.wait(1500);
        await d.snapshot();
      },
    },
    {
      say: {
        sl: "Na papirju večje velikosti, kot sta A1 ali A0, gre celo drevo na en sam list, primeren za steno.",
        en: "On a larger paper, such as A1 or A0, the whole tree fits on a single sheet, ready for the wall.",
      },
      run: async (d) => {
        await d.wait(1500);
        await closePrint(d);
      },
    },
    {
      say: {
        sl: "Zadnja možnost je datoteka GEDCOM samo z osebami na diagramu. Tako sorodniku pošljete le vejo, ki ga zanima, in ne vsega drevesa.",
        en: "The last choice is a GEDCOM file with only the people on the chart. That way you send a relative just the branch they care about, not the whole tree.",
      },
      run: async (d) => {
        await openExport(d);
        const ged = exportItem(d, "GEDCOM");
        await d.highlight(ged.locator(".."), 4);
        await d.wait(2500);
        await d.highlight(null);
        await d.click(ged);
      },
    },
    {
      callout: { sl: "Zasebnost", en: "Privacy" },
      say: {
        sl: "Preden drevo pošljete drugim, pomislite na žive sorodnike. V Prešernovi rodbini živih oseb ni, zato odpremo drugo drevo: izsek iz drevesa avtorja GED Merge. Imena živih sorodnikov so v njem izmišljena.",
        en: "Before you share a tree, think of your living relatives. Prešeren's family has no living people, so we open another tree: an excerpt from the GED Merge author's own tree, in which the living relatives have made-up names.",
      },
      run: async (d) => {
        await d.page.keyboard.press("Escape");
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(600);
        await d.click(d.page.locator(".gm-file").first());
        await d.wait(700);
        await d.upload(d.page.locator(".dropzone.compact").filter({ visible: true }).first(), LIVING);
        await d.page.locator(".gm-file").filter({ hasText: "rodbina-renko" }).first().waitFor();
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(1200);
        await d.click(d.page.locator(".info-panel-close").filter({ visible: true }).first());
      },
    },
    {
      say: {
        sl: "Pojdimo k dedu in narišimo njegove potomce v pahljači. Na diagramu so zdaj tudi živi: starši, strici, tete in bratranci.",
        en: "Let's go to the grandfather and draw his descendants as a fan. Now the chart also holds living people: parents, uncles, aunts and cousins.",
      },
      run: async (d) => {
        await d.wait(400);
        // The father's card, then his father's.
        for (let i = 0; i < 2; i++) {
          await d.click(d.page.locator(".person-card").filter({ visible: true }).first());
          await d.wait(1000);
        }
        await d.click(d.page.locator(".charts-open-btn"));
        await d.page.locator(".charts-kind").waitFor();
        await d.click(d.page.locator(".charts-kind button").nth(1));
        await d.click(tool(d, /^(Potomci|Descendants)\d/));
        await fit(d);
        await d.page.keyboard.press("+");
      },
    },
    {
      say: {
        sl: "Omejimo pahljačo na dva rodova: dedove otroke in vnuke. Barva »Živi« pokaže, katere osebe program šteje za žive: tiste brez zapisa o smrti, rojene v zadnjih sto letih.",
        en: "Let's limit the fan to two generations: the grandfather's children and grandchildren. The Living colour shows whom the program counts as living: people with no record of death, born within the last hundred years.",
      },
      run: async (d) => {
        await openChartSettings(d);
        const rows = group(d, { sl: "Rodovi", en: "Generations" });
        await d.highlight(rows, 4);
        for (let i = 0; i < 6 && !/^2\D/.test(await rows.locator(".chart-settings-value").innerText()); i++) {
          await d.click(rows.locator("button").first());
          await d.wait(700);
        }
        await d.wait(800);
        await flip(d, { sl: "Živi", en: "Living" }, 1200);
        await closePopover(d);
        await fit(d);
        await d.highlight(d.page.locator(".chart-legend").filter({ visible: true }).first(), 6);
        await d.wait(2500);
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Vklopite »Skrij žive osebe«. Namesto imena ostane samo sorodstvo, letnice in kraji izginejo. Tako je zaščiten tudi izvoz: slika, tisk in datoteka GEDCOM.",
        en: "Switch on Hide living people. Only the kinship stays in place of the name, and the years and places disappear. The exports are protected too: the image, the print and the GEDCOM file.",
      },
      run: async (d) => {
        await openChartSettings(d);
        await flip(d, { sl: "Skrij žive osebe", en: "Hide living people" }, 1500);
        await closePopover(d);
        await fit(d);
        await d.wait(2500);
      },
    },
    {
      callout: { sl: "Orodje Zasebnost", en: "Privacy tool" },
      say: {
        sl: "Za celo datoteko uporabite orodje Zasebnost v Orodjih. Orodje poišče verjetno žive osebe in pove, koliko jih je.",
        en: "For the whole file, use the Privacy tool under Tools. It finds the people who are probably living, and tells you how many there are.",
      },
      run: async (d) => {
        await d.page.keyboard.press("Escape");
        await d.wait(600);
        await d.click(d.page.locator(".mode-tabs button").nth(2));
        await d.wait(800);
        await d.click(d.page.locator(".tools-tab").filter({ hasText: d.t({ sl: "Zasebnost", en: "Privacy" }) }).first());
        await d.page.locator(".tools-privacy").waitFor();
        await d.wait(600);
        await d.highlight(d.page.locator(".tools-privacy-group").first(), 6);
        await d.wait(2500);
        const count = d.page.locator(".tools-privacy .tools-fix-hint").first().locator("..");
        await d.scrollTo(count);
        await d.highlight(count, 6);
        await d.wait(2500);
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Žive osebe lahko prikrijete ali pa jih odstranite, po želji skupaj z vsemi potomci.",
        en: "You can sanitize living people, or remove them — if you like, together with all their descendants.",
      },
      run: async (d) => {
        const action = d.page.locator(".tools-privacy-group").filter({ has: d.page.locator("input[name=privacy-action]") }).first();
        await d.scrollTo(action);
        await d.highlight(action, 6);
        await d.wait(3000);
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Pri prikritih osebah izberete, s čim se zamenja ime, na primer z začetnicami. Odstranijo se tudi datumi, kraji, opombe, viri in fotografije.",
        en: "For sanitized people, choose what replaces the name — initials, for example. Their dates, places, notes, sources and photos are removed as well.",
      },
      run: async (d) => {
        const names = d.page.locator(".tools-privacy-group").filter({ has: d.page.locator("input[name=privacy-name]") }).first();
        await d.scrollTo(names);
        await d.highlight(names, 6);
        await d.wait(1000);
        await d.click(names.locator("label").nth(2));
        await d.wait(1500);
        const strip = d.page.locator(".tools-privacy-group").filter({ has: d.page.locator(".tools-norm-summary") }).first();
        await d.scrollTo(strip);
        await d.highlight(strip, 6);
        await d.wait(2500);
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Na koncu kliknite »Prenesi prikrito datoteko GEDCOM«. Prikrita kopija se prenese posebej, vaša delovna datoteka pa ostane nespremenjena.",
        en: "Finally, click Download redacted GEDCOM. The redacted copy downloads separately, and your working file stays unchanged.",
      },
      run: async (d) => {
        const dl = d.page.locator(".tools-privacy .tools-run").first();
        await d.scrollTo(dl);
        await d.highlight(dl, 6);
        await d.click(dl);
        await d.wait(1500);
        await d.highlight(null);
      },
    },
    {
      callout: null,
      say: {
        sl: "GED Merge je vaš rodoslovni program v brskalniku. V njem urejate drevo, ga dopolnjujete iz drugih datotek ter rišete diagrame in zemljevide. Je brezplačen, ne potrebuje računa, najdete pa ga na naslovu gedmerge.com.",
        en: "GED Merge is your genealogy program in the browser. You edit your tree, complete it from other files, and draw charts and maps. It is free, needs no account, and you will find it at gedmerge.com.",
      },
      run: async (d) => {
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
