import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

function writeFixture(): string {
  const ged = [
    "0 HEAD",
    "1 SOUR TEST",
    "1 SUBM @U1@",
    "1 GEDC",
    "2 VERS 5.5.1",
    "2 FORM LINEAGE-LINKED",
    "1 CHAR UTF-8",
    "0 @U1@ SUBM",
    "1 NAME Tester",
    "0 @I1@ INDI",
    "1 NAME Franc /Novak/",
    "1 SEX M",
    "1 BIRT",
    "2 DATE 1 JAN 1850",
    "1 DEAT",
    "2 DATE ABT 1910",
    "0 @I2@ INDI",
    "1 NAME Ana /Kos/",
    "1 SEX F",
    "0 TRLR",
    "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `research-notes-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

async function saveFile(page: Page): Promise<string> {
  await page.locator(".app-head-actions .export-btn").click();
  const downloadPromise = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  return readFileSync((await (await downloadPromise).path())!, "utf-8");
}

test("edit mode: research notes are added to a person and an event, settled, undone and saved", async ({ page }) => {
  const fixture = writeFixture();
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // A note about the person, from the chip among the card's "+ Add" actions.
  await page.getByRole("button", { name: "+ Research note" }).click();
  const dialog = page.getByRole("dialog", { name: "New research note" });
  await dialog.locator("textarea").fill("Where did the family come from?");
  await expect(dialog.locator(".research-target-name")).toHaveText("Franc Novak");
  await dialog.getByRole("button", { name: "Save" }).click();

  const chips = page.locator(".research-section .research-chip");
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toContainText("Where did the family come from?");

  // A note about one event, from that event's "+ Detail" menu.
  const death = page.locator(".edit-event", { hasText: "Death" });
  await death.locator(".edit-event-addfield").click();
  await page.locator(".dd-menu [role=option]", { hasText: "Research note" }).click();
  await expect(dialog.locator(".research-target-event")).toContainText("Death");
  await dialog.getByRole("tab", { name: /Task/ }).click();
  await dialog.locator("textarea").fill("Check the passenger lists");
  await dialog.locator(".add-source-url-wrap input").first().fill("https://example.org/lists");
  await dialog.getByRole("button", { name: "Save" }).click();

  // The event row carries the note's mark; the person's section lists both.
  await expect(death.locator(".research-ref")).toHaveCount(1);
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(1)).toContainText("Check the passenger lists");
  await expect(chips.nth(1).locator(".research-chip-where")).toHaveText("Death");

  // The mark opens the note; filing it under a second person too.
  await death.locator(".research-ref").click();
  const editing = page.getByRole("dialog", { name: "Research note", exact: true });
  await editing.getByRole("button", { name: "+ Add person" }).click();
  await editing.locator(".relative-picker-input").fill("ana");
  await editing.locator(".relative-picker-option", { hasText: "Ana Kos" }).click();
  await expect(editing.locator(".research-target")).toHaveCount(2);
  await editing.getByRole("button", { name: "Save" }).click();

  // Settling the first note folds it behind the count and off the open ones.
  // A click, not `check()`: the settled chip leaves the place it was ticked in.
  await chips.first().locator(".research-chip-check").click();
  await expect(page.locator(".research-section .research-chip:not(.is-done)")).toHaveCount(1);
  await expect(page.locator(".research-done-toggle")).toContainText("Done: 1");

  // One undo takes the settling back, as one step.
  await page.keyboard.press("Control+z");
  await expect(page.locator(".research-section .research-chip:not(.is-done)")).toHaveCount(2);
  await expect(page.locator(".research-done-toggle")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator(".research-done-toggle")).toContainText("Done: 1");

  const content = await saveFile(page);
  const lines = content.split(/\r?\n/);
  expect(lines).toContain("0 @RN1@ _RESEARCH");
  expect(content).toMatch(/0 @RN1@ _RESEARCH\r?\n1 TYPE QUESTION\r?\n1 STAT DONE\r?\n1 DATE \d+ [A-Z]{3} \d{4}\r?\n1 NOTE Where did the family come from\?/);
  expect(content).toMatch(/0 @RN2@ _RESEARCH\r?\n1 TYPE TASK\r?\n1 STAT OPEN\r?\n1 DATE \d+ [A-Z]{3} \d{4}\r?\n1 NOTE Check the passenger lists\r?\n1 WWW https:\/\/example.org\/lists/);
  // Filed where they were added: the person, the death, and the second person.
  expect(content).toMatch(/1 DEAT\r?\n2 DATE ABT 1910\r?\n2 _RESEARCH @RN2@/);
  expect(lines.filter((l) => l === "1 _RESEARCH @RN1@")).toHaveLength(1);
  expect(content).toMatch(/1 NAME Ana \/Kos\/\r?\n1 SEX F\r?\n1 _RESEARCH @RN2@/);
});

test("edit mode: deleting a research note takes it off everything it was filed under", async ({ page }) => {
  const fixture = writeFixture();
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  await page.getByRole("button", { name: "+ Research note" }).click();
  await page.getByRole("dialog").locator("textarea").fill("A passing thought");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  const chips = page.locator(".research-section .research-chip");
  await expect(chips).toHaveCount(1);

  await chips.first().locator(".research-chip-open").click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete note" }).click();
  await expect(page.locator(".research-section")).toHaveCount(0);
  // The card offers the first note again.
  await expect(page.getByRole("button", { name: "+ Research note" })).toBeVisible();

  // Undo brings the note and its filing back together.
  await page.keyboard.press("Control+z");
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toContainText("A passing thought");
});

test("a note written for later waits in the notebook, is filed from there, and stays out of an export", async ({ page }) => {
  const fixture = writeFixture();
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // The header's button, from anywhere: a note filed under nobody.
  await page.getByRole("button", { name: "Research note", exact: true }).click();
  const fresh = page.getByRole("dialog", { name: "New research note" });
  await expect(fresh.locator(".research-dialog-unfiled")).toBeVisible();
  await fresh.getByRole("tab", { name: /Find/ }).click();
  await fresh.locator("textarea").fill("Newspaper clipping about the Novak farm");
  await fresh.getByRole("button", { name: "Save" }).click();
  // Nothing on the person's card: it is not about them yet.
  await expect(page.locator(".research-section")).toHaveCount(0);

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.locator(".tools-tab", { hasText: "Notebook" }).click();
  const unfiled = page.locator(".tools-research-group", { hasText: "Not filed" });
  await expect(unfiled.locator(".research-row")).toHaveCount(1);
  await expect(unfiled.locator(".research-row")).toContainText("Newspaper clipping about the Novak farm");

  // Filed under Ana from the notebook: it moves to the filed group.
  await unfiled.locator(".research-row-open").click();
  const editing = page.getByRole("dialog", { name: "Research note", exact: true });
  await editing.getByRole("button", { name: "+ Add person" }).click();
  await editing.locator(".relative-picker-input").fill("ana");
  await editing.locator(".relative-picker-option", { hasText: "Ana Kos" }).click();
  await editing.getByRole("button", { name: "Save" }).click();
  await expect(unfiled).toHaveCount(0);
  const filed = page.locator(".tools-research-group", { hasText: "Filed under" });
  await expect(filed.locator(".research-row")).toContainText("Ana Kos");

  // Settled, it leaves the open list and shows under Done.
  await filed.locator(".research-chip-check").click();
  await expect(page.locator(".tools-research-empty")).toHaveText("No note matches.");
  await page.locator(".tools-research").getByRole("tab", { name: "Done" }).click();
  await expect(page.locator(".research-row.is-done")).toHaveCount(1);

  // The person's link opens them in Edit, where the settled note is listed.
  await page.locator(".research-row .person-ref").click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Ana");
  await expect(page.locator(".research-done-toggle")).toContainText("Done: 1");

  // Save writes the note; the privacy export leaves it out.
  const saved = await saveFile(page);
  expect(saved).toContain("0 @RN1@ _RESEARCH");
  expect(saved).toMatch(/1 SEX F\r?\n1 _RESEARCH @RN1@/);

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.locator(".tools-tab", { hasText: "Privacy" }).click();
  const dl = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.getByRole("button", { name: "Download redacted GEDCOM" }).click();
  const exported = readFileSync((await (await dl).path())!, "utf-8");
  expect(exported).toContain("1 NAME Franc /Novak/");
  expect(exported).not.toContain("_RESEARCH");
});

test("B opens a research note for later", async ({ page }) => {
  const fixture = writeFixture();
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  // From the page itself, not from inside a field, where B is a letter.
  await page.locator("body").press("b");
  await expect(page.getByRole("dialog", { name: "New research note" })).toBeVisible();
});
