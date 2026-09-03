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
// Currently empty. The one entry this started with (bramkragten/weather-card, loaded from
// cdn.jsdelivr.net and throwing on every page load) was removed from configuration.yaml on
// 2026-08-22 rather than tolerated — no dashboard used it. Keep this list empty if you can.
const KNOWN_ISSUES = [];

// Card geometry drifts by a pixel with sub-pixel layout rounding; anything larger is a real move.
const BOX_TOLERANCE_PX = 2;

// Cards whose height legitimately varies between runs, keyed by dashboard name then by card
// index, listing every height that card is allowed to take. The baseline cannot pin these, but
// they are not exempt from checking either: the height still has to be one of the listed values,
// so a card that genuinely breaks is still caught.
//
// wall card 1 is the `camera.cameras_wallpanel_cycle` picture-entity. The card is sized so a
// standard 16:9 camera stream fills the height available to it; when the cycle reaches the
// dual-lens camera the view is far wider, so the card shrinks vertically to keep the stream to
// scale. Both heights are correct — which one a run sees depends only on where the cycle
// happens to be at that moment. Measured by sampling every 2s for 3.5 minutes on 2026-09-04:
// 591px (69 samples) and 293px (41 samples), and nothing else. If a third camera aspect ratio
// is ever added to the cycle, its height goes here — do not widen this to "ignore the height".
const VARIABLE_CARD_HEIGHTS = {
  wall: { 1: [591, 293] },
};

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

      const variableHeights = VARIABLE_CARD_HEIGHTS[name] || {};

      const moved = [];
      const unexpectedHeights = [];

      boxes.forEach((b, i) => {
        const base = baseline[i];
        const allowed = variableHeights[i];

        // A card with a legitimately variable height is still pinned on x, y and width — only
        // the height is judged against its allow-list instead of the baseline.
        const pinned = allowed ? ['x', 'y', 'w'] : ['x', 'y', 'w', 'h'];
        if (pinned.some((k) => Math.abs(b[k] - base[k]) > BOX_TOLERANCE_PX)) {
          moved.push(`  card ${i}: ${JSON.stringify(base)} → ${JSON.stringify(b)}`);
        }

        if (allowed && !allowed.some((h) => Math.abs(b.h - h) <= BOX_TOLERANCE_PX)) {
          unexpectedHeights.push(
            `  card ${i}: height ${b.h} is not one of the expected ${allowed.join(' or ')}`,
          );
        }
      });

      expect(
        moved,
        `cards moved unexpectedly. If intended, re-run with UPDATE_BASELINE=1 and commit the new baseline:\n${moved.join('\n')}`,
      ).toEqual([]);

      expect(
        unexpectedHeights,
        `a card with a known set of valid heights rendered at none of them — see VARIABLE_CARD_HEIGHTS:\n${unexpectedHeights.join('\n')}`,
      ).toEqual([]);
    });
  });
}

module.exports = { dashboardTests, TARGET };
