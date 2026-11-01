// www/kiosk-video-guard.js against the served kiosk-candidate dashboard, WITHOUT deploying the
// script: it is injected as a module via a route + init script. Bound to the `kiosk` project
// (3440x1440) in playwright.config.js. Nothing here writes to HA: logToHA is off, because the
// guard's logbook.log call would land in the live logbook.
//
// Thresholds are shortened through window.kioskVideoGuardOverrides; production defaults are
// 10 s tick / 90 s grace / 45 s stall / 90 s never-started (covered by the node unit tests).
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { authenticate, openDashboard } = require('./helpers');

const SOURCE = fs.readFileSync(path.join(__dirname, '../www/kiosk-video-guard.js'), 'utf8');
const SCRIPT_URL = '/__kvg-test/kiosk-video-guard.js';
const FAST = { tickMs: 1000, graceMs: 15000, stallMs: 8000, neverStartedMs: 40000, logToHA: false };
const VIDEOS = 6;

async function inject(page, overrides) {
  const served = { count: 0 };
  await page.route('**' + SCRIPT_URL, (r) => {
    served.count++;
    return r.fulfill({ contentType: 'text/javascript', body: SOURCE });
  });
  await page.addInitScript(
    ([o, src]) => {
      if (window !== window.top) return;
      window.kioskVideoGuardOverrides = o;
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('script');
        s.type = 'module';
        s.src = src;
        document.head.append(s);
      });
    },
    [overrides, SCRIPT_URL],
  );
  return served;
}

const status = (page) => page.evaluate(() => window.kioskVideoGuard && window.kioskVideoGuard.status());

test.describe('kiosk video guard', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
  });

  test('tracks all six videos, then reloads when one is stalled', async ({ page }) => {
    await inject(page, { ...FAST, allowedPaths: ['/kiosk-candidate'] });
    const errors = await openDashboard(page, 'kiosk-candidate');
    await page.evaluate(() => (window.__beforeReload = true));

    // All six found and progressing (every one has moved within the last 3 s).
    await expect
      .poll(async () => {
        const s = await status(page);
        return s && s.videos.length === VIDEOS && s.videos.every((v) => v.everProgressed && v.msSinceProgress < 3000);
      }, { timeout: 35000, intervals: [1000] })
      .toBe(true);
    const s = await status(page);
    console.log('videos:', JSON.stringify(s.videos));
    expect(s.videos.every((v) => /^camera\./.test(v.entity))).toBe(true);
    expect(s.lastAction).toBeNull();

    // Stall exactly one: pause it. Others keep running, so only a per-video check can fire.
    await page.evaluate(() => {
      const walk = (root, out) => {
        out.push(...root.querySelectorAll('video'));
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot, out);
        return out;
      };
      const v = walk(document, []).find((x) => x.getBoundingClientRect().width > 0);
      // The HA player may call play() again; keep it frozen the way a stuck decoder would be.
      v.addEventListener('play', () => v.pause());
      v.pause();
    });
    const t0 = Date.now();
    // stallMs 8 s + a tick, with slack. Any extra wait means the guard missed it.
    await page.waitForFunction(() => !window.__beforeReload, null, { timeout: 25000, polling: 500 });
    console.log(`reloaded ${Math.round((Date.now() - t0) / 1000)}s after the stall`);

    // After the reload the guard is back, remembers it reloaded, and has not complained.
    await expect.poll(async () => (await status(page))?.reloads.length, { timeout: 15000 }).toBe(1);
    expect(errors.filter((e) => /video-guard/i.test(e))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('is a complete no-op outside its allowed paths', async ({ page }) => {
    // Default allow-list (/kiosk-main) against the candidate URL, with a video paused and
    // thresholds short enough that an active guard would have reloaded.
    const served = await inject(page, { ...FAST, graceMs: 1000, stallMs: 2000, neverStartedMs: 4000 });
    await openDashboard(page, 'kiosk-candidate');
    await page.evaluate(() => (window.__beforeReload = true));
    await page.waitForTimeout(12000); // an active guard would have reloaded by now
    expect(served.count).toBe(1); // the module did load and run; it chose to do nothing
    expect(await page.evaluate(() => window.__beforeReload)).toBe(true);
    expect(await page.evaluate(() => 'kioskVideoGuard' in window)).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('kioskVideoGuard.reloads'))).toBeNull();
  });
});
