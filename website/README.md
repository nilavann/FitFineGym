# FitNFine website

The public marketing site for FitNFine Gym: a pinned scroll hero, a training film, a weight-loss
calculator with South Indian meal plans, programs, six membership plans, testimonials and a
free-demo booking form. It is plain static HTML, CSS and JavaScript. There is no build step and it
does not touch Supabase or the gym-management app in `frontend/`.

English and Tamil are built in (toggle in the header). Bookings are not sent anywhere yet: the form
validates and builds a pre-filled WhatsApp message (`https://wa.me/?text=...`) the visitor can send.

## Layout

```
website/
  index.html              the page
  assets/
    css/site.css          all styles (colour tokens in :root)
    js/media.js           map of image and video paths used by app.js
    js/app.js             behaviour: pinned hero, language, calculator, dialogs, menu
    img/                  photos (Pexels contributors, free licence) and logo.png
    video/film.mp4        17 s training film cut from those photos
  tests/                  Playwright specs (below)
  playwright.config.ts    browser and device projects
```

Colours come from the FF Gym logo: orange `#F28322`, yellow `#FCF00C`, black `#0F0F0F`.

## Run it

```bash
cd website
npm install
npm start            # http://localhost:4174
```

## Test it

```bash
npm run browsers     # once: downloads Chromium, Firefox and WebKit (+ system deps)
npm test             # every project below
npm run test:chromium   # only the Chromium-based projects (no Firefox/WebKit needed)
npm run test:mobile     # Pixel 7, iPhone 13 and the 360px phone
npm run test:report     # open the HTML report, including the per-section screenshots
npm run typecheck
```

The suite serves this folder with `http-server`, never reuses a running server, and answers the
Google Fonts requests with empty files so every browser measures the same fallback fonts and the
tests work offline.

### Browser and device projects

| Project | Engine | Viewport |
|---|---|---|
| `desktop-chrome` | Chromium | 1440 x 900 |
| `desktop-firefox` | Firefox | 1440 x 900 |
| `desktop-safari` | WebKit | 1440 x 900 |
| `desktop-edge` | Microsoft Edge (opt in: `PW_EDGE=1`, needs Edge installed) | 1440 x 900 |
| `tablet` | Chromium, touch | 820 x 1180 |
| `tablet-safari` | WebKit, iPad (gen 7) | device default |
| `mobile-chrome` | Chromium, Pixel 7 | device default |
| `mobile-safari` | WebKit, iPhone 13 | device default |
| `small-phone` | Chromium, touch | 360 x 740 |

Project names match `frontend/playwright.config.ts` where they overlap.

### What the specs check

- `smoke.spec.ts`: metadata, no console errors or exceptions while scrolling the whole page, every
  local asset returns 200, the logo and hero photo decode, the film is wired, images have alt text.
- `responsive.spec.ts` (English and Tamil): no sideways scroll at any scroll position, one
  navigation pattern at a time (links above 1000px, menu button below), plan grid columns (3, 2, 1),
  nutrition panel stacking, 44px touch targets and 16px form fields on phones, no clipped headings.
- `hero.spec.ts`: the pinned hero (photo card grows to full bleed, title turns white, copy and demo
  button fade in), header tone and hide-on-scroll, and the reduced-motion version.
- `content.spec.ts`: the six plans and their prices, discounts, the three programs, no batches
  section, ticker words, 500+ clients and 5:30 AM to 10:00 PM timings, demo wording, WhatsApp links.
- `interactions.spec.ts`: language switch and persistence, calculator, veg and non-veg meal panel
  (photo swaps), program and plan dialogs, booking form validation (Indian mobile numbers) and
  success state, testimonials, film pause, mobile menu.
- `seo.spec.ts`: title and description length, canonical, share tags and image size, structured
  data, heading outline, crawlable images, in-page links, robots, sitemap and manifest.
- `location.spec.ts`: the Find the gym section, map embed at the exact pin, Google Maps and
  directions links, copy-address button, map data in the structured data, nav link, Tamil text.
- `views.spec.ts`: one screenshot per key section in English and Tamil, attached to the HTML
  report for every project so a person can look at each viewport. These are not pixel baselines,
  because font rendering differs between operating systems.

## SEO and sharing

Already set up in `index.html` and the files next to it:

- `<title>`, meta description, `robots`, canonical URL, `lang`, theme colour
- Open Graph and Twitter share tags with a 1200 x 630 share image (`assets/img/og-image.jpg`)
- `ExerciseGym` structured data (JSON-LD): name, address, phone, 5:30 AM to 10:00 PM hours, price range
- `robots.txt`, `sitemap.xml`, `site.webmanifest` and favicon / home-screen icons
- real `src` attributes on page images (crawlers do not need to run scripts), lazy loading below
  the fold, and the hero photo preloaded
- one `h1` and a clean heading outline

**Before launch, point it at your real domain** (the files use `https://www.fitnfine.example`):

```bash
npm run set-domain -- https://www.yourgym.in
```

Then check the structured data values (address, phone, hours, price range) match reality, and
register the site in Google Search Console and a Google Business Profile for local search.
`tests/seo.spec.ts` checks all of the above and that the files agree on one origin.

The language toggle is client side, so there is one URL. If you later want Tamil pages to rank
separately, give them their own URLs (for example `/ta/`) and add `hreflang` links.

## Location

The gym is "Fit&Fine (unisex) gym" on Google Maps (https://maps.app.goo.gl/YEXsZ4W4Y3BdDQwq6),
pinned at 11.3729575, 77.8745749. The Find the gym section shows the address and hours, an embedded
map (Google's no-key embed, loaded lazily), and buttons for the Maps listing, turn-by-turn
directions and copying the address. The footer has a Get directions link, and the JSON-LD carries
`geo`, `hasMap` and the Maps listing name as `alternateName`.

The tests stub the Google Maps request so they never depend on a third-party page. If the pin ever
moves, update the coordinates in `index.html` (iframe, directions links, JSON-LD) and in
`tests/location.spec.ts`.

### Limits

- WebKit is not iOS Safari. Safe-area insets, focus zoom and address-bar behaviour need a manual
  pass on a real iPhone or a hosted preview.
- `@playwright/test` is pinned to `1.63.0` to match the browsers pre-installed in the cloud
  sandbox. Bump it together with `npm run browsers` on your own machine if you prefer.
- Photos and the film are placeholders from free stock sources. All addresses, phone numbers,
  prices, GSTIN, coach names and testimonials are samples: replace them before launch.
