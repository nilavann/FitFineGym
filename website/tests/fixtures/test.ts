import { test as base, expect, type Page } from '@playwright/test';

// Shared fixture for every spec:
//  - Google Fonts requests are answered with empty files, so the site is measured with the same
//    fallback fonts on every browser and the suite works offline.
//  - Uncaught exceptions and console errors are collected in `errors` so a spec can assert none.
//  - `lang` (default 'en') pre-seeds the language the site remembers in localStorage.
type Fixtures = { errors: string[]; lang: 'en' | 'ta' };

export const test = base.extend<Fixtures>({
  errors: async ({}, use) => {
    await use([]);
  },
  lang: ['en', { option: true }],
  page: async ({ page, errors, lang }, use) => {
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
      route.fulfill({
        status: 200,
        contentType: route.request().url().includes('/css') ? 'text/css' : 'font/woff2',
        body: '',
      }),
    );
    await page.addInitScript((l) => {
      try {
        // Seed only the first visit, so a reload still shows what the visitor chose.
        if (!localStorage.getItem('fnf-lang')) localStorage.setItem('fnf-lang', l);
      } catch {
        /* storage blocked: the site falls back to English */
      }
    }, lang);
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await use(page);
  },
});

export { expect };

/** Open the site and wait until the page script has wired the images. */
export async function openSite(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const img = document.querySelector('img[data-img]');
    return !!img && !!img.getAttribute('src');
  });
}

/** Jump (no smooth scrolling) to an absolute scroll position and let the scroll handlers run. */
export async function jumpTo(page: Page, y: number) {
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' as ScrollBehavior }), y);
  await page.waitForTimeout(150);
}

/** Scroll the whole page top to bottom in viewport-sized steps, calling `each` at every stop. */
export async function walkPage(page: Page, each?: (y: number) => Promise<void>) {
  const { height, vh } = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    vh: window.innerHeight,
  }));
  for (let y = 0; y < height; y += Math.round(vh * 0.8)) {
    await jumpTo(page, y);
    if (each) await each(y);
  }
}

/** The site swaps from a link bar to a menu button at 1000px. */
export const isWide = (page: Page) => (page.viewportSize()?.width ?? 0) > 1000;
