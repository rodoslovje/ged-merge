/**
 * Video 18 (SCENARIJI.md): the first twelve keyboard shortcuts — four general,
 * four for moving around the family, four for editing — written on an index
 * card that fills in as the video goes, with the reason behind each key.
 *
 * The whole episode is driven from the keyboard: there is no pointer, and each
 * key pressed is drawn as keycaps (`d.press`).
 *
 * Data: France Prešeren's pedigree from Peter Hawlina's tree (videos/demo/).
 * Everything typed in is real, from Hawlina's full tree in the Slovenian
 * genealogical index: Šimen's daughter Mina (b. 22 Jan 1808, Vrba; d. 17 Apr
 * 1878) and son Jurij (b. 29 Mar 1805, Vrba).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import { seriesSettings } from "../lib/series.ts";
import type { Scenario, Text } from "../lib/types.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "preseren-hawlina.ged");

const type = (d: Director, text: string) => d.page.keyboard.type(text, { delay: 140 });
/** The index card: three groups of four rows, [keys, what they do]. */
const SHEET: { title: Text; groups: { name: Text; rows: [string, Text][] }[] } = {
  title: { sl: "GED Merge · prvih dvanajst bližnjic", en: "GED Merge · your first twelve shortcuts" },
  groups: [
    {
      name: { sl: "Splošno", en: "General" },
      rows: [
        ["?", { sl: "seznam vseh bližnjic", en: "the list of all shortcuts" }],
        ["/", { sl: "poišči osebo", en: "find a person" }],
        ["Ctrl+Z", { sl: "razveljavi", en: "undo" }],
        ["Ctrl+S", { sl: "shrani", en: "save" }],
      ],
    },
    {
      name: { sl: "Navigacija", en: "Moving around" },
      rows: [
        ["Alt+↑ ↓ ← →", { sl: "oče · otrok · brat ali sestra", en: "father · child · brother or sister" }],
        ["Alt+Shift+↑ →", { sl: "»tisti drugi«: mati · partner", en: "“the other one”: mother · partner" }],
        ["⌫ H", { sl: "nazaj · domov, k izhodiščni osebi", en: "back · home, to the start person" }],
        ["E M T V", { sl: "Urejanje · Združevanje · Orodja · diagram", en: "Edit · Merge · Tools · chart" }],
      ],
    },
    {
      name: { sl: "Urejanje", en: "Editing" },
      rows: [
        ["N", { sl: "nova oseba", en: "new person" }],
        ["Alt+Shift+F M P C", { sl: "dodaj očeta · mater · partnerja · otroka", en: "add father · mother · partner · child" }],
        ["Alt+Shift+1 2 3 4 5", { sl: "rojstvo · prebivališče · poklic · smrt · pokop", en: "birth · residence · occupation · death · burial" }],
        ["Enter Esc", { sl: "naslednje polje · ven iz polja", en: "next field · leave the field" }],
      ],
    },
  ],
};

/** Show the index card with its first `shown` groups filled in; `null` hides it. */
async function sheet(d: Director, shown: number | null): Promise<void> {
  if (shown === null) return d.overlay("sheet", null, [], 0);
  await d.overlay(
    "sheet",
    d.t(SHEET.title),
    SHEET.groups.map((g) => ({ name: d.t(g.name), rows: g.rows.map(([k, label]): [string, string] => [k, d.t(label)]) })),
    shown,
  );
}

/** Alt+Shift+C at the open parent → type the name → Enter adds the new child and opens it. */
async function addChild(d: Director, name: string): Promise<void> {
  await d.press("Alt+Shift+C", 1200);
  await d.releaseKeys();
  await type(d, name);
  await d.wait(900);
  await d.press("Enter", 600);
  await d.page.locator(".edit-person .edit-event-date").first().waitFor();
}

/** Type the birth date and place of the person just added; Enter walks the fields. */
async function birth(d: Director, date: string): Promise<void> {
  await d.releaseKeys();
  await type(d, date);
  await d.wait(600);
  await d.press("Enter", 500);
  await d.releaseKeys();
  await type(d, "Vrb");
  await d.wait(900);
  await d.press("ArrowDown", 500);
  await d.press("Enter", 700);
  await d.press("Enter", 700);
}

const scenario: Scenario = {
  id: "shortcuts",
  episode: 18,
  title: {
    sl: "GED Merge: prvih dvanajst bližnjic na tipkovnici",
    en: "GED Merge: your first twelve keyboard shortcuts",
  },
  description: {
    sl: "GED Merge lahko v celoti uporabljate s tipkovnico. Za začetek zadostuje dvanajst bližnjic: štiri splošne, štiri za premikanje po družini in štiri za urejanje. Video pove tudi, zakaj je izbrana prav ta tipka, da si jo laže zapomnite. Zapišite si jih na kartonček in en teden delajte brez miške. Primer: rodovnik Franceta Prešerna, ki mu dodamo sestro Mino in brata Jurija.\n\nNa računalnikih Mac je Ctrl tipka ⌘, Alt pa tipka ⌥.",
    en: "GED Merge can be used entirely from the keyboard. Twelve shortcuts are enough to start with: four general ones, four for moving around the family and four for editing. The video also tells you why each key was chosen, so it is easier to remember. Write them on an index card and work without the mouse for a week. Example: France Prešeren's pedigree, to which we add his sister Mina and his brother Jurij.\n\nOn a Mac, Ctrl is the ⌘ key and Alt is the ⌥ key.",
  },
  thumbnail: {
    tag: { sl: "Tipkovnica", en: "Keyboard" },
    title: { sl: "Prvih *dvanajst* bližnjic", en: "Your first *twelve* shortcuts" },
  },
  settings: seriesSettings,
  steps: [
    {
      say: {
        sl: "GED Merge lahko v celoti uporabljate s tipkovnico. Bližnjic je veliko, za začetek pa jih potrebujete samo dvanajst.",
        en: "GED Merge can be used entirely from the keyboard. There are many shortcuts, but to start with you need only twelve.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Prvih dvanajst bližnjic", en: "Your first twelve shortcuts" },
          { sl: "S tipkovnico gre hitreje", en: "The keyboard is faster" },
        );
      },
    },
    {
      say: {
        sl: "Vzemite kartonček in pisalo. Zapisali bomo tri skupine po štiri bližnjice: splošne, navigacijo in urejanje. Kartonček postavite ob tipkovnico in en teden delajte brez miške.",
        en: "Take an index card and a pen. We will write down three groups of four shortcuts: general ones, moving around, and editing. Stand the card next to your keyboard and work without the mouse for a week.",
      },
      run: async (d) => {
        await sheet(d, 0);
        await d.wait(600);
        await d.card(null, null);
        // Behind the card: open the file, so the app is ready when the card lifts.
        await d.page.locator(".lb-drop input[type=file]").setInputFiles(MAIN);
        await d.page.locator(".edit-person").first().waitFor();
      },
    },
    {
      say: {
        sl: "Najprej pravilo. Bližnjice s tipko Ctrl so enake kot v drugih programih. Posebnosti programa GED Merge so ena sama črka, največkrat začetnica dejanja.",
        en: "First, the rule. Shortcuts with the Ctrl key are the same as in other programs. The ones special to GED Merge are a single letter, usually the initial of the action.",
      },
      run: async (d) => {
        await d.overlay("keys", "Ctrl+S", 0);
        await d.wait(5000);
        await d.overlay("keys", "N", 0);
      },
    },
    {
      callout: { sl: "Splošno", en: "General" },
      say: {
        sl: "Prva je vprašaj: kadar ne veste naprej, vprašate. Odpre se seznam vseh bližnjic, na vrhu so tiste, ki veljajo tam, kjer ste. Tipka Escape seznam zapre.",
        en: "The first is the question mark: when you are stuck, you ask. It opens the list of all shortcuts, with the ones that work where you are at the top. The Escape key closes the list.",
      },
      run: async (d) => {
        await d.releaseKeys();
        await sheet(d, null);
        await d.wait(1500);
        await d.press("?", 600);
        await d.untilSaid(2.5);
        await d.press("Escape");
      },
    },
    {
      say: {
        sl: "Druga je poševnica, ki poišče katero koli osebo v datoteki. Vpišete začetek imena, brez strešic, in potrdite s tipko Enter.",
        en: "The second is the slash, which finds anyone in the file. Type the start of the name, without the accents, and confirm with Enter.",
      },
      run: async (d) => {
        await d.press("/", 1200);
        await d.releaseKeys();
        await type(d, "simen");
        await d.untilSaid(1.5);
        await d.press("Enter");
        await d.wait(800);
      },
    },
    {
      say: {
        sl: "Tretja in četrta sta stari znanki. Šimen je pomotoma postal ženska: Ctrl+Z razveljavi zadnjo spremembo. Ctrl+S pa shrani datoteko, enako kot gumb »Shrani GEDCOM«.",
        en: "The third and fourth are old friends. Šimen has become a woman by mistake: Ctrl+Z undoes the last change. And Ctrl+S saves the file, just like the Save GEDCOM button.",
      },
      run: async (d) => {
        await d.releaseKeys();
        // The mistake itself, made without showing its key (it is not one of the twelve).
        await d.wait(2600);
        await d.page.keyboard.press("Alt+Shift+X");
        await d.highlight(d.page.locator(".edit-person .sex-select").first(), 4);
        await d.wait(2400);
        await d.press("Control+z", 1800);
        await d.highlight(null);
        // Nothing is left to save after the undo, so the chord is only shown
        // beside its button here; the practice step saves for real.
        await d.untilSaid(4.5);
        await d.overlay("keys", "Ctrl+S", 0);
        await d.highlight(d.page.locator(".app-head-actions .export-btn"), 5);
        await d.untilSaid();
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Prva skupina je zapisana: vprašaj, poševnica, Ctrl+Z in Ctrl+S.",
        en: "The first group is written down: question mark, slash, Ctrl+Z and Ctrl+S.",
      },
      run: async (d) => {
        await d.releaseKeys();
        await sheet(d, 1);
        // Behind the card: home to France, for the walk through his family.
        await d.wait(700);
        await d.page.keyboard.press("h");
      },
    },
    {
      callout: { sl: "Navigacija", en: "Moving around" },
      say: {
        sl: "Navigacija sledi sliki na zaslonu. Starši so nad osebo, partnerji in otroci pod njo, bratje in sestre pa levo in desno.",
        en: "Moving around follows the picture on the screen. Parents are above the person, partners and children below, brothers and sisters to the left and right.",
      },
      run: async (d) => {
        await sheet(d, null);
        await d.wait(1200);
        await d.highlight(d.page.locator(".edit-parents").filter({ visible: true }).first(), 4);
        await d.wait(3200);
        const children = d.page.locator(".edit-children").filter({ visible: true }).first();
        await d.scrollTo(children);
        await d.highlight(children, 4);
        await d.wait(3200);
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Zato držite tipko Alt in pritisnete puščico. Gor odpre očeta, dol najstarejšega otroka, levo in desno pa brata ali sestro.",
        en: "So you hold Alt and press an arrow. Up opens the father, down the eldest child, left and right a brother or sister.",
      },
      run: async (d) => {
        await d.wait(2500);
        await d.press("Alt+ArrowUp", 1500);
        await d.press("Alt+ArrowDown", 1300);
        await d.press("Alt+ArrowDown", 1500);
        await d.press("Alt+ArrowRight", 1300);
        await d.press("Alt+ArrowRight", 1300);
        await d.press("Alt+ArrowLeft", 1000);
      },
    },
    {
      say: {
        sl: "Tipka Shift pomeni »tisti drugi«. Z njo puščica gor odpre mater namesto očeta, puščica desno pa partnerja namesto brata ali sestre.",
        en: "The Shift key means “the other one”. With it, the up arrow opens the mother instead of the father, and the right arrow a partner instead of a brother or sister.",
      },
      run: async (d) => {
        await d.wait(3000);
        await d.press("Alt+Shift+ArrowUp", 2800);
        await d.press("Alt+Shift+ArrowRight", 1500);
      },
    },
    {
      say: {
        sl: "Vračalka, tipka Backspace, vas vrne na prejšnjo osebo, kot gumb »Nazaj« v brskalniku. Črka H, kot Home, vas od koder koli pripelje domov, na izhodiščno osebo.",
        en: "Backspace takes you back to the previous person, like the browser's Back button. The letter H, for Home, brings you home from anywhere, to the start person.",
      },
      run: async (d) => {
        await d.wait(1500);
        await d.press("Backspace", 1500);
        await d.press("Backspace", 1500);
        await d.untilSaid(4);
        await d.press("h", 1500);
      },
    },
    {
      say: {
        sl: "Črka V odpre diagram osebe. Med načini dela preklapljate z začetnicami E, M in T. To so angleške besede Edit, Merge in Tools; M je isti Merge kot v imenu programa.",
        en: "The letter V opens the person's chart. You switch between the three modes with their initials: E for Edit, M for Merge, as in the program's name, and T for Tools.",
      },
      run: async (d) => {
        await d.press("v", 2600);
        await d.press("Escape", 1200);
        await d.press("m", 1800);
        await d.press("t", 1800);
        await d.press("e", 1200);
      },
    },
    {
      say: {
        sl: "Druga skupina je zapisana: Alt s puščicami, Shift za tistega drugega, vračalka in H ter črke E, M, T in V.",
        en: "The second group is written down: Alt with the arrows, Shift for the other one, Backspace and H, and the letters E, M, T and V.",
      },
      run: async (d) => {
        await d.releaseKeys();
        await sheet(d, 2);
        // Behind the card: to Šimen, whose children we add next.
        await d.wait(700);
        await d.page.keyboard.press("Alt+ArrowUp");
      },
    },
    {
      callout: { sl: "Urejanje", en: "Editing" },
      say: {
        sl: "Črka N, kot nova, doda novo osebo, ki še ni povezana z nikomer. Te zdaj ne potrebujemo, zato jo s tipko Escape in s Ctrl+Z odstranimo.",
        en: "The letter N, for new, adds a new person who is not yet linked to anyone. We do not need this one now, so Escape and Ctrl+Z take it away again.",
      },
      run: async (d) => {
        await sheet(d, null);
        await d.wait(1500);
        await d.press("n", 2200);
        await d.untilSaid(3.5);
        await d.press("Escape", 900);
        await d.press("Control+z", 1200);
      },
    },
    {
      say: {
        sl: "Med pisanjem v polje bi se črka zapisala kot besedilo. Zato imajo dejanja urejanja pred črko še Alt in Shift in delujejo tudi sredi pisanja.",
        en: "While you type in a field, a letter would simply be typed as text. So the editing actions have Alt and Shift before the letter, and work in the middle of typing too.",
      },
      run: async (d) => {
        await d.wait(3500);
        await d.overlay("keys", "Alt+Shift+C", 0);
      },
    },
    {
      say: {
        sl: "Štiri črke dodajo sorodnika: F očeta, M mater, P partnerja in C otroka. Črki F in C sta angleški, father in child. Laže si ju zapomnite kot »fotr« in »cicibán«.",
        en: "Four letters add a relative: F the father, M the mother, P a partner and C a child.",
      },
      run: async (d) => {
        await d.overlay("keys", "Alt+Shift+F M P C", 0);
        const children = d.page.locator(".edit-children").filter({ visible: true }).first();
        await d.scrollTo(children);
        await d.highlight(children, 4);
        await d.untilSaid();
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Šimnu dodajmo hčer Mino. Vpišete ime in potrdite, nato datum in kraj rojstva. Tipka Enter vsako polje shrani in skoči na naslednje, zato roke ostanejo na tipkovnici.",
        en: "Let's give Šimen his daughter Mina. Type the name and confirm, then the date and place of birth. Enter saves each field and jumps to the next, so your hands stay on the keyboard.",
      },
      run: async (d) => {
        await addChild(d, "Mina");
        await birth(d, "22. 1. 1808");
      },
    },
    {
      say: {
        sl: "Pod dogodki je vrsta gumbov za najpogostejše dogodke: rojstvo, prebivališče, poklic, smrt in pokop. Z Alt in Shift jih prikličete s številkami od 1 do 5, v istem vrstnem redu. Smrt je četrta, torej Alt+Shift+4.",
        en: "Below the events is a row of buttons for the most common ones: birth, residence, occupation, death and burial. With Alt and Shift you call them by the numbers 1 to 5, in the same order. Death is the fourth, so Alt+Shift+4.",
      },
      run: async (d) => {
        await d.releaseKeys();
        await d.highlight(d.page.locator(".edit-person .edit-event-add-row").first(), 4);
        await d.overlay("keys", "Alt+Shift+1 2 3 4 5", 0);
        await d.untilSaid(2.5);
        await d.highlight(null);
        await d.press("Alt+Shift+4", 1200);
        await d.releaseKeys();
        await type(d, "17. 4. 1878");
        await d.wait(800);
        await d.snapshot();
      },
    },
    {
      say: {
        sl: "Vse druge dogodke najdete v meniju, ki ga odpre Alt+Shift+E, kot »event«; po njem se premikate s puščicama. Escape vas vedno spusti ven: iz menija, iz polja ali iz okna.",
        en: "Every other event is in the menu that Alt+Shift+E opens, E for event; the arrow keys move through it. Escape always lets you out: of a menu, a field or a dialog.",
      },
      run: async (d) => {
        await d.press("Enter", 500);
        await d.press("Escape", 700);
        await d.press("Alt+Shift+E", 1500);
        await d.press("ArrowDown", 600);
        await d.press("ArrowDown", 600);
        await d.untilSaid(4);
        await d.press("Escape", 800);
      },
    },
    {
      say: {
        sl: "Tretja skupina je zapisana in kartonček je poln: N, Alt in Shift s črkami F, M, P in C ter s številkami od 1 do 5, pa še Enter in Escape.",
        en: "The third group is written down and the card is full: N, Alt and Shift with the letters F, M, P and C and with the numbers 1 to 5, plus Enter and Escape.",
      },
      run: async (d) => {
        await d.releaseKeys();
        await sheet(d, 3);
      },
    },
    {
      callout: { sl: "Vaja", en: "Practice" },
      say: {
        sl: "Zdaj še vaja, ki jo ponovite na svojem drevesu. Domov, k očetu, nov otrok: Prešernov brat Jurij, rojen 29. marca 1805 v Vrbi. Nazaj k očetu in shranimo. Miške se nismo dotaknili.",
        en: "Now an exercise to repeat on your own tree. Home, to the father, a new child: Prešeren's brother Jurij, born on 29 March 1805 in Vrba. Back to the father, and save. We never touched the mouse.",
      },
      run: async (d) => {
        await sheet(d, null);
        await d.wait(1200);
        await d.press("h", 1100);
        await d.press("Alt+ArrowUp", 1100);
        await addChild(d, "Jurij");
        await birth(d, "29. 3. 1805");
        await d.press("Alt+ArrowUp", 1500);
        await d.press("Control+s", 3500);
        await d.press("Escape", 500);
      },
    },
    {
      say: {
        sl: "Ko vam teh dvanajst steče, se naslednjih učite sproti. Celoten seznam odprete z vprašajem in ga z gumbom »Natisni« natisnete na en list. Vse bližnjice so opisane tudi v navodilih za uporabo.",
        en: "Once these twelve come naturally, pick up the next ones as you go. The question mark opens the whole list, and its Print button puts it on a single sheet. Every shortcut is also described in the User's Guide.",
      },
      run: async (d) => {
        await d.releaseKeys();
        await d.press("?", 2500);
        await d.releaseKeys();
        await d.highlight(d.page.locator(".shortcuts-print-btn").first(), 5);
        await d.untilSaid();
        await d.highlight(null);
        await d.page.keyboard.press("Escape");
      },
    },
    {
      callout: { sl: "Kartonček", en: "The card" },
      say: {
        sl: "Tukaj video ustavite in prepišite kartonček.",
        en: "Pause the video here and copy the card.",
      },
      run: async (d) => {
        await sheet(d, 3);
        await d.wait(8000);
      },
    },
    {
      callout: null,
      say: {
        sl: "GED Merge je vaš rodoslovni program v brskalniku. V njem urejate drevo, ga dopolnjujete iz drugih datotek ter rišete diagrame in zemljevide. Je brezplačen, ne potrebuje računa, najdete pa ga na naslovu gedmerge.com.",
        en: "GED Merge is your genealogy program in the browser. You edit your tree, complete it from other files, and draw charts and maps. It is free, needs no account, and you will find it at gedmerge.com.",
      },
      run: async (d) => {
        await d.card(
          { sl: "Brezplačno · brez računa · v brskalniku", en: "Free · no account · in your browser" },
          { sl: "GED Merge — vaš rodoslovni program", en: "GED Merge — your genealogy program" },
          { sl: "gedmerge.com", en: "gedmerge.com" },
        );
        await d.wait(600);
        await sheet(d, null);
      },
    },
  ],
};

export default scenario;
