import { test, expect, type Page } from "@playwright/test";

// Typing in an overlay field used to commit to the global settings on every
// keystroke, which re-rendered the whole mounted app. Typed edits now echo
// locally and commit on a pause, so these guard the two things that pause can
// get wrong: the field must accept a whole word without dropping characters,
// and the edit must survive being interrupted before the pause elapses.

const OVERLAY_NAME = "Franciscean cadastre";

/** Settings → Map, with the tile opt-in on (the overlay list is inert without
 *  it, since an overlay is nothing but a request to a tile provider). */
async function openMapSettings(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("tab", { name: "Map" }).click();
  await page.locator("label.settings-row-toggle", { hasText: "Load base-map tiles" }).locator("input").check();
}

/** Add a blank overlay layer and return its name field. */
async function addLayer(page: Page) {
  await page.getByRole("button", { name: "+ Add layer" }).click();
  return page.locator(".settings-overlay-row").last().locator("input.settings-overlay-title");
}

/** The overlay list as the app has actually stored it. */
function storedOverlays(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("gedmerge.settings");
    return raw ? ((JSON.parse(raw) as { mapOverlays?: { name?: string }[] }).mapOverlays ?? []) : [];
  });
}

test("a name typed into an overlay row keeps every character and reaches the settings", async ({ page }) => {
  await openMapSettings(page);
  const name = await addLayer(page);
  await name.pressSequentially(OVERLAY_NAME, { delay: 15 });

  // Echoed in full straight away, even though the commit is still pending.
  await expect(name).toHaveValue(OVERLAY_NAME);

  await expect.poll(async () => (await storedOverlays(page)).map((o) => o.name)).toContain(OVERLAY_NAME);
});

test("closing Settings mid-word still commits what was typed", async ({ page }) => {
  await openMapSettings(page);
  const name = await addLayer(page);
  await name.pressSequentially(OVERLAY_NAME, { delay: 15 });
  // Shut the modal immediately — inside the commit pause, not after it.
  await page.locator(".modal-close").first().click();

  await expect.poll(async () => (await storedOverlays(page)).map((o) => o.name)).toContain(OVERLAY_NAME);
});

test("deleting a row before the pause elapses keeps the edit typed into another", async ({ page }) => {
  await openMapSettings(page);
  const first = await addLayer(page);
  await first.pressSequentially("Keeper", { delay: 15 });
  const second = await addLayer(page);
  await second.pressSequentially("Doomed", { delay: 15 });

  // Remove the row just typed into, without waiting for its commit: the other
  // row's name must survive, and the deleted one must not come back.
  await page.locator(".settings-overlay-row").last().getByRole("button", { name: "Remove" }).click();

  await expect.poll(async () => (await storedOverlays(page)).map((o) => o.name)).toEqual(["Keeper"]);
});
