import { expect, openSite, test, walkPage } from './fixtures/test';

test.describe('smoke', () => {
  test('loads with the right document metadata', async ({ page }) => {
    await openSite(page);
    await expect(page).toHaveTitle(/FitNFine Gym/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewport).toContain('viewport-fit=cover');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /FitNFine/);
  });

  test('runs without console errors or uncaught exceptions while scrolling the whole page', async ({ page, errors }) => {
    await openSite(page);
    await walkPage(page);
    expect(errors).toEqual([]);
  });

  test('every local asset the page requests is found', async ({ page }) => {
    const failed: string[] = [];
    const asset = /\/assets\//;
    page.on('response', (res) => {
      if (asset.test(res.url()) && res.status() >= 400) failed.push(`${res.status()} ${res.url()}`);
    });
    await openSite(page);
    await walkPage(page);
    expect(failed).toEqual([]);
  });

  test('the brand logo and the hero photo decode', async ({ page }) => {
    await openSite(page);
    const logo = page.getByRole('link', { name: /FitNFine Gym, back to top/ }).locator('img');
    await expect(logo).toBeVisible();
    await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);
    const hero = page.locator('#card img');
    await expect.poll(() => hero.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(1000);
  });

  test('the training film is wired, muted and looping', async ({ page }) => {
    await openSite(page);
    const film = page.locator('#film');
    await expect(film).toHaveAttribute('src', /assets\/video\/film\.mp4$/);
    expect(await film.evaluate((v: HTMLVideoElement) => v.muted && v.loop)).toBe(true);
  });

  test('every image carries an alt attribute, and meaningful images are described', async ({ page }) => {
    await openSite(page);
    const missing = await page.evaluate(() =>
      Array.from(document.images)
        .filter((img) => !img.hasAttribute('alt'))
        .map((img) => img.className || img.src.slice(0, 40)),
    );
    expect(missing).toEqual([]);
    await expect(page.getByRole('img', { name: 'A smiling FitNFine coach in a blue t-shirt' })).toBeAttached();
  });

  test('has no leftover template placeholders', async ({ page }) => {
    await openSite(page);
    const text = (await page.locator('body').innerText()).toLowerCase();
    for (const bad of ['lorem ipsum', 'undefined', 'nan kg', '[object']) expect(text).not.toContain(bad);
  });
});
