import { expect, isWide, jumpTo, openSite, test } from './fixtures/test';
import type { Page } from '@playwright/test';

const openTrial = async (page: Page) => {
  const cta = page.locator('.cta').getByRole('button', { name: /^Book a free demo$|^இலவச டெமோ முன்பதிவு$/ });
  await cta.scrollIntoViewIfNeeded();
  await cta.click();
};

test.describe('language', () => {
  test('switches between English and Tamil and remembers the choice', async ({ page }) => {
    await openSite(page);
    await expect(page.locator('#title')).toContainText('Get fit.');
    await page.getByRole('button', { name: 'Switch language to Tamil' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ta');
    await expect(page.locator('#title')).toContainText('உறுதியாய் இரு.');
    await expect(page.locator('#planGrid')).toContainText('ஒரு நாள் அனுமதி');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ta');
    await page.getByRole('button', { name: 'Switch language to English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#title')).toContainText('Stay fine.');
  });
});

test.describe('calculator', () => {
  test('recalculates as the goal changes', async ({ page }) => {
    await openSite(page);
    const kcal = page.locator('#res .big-num');
    const before = await kcal.innerText();
    await page.getByLabel('Goal weight (kg)').fill('72');
    await expect.poll(() => kcal.innerText()).not.toBe(before);
    await expect(page.locator('#res')).toContainText('Time to goal');
  });

  test('warns about out-of-range values', async ({ page }) => {
    await openSite(page);
    await page.getByLabel('Age', { exact: true }).fill('5');
    await expect(page.locator('#res .warn')).toContainText('Enter an age from 16 to 80');
    await page.getByLabel('Age', { exact: true }).fill('32');
    await expect(page.locator('#res .warn')).toHaveCount(0);
  });

  test('explains a goal at or above the current weight', async ({ page }) => {
    await openSite(page);
    await page.getByLabel('Goal weight (kg)').fill('80');
    await expect(page.locator('#res')).toContainText('Daily calories to maintain');
  });

  test('the nutrition panel swaps photo and meals between vegetarian and non-vegetarian', async ({ page }) => {
    await openSite(page);
    const meal = page.locator('#meal');
    await expect(meal.getByRole('img', { name: 'Idli served with chutney and sambar' })).toBeAttached();
    await expect(meal.getByRole('button', { name: 'Vegetarian', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await meal.getByRole('button', { name: 'Non-vegetarian' }).click();
    await expect(meal.getByRole('img', { name: 'Chicken biryani served on a plate' })).toBeAttached();
    await expect(meal.getByRole('button', { name: 'Non-vegetarian' })).toHaveAttribute('aria-pressed', 'true');
    await expect(meal).toContainText(/fish curry|chicken curry|omelette/);
    await meal.getByRole('button', { name: 'Vegetarian', exact: true }).click();
    await expect(meal).toContainText('paneer');
  });

  test('the meal photo fills the height of its panel', async ({ page }) => {
    await openSite(page);
    test.skip(!isWide(page), 'the photo stretches beside the list on wide screens only');
    const { img, grid } = await page.evaluate(() => ({
      img: document.querySelector('#meal .meal-img')!.getBoundingClientRect().height,
      grid: document.querySelector('#meal .meal-grid > div:last-child')!.getBoundingClientRect().height,
    }));
    expect(img).toBeGreaterThanOrEqual(grid - 2);
  });
});

test.describe('programs and plans', () => {
  test('a program opens a details dialog that closes with Escape', async ({ page }) => {
    await openSite(page);
    await page.locator('#items .item').first().evaluate((b: HTMLElement) => b.click());
    const dialog = page.getByRole('dialog', { name: 'Lift' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Book a free demo' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Burn mentions Kuthu Fit', async ({ page }) => {
    await openSite(page);
    await page.locator('#items .item').nth(1).evaluate((b: HTMLElement) => b.click());
    await expect(page.getByRole('dialog', { name: 'Burn' })).toContainText('Kuthu Fit');
  });

  test('choosing a plan opens the booking dialog', async ({ page }) => {
    await openSite(page);
    const choose = page.getByRole('button', { name: 'Choose Quarterly' });
    await choose.scrollIntoViewIfNeeded();
    await choose.click();
    await expect(page.getByRole('dialog', { name: 'Book your free demo' })).toBeVisible();
  });

  test('the testimonial slider moves with its dots', async ({ page }) => {
    await openSite(page);
    const quote = page.locator('#q');
    await quote.scrollIntoViewIfNeeded();
    await expect(quote).toContainText('crash diet');
    await page.getByRole('button', { name: 'Story 2' }).click();
    await expect(quote).toContainText('climb stairs');
  });

  test('the film can be paused and played', async ({ page }) => {
    await openSite(page);
    const pause = page.getByRole('button', { name: 'Pause video' });
    await pause.scrollIntoViewIfNeeded();
    await pause.click();
    await expect(page.getByRole('button', { name: 'Play video' })).toBeVisible();
    await page.getByRole('button', { name: 'Play video' }).click();
    await expect(page.getByRole('button', { name: 'Pause video' })).toBeVisible();
  });
});

test.describe('booking dialog', () => {
  test('opens centred inside the viewport', async ({ page }) => {
    await openSite(page);
    await openTrial(page);
    const dialog = page.getByRole('dialog', { name: 'Book your free demo' });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeLessThan(vp.height * 0.5);
  });

  test('validates the form, then builds a WhatsApp message', async ({ page }) => {
    await openSite(page);
    await openTrial(page);
    const dialog = page.getByRole('dialog', { name: 'Book your free demo' });
    await dialog.getByRole('button', { name: 'Book my free demo' }).click();
    await expect(dialog).toContainText('Please add your name.');
    await expect(dialog).toContainText('Enter a valid 10-digit mobile number.');
    await expect(dialog).toContainText('Please choose a goal.');

    await dialog.getByLabel('Name', { exact: true }).fill('Priya Nair');
    await dialog.getByLabel('Mobile number').fill('58765 43210'); // Indian mobiles start 6 to 9
    await dialog.getByLabel('Main goal').selectOption('Lose weight');
    await dialog.getByRole('button', { name: 'Book my free demo' }).click();
    await expect(dialog).toContainText('Enter a valid 10-digit mobile number.');

    await dialog.getByLabel('Mobile number').fill('+91 98765 43210');
    await dialog.getByRole('button', { name: 'Book my free demo' }).click();
    await expect(dialog.getByRole('heading', { name: /You.re in/ })).toBeVisible();
    const wa = dialog.getByRole('link', { name: 'Open in WhatsApp' });
    await expect(wa).toHaveAttribute('href', /^https:\/\/wa\.me\/\?text=/);
    await expect(wa).toHaveAttribute('href', /Priya%20Nair/);
    await expect(wa).toHaveAttribute('href', /9876543210/);
    await expect(dialog.locator('#tmsg')).toContainText('Goal: Lose weight');
  });

  test('closes with Escape and with the close button', async ({ page }) => {
    await openSite(page);
    await openTrial(page);
    const dialog = page.getByRole('dialog', { name: 'Book your free demo' });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await openTrial(page);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  test.describe('in Tamil', () => {
    test.use({ lang: 'ta' });
    test('shows Tamil validation messages', async ({ page }) => {
      await openSite(page);
      await openTrial(page);
      const dialog = page.getByRole('dialog');
      await dialog.locator('button[type="submit"]').click();
      await expect(dialog).toContainText('உங்கள் பெயரைச் சேர்க்கவும்.');
      await expect(dialog).toContainText('சரியான 10 இலக்க கைபேசி எண்ணை உள்ளிடவும்.');
    });
  });
});

test.describe('mobile menu', () => {
  test.beforeEach(({ page }) => {
    test.skip(isWide(page), 'the menu button exists below 1000px only');
  });

  test('opens, locks the page, and closes with Escape returning focus', async ({ page }) => {
    await openSite(page);
    const burger = page.getByRole('button', { name: 'Open menu' });
    await burger.click();
    const menu = page.locator('#menu');
    await expect(menu.getByRole('link', { name: /Programs/ })).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/lock/);
    await expect(page.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(menu.getByRole('link', { name: /Programs/ })).toBeHidden();
    await expect(burger).toBeFocused();
    await expect(page.locator('body')).not.toHaveClass(/lock/);
  });

  test('a menu link closes the menu and scrolls to its section', async ({ page }) => {
    await openSite(page);
    await jumpTo(page, 0);
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('#menu').getByRole('link', { name: /Plans/ }).click();
    await expect(page.locator('#menu')).toBeHidden();
    const vh = page.viewportSize()!.height;
    await expect
      .poll(() => page.locator('#plans').evaluate((el) => el.getBoundingClientRect().top), { timeout: 8000 })
      .toBeLessThan(vh * 0.5);
  });

  test('the language toggle stays reachable beside the menu button', async ({ page }) => {
    await openSite(page);
    await expect(page.getByRole('button', { name: /Switch language to/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  });
});
