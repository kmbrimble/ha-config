const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { authenticate, openDashboard, cardBoxes } = require('./helpers');

// Which copy of each dashboard to test. The candidate is the default because that is the
// development loop (CLAUDE.md, the candidate-dashboard workflow): edit candidate, deploy
// candidate, test candidate, and only promote to live once green.
//   npm run test:e2e                  → candidate
//   TARGET=live npm run test:e2e      → live, for a post-deploy check
const TARGET = process.env.TARGET === 'live' ? 'live' : 'candidate';

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const BASELINE_DIR = path.join(__dirname, 'baselines');

// Console noise that is not ours and not actionable from this repo. Keep this list short and
// justified — every entry is a real error being deliberately ignored.
const IGNORED_CONSOLE = [
  /Failed to load resource.*camera_proxy/i, // camera thumbnails 404 while a stream is down
  /ERR_INTERNET_DISCONNECTED/i,
];

// Pre-existing defects that fire on every dashboard, including known-good ones. These are NOT
// noise — they are real bugs that predate this harness, listed here so the suite can still give
// a signal on new breakage. Fix the underlying issue and delete the entry.
//
//  - weather-card: configuration.yaml loads bramkragten/weather-card from cdn.jsdelivr.net.
//    It throws on every load and is the only frontend resource still fetched from an external
//    CDN rather than /hacsfiles. Seen on all four dashboards as of 2026-08-22.
const KNOWN_ISSUES = [/weather-card(\.min)?\.js/i, /Cannot convert undefined or null to object/i];

// Card geometry drifts by a pixel with sub-pixel layout rounding; anything larger is a real move.
const BOX_TOLERANCE_PX = 2;

/**
 * Build the suite for one dashboard.
 *
 * Each dashboard is laid out for exactly one display and is only correct at that display's
 * resolution, so each spec file is bound to its own project in playwright.config.js via
 * testMatch. That pairing is what stops a dashboard ever being measured at the wrong size —
 * it is not a convention, it is enforced by the config.
 */
function dashboardTests(name, { candidate, live }) {
  const urlPath = TARGET === 'live' ? live : candidate;

  test.describe(`${name} dashboard (${urlPath})`, () => {
    test.beforeEach(async ({ page }) => {
      await authenticate(page);
    });

    test('renders, is error-free, and fits the display', async ({ page }, testInfo) => {
      const consoleErrors = await openDashboard(page, urlPath);
      const { width, height } = page.viewportSize();

      // Artefact for the human. Not a pass/fail signal — visual correctness is a human
      // judgement and these dashboards are full of live values (CLAUDE.md).
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      const shot = path.join(SCREENSHOT_DIR, `${name}-${TARGET}-${width}x${height}.png`);
      await page.screenshot({ path: shot });
      await testInfo.attach(`${name} at ${width}x${height}`, { path: shot, contentType: 'image/png' });

      // 1. It rendered at all.
      const cards = await page.locator('ha-card').count();
      expect(cards, 'dashboard rendered no cards').toBeGreaterThan(0);

      // 2. No error cards, and no missing custom elements or entities. These use locators rather
      // than body.innerText because innerText does not cross a shadow boundary and every HA card
      // lives inside one — an innerText check here silently passes on a page full of errors.
      expect(await page.locator('hui-error-card').count(), 'hui-error-card present').toBe(0);
      expect(
        await page.getByText("Custom element doesn't exist").count(),
        'a custom card failed to load — check its HACS resource',
      ).toBe(0);
      expect(
        await page.getByText('Entity not found').count(),
        'a card references an entity that no longer exists',
      ).toBe(0);

      // 3. Console clean.
      const realErrors = consoleErrors.filter(
        (e) => ![...IGNORED_CONSOLE, ...KNOWN_ISSUES].some((p) => p.test(e)),
      );
      expect(realErrors, `console errors during load:\n${realErrors.join('\n')}`).toEqual([]);

      // 4. No horizontal overflow at the target resolution. This is the assertion that catches a
      // card too wide for the display, which on the real hardware means a clipped or
      // scrolling layout.
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth, `content overflows ${width}px wide display`).toBeLessThanOrEqual(width);
    });

    test('card layout has not shifted', async ({ page }) => {
      await openDashboard(page, urlPath);
      const boxes = await cardBoxes(page);

      fs.mkdirSync(BASELINE_DIR, { recursive: true });
      const baselineFile = path.join(BASELINE_DIR, `${name}-${TARGET}.json`);

      if (process.env.UPDATE_BASELINE || !fs.existsSync(baselineFile)) {
        fs.writeFileSync(baselineFile, `${JSON.stringify(boxes, null, 2)}\n`);
        test.skip(
          true,
          `baseline written to ${path.relative(process.cwd(), baselineFile)} — commit it, then this test compares against it`,
        );
        return;
      }

      const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
      expect(
        boxes.length,
        `card count changed (${baseline.length} → ${boxes.length}). If intended, re-run with UPDATE_BASELINE=1 and commit the new baseline.`,
      ).toBe(baseline.length);

      const moved = boxes
        .map((b, i) => ({ i, b, base: baseline[i] }))
        .filter(({ b, base }) =>
          ['x', 'y', 'w', 'h'].some((k) => Math.abs(b[k] - base[k]) > BOX_TOLERANCE_PX),
        )
        .map(({ i, b, base }) => `  card ${i}: ${JSON.stringify(base)} → ${JSON.stringify(b)}`);

      expect(
        moved,
        `cards moved unexpectedly. If intended, re-run with UPDATE_BASELINE=1 and commit the new baseline:\n${moved.join('\n')}`,
      ).toEqual([]);
    });
  });
}

module.exports = { dashboardTests, TARGET };
