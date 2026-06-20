import { chromium } from "playwright";
import path from "path";

const SAMPLE = path.resolve("/Users/lukarenko/rodoslovje/ged-merge/test-data/Senen.ged");

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

await page.goto("http://localhost:5180/");
await page.locator('input[type="file"]').first().setInputFiles(SAMPLE);
await page.getByRole("button", { name: "Edit" }).click();
await page.locator(".edit-person").waitFor();

const marriage = page.locator(".edit-family .edit-event").first();
await marriage.locator(".edit-event-date").fill("3 MAR 1999");
await marriage.locator(".edit-event-place").click();
await marriage.locator(".edit-event-place").fill("Maribor, Slovenija");
await marriage.locator(".edit-event-addr").click(); // blur place

const saveBtn = page.locator(".export-btn", { hasText: /Save GEDCOM/i });
await saveBtn.waitFor({ timeout: 5000 });
await saveBtn.click();

await page.locator(".preview-card").first().waitFor({ timeout: 5000 });
await page.screenshot({ path: "/tmp/save-preview.png", fullPage: true });
console.log("HTML snippet:");
console.log(await page.locator(".preview-section").first().innerHTML());

await browser.close();
