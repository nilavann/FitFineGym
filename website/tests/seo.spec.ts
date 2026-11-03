import { expect, openSite, test } from './fixtures/test';

// Search and social-sharing setup. The domain in canonical / og:url / sitemap / robots is a
// placeholder until `npm run set-domain -- https://your-domain` runs; these tests only require
// that every file agrees on one origin, so a half-finished swap fails.
const meta = (page: import('@playwright/test').Page, selector: string) =>
  page.locator(selector).first().getAttribute('content');

test.describe('SEO', () => {
  test('has a title and description of a useful length', async ({ page }) => {
    await openSite(page);
    const title = await page.title();
    expect(title.length).toBeGreaterThanOrEqual(30);
    expect(title.length).toBeLessThanOrEqual(65);
    const description = (await meta(page, 'meta[name="description"]'))!;
    expect(description.length).toBeGreaterThanOrEqual(70);
    expect(description.length).toBeLessThanOrEqual(160);
  });

  test('has one canonical URL and allows indexing', async ({ page }) => {
    await openSite(page);
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(canonical).toMatch(/^https:\/\/[^/]+\/$/);
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
    expect(await meta(page, 'meta[name="robots"]')).not.toMatch(/noindex/i);
  });

  test('has complete Open Graph and Twitter share tags', async ({ page }) => {
    await openSite(page);
    for (const p of ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image', 'og:image:alt']) {
      expect(await meta(page, `meta[property="${p}"]`), p).toBeTruthy();
    }
    expect(await meta(page, 'meta[property="og:image"]')).toMatch(/^https:\/\/.+\/og-image\.jpg$/);
    expect(await meta(page, 'meta[name="twitter:card"]')).toBe('summary_large_image');
    expect(await meta(page, 'meta[name="twitter:image"]')).toBe(await meta(page, 'meta[property="og:image"]'));
    expect(await meta(page, 'meta[property="og:url"]')).toBe(await page.locator('link[rel="canonical"]').getAttribute('href'));
  });

  test('the share image exists at 1200 x 630', async ({ page }) => {
    await openSite(page);
    const size = await page.evaluate(
      () =>
        new Promise<[number, number]>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
          img.onerror = () => reject(new Error('og-image.jpg did not load'));
          img.src = 'assets/img/og-image.jpg';
        }),
    );
    expect(size).toEqual([1200, 630]);
  });

  test('describes the gym with valid LocalBusiness structured data', async ({ page }) => {
    await openSite(page);
    const raw = await page.locator('script[type="application/ld+json"]').first().textContent();
    const data = JSON.parse(raw!);
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@type']).toBe('ExerciseGym');
    for (const key of ['name', 'url', 'telephone', 'priceRange', 'image', 'logo']) expect(data[key], key).toBeTruthy();
    expect(data.address['@type']).toBe('PostalAddress');
    expect(data.address.addressCountry).toBe('IN');
    expect(data.openingHoursSpecification[0].opens).toBe('05:30');
    expect(data.openingHoursSpecification[0].closes).toBe('22:00');
  });

  test('has exactly one h1 and a sensible heading outline', async ({ page }) => {
    await openSite(page);
    await expect(page.locator('h1')).toHaveCount(1);
    const levels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('h1,h2,h3,h4')).map((h) => Number(h.tagName[1])),
    );
    expect(levels[0]).toBe(1);
    // no jump of more than one level downwards (h1 to h3, for example)
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1], `heading #${i}`).toBeLessThanOrEqual(1);
  });

  test('images in the page source have real src attributes, so crawlers see them without running scripts', async ({ page }) => {
    const res = await page.request.get('/');
    const html = await res.text();
    // the program dialog's photo (#pdi) is filled in when a program opens, so it is exempt
    const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]).filter((tag) => !tag.includes('id="pdi"'));
    expect(imgs.length).toBeGreaterThan(5);
    for (const tag of imgs) expect(tag, tag.slice(0, 80)).toMatch(/\ssrc="assets\//);
    expect(html).toContain('rel="preload" as="image" href="assets/img/hero.jpg"');
  });

  test('every in-page link points at an element that exists', async ({ page }) => {
    await openSite(page);
    const broken = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href^="#"]'))
        .map((a) => a.getAttribute('href')!)
        .filter((h) => h.length > 1 && !document.querySelector(h)),
    );
    expect(broken).toEqual([]);
  });

  test('robots.txt, sitemap.xml and the web manifest are served and agree on one origin', async ({ page }) => {
    await openSite(page);
    const canonical = (await page.locator('link[rel="canonical"]').getAttribute('href'))!;
    const origin = new URL(canonical).origin;

    const robots = await page.request.get('/robots.txt');
    expect(robots.status()).toBe(200);
    const robotsText = await robots.text();
    expect(robotsText).toMatch(/User-agent: \*/);
    expect(robotsText).not.toMatch(/Disallow: \/\s*$/m);
    expect(robotsText).toContain(`Sitemap: ${origin}/sitemap.xml`);

    const sitemap = await page.request.get('/sitemap.xml');
    expect(sitemap.status()).toBe(200);
    expect(await sitemap.text()).toContain(`<loc>${origin}/</loc>`);

    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    const manifest = await page.request.get(`/${manifestHref}`);
    expect(manifest.status()).toBe(200);
    const json = await manifest.json();
    expect(json.name).toBe('FitNFine Gym');
    for (const icon of json.icons) expect((await page.request.get(`/${icon.src}`)).status(), icon.src).toBe(200);
  });

  test('declares its language and a mobile theme colour', async ({ page }) => {
    await openSite(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(await meta(page, 'meta[name="theme-color"]')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(await meta(page, 'meta[property="og:locale:alternate"]')).toBe('ta_IN');
  });
});
