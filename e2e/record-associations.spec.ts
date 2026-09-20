import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/**
 * A couple with a marriage and a spare person to name, in whichever dialect the
 * test is about. Where an association may be written is the dialect's decision:
 * 7.0 has `ASSO` under a person, under a family and under any event; 5.5.1 has it
 * on a person and nowhere else.
 */
function writeFixture(version: "5.5.1" | "7.0"): string {
  const ged = [
    "0 HEAD", "1 GEDC", `2 VERS ${version}`, "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Janez /Renko/", "1 SEX M",
    "1 BAPM", "2 DATE 31 AUG 1958",
    "1 FAMS @F1@",
    "0 @I2@ INDI", "1 NAME Marjana /Sajovic/", "1 SEX F", "1 FAMS @F1@",
    "0 @I3@ INDI", "1 NAME Jozefa /Pezdirc/", "1 SEX F",
    "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@", "1 MARR", "2 DATE 12 MAY 1980",
    "0 TRLR", "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `record-assoc-${version}-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

async function openEdit(page: import("@playwright/test").Page, version: "5.5.1" | "7.0") {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture(version));
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
}

/** Name an associate through a record's "+ Add associate", role, note and all. */
async function addAssociate(panel: import("@playwright/test").Locator, name: string, note?: string) {
  await panel.getByRole("button", { name: "+ Add associate" }).click();
  const picker = panel.locator(".relative-picker-input");
  await expect(picker).toBeVisible();
  await picker.fill(name);
  await panel.getByRole("button", { name: new RegExp(name) }).first().click();
  if (note !== undefined) await panel.getByLabel("Note about this association").fill(note);
  await panel.getByRole("button", { name: "Save" }).click();
}

test("a person's own record takes an associate, in either dialect", async ({ page }) => {
  await openEdit(page, "5.5.1");

  const panel = page.locator(".edit-person .edit-assoc");
  await addAssociate(panel, "Jozefa");

  await expect(panel.locator(".edit-event-assoc")).toHaveCount(1);
  await expect(panel.locator(".edit-event-assoc")).toContainText("Jozefa");
});

test("the note is written while the associate is being named", async ({ page }) => {
  // `ASSO` carries `NOTE` in both dialects, so what the register said — or the
  // centimorgans behind a DNA match — belongs on the association itself rather
  // than on the person as a whole. And it is asked for in the same breath as
  // the role, not on a second trip through the row.
  await openEdit(page, "7.0");

  const panel = page.locator(".edit-person .edit-assoc");
  await addAssociate(panel, "Jozefa", "78 cM over 4 segments");

  // It sits with the associate, not among the person's own notes.
  await expect(panel.locator(".edit-note-item")).toHaveCount(1);
  await expect(panel.locator(".edit-event-assoc")).toContainText("78 cM over 4 segments");

  // And afterwards it is edited where it stands, like an event's own note —
  // there is no second form to open.
  const chip = panel.locator(".edit-event-note").first();
  await chip.click();
  await chip.fill("78 cM over 4 segments · MyHeritage");
  await chip.blur();
  await expect(panel.locator(".edit-event-assoc")).toContainText("MyHeritage");
});

test("the role is a field, and its menu carries what typing cannot do", async ({ page }) => {
  // The event rows' way: the value is the field, edited where it stands. The
  // vocabulary and the actions hang off the caret beside it.
  await openEdit(page, "7.0");

  const panel = page.locator(".edit-person .edit-assoc");
  await addAssociate(panel, "Jozefa");

  // Typed over, the file keeps the words — no dialog, no edit button.
  // The exact word the language has for a woman in that role, not the neutral one.
  const role = panel.locator(".edit-assoc-role-field").first();
  await expect(role).toHaveValue("godmother");
  await role.fill("DNA match");
  await role.blur();
  await expect(role).toHaveValue("DNA match");

  // The vocabulary is in the menu, and picking from it replaces the wording
  // rather than leaving the association with two answers.
  await panel.locator(".edit-event-assoc").first().hover();
  await panel.locator(".edit-assoc-role-menu").first().click();
  await page.locator(".dd-menu [role=option]", { hasText: "witness" }).first().click();
  await expect(role).toHaveValue("witness");
});

test("a long note drops under its associate, a short one reads on after the role", async ({ page }) => {
  // The event rows' rule, applied to an associate: a record naming several
  // people, each with a sentence about them, is a list — and inline, one
  // sentence claimed the line and left the name a column a character wide.
  await openEdit(page, "7.0");

  const panel = page.locator(".edit-person .edit-assoc");
  await addAssociate(panel, "Jozefa", "godmother of the eldest");
  await addAssociate(
    panel,
    "Marjana",
    "FTDNA 50,7 cM · GEDmatch 48,6 cM · MyHeritage 46,0 cM — Luka Porenta (1819–1883, Spodnje Bitnje)",
  );

  const rows = panel.locator(".edit-event-assoc");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).not.toHaveClass(/edit-event-assoc--tall/);
  await expect(rows.nth(1)).toHaveClass(/edit-event-assoc--tall/);

  // The long one's note sits below the name rather than beside it, and the
  // name keeps its own width either way.
  const name = await rows.nth(1).locator(".person-name").boundingBox();
  const note = await rows.nth(1).locator(".edit-note-item").boundingBox();
  expect(note!.y).toBeGreaterThan(name!.y + name!.height - 1);
  expect(name!.width).toBeGreaterThan(40);
});

test("naming an associate takes a line of its own", async ({ page }) => {
  // The picker, the role, the wording and the note are more than fits beside a
  // heading and the associates already named.
  await openEdit(page, "7.0");

  const panel = page.locator(".edit-person .edit-assoc");
  await expect(panel.locator(".edit-record-label")).toHaveCount(0); // nothing to name yet
  await panel.getByRole("button", { name: "+ Add associate" }).click();

  // The heading is there to say which slot the picker is filling — it is the
  // same control the parent and partner slots use.
  await expect(panel.locator(".edit-record-label")).toHaveText("Associations");
  const label = await panel.locator(".edit-record-label").boundingBox();
  const picker = await panel.locator(".relative-picker").boundingBox();
  expect(picker!.y).toBeGreaterThan(label!.y + label!.height - 1);
});

test("a 5.5.x file offers no association on an event or on a family", async ({ page }) => {
  await openEdit(page, "5.5.1");

  // 5.5.1 defines ASSO only under INDI, so the baptism row's "+ Add" menu lists
  // everything else and not this.
  const bapm = page.locator(".edit-event").filter({ hasText: "Baptism" }).first();
  await bapm.locator(".edit-event-addfield").click();
  const items = page.locator(".dd-menu [role=option]");
  await expect(items.first()).toBeVisible();
  await expect(items.filter({ hasText: "Association" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Nor does the family panel, which in this dialect has nowhere to put one.
  await expect(page.locator(".edit-family .edit-assoc")).toHaveCount(0);
  // The person's own record still does.
  await expect(page.locator(".edit-person .edit-assoc").getByRole("button", { name: "+ Add associate" })).toBeVisible();
});

test("a 7.0 family record takes its own witnesses", async ({ page }) => {
  await openEdit(page, "7.0");

  const family = page.locator(".edit-family").filter({ has: page.locator(".edit-assoc") }).first();
  const panel = family.locator(".edit-assoc");
  await expect(panel.getByRole("button", { name: "+ Add associate" })).toBeVisible();

  await addAssociate(panel, "Jozefa");

  await expect(panel.locator(".edit-event-assoc")).toHaveCount(1);
  await expect(panel.locator(".edit-event-assoc")).toContainText("Jozefa");

  // The other side of it: the witness's own record says where she is named, and
  // a family reads as its couple rather than as an @F1@ nobody recognises.
  await panel.locator(".edit-event-assoc").getByRole("button", { name: /Jozefa/ }).first().click();
  const namedBy = page.locator(".edit-person .edit-assoc");
  await expect(namedBy).toContainText("Janez");
  await expect(namedBy).toContainText("Marjana");
});
