import { expect, isWide, jumpTo, openSite, test } from './fixtures/test';

// Content the site owner asked for, pinned so a redesign cannot silently drop it.
test.describe('content', () => {
  test('lists the six membership plans with their prices', async ({ page }) => {
    await openSite(page);
    const plans: Array<[string, string]> = [
      ['Day pass', '₹199'],
      ['Monthly', '₹1,999'],
      ['Quarterly', '₹5,397'],
      ['Yearly', '₹19,190'],
      ['Couple', '₹3,518'],
      ['Professional', '₹2,799'],
    ];
    for (const [name, price] of plans) {
      const card = page.locator('#planGrid .plan').filter({ has: page.getByRole('heading', { name, level: 3 }) });
      await expect(card, name).toHaveCount(1);
      await expect(card.locator('.price')).toContainText(price);
    }
  });

  test('shows the plan discounts', async ({ page }) => {
    await openSite(page);
    const strip = page.locator('#disc');
    for (const text of [
      'Pay quarterly, save 10%',
      'Pay yearly, save 20%',
      'Couples save 12%',
      'Teams of 5+ save 15%',
      'Students ₹999 with college ID',
    ]) {
      await expect(strip).toContainText(text);
    }
    await expect(page.locator('#planGrid .save')).toHaveText(['Save 10%', 'Save 20%', 'Save 12%']);
    await expect(page.getByText('Most loved')).toHaveCount(1);
    await expect(page.getByText('Best value')).toHaveCount(1);
  });

  test('offers three programs: Lift, Burn and Fuel', async ({ page }) => {
    await openSite(page);
    await expect(page.locator('#items .item-word')).toHaveText(['Lift', 'Burn', 'Fuel']);
    const programs = page.locator('#programs');
    await expect(programs).not.toContainText('Silambam');
    await expect(programs).not.toContainText('Flow');
  });

  test('has no batches section and no link to one', async ({ page }) => {
    await openSite(page);
    await expect(page.locator('#batches')).toHaveCount(0);
    await expect(page.locator('a[href="#batches"]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Batches that fit your day');
  });

  test('the ticker names only the current offer', async ({ page }) => {
    await openSite(page);
    const words = await page.locator('#mq li').allTextContents();
    expect(new Set(words)).toEqual(new Set(['Lift', 'Millet meals', 'Weight loss', 'Strength', 'Cardio']));
  });

  test('states 500+ clients and the 5:30 AM to 10:00 PM timings', async ({ page }) => {
    await openSite(page);
    const clients = page.locator('.stat strong[data-n="500"]');
    await clients.scrollIntoViewIfNeeded();
    await expect(clients).toHaveText('500+', { timeout: 6000 });
    const time = page.locator('.stat strong.time');
    await expect(time).toContainText('5:30 AM');
    await expect(time).toContainText('10:00 PM');
    await expect(page.locator('footer')).toContainText('Every day, 5:30 AM to 10:00 PM');
    await expect(page.locator('#why')).not.toContainText('Sample figures');
  });

  test('uses demo wording on every call to action', async ({ page }) => {
    await openSite(page);
    await expect(page.locator('#hcopy').getByRole('button', { name: 'Book your demo' })).toBeAttached();
    await expect(page.locator('.cta').getByRole('button', { name: 'Book a free demo' })).toBeAttached();
    const header = page.getByRole('button', { name: 'Book a demo' });
    if (isWide(page)) await expect(header).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/free week/i);
  });

  test('the calculator uses Asian BMI cut-offs and a South Indian meal plan', async ({ page }) => {
    await openSite(page);
    await expect(page.locator('#res')).toContainText('BMI (Asian cut-offs)');
    await expect(page.locator('#meal')).toContainText('A sample day on a Tamil Nadu plate');
    for (const food of ['idli', 'sambar', 'rice']) await expect(page.locator('#meal')).toContainText(food);
  });

  test('every WhatsApp link opens safely in a new tab', async ({ page }) => {
    await openSite(page);
    const links = page.locator('a[href^="https://wa.me/"]');
    expect(await links.count()).toBeGreaterThanOrEqual(3);
    for (const a of await links.all()) {
      await expect(a).toHaveAttribute('target', '_blank');
      await expect(a).toHaveAttribute('rel', /noopener/);
    }
  });

  test('the coaches dialog lists the team', async ({ page }) => {
    await openSite(page);
    await jumpTo(page, 0);
    await page.getByRole('button', { name: 'Meet the coaches' }).evaluate((b: HTMLElement) => b.click());
    const dialog = page.getByRole('dialog', { name: 'Your coaches' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Priya Raman');
    await expect(dialog).not.toContainText('Silambam');
    await expect(dialog).not.toContainText('yoga');
  });

  test('shows the Tiruchengode address and nothing from the old one', async ({ page }) => {
    await openSite(page);
    const footer = page.locator('footer');
    await expect(footer).toContainText('45/3, Vellalar Colony, Koottapalli Colony, Namakkal, Post Tiruchengode Road, TCS Nagar');
    await expect(footer).toContainText('Tiruchengode 637214, Tamil Nadu');
    for (const old of ['Coimbatore', 'RS Puram', 'Park Avenue', '641002']) {
      await expect(page.locator('body'), old).not.toContainText(old);
    }
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent())!);
    expect(ld.address.postalCode).toBe('637214');
    expect(ld.address.addressLocality).toBe('Tiruchengode');
    expect(ld.address.streetAddress).toContain('Vellalar Colony');
  });

  test('the footer address and hours are in Tamil when the language is Tamil', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('fnf-lang', 'ta'));
    await openSite(page);
    await expect(page.locator('footer')).toContainText('திருச்செங்கோடு 637214, தமிழ்நாடு');
    await expect(page.locator('footer')).toContainText('இரவு 10:00');
  });
});
