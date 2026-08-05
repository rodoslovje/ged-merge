import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

/** The field the keyboard is in, by its own class. */
function focused(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return a?.className.split(/\s+/).find((c) => c.startsWith("edit-name-") || c.startsWith("edit-event-")) ?? a?.tagName ?? "none";
  });
}

async function openEdit(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
}

/** Create a person from the search bar, named after what was typed — the
 *  search that finds nobody offers it, so the names here match nobody. Nothing around them supplies a surname,
 *  unlike a child or a father added from a family. */
async function addFromSearch(page: import("@playwright/test").Page, typed: string) {
  await page.getByRole("button", { name: /Search everyone/i }).click();
  const input = page.locator(".global-search-input");
  await input.waitFor();
  await input.fill(typed);
  // The offer to create appears once the search has settled on no matches.
  const create = page.locator(".global-search-create");
  await expect(create).toBeVisible();
  await create.click();
  await expect(page.locator(".edit-event").first()).toBeVisible();
}

// The name and the birth date are a dozen buttons apart in the tab order, so a
// name that arrived complete should not cost that walk.
test("a person named in full from the search bar opens on the birth date", async ({ page }) => {
  await openEdit(page);
  await addFromSearch(page, "xylo zorn");

  await expect.poll(() => focused(page)).toBe("edit-event-date");
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Xylo");
  await expect(page.locator(".edit-name-input").nth(1)).toHaveValue("Zorn");
});

test("a person named only in part opens on the name, to finish it", async ({ page }) => {
  await openEdit(page);
  await addFromSearch(page, "xylo");

  await expect.poll(() => focused(page)).toBe("edit-name-input");
});

test("Enter runs the name into the birth date and on through the event", async ({ page }) => {
  await openEdit(page);
  // One word names them only in part, so the keyboard waits on the name.
  await addFromSearch(page, "xylo");
  await expect.poll(() => focused(page)).toBe("edit-name-input");

  await page.keyboard.press("Enter");
  await expect.poll(() => focused(page)).toBe("edit-name-input"); // the surname

  await page.keyboard.type("Zorn");
  await page.keyboard.press("Enter");
  await expect.poll(() => focused(page)).toBe("edit-event-date");

  await page.keyboard.type("1 JAN 1900");
  await page.keyboard.press("Enter");
  await expect.poll(() => focused(page)).toBe("edit-event-place");

  // Everything typed on the way is kept.
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Xylo");
  await expect(page.locator(".edit-name-input").nth(1)).toHaveValue("Zorn");
  await expect(page.locator(".edit-event-date").first()).toHaveValue("1 JAN 1900");
});
