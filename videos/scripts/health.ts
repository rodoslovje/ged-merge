/**
 * Video 15 (SCENARIJI.md, "Pregled"): finding and fixing errors with the
 * health check — most with a button in the check itself, two in Edit, and all
 * the fixable ones at once.
 *
 * Data: demo/preseren-hawlina-pregled.ged, a copy of the Prešeren pedigree
 * (demo/preseren-hawlina.ged) with errors put in on purpose; its HEAD note says
 * so, and so does the narration. The errors (table in SCENARIJI.md):
 *   - Mina Prešeren's death 1823 typed as 1723 — death before birth, and with
 *     it an event outside her lifespan and her son Šimen born after her death;
 *   - Terezija Jelovšek detached from her parents France Prešeren and Ana;
 *   - a FAMS to a family that is gone, Ernestina's CHIL twice, Šimen and Mina
 *     Svetina in two families, a citation of a source that is not there;
 *   - Simon Muhovec and Marija Legat in swapped roles, Ana Jelovšek's sex
 *     removed;
 *   - Marija (Matija Prešeren's wife) without her birth, Jernej and Mina
 *     Prešeren's marriage without its date (~1761 in the original);
 *   - Jožef Prešeren's birth written 1. 3. 1698.
 * Real, as in the original: four people born in the 17th–18th century with no
 * death record, and 14 dates written ~1665, <1687, >1835.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import { seriesSettings } from "../lib/series.ts";
import type { Scenario, Text } from "../lib/types.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "preseren-hawlina-pregled.ged");

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A filter by its exact label: the chip reads "<label> <count>". */
const chip = (d: Director, label: Text) =>
  d.page.locator(".tools-chips .tools-chip").filter({ hasText: new RegExp(`^${escape(d.t(label))}\\s*\\d`) }).first();
const row = (d: Director, text: string) => d.page.locator(".tools-issues .tools-issue").filter({ hasText: text }).first();
const groupTab = (d: Director, i: number) => d.page.locator(".batch-section-tab").nth(i);
const rerun = (d: Director) => d.page.locator(".tools-fix-item .tools-run").first();

/** Scroll the Tools page so the health check's tabs sit at the top: the
 *  other tools' tiles go off screen and the check has the screen to itself. */
async function toolsToTop(d: Director): Promise<void> {
  await d.page
    .locator(".batch-section-toggle")
    .first()
    .evaluate((el) => {
      // The Tools page scrolls in its own container, not the window.
      const view = el.closest<HTMLElement>(".tools-view");
      if (!view) return;
      // A short list leaves nothing to scroll: room below lets the tiles go.
      view.style.paddingBottom = "100vh";
      view.scrollBy({ top: el.getBoundingClientRect().top - view.getBoundingClientRect().top - 8, behavior: "smooth" });
    });
  await d.wait(700);
}

/** Open a category's rows and give the viewer time to read them. */
async function openChip(d: Director, label: Text): Promise<void> {
  await d.click(chip(d, label));
  await d.wait(600);
  await d.highlight(d.page.locator(".tools-issues").first(), 6);
  await d.wait(2200);
  await d.highlight(null);
}

/** Run one row's own fix and wait until the check has read the file again.
 *  With `secondsBefore`, the click waits for the narration instead: it comes
 *  that many seconds before the step's last sentence ends. */
async function fixRow(d: Director, text: string, secondsBefore?: number): Promise<void> {
  const r = row(d, text);
  await d.highlight(r, 4);
  await d.wait(2500);
  if (secondsBefore !== undefined) await d.untilSaid(secondsBefore);
  await d.click(r.locator(".tools-issue-fix"));
  await d.highlight(null);
  await d.wait(1500);
}

/** Back to Tools (the health check stays open). */
async function backToTools(d: Director): Promise<void> {
  await d.click(d.page.locator(".seg-btn").nth(2));
  await d.wait(700);
  await toolsToTop(d);
}

/** Back to Tools and read the file again. */
async function backAndRerun(d: Director): Promise<void> {
  await backToTools(d);
  const btn = rerun(d);
  await d.highlight(btn, 4);
  await d.wait(900);
  await d.click(btn);
  await d.highlight(null);
  await d.page.locator(".tools-chips").first().waitFor();
  await toolsToTop(d);
  await d.wait(900);
}

/** Pick every fixable row shown and run them in one step. */
async function fixShown(d: Director): Promise<void> {
  await d.click(d.page.locator(".tools-pick-bar .tools-issue-link").first());
  await d.wait(900);
  await d.click(d.page.locator(".tools-pick-bar .tools-run").first());
  const dialog = d.page.locator(".confirm-dialog");
  await dialog.waitFor();
  await d.highlight(dialog, 4);
  await d.wait(3500);
  await d.highlight(null);
  await d.click(dialog.locator(".confirm-dialog-confirm"));
  await dialog.waitFor({ state: "detached" });
  await d.page.locator(".tools-clean--ok").first().waitFor();
  await d.wait(1200);
}

/** Pick every fixable row of the open half and run them in one step. */
async function fixAll(d: Director): Promise<void> {
  await openChip(d, { sl: "Popravljivo", en: "Fixable" });
  await fixShown(d);
}

/** Show the person open in Edit, then come back. */
async function showInEdit(d: Director, ring: string, ms = 3500): Promise<void> {
  await d.click(d.page.locator(".seg-btn").nth(0));
  await d.page.locator(".edit-person").first().waitFor();
  await d.wait(800);
  await d.highlight(d.page.locator(ring).first(), 6);
  await d.wait(ms);
  await d.highlight(null);
}

/** Fill an empty parent slot with a person already in the file. */
async function pickParent(d: Director, slot: Text, name: string, full: string): Promise<void> {
  await d.click(d.page.locator(".edit-parents .person-card-add").filter({ hasText: d.t(slot) }).first());
  const picker = d.page.locator(".relative-picker");
  await picker.locator(".relative-picker-input").click();
  await d.page.keyboard.type(name, { delay: 90 });
  await d.wait(500);
  await d.click(picker.locator(".relative-picker-option", { hasText: full }).first());
  await d.wait(800);
}

/** What the health check looks at, grouped, for the on-screen list (the filter names). */
const CHECKS: { name: Text; items: [string, Text][]; column?: boolean }[] = [
  {
    name: { sl: "Manjkajoči podatki", en: "Missing data" },
    items: [
      ["🏷️", { sl: "Brez imena, brez spola", en: "No name, no sex" }],
      ["⌛", { sl: "Brez ključnih datumov", en: "No vital dates" }],
      ["💒", { sl: "Poroka brez datuma", en: "Undated marriage" }],
      ["🧓", { sl: "Živi nad 99 let", en: "Living over 99" }],
    ],
  },
  {
    name: { sl: "Starosti", en: "Ages" },
    items: [
      ["💍", { sl: "Starost ob poroki in ob smrti", en: "Age at marriage and at death" }],
      ["👶", { sl: "Starost starša", en: "Parent's age" }],
      ["↔", { sl: "Starostna razlika zakoncev", en: "Spouse age gap" }],
      ["🔢", { sl: "Navedena starost", en: "Stated age" }],
      ["🕯️", { sl: "Rojstvo po smrti starša", en: "Born after a parent's death" }],
      ["⏪", { sl: "Rojstvo pred poroko", en: "Born before the marriage" }],
    ],
  },
  {
    column: true,
    name: { sl: "Datumi", en: "Dates" },
    items: [
      ["✝", { sl: "Smrt pred rojstvom", en: "Death before birth" }],
      ["📅", { sl: "Dogodek zunaj življenjske dobe", en: "Event outside lifespan" }],
      ["⏩", { sl: "Datumi v prihodnosti", en: "Future dates" }],
      ["❓", { sl: "Neberljivi in neobstoječi datumi", en: "Unparseable and impossible dates" }],
    ],
  },
  {
    name: { sl: "Povezave", en: "Links" },
    items: [
      ["🔗", { sl: "Pokvarjene povezave", en: "Broken links" }],
      ["⧉", { sl: "Podvojeni kazalci", en: "Duplicate pointers" }],
      ["👫", { sl: "Isti par dvakrat", en: "Same couple twice" }],
      ["🔁", { sl: "Krožni predniki", en: "Pedigree loops" }],
      ["👪", { sl: "Dve družini staršev", en: "Two sets of parents" }],
      ["🏝️", { sl: "Nepovezane osebe in veje", en: "Disconnected people and detached branches" }],
    ],
  },
  {
    column: true,
    name: { sl: "Zapis GEDCOM", en: "GEDCOM" },
    items: [
      ["📄", { sl: "Skladnost s standardom", en: "Conformance to the standard" }],
      ["🔗", { sl: "Neobstoječi sklici", en: "Dangling references" }],
      ["〰", { sl: "Nestandardni datumi", en: "Non-standard dates" }],
    ],
  },
];

const scenario: Scenario = {
  id: "health",
  episode: 15,
  // Married surnames shown throughout (episode 3 explains the two switches).
  settings: (lang) => ({ ...seriesSettings(lang), marriedSurname: true, marriedNameFromPartner: true }),
  title: {
    sl: "GED Merge: pregled — poiščite in popravite napake v drevesu",
    en: "GED Merge: health check — find and fix the errors in your tree",
  },
  description: {
    sl: "Kako Pregled v GED Merge najde napake v drevesu: pokvarjene in podvojene povezave, nemogoče datume in starosti, manjkajoče podatke ter odstopanja od standarda GEDCOM. Večino popravite z enim klikom, nekatere v Urejanju, vse popravljive pa naenkrat. Primer: kopija rodovnika pesnika Franceta Prešerna z namerno vnesenimi napakami.",
    en: "How the GED Merge health check finds the errors in a tree: broken and duplicated links, impossible dates and ages, missing data and departures from the GEDCOM standard. Most are fixed with one click, some in Edit, and all the fixable ones at once. Example: a copy of the poet France Prešeren's pedigree with errors put in on purpose.",
  },
  thumbnail: {
    tag: { sl: "Pregled", en: "Health check" },
    title: { sl: "Počistite *napake* v drevesu", en: "Clean up the *errors* in your tree" },
  },
  steps: [
    {
      say: {
        sl: "Tudi v skrbno vodenem drevesu se naberejo napake. Pregled jih najde v nekaj sekundah.",
        en: "Even a carefully kept tree collects errors. The health check finds them in seconds.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Pregled", en: "Health check" },
          { sl: "Poiščite in popravite napake v drevesu", en: "Find and fix the errors in your tree" },
        );
      },
    },
    {
      say: {
        sl: "Odprimo kopijo rodovnika pesnika Franceta Prešerna. Napake smo vanjo vnesli namerno, take, kot jih pustijo tipkarske napake, uvozi in združevanja.",
        en: "Let's open a copy of the poet France Prešeren's pedigree. We put errors into it on purpose, the kind that typos, imports and merges leave behind.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(700);
        await d.upload(d.page.locator(".lb-drop"), MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.overlay("hideCursor");
        await d.wait(1200);
        await d.highlight(d.page.locator(".edit-person").first(), 6);
      },
    },
    {
      callout: { sl: "Orodja → Pregled", en: "Tools → Health check" },
      say: {
        sl: "V Orodjih odprite Pregled. Na zavihku »Težave v podatkih« preveri povezave med osebami, datume, starosti in manjkajoče podatke, drugi zavihek pa zapis po standardu GEDCOM. Vsaka vrsta težave ima svoj filter s številom zadetkov.",
        en: "In Tools, open the health check. The Data issues tab checks the links between people, dates, ages and missing data, and the second tab how the file follows the GEDCOM standard. Each kind of issue has its own filter with the number of findings.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(d.page.locator(".seg-btn").nth(2));
        await d.wait(250);
        await d.click(d.page.locator(".tools-tab").filter({ has: d.page.locator(".tools-tab-label", { hasText: new RegExp(`^${d.t({ sl: "Pregled", en: "Health check" })}$`) }) }).first());
        await d.skippable(() => d.page.locator(".tools-chips").first().waitFor({ timeout: 60_000 }));
        await toolsToTop(d);
        await d.overlay(
          "list",
          d.t({ sl: "Kaj Pregled preveri", en: "What the health check looks at" }),
          CHECKS.map((g) => ({ name: d.t(g.name), column: g.column, items: g.items.map(([icon, label]) => [icon, d.t(label)] as [string, string]) })),
        );
        // The ring walks the file's own findings, filter by filter.
        const chips = d.page.locator(".tools-chips .tools-chip");
        const n = await chips.count();
        for (let i = 1; i < n; i++) {
          await d.highlight(chips.nth(i), 4);
          await d.wait(700);
        }
        await d.highlight(d.page.locator(".tools-chips").first(), 6);
        await d.snapshot();
        await d.untilSaid();
        await d.overlay("list", null, []);
      },
    },
    {
      callout: { sl: "Popravek v Urejanju", en: "Fixing in Edit" },
      say: {
        sl: "Začnimo pri smrti pred rojstvom. Klik na ime odpre osebo v Urejanju. Mina Prešeren je umrla leta 1823, v datoteki pa piše 1723. Ena napačna števka povzroči kar tri težave: smrt pred rojstvom, rojstvo po smrti in sina, rojenega po materini smrti.",
        en: "Let's start with the death before birth. A click on the name opens the person in Edit. Mina Prešeren died in 1823, but the file says 1723. One wrong digit causes three issues: a death before birth, a birth after the death, and a son born after his mother's death.",
      },
      run: async (d) => {
        await d.highlight(null);
        await openChip(d, { sl: "Smrt pred rojstvom", en: "Death before birth" });
        const mina = row(d, "Mina Prešeren");
        await d.highlight(mina, 4);
        await d.wait(2500);
        await d.highlight(null);
        await d.click(mina.locator(".tools-issue-link").first());
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(900);
        const death = d.page.locator(".edit-person .edit-event").filter({ hasText: d.t({ sl: "Smrt", en: "Death" }) }).first();
        await d.highlight(death, 6);
        await d.untilSaid(2);
        const date = death.locator(".edit-event-date").first();
        await d.click(date);
        await d.page.keyboard.press("End");
        for (let i = 0; i < 4; i++) await d.page.keyboard.press("Backspace");
        await d.page.keyboard.type("1823", { delay: 160 });
        await d.page.keyboard.press("Enter");
        // Enter moves on to the place, whose suggestions must not stay open.
        await d.wait(400);
        await d.page.keyboard.press("Escape");
        await d.wait(700);
      },
    },
    {
      say: {
        sl: "Ko datoteko spremenite, pregled zaženete znova. Vse tri težave so izginile.",
        en: "Once the file has changed, you run the check again. All three issues are gone.",
      },
      run: async (d) => {
        await d.highlight(null);
        await backAndRerun(d);
        await d.highlight(d.page.locator(".tools-chips").first(), 6);
      },
    },
    {
      callout: { sl: "Popravek z enim klikom", en: "One-click fixes" },
      say: {
        sl: "Nekaterih napak v Urejanju sploh ne vidite: povezave na družino, ki je ni več, otroka, ki je v družini naveden dvakrat, in para, zapisanega v dveh družinah. Te popravite kar tukaj, z gumbom v vrstici.",
        en: "Some errors you cannot even see in Edit: a link to a family that no longer exists, a child listed twice in one family, and a couple recorded in two families. You fix these right here, with the button on the row.",
      },
      run: async (d) => {
        await openChip(d, { sl: "Pokvarjene povezave", en: "Broken links" });
        await fixRow(d, "Ernestina");
        await openChip(d, { sl: "Podvojeni kazalci", en: "Duplicate pointers" });
        await fixRow(d, "F36128");
        await openChip(d, { sl: "Isti par dvakrat", en: "Same couple twice" });
        await fixRow(d, "Šimen");
        // The next step's people are on screen before its narration names them.
        await d.untilSaid();
        await d.calloutAhead();
        await openChip(d, { sl: "Spol proti vlogi", en: "Sex vs. role" });
      },
    },
    {
      callout: { sl: "Spol in vloga", en: "Sex and role" },
      say: {
        sl: "Simon Muhovec je zapisan kot žena, Marija Legat pa kot mož. Program ju vrne v pravi vlogi.",
        en: "Simon Muhovec is recorded as the wife and Marija Legat as the husband. The program puts them back in their roles.",
      },
      run: async (d) => {
        await fixRow(d, "Simon Muhovec");
        await d.untilSaid();
        await openChip(d, { sl: "Brez spola", en: "No sex" });
      },
    },
    {
      say: {
        sl: "Ana Jelovšek nima spola, a je zapisana kot žena, zato ji ga program določi iz te vloge.",
        en: "Ana Jelovšek has no sex recorded, but she is listed as a wife, so the program takes it from that role.",
      },
      run: async (d) => {
        await fixRow(d, "Ana Jelovšek");
        await d.untilSaid();
        await d.calloutAhead();
        await openChip(d, { sl: "Nepovezane osebe", en: "Disconnected people" });
      },
    },
    {
      callout: { sl: "Nepovezane osebe", en: "Disconnected people" },
      say: {
        sl: "Prešernova hči, ki je umrla kot dojenček, ni povezana z nikomer. Osebo, ki v datoteko ne sodi, odstranite z gumbom »Odstrani osebo«. Ta pa je le pozabljena povezava, zato ji v Urejanju dodamo očeta in mater, ki sta že v datoteki: Franceta Prešerna in Ano Jelovšek.",
        en: "Prešeren's daughter, who died as a baby, is linked to nobody. A person who does not belong in the file you remove with the Remove person button. She, though, is just a forgotten link, so in Edit we add her father and mother, who are already in the file: France Prešeren and Ana Jelovšek.",
      },
      run: async (d) => {
        const terezija = row(d, "Terezija");
        await d.highlight(terezija, 4);
        await d.wait(3800);
        // The row's own remove button, named but not used.
        await d.highlight(terezija.locator(".tools-issue-iconfix").first(), 4);
        await d.wait(3200);
        await d.highlight(null);
        await d.click(terezija.locator(".tools-issue-link").first());
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(900);
        await d.highlight(d.page.locator(".edit-parents").first(), 6);
        await d.wait(900);
        await d.highlight(null);
        await pickParent(d, { sl: "Dodaj očeta", en: "Add Father" }, "France", "France Prešeren");
        await pickParent(d, { sl: "Dodaj mater", en: "Add Mother" }, "Ana", "Ana Jelovšek");
        await d.highlight(d.page.locator(".edit-parents").first(), 6);
        await d.wait(1200);
        await d.highlight(null);
        await backAndRerun(d);
        await d.untilSaid();
        await d.calloutAhead();
        await openChip(d, { sl: "Nepovezane veje", en: "Detached branches" });
      },
    },
    {
      callout: { sl: "Nepovezane veje", en: "Detached branches" },
      say: {
        sl: "Nepovezana veja je skupina oseb, povezanih le med sabo. Tu je Svetinova družina zapisana še enkrat, kot ostanek uvoza, ki ni bil nikoli pripet. Vejo lahko prenesete kot datoteko GEDCOM ali jo odstranite. Pred odstranitvijo program pove, kaj vse se izbriše.",
        en: "A detached branch is a group of people linked only to each other. Here the Svetina family is written a second time, left over from an import that was never attached. You can download the branch as a GEDCOM file or remove it. Before removing it, the program tells you everything that goes.",
      },
      run: async (d) => {
        const branch = row(d, "Mina Svetina");
        await d.highlight(branch, 4);
        await d.wait(5500);
        await d.highlight(branch.locator(".tools-issue-icon").first(), 4);
        await d.wait(2500);
        const remove = branch.locator(".tools-issue-iconfix").first();
        await d.highlight(remove, 4);
        await d.wait(1500);
        await d.highlight(null);
        await d.click(remove);
        const dialog = d.page.locator(".confirm-dialog");
        await dialog.waitFor();
        await d.highlight(dialog, 4);
        await d.untilSaid(1);
        await d.highlight(null);
        await d.click(dialog.locator(".confirm-dialog-confirm"));
        await dialog.waitFor({ state: "detached" });
        await d.wait(1500);
      },
    },
    {
      callout: { sl: "Ocena rojstva", en: "Estimated birth" },
      say: {
        sl: "Manjkajoče datume program oceni iz sorodnikov, enako kot paketno opravilo. Marija, žena Matije Prešerna, nima zapisanega ne rojstva ne smrti. Njen mož je rojen okoli leta 1665, zato ji program pripiše rojstvo okoli leta 1670.",
        en: "The program estimates missing dates from the relatives, the same way the batch action does. Marija, Matija Prešeren's wife, has neither a birth nor a death recorded. Her husband was born about 1665, so the program gives her a birth of about 1670.",
      },
      run: async (d) => {
        await openChip(d, { sl: "Brez ključnih datumov", en: "No vital dates" });
        // With married surnames shown she reads "Marija Prešeren", like Matija's
        // sister: the only row in this filter.
        await d.click(d.page.locator(".tools-issues .tools-issue").first().locator(".tools-issue-link").first());
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(800);
        await d.highlight(d.page.locator(".edit-person").first(), 6);
        await d.wait(4000);
        await d.highlight(null);
        await backToTools(d);
        await fixRow(d, "Marija");
        await showInEdit(d, ".edit-person");
        await backToTools(d);
        await d.untilSaid();
        await d.calloutAhead();
        await openChip(d, { sl: "Poroka brez datuma", en: "Undated marriage" });
      },
    },
    {
      callout: { sl: "Ocena poroke", en: "Estimated marriage" },
      say: {
        sl: "Poroka Jerneja in Mine Prešeren je zapisana brez datuma. Program ji pripiše datum pred rojstvom njunega prvega otroka, Šimna.",
        en: "Jernej and Mina Prešeren's marriage is recorded without a date. The program gives it a date before the birth of their first child, Šimen.",
      },
      run: async (d) => {
        // The date is written as the narration says what it will be.
        await fixRow(d, "Jernej", 2);
      },
    },
    {
      callout: { sl: "Živi nad 99 let", en: "Living over 99" },
      say: {
        sl: "Kdor bi bil danes star več kot 99 let, je skoraj gotovo umrl, le zapisa o smrti ni. Med njimi je zdaj tudi Marija: z ocenjenim rojstvom je popravek odkril novo težavo. Z gumboma »Izberi vse popravljive« in »Popravi izbrane« vsem v enem koraku dodate smrt brez datuma in kraja.",
        en: "Anyone who would be over 99 today has almost certainly died; only the death record is missing. Marija is among them now: her estimated birth has brought up a new issue. With Select all fixable and Fix selected, you give them all a death without a date or place in one step.",
      },
      run: async (d) => {
        await openChip(d, { sl: "Živi nad 99 let", en: "Living over 99" });
        // Her estimated birth year sets her apart from Matija's sister Marija.
        await d.highlight(row(d, "1670"), 4);
        await d.wait(3000);
        await d.highlight(null);
        await fixShown(d);
      },
    },
    {
      callout: { sl: "Datumi in sklici", en: "Dates and references" },
      say: {
        sl: "Datum, zapisan kot »1. 3. 1698«, program prepiše v obliko GEDCOM. Navedba vira, ki ga v datoteki ni, pa se odstrani.",
        en: "A date written as 1. 3. 1698 is rewritten in the GEDCOM form. A citation of a source that is not in the file is removed.",
      },
      run: async (d) => {
        await openChip(d, { sl: "Neberljivi datumi", en: "Unparseable dates" });
        await d.highlight(d.page.locator(".tools-issues .tools-issue").first(), 4);
        await d.wait(2500);
        await openChip(d, { sl: "Neobstoječi sklici", en: "Dangling references" });
        await d.highlight(d.page.locator(".tools-issues .tools-issue").first(), 4);
        await d.wait(1500);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Vse naenkrat", en: "All at once" },
      say: {
        sl: "Vse popravljive težave pa lahko popravite tudi naenkrat: »Popravljivo«, »Izberi vse popravljive« in »Popravi izbrane«. Pred tem vidite seznam popravkov s številom.",
        en: "You can also fix all the fixable issues at once: Fixable, Select all fixable, and Fix selected. Before that you see the list of fixes with their counts.",
      },
      run: async (d) => {
        await fixAll(d);
      },
    },
    {
      callout: { sl: "Skladnost z GEDCOM", en: "GEDCOM conformance" },
      say: {
        sl: "Drugi zavihek preveri, ali je datoteka zapisana po standardu. Datum »~1665« je navada drugega programa, standard pa ga zapiše kot »ABT 1665«. Tudi te popravite naenkrat.",
        en: "The second tab checks whether the file is written to the standard. A date like ~1665 is another program's habit; the standard writes it as ABT 1665. These you also fix at once.",
      },
      run: async (d) => {
        await d.click(groupTab(d, 1));
        await d.page.locator(".tools-chips").first().waitFor();
        await d.wait(600);
        await openChip(d, { sl: "Nestandardni datumi", en: "Non-standard dates" });
        await fixAll(d);
      },
    },
    {
      callout: { sl: "Počiščeno", en: "All clean" },
      say: {
        sl: "Nazaj pri težavah v podatkih ni ostalo nič. Drevo je počiščeno.",
        en: "Back in the data issues, nothing is left. The tree is clean.",
      },
      run: async (d) => {
        await d.click(groupTab(d, 0));
        await d.wait(900);
        await d.highlight(d.page.locator(".tools-clean").first(), 6);
        await d.wait(1500);
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
