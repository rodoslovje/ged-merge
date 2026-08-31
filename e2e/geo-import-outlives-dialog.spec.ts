import { test, expect } from "@playwright/test";

// A download must outlive the dialog it was started from.
//
// It did not: the import belonged to the settings component, whose unmount
// cleanup terminated its worker — and Settings unmounts that component every
// time its tab changes and every time it closes. Waiting on a 45 MB register
// with the dialog open is not something to require of anyone, so what a reader
// saw was a download that ran to the end and a directory that was never there,
// with nothing said. This holds the register's own response open until the
// dialog is shut, and then asks for the directory.

const box = (lon: number, lat: number) => [
  [lon, lat],
  [lon + 0.01, lat],
  [lon + 0.01, lat + 0.01],
  [lon, lat + 0.01],
  [lon, lat],
];

const NASELJA = {
  features: [
    { properties: { NAZIV: "Kranj", EID_OBCINA: "o-kranj" }, geometry: { type: "Polygon", coordinates: [box(14.35, 46.23)] } },
  ],
};
const OBCINE = { features: [{ properties: { EID_OBCINA: "o-kranj", NAZIV: "Kranj" } }] };

test("a register download outlives the dialog it was started in", async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The settlements answer only once the dialog is gone, so the import is
  // provably still on the wire at the moment the component unmounts.
  await page.route("**/ipi.eprostor.gov.si/**", async (route) => {
    const url = route.request().url();
    if (url.includes("NASELJA")) {
      await held;
      return route.fulfill({ json: NASELJA });
    }
    if (url.includes("OBCINE")) return route.fulfill({ json: OBCINE });
    return route.fulfill({ status: 404, body: "not fixtured" });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("tab", { name: "Map" }).click();

  const places = page
    .locator(".tools-geo-source", { hasText: "GURS (Slovenia)" })
    .getByRole("button", { name: "Places" });
  await places.click();
  await expect(page.locator(".tools-loading")).toBeVisible();

  // Away from the tab, and out of the dialog altogether — the two ways the
  // manager is unmounted mid-import.
  await page.getByRole("tab", { name: "General" }).click();
  await page.locator(".modal-close").click();
  await expect(page.locator(".settings-tabs")).toHaveCount(0);

  release();

  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("tab", { name: "Map" }).click();
  await expect(page.locator(".tools-geo-countries li", { hasText: "SI-GURS" })).toBeVisible();
});
