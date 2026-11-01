// www/kiosk-video-guard.js (OBSERVE-ONLY v2) against the served kiosk-candidate dashboard, WITHOUT
// deploying the script: it is injected as a module via a route + init script. Bound to the `kiosk` project
// (3440x1440) in playwright.config.js. Nothing here writes to HA: logToHA is off, because the
// guard's logbook.log call would land in the live logbook.
//
// Thresholds are shortened through window.kioskVideoGuardOverrides; production defaults are
// 10 s tick / 90 s grace / 120 s first summary / 45 s WOULD-RESTART (covered by the node unit tests).
// This is Chromium: it supports getVideoPlaybackQuality and requestVideoFrameCallback but not the
// Firefox-only moz* counters, which the unit tests cover with fake elements.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { authenticate, openDashboard, DEEP_QUERY_ALL } = require('./helpers');

const SOURCE = fs.readFileSync(path.join(__dirname, '../www/kiosk-video-guard.js'), 'utf8');
const SCRIPT_URL = '/__kvg-test/kiosk-video-guard.js';
const FAST = {
  tickMs: 1000, graceMs: 15000, firstSummaryMs: 20000, summaryEveryMs: 600000,
  wouldRestartMs: 8000, wouldRestartGapMs: 600000, logToHA: false,
};
const VIDEOS = 6;

async function inject(page, overrides) {
  const served = { count: 0 };
  // The dashboard also loads the DEPLOYED copy as a lovelace resource. Stub it out, otherwise it
  // would run alongside the injected copy under test and share window.kioskVideoGuard.
  await page.route('**/local/kiosk-video-guard.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'export {};' }));
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
const logs = (page) => page.evaluate(() => window.kioskVideoGuard ? window.kioskVideoGuard.logs.slice() : []);

// All <video> elements, through shadow roots (the repo's DEEP_QUERY_ALL walker).
const WALK = `(root, out) => eval(${JSON.stringify(DEEP_QUERY_ALL)})('video')`;

test.describe('kiosk video guard (observe-only)', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
  });

  test('observes six videos; a stalled one logs WOULD-RESTART and NOTHING is reloaded or changed', async ({ page }) => {
    await inject(page, { ...FAST, allowedPaths: ['/kiosk-candidate'] });
    const errors = await openDashboard(page, 'kiosk-candidate');

    await expect
      .poll(async () => {
        const s = await status(page);
        return s && s.videos.length === VIDEOS && s.videos.every((v) => v.signals.tvf?.everProgressed && v.signals.rvfc?.everProgressed && v.signals.rvfc.ageMs < 3000);
      }, { timeout: 35000, intervals: [1000] })
      .toBe(true);
    // Tag the page and the six camera <video> elements, to prove the guard replaces nothing. Done only once
    // all six are playing: HA's own player swaps <video> elements while the page settles after load.
    await page.evaluate((walk) => {
      window.__marker = 'alive';
      const vids = eval(walk)(document, []).filter((v) => v.getBoundingClientRect().width > 0); // the six camera videos; the page has other, hidden ones that come and go
      vids.forEach((v, i) => (v.__tag = i + 1));
      window.__videoCount = vids.length;
    }, WALK);

    const s = await status(page);
    console.log('videos:', JSON.stringify(s.videos.map((v) => ({ k: v.key, signals: Object.keys(v.signals), meta: v.meta }))));
    expect(s.observeOnly).toBe(true);
    expect(s.videos.every((v) => /^camera\./.test(v.entity) && !v.wouldRestart)).toBe(true);
    expect(s.videos.every((v) => v.signals.painted === undefined && v.signals.decoded === undefined)).toBe(true); // Chromium: no moz*

    // Stall exactly one: pause it. Others keep running.
    const stalledKey = await page.evaluate((walk) => {
      const v = eval(walk)(document, []).find((x) => x.getBoundingClientRect().width > 0);
      v.pause();
      for (let n = v; n; n = n.parentNode || n.host) if (n.stateObj?.entity_id) return n.stateObj.entity_id;
    }, WALK);

    await expect.poll(async () => (await logs(page)).some((l) => l.kind === 'would-restart'), { timeout: 40000, intervals: [1000] }).toBe(true);
    const wr = (await logs(page)).filter((l) => l.kind === 'would-restart');
    console.log('would-restart:', JSON.stringify(wr));
    expect(wr).toHaveLength(1); // only the stalled camera, and throttled (no repeat)
    expect(wr[0].entity).toBe(stalledKey);
    expect(wr[0].message).toMatch(new RegExp(`^WOULD-RESTART ${stalledKey.replace('.', '\\.')}: no progress on tvf,rvfc for \\d+ s \\(tvf=\\d+s rvfc=\\d+s\\)$`));

    // The summary line (first one at 20 s after load) has the documented shape.
    await expect.poll(async () => (await logs(page)).some((l) => l.kind === 'summary'), { timeout: 30000, intervals: [1000] }).toBe(true);
    const sum = (await logs(page)).find((l) => l.kind === 'summary');
    console.log('summary:', sum.message);
    expect(sum.message).toMatch(/^(Chrome|Firefox) [\d.]+ \| 6 videos \| camera\.bi_\w+: tvf=\d+(\(stale \d+s\))? painted=n\/a decoded=n\/a parsed=n\/a rvfc=\d+(\(stale \d+s\))? ct=ok \d+x\d+ rs=\d paused=[01] trk=\S+( ; |$)/);

    // Observe-only: no navigation, same elements, nothing written to storage.
    const after = await page.evaluate((walk) => {
      const vids = eval(walk)(document, []).filter((v) => v.getBoundingClientRect().width > 0);
      return { marker: window.__marker, count: vids.length, tags: vids.map((v) => v.__tag).filter(Boolean).length, stalledStillPaused: vids.some((v) => v.paused), keys: Object.keys(localStorage).filter((k) => /kioskVideoGuard/.test(k)) };
    }, WALK);
    expect(after.marker).toBe('alive');
    expect(after.count).toBe(await page.evaluate(() => window.__videoCount));
    expect(after.tags).toBe(after.count);
    expect(after.stalledStillPaused).toBe(true); // we did not un-pause or replace it
    expect(after.keys).toEqual([]);
    // Console clean, except HLS resource-load failures from HA's own stream component (400s as in
    // dashboard-tests.js, and an occasional 404 on master_playlist.m3u8 - seen with no guard loaded at all).
    expect(errors.filter((e) => !/^Failed to load resource.*\[\/api\/hls\//.test(e))).toEqual([]);
  });

  test('is a complete no-op outside its allowed paths', async ({ page }) => {
    // Default allow-list (/kiosk-main) against the candidate URL, with thresholds short enough that
    // an active guard would have logged by now.
    const served = await inject(page, { ...FAST, graceMs: 1000, firstSummaryMs: 2000, wouldRestartMs: 2000 });
    await openDashboard(page, 'kiosk-candidate');
    await page.evaluate(() => (window.__beforeReload = true));
    await page.waitForTimeout(12000);
    expect(served.count).toBe(1); // the module did load and run; it chose to do nothing
    expect(await page.evaluate(() => window.__beforeReload)).toBe(true);
    expect(await page.evaluate(() => 'kioskVideoGuard' in window)).toBe(false);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /kioskVideoGuard/.test(k)))).toEqual([]);
  });
});
