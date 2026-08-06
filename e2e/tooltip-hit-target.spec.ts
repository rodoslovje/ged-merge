import { test, expect } from "@playwright/test";

// Two unparsable lines, so the file loads with warnings and the chip is titled.
const GED = [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Novak/",
  "this line is not gedcom at all",
  "nor is this one",
  "0 TRLR", "",
].join("\n");

// Safari resolves a tooltip for SVG content from an SVG <title> child only — it
// does not walk up to the HTML ancestor holding the `title` attribute, as Chrome
// and Firefox do. So a decorative icon sitting in a titled chip swallowed the
// tooltip there entirely: hovering the ⚠ showed nothing. The icon must stay out
// of hit-testing so the hover always reaches the element that owns the title.
test("a decorative icon does not take the hover from its titled chip", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first()
    .setInputFiles({ name: "warn.ged", mimeType: "text/plain", buffer: Buffer.from(GED, "utf-8") });
  await page.locator(".header-file-btn").first().click();

  const chip = page.locator(".loader-warn");
  await expect(chip).toHaveAttribute("title", /Unparsable/);

  // Over the icon, at the chip's left edge — where the ⚠ is drawn.
  const hit = await chip.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const target = document.elementFromPoint(box.left + 7, box.top + box.height / 2);
    return {
      inSvg: !!target?.namespaceURI?.includes("svg"),
      ownsTitle: target?.closest("[title]") === el,
    };
  });
  expect(hit).toEqual({ inSvg: false, ownsTitle: true });
});
