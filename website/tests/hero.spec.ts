import { expect, jumpTo, openSite, test } from './fixtures/test';

// The hero is pinned for 340vh: a photo card grows from an inset rectangle to full bleed while
// the huge title turns white, then the intro copy and the demo button fade in.
const insetNumbers = (clip: string) =>
  (clip.split('round')[0].match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

test.describe('pinned hero', () => {
  test('starts with an inset photo card under a dark title', async ({ page }) => {
    await openSite(page);
    const clip = await page.locator('#card').evaluate((el: HTMLElement) => el.style.clipPath);
    expect(Math.max(...insetNumbers(clip))).toBeGreaterThanOrEqual(50);
    expect(await page.locator('#title').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(15, 15, 15)');
  });

  test('the photo grows to full bleed and the title turns white as you scroll', async ({ page }) => {
    await openSite(page);
    const vh = page.viewportSize()!.height;
    await jumpTo(page, vh * 1.5);
    await expect
      .poll(async () => Math.max(...insetNumbers(await page.locator('#card').evaluate((el: HTMLElement) => el.style.clipPath))))
      .toBeLessThanOrEqual(0.5);
    await expect
      .poll(() => page.locator('#title').evaluate((el) => getComputedStyle(el).color))
      .toBe('rgb(255, 255, 255)');
  });

  test('the intro copy and the demo button appear once the photo is full bleed', async ({ page }) => {
    await openSite(page);
    const vh = page.viewportSize()!.height;
    const copy = page.locator('#hcopy');
    expect(Number(await copy.evaluate((el) => getComputedStyle(el).opacity))).toBe(0);
    await jumpTo(page, vh * 2.2);
    await expect.poll(async () => Number(await copy.evaluate((el) => getComputedStyle(el).opacity))).toBeGreaterThan(0.95);
    await expect(copy.getByRole('button', { name: 'Book your demo' })).toBeVisible();
  });

  test('the header switches tone with the hero and hides while scrolling down', async ({ page }) => {
    await openSite(page);
    const header = page.locator('#hdr');
    const vh = page.viewportSize()!.height;
    await expect(header).toHaveAttribute('data-tone', 'ink');
    await jumpTo(page, vh * 1.5);
    await expect(header).toHaveAttribute('data-tone', 'light');
    await jumpTo(page, vh * 6);
    await expect(header).toHaveAttribute('data-tone', 'solid');
    await jumpTo(page, vh * 6 + 400);
    await expect(header).toHaveClass(/hide/);
    await jumpTo(page, vh * 6 + 100);
    await expect(header).not.toHaveClass(/hide/);
  });

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('shows the finished hero at once, with no pinned scroll', async ({ page }) => {
      await openSite(page);
      const vh = page.viewportSize()!.height;
      const heroHeight = await page.locator('#top').evaluate((el) => el.getBoundingClientRect().height);
      expect(Math.abs(heroHeight - vh)).toBeLessThanOrEqual(90);
      expect(await page.locator('#card').evaluate((el) => getComputedStyle(el).clipPath)).toBe('none');
      expect(Number(await page.locator('#hcopy').evaluate((el) => getComputedStyle(el).opacity))).toBe(1);
      await expect(page.locator('#hcopy').getByRole('button', { name: 'Book your demo' })).toBeVisible();
    });
  });
});
