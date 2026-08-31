import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/** A baptism to name a godparent at, and somebody to name. */
function writeFixture(): string {
  const ged = [
    "0 HEAD",
    "1 GEDC",
    "2 VERS 7.0",
    "1 CHAR UTF-8",
    "0 @I1@ INDI",
    "1 NAME Janez /Renko/",
    "1 SEX M",
    "1 BIRT",
    "2 DATE 31 AUG 1958",
    "1 BAPM",
    "2 DATE 31 AUG 1958",
    "0 @I2@ INDI",
    "1 NAME Jozefa /Pezdirc/",
    "1 SEX F",
    "1 BIRT",
    "2 DATE 1900",
    "0 TRLR",
    "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `event-assoc-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

test("edit mode: an event's + Add menu records a godparent on that event", async ({ page }) => {
  const fixture = writeFixture();
  await page.goto("/");

  await page.locator("input.file-input").first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // The baptism row's own "+ Add" menu.
  const bapm = page.locator(".edit-event").filter({ hasText: "Baptism" }).first();
  await bapm.locator(".edit-event-addfield").click();
  await page.getByRole("option", { name: "Association" }).click();

  // The person picker opens on that row — this is what did nothing before.
  const picker = bapm.locator(".relative-picker-input");
  await expect(picker).toBeVisible();

  await picker.fill("Jozefa");
  await bapm.getByRole("button", { name: /Jozefa/ }).first().click();

  // Then the role, defaulting to godparent.
  await bapm.getByRole("button", { name: "Save" }).click();

  // The associate now sits on the baptism row.
  await expect(bapm.locator(".edit-event-assoc")).toHaveCount(1);
  await expect(bapm.locator(".edit-event-assoc")).toContainText("Jozefa");
});

test("the association row keeps to itself and to the row's scale", async ({ page }) => {
  const fixture = writeFixture();
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const bapm = page.locator(".edit-event").filter({ hasText: "Baptism" }).first();
  await bapm.locator(".edit-event-addfield").click();
  await page.locator(".dd-menu [role=option]", { hasText: "Association" }).click();
  await bapm.locator(".relative-picker-input").fill("Jozefa");
  await bapm.getByRole("button", { name: /Jozefa/ }).first().click();

  // The role form is on screen with the person it is about.
  const form = bapm.locator(".edit-assoc-roleform");
  await expect(form).toBeVisible();
  await expect(form).toContainText("Jozefa");

  // It stays inside the event row rather than running across the note beside it.
  const overflow = await bapm.evaluate((row) => {
    const slot = row.querySelector<HTMLElement>('[data-detail="assoc"]');
    const note = row.querySelector<HTMLElement>('[data-detail="note"]');
    if (!slot) return { missing: true, over: 0, notes: 0 };
    const s = slot.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const n = note?.getBoundingClientRect();
    return {
      missing: false,
      // How far the slot spills past its row.
      over: Math.max(0, Math.round(s.right - r.right)),
      // Horizontal overlap with the note slot, if the note shares its line.
      notes: n && s.top < n.bottom && n.top < s.bottom ? Math.max(0, Math.round(Math.min(s.right, n.right) - Math.max(s.left, n.left))) : 0,
    };
  });
  expect(overflow.missing).toBe(false);
  expect(overflow.over).toBe(0);
  expect(overflow.notes).toBe(0);

  // The form's own buttons are words, not glyphs: clamped like the hover-only
  // ✎ and ✕ they were cut to 1.4em and printed on top of each other.
  const buttons = await form.evaluate((el) => {
    const [save, cancel] = [...el.querySelectorAll<HTMLElement>(".edit-assoc-action")];
    if (!save || !cancel) return { found: false, overlap: 0, clipped: true };
    const a = save.getBoundingClientRect();
    const b = cancel.getBoundingClientRect();
    return {
      found: true,
      overlap: Math.max(0, Math.round(Math.min(a.right, b.right) - Math.max(a.left, b.left))),
      // A word narrower than its own text is a clamped one.
      clipped: save.scrollWidth > Math.ceil(a.width) + 1,
    };
  });
  expect(buttons.found).toBe(true);
  expect(buttons.overlap).toBe(0);
  expect(buttons.clipped).toBe(false);
});

/** How a picker row reads: the name's size and leading, and the row's height.
 *  Runs in the page, so it is passed to `evaluate` as source, not captured. */
const METRICS = (nameEl: Element) => {
  const s = getComputedStyle(nameEl);
  const row = nameEl.closest(".relative-picker-option")!;
  const label = nameEl.closest(".person-label") as HTMLElement | null;
  return {
    font: s.fontSize,
    weight: s.fontWeight,
    // The row's height is where the Edit panel's heading style showed up: it
    // carries a 12px bottom margin, which made every option 42px here against
    // the relatives column's 30px.
    rowHeight: `${Math.round(row.getBoundingClientRect().height)}px`,
    labelMargin: label ? getComputedStyle(label).marginBottom : "—",
  };
};

test("the person picker is the same size wherever it is opened", async ({ page }) => {
  const fixture = writeFixture();
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // The partner picker, which is the size to match.
  await page.getByRole("button", { name: /Add Partner/i }).first().click();
  // A person row, not the "+ add new" row above it — that one carries no name
  // and so says nothing about the size the names are drawn at.
  const partnerOpt = page.locator(".relative-picker-option .person-name").first();
  await expect(partnerOpt).toBeVisible();
  const partnerSize = await partnerOpt.evaluate(METRICS);
  await page.keyboard.press("Escape");

  const birth = page.locator(".edit-event").filter({ hasText: "Birth" }).first();
  await birth.locator(".edit-event-addfield").click();
  await page.locator(".dd-menu [role=option]", { hasText: "Association" }).click();
  const assocOpt = birth.locator(".relative-picker-option .person-name").first();
  await expect(assocOpt).toBeVisible();
  const assocSize = await assocOpt.evaluate(METRICS);

  // It is the same control, and it must read the same wherever it is opened —
  // the size of the names, the line spacing, and the height of a row.
  expect(assocSize).toEqual(partnerSize);
});

test("the picker survives the mousedown that opened it", async ({ page }) => {
  // The "+ Add" menu selects on mousedown, and that same mousedown was still
  // travelling to the document when the picker registered its outside-click
  // dismissal — so the picker opened and closed within one event and the row
  // looked inert. It must still be there a moment later.
  const fixture = writeFixture();
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const birth = page.locator(".edit-event").filter({ hasText: "Birth" }).first();
  await birth.locator(".edit-event-addfield").click();
  await page.locator(".dd-menu [role=option]", { hasText: "Association" }).click();
  await expect(birth.locator(".relative-picker-input")).toBeVisible();
  await expect(birth.locator(".relative-picker-input")).toBeVisible(); // still there a tick later
});

test("an event added this session is named with its date in the move menu", async ({ page }) => {
  // A record-level association — what a 5.5.1 file writes — is the only place
  // the "move to an event" menu appears.
  const ged = [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Janez /Renko/", "1 SEX M",
    "1 BIRT", "2 DATE 1974",
    "1 ASSO @I2@", "2 TYPE INDI", "2 RELA teacher",
    "0 @I2@ INDI", "1 NAME Marjana /Sajovic/", "1 SEX F",
    "0 TRLR", "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `assoc-move-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(filePath);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  await page.getByRole("button", { name: "+ Add Event" }).click();
  await page.getByRole("option", { name: "Education", exact: true }).click();
  const educ = page.locator(".edit-event").filter({ hasText: "Education" }).first();

  // Every event leads with its date, this one included, and a freshly added
  // event opens with the caret in it.
  const date = educ.locator("input.edit-event-date").first();
  await date.fill("1980");
  await date.blur();
  await expect(date).toHaveValue("1980");

  // The ↧ is revealed by hovering its row, like the ✎ and ✕ beside it.
  const assocRow = page.locator(".edit-assoc .edit-assoc-row").first();
  await assocRow.hover();
  await assocRow.getByRole("button", { name: "Move to an event" }).click();
  const items = await page.locator(".dd-menu [role=option]").allInnerTexts();
  expect(items).toContain("Education 1980");
});
