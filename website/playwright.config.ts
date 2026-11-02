import { defineConfig, devices } from '@playwright/test';

const PORT = 4174;

// The website is plain static files (index.html + assets/), so the tests serve the folder as-is
// with http-server. Nothing is built, and no request leaves the machine: tests/fixtures/test.ts
// stubs the Google Fonts requests so the layout is measured with the same fallback fonts everywhere.
//
// Project names follow frontend/playwright.config.ts (desktop-chrome, mobile-chrome, mobile-safari)
// and add the browsers and sizes a marketing site is judged on:
//   desktop-chrome   Chromium, 1440 x 900
//   desktop-firefox  Firefox,  1440 x 900
//   desktop-safari   WebKit,   1440 x 900
//   desktop-edge     Microsoft Edge (opt-in: PW_EDGE=1, needs Edge installed)
//   tablet           Chromium, 820 x 1180 touch      (iPad Air portrait size)
//   tablet-safari    WebKit,   iPad (gen 7)
//   mobile-chrome    Pixel 7
//   mobile-safari    iPhone 13
//   small-phone      Chromium, 360 x 740 touch       (the smallest phone we support)
//
// WebKit is not iOS Safari: safe-area insets, focus zoom and address-bar behaviour still need a
// manual pass on a real device.
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } } },
    { name: 'desktop-safari', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
    ...(process.env.PW_EDGE
      ? [{ name: 'desktop-edge', use: { ...devices['Desktop Edge'], channel: 'msedge', viewport: { width: 1440, height: 900 } } }]
      : []),
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true },
    },
    { name: 'tablet-safari', use: { ...devices['iPad (gen 7)'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 13'] } },
    {
      name: 'small-phone',
      use: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 }, deviceScaleFactor: 2 },
    },
  ],
  webServer: {
    command: `npx http-server . -p ${PORT} -c-1 --silent`,
    url: `http://localhost:${PORT}`,
    // Never reuse: a stale server from an earlier run could serve old files.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
