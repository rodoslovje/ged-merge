import { test, expect, type Page } from "@playwright/test";

const MAIN_TEXT = [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1 JAN 1900",
  "0 @I2@ INDI", "1 NAME Ana /Novak/", "1 SEX F",
  "0 TRLR", "",
].join("\n");

// Seed a cached workspace whose session.startId points at a person that does
// NOT exist in the main (e.g. a stale id from a previously-loaded file).
async function seedBadStart(page: Page, mainText: string, badStartId: string) {
  await page.addInitScript(
    ([text, startId]) => {
      localStorage.setItem("gedmerge.settings", JSON.stringify({ persistWorkspace: true }));
      const req = indexedDB.open("gedmerge-session", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
        if (!db.objectStoreNames.contains("session")) db.createObjectStore("session");
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(["files", "session"], "readwrite");
        tx.objectStore("files").put(
          { fileName: "Seeded.ged", blob: new Blob([text]), savedAt: Date.now() },
          "main",
        );
        tx.objectStore("session").put(
          {
            mainFileName: "Seeded.ged",
            decisions: [],
            importBranches: [],
            startId,
            savedAt: Date.now(),
          },
          "current",
        );
      };
    },
    [mainText, badStartId] as const,
  );
}

test("restore with a stale start id still shows the individuals", async ({ page }) => {
  await seedBadStart(page, MAIN_TEXT, "@I999@");
  await page.goto("/");
  // The restore is what this test is about, so wait for the thing it produces —
  // the header naming the cached file — rather than for a fixed span of time
  // the restore may well outlast on a loaded machine.
  await expect(page.locator(".header-file-btn.main")).toContainText("Seeded.ged");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByText("no individuals to edit")).toHaveCount(0);
  await expect(page.locator(".edit-person").first()).toBeVisible();
});
