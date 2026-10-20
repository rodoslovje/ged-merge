import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Some exporters write a description on the death line itself
// (`1 DEAT exact date unknown`). Merge always compared it; Edit now shows it on
// the extras line too. A bare `1 DEAT Y` only says the person died: Edit shows
// no value for it and keeps the flag when another field of the death changes.

function fixture(name: string, deathLine: string): string {
  const file = path.join(tmpdir(), `death-line-value-${name}.ged`);
  writeFileSync(file, [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Anton /Renka/", "1 SEX M",
    deathLine, "2 DATE 1918",
    "0 TRLR", "",
  ].join("\n"), "utf-8");
  return file;
}

async function open(page: Page, file: string) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(file);
  await expect(page.locator(".edit-person .edit-name-input").first()).toHaveValue("Anton");
  return page.locator(".edit-person").first();
}

async function saveContent(page: Page): Promise<string> {
  const saveBtn = page.locator(".app-head-actions .export-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  const downloadPromise = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  return readFileSync((await (await downloadPromise).path())!, "utf-8");
}

test("a death's line value shows in Edit", async ({ page }) => {
  const person = await open(page, fixture("described", "1 DEAT exact date unknown"));
  await expect(person.getByRole("textbox", { name: "Death value" })).toHaveValue("exact date unknown");
});

test("a bare Y on the death line stays a flag", async ({ page }) => {
  const person = await open(page, fixture("flag", "1 DEAT Y"));
  await expect(person.getByRole("textbox", { name: "Death date" })).toHaveValue("1918");
  await expect(person.getByRole("textbox", { name: "Death value" })).toHaveCount(0);
  await person.getByRole("textbox", { name: "Death date" }).fill("1919");
  await person.getByRole("textbox", { name: "Death date" }).press("Tab");
  expect(await saveContent(page)).toMatch(/1 DEAT Y\r?\n2 DATE 1919/);
});
