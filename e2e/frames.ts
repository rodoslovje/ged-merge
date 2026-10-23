import { expect, type Locator, type Page } from "@playwright/test";

// Condition-based pacing for specs that drive scrolling and virtual lists.
// AGENTS.md: wait for what a step produces, never for a duration.

/** Resolves once the page has rendered two more frames — i.e. whatever the
 *  last input (a wheel tick, a scrollTop write) scheduled has been laid out
 *  and painted. A frame, not a fixed delay: it is as long as the machine needs. */
export async function nextFrames(page: Page, frames = 2): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
        step(n);
      }),
    frames,
  );
}

/**
 * Waits until a (virtual) list has stopped changing: the number of rendered
 * rows and the scroller's content height are the same across two frames. A
 * virtual list measures its rows after the first paint and re-renders with the
 * real heights, so the first visible row is not yet the settled list.
 */
export async function waitForListSettled(rows: Locator, scroller?: Locator): Promise<void> {
  await expect(rows.first()).toBeVisible();
  const page = rows.page();
  const sample = async () => ({
    rows: await rows.count(),
    height: scroller ? await scroller.evaluate((el) => el.scrollHeight) : 0,
  });
  await expect(async () => {
    const before = await sample();
    await nextFrames(page, 3);
    expect(await sample()).toEqual(before);
  }).toPass();
}
