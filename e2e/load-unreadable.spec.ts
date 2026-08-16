import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

// A picked file can refuse to be read: moved or renamed between the picker and
// the read, a cloud folder's placeholder that never materializes, permission
// withdrawn. That has to end in an error the reader can see. Unguarded the
// rejection went nowhere and the slot stayed "loading" — a spinner with no end
// and no way back except reloading the page.
test("a file that cannot be read says so instead of spinning forever", async ({ page }) => {
  await page.addInitScript(() => {
    File.prototype.arrayBuffer = () =>
      Promise.reject(new DOMException("The requested file could not be read", "NotReadableError"));
  });
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);

  await expect(page.locator(".error").first()).toContainText(/could not be read/i, { timeout: 10000 });
  // And the app is still usable: the file picker is there to try another one.
  await expect(page.locator("input.file-input").first()).toBeAttached();
});
