import { expect, jumpTo, openSite, test } from './fixtures/test';

// Visual review: one screenshot per key section, attached to the HTML report for every browser
// and device project (`npm run test:report`). These are not pixel baselines, because font
// rendering differs per OS; they exist so a person can look at each viewport. The assertions only
// check that the section is on screen and does not overflow sideways.
const sections = [
  ['why', '#why'],
  ['numbers', '#calc'],
  ['meal', '#meal'],
  ['programs', '#programs'],
  ['plans', '#planGrid'],
  ['stories', '#stories'],
  ['contact', '.cta'],
  ['footer', 'footer'],
] as const;

for (const lang of ['en', 'ta'] as const) {
  test.describe(`views (${lang})`, () => {
    test.use({ lang });

    test('hero', async ({ page }, testInfo) => {
      await openSite(page);
      await page.waitForTimeout(500);
      await testInfo.attach(`hero-start-${lang}`, { body: await page.screenshot(), contentType: 'image/png' });
      await jumpTo(page, page.viewportSize()!.height * 2.4);
      await page.waitForTimeout(700);
      await testInfo.attach(`hero-end-${lang}`, { body: await page.screenshot(), contentType: 'image/png' });
    });

    for (const [name, selector] of sections) {
      test(`section: ${name}`, async ({ page }, testInfo) => {
        await openSite(page);
        const target = page.locator(selector).first();
        await target.scrollIntoViewIfNeeded();
        await jumpTo(page, await target.evaluate((el) => el.getBoundingClientRect().top + window.scrollY - 90));
        await page.waitForTimeout(900);
        await expect(target).toBeInViewport({ ratio: 0.05 });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        await testInfo.attach(`${name}-${lang}`, { body: await page.screenshot(), contentType: 'image/png' });
      });
    }
  });
}
