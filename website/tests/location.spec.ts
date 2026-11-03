import { expect, jumpTo, openSite, test } from './fixtures/test';

// The gym's Google Maps listing: "Fit&Fine (unisex) gym" in Tiruchengode.
const SHORT_LINK = 'https://maps.app.goo.gl/YEXsZ4W4Y3BdDQwq6';
const LAT = '11.3729575';
const LNG = '77.8745749';

test.describe('location and map', () => {
  test('has a Find the gym section with the address and hours', async ({ page }) => {
    await openSite(page);
    const section = page.locator('#visit');
    await expect(section.getByRole('heading', { level: 2, name: /Find the gym/ })).toBeVisible();
    await expect(section.locator('address')).toContainText('Vellalar Colony');
    await expect(section.locator('address')).toContainText('Tiruchengode 637214, Tamil Nadu');
    await expect(section).toContainText('Every day, 5:30 AM to 10:00 PM');
  });

  test('embeds the map at the exact pin, with an accessible title', async ({ page }) => {
    await openSite(page);
    const frame = page.locator('#mapFrame');
    await frame.scrollIntoViewIfNeeded();
    await expect(frame).toHaveAttribute('title', /Map showing the FitNFine Gym location/);
    const src = (await frame.getAttribute('src'))!;
    expect(src).toContain(`q=${LAT},${LNG}`);
    expect(src).toContain('output=embed');
    await expect(frame).toHaveAttribute('loading', 'lazy');
    await expect(frame).toBeVisible();
  });

  test('links to the Google Maps listing and to directions in a new tab', async ({ page }) => {
    await openSite(page);
    const open = page.getByRole('link', { name: 'Open in Google Maps' });
    await expect(open).toHaveAttribute('href', SHORT_LINK);
    await expect(open).toHaveAttribute('target', '_blank');
    await expect(open).toHaveAttribute('rel', /noopener/);
    const directions = page.locator('#mapDir');
    await expect(directions).toHaveAttribute('href', new RegExp(`destination=${LAT},${LNG}`));
    await expect(directions).toHaveAttribute('target', '_blank');
    await expect(page.locator('footer #footDir')).toHaveAttribute('href', new RegExp(`destination=${LAT},${LNG}`));
  });

  test('copies the full address', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'clipboard permissions are granted for Chromium only');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openSite(page);
    await page.locator('#copyAddr').scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Copy address' }).click();
    await expect(page.getByRole('status')).toContainText('Address copied');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain('45/3, Vellalar Colony');
    expect(text).toContain('Tiruchengode 637214, Tamil Nadu');
  });

  test('tells search engines where the gym is', async ({ page }) => {
    await openSite(page);
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent())!);
    expect(ld.geo['@type']).toBe('GeoCoordinates');
    expect(String(ld.geo.latitude)).toBe(LAT);
    expect(String(ld.geo.longitude)).toBe(LNG);
    expect(ld.hasMap).toBe(SHORT_LINK);
    expect(ld.alternateName).toBe('Fit&Fine (unisex) gym');
  });

  test('the "Find us" link scrolls to the section', async ({ page }) => {
    await openSite(page);
    await jumpTo(page, 6000);
    await jumpTo(page, 5800); // scrolling up brings the header back
    await expect(page.locator('#hdr')).not.toHaveClass(/hide/);
    const vw = page.viewportSize()!.width;
    if (vw > 1000) {
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Find us' }).click();
    } else {
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.locator('#menu').getByRole('link', { name: /Find us/ }).click();
    }
    const vh = page.viewportSize()!.height;
    await expect
      .poll(() => page.locator('#visit').evaluate((el) => el.getBoundingClientRect().top), { timeout: 8000 })
      .toBeLessThan(vh * 0.5);
  });

  test('the map stays inside the screen and is big enough to use', async ({ page }) => {
    await openSite(page);
    const card = page.locator('.map-card');
    await card.scrollIntoViewIfNeeded();
    const box = (await card.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
    expect(box.height).toBeGreaterThanOrEqual(260);
  });

  test.describe('in Tamil', () => {
    test.use({ lang: 'ta' });
    test('shows the section and buttons in Tamil', async ({ page }) => {
      await openSite(page);
      await expect(page.locator('#visit')).toContainText('கண்டறியுங்கள்');
      await expect(page.getByRole('link', { name: 'கூகுள் மேப்ஸில் திற' })).toBeVisible();
      await expect(page.locator('#visit address')).toContainText('637214');
    });
  });
});
