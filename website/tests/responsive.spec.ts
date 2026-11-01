import { expect, isWide, jumpTo, openSite, test, walkPage } from './fixtures/test';

const overflow = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const lang of ['en', 'ta'] as const) {
  test.describe(`responsive layout (${lang})`, () => {
    test.use({ lang });

    test('never scrolls sideways at any point of the page', async ({ page }) => {
      await openSite(page);
      const worst: string[] = [];
      await walkPage(page, async (y) => {
        const extra = await overflow(page);
        if (extra > 1) worst.push(`y=${y}: ${extra}px wider than the viewport`);
      });
      expect(worst).toEqual([]);
    });

    test('keeps every plan card inside the viewport', async ({ page }) => {
      await openSite(page);
      const cards = page.locator('#planGrid .plan');
      await expect(cards).toHaveCount(6);
      const vw = page.viewportSize()!.width;
      for (const box of await cards.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
        expect(box.left).toBeGreaterThanOrEqual(-1);
        expect(box.right).toBeLessThanOrEqual(vw + 1);
      }
    });
  });
}

test.describe('responsive layout', () => {
  test('shows exactly one navigation pattern: the link bar on wide screens, the menu button otherwise', async ({ page }) => {
    await openSite(page);
    const links = page.getByRole('navigation', { name: 'Main' });
    const burger = page.getByRole('button', { name: 'Open menu' });
    if (isWide(page)) {
      await expect(links).toBeVisible();
      await expect(burger).toBeHidden();
      await expect(page.getByRole('button', { name: 'Book a demo' })).toBeVisible();
    } else {
      await expect(links).toBeHidden();
      await expect(burger).toBeVisible();
      await expect(page.getByRole('button', { name: 'Book a demo' })).toBeHidden();
    }
  });

  test('the plan grid has 3, 2 or 1 columns as the viewport narrows', async ({ page }) => {
    await openSite(page);
    const vw = page.viewportSize()!.width;
    const expected = vw > 1000 ? 3 : vw > 640 ? 2 : 1;
    const cols = await page
      .locator('#planGrid')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(cols).toBe(expected);
  });

  test('the nutrition panel stacks its photo above the list on narrow screens', async ({ page }) => {
    await openSite(page);
    const vw = page.viewportSize()!.width;
    const { img, list } = await page.evaluate(() => {
      const i = document.querySelector('#meal .meal-img')!.getBoundingClientRect();
      const l = document.querySelector('#meal .mls')!.getBoundingClientRect();
      return { img: i.toJSON(), list: l.toJSON() };
    });
    if (vw > 1000) expect(img.right).toBeLessThanOrEqual(list.left + 1);
    else expect(img.bottom).toBeLessThanOrEqual(list.top + 1);
  });

  test('touch devices get 44px hit areas on the primary controls', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'hit-area rule applies to touch devices');
    await openSite(page);
    const controls = [
      page.getByRole('button', { name: 'Open menu' }),
      page.getByRole('button', { name: /Switch language to/ }),
    ];
    await jumpTo(page, 14000);
    const plan = page.getByRole('button', { name: 'Choose Monthly' });
    await plan.scrollIntoViewIfNeeded();
    controls.push(plan);
    await jumpTo(page, 0);
    for (const c of controls) {
      const box = await c.boundingBox();
      expect(box, 'control must be on screen').not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(43.5);
      expect(box!.width).toBeGreaterThanOrEqual(43.5);
    }
  });

  test('form fields are at least 16px on phones, so iOS does not zoom on focus', async ({ page }) => {
    await openSite(page);
    const vw = page.viewportSize()!.width;
    test.skip(vw >= 768, 'rule is scoped to phones');
    for (const label of ['Age', 'Height (cm)', 'Weight now (kg)', 'Goal weight (kg)']) {
      const size = await page.getByLabel(label, { exact: true }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(size, label).toBeGreaterThanOrEqual(16);
    }
    await page.evaluate(() => (document.querySelector('#trial') as HTMLDialogElement).showModal());
    for (const label of ['Name', 'Mobile number']) {
      const size = await page.getByLabel(label, { exact: true }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(size, label).toBeGreaterThanOrEqual(16);
    }
  });

  test('headings never clip their text', async ({ page }) => {
    await openSite(page);
    const clipped = await page.evaluate(() =>
      Array.from(document.querySelectorAll('main h2, main h3'))
        .filter((el) => (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 2)
        .map((el) => (el.textContent || '').trim().slice(0, 40)),
    );
    expect(clipped).toEqual([]);
  });
});
