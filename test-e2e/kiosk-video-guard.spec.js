// www/kiosk-video-guard.js (v3) against the served kiosk-candidate dashboard, WITHOUT deploying the
// script: it is injected as a module via a route + init script. Bound to the `kiosk` project
// (3440x1440) in playwright.config.js. Nothing here writes to HA: logToHA is off, because the
// guard's logbook.log call would land in the live logbook.
//
// Thresholds are shortened through window.kioskVideoGuardOverrides; production defaults (10 s tick,
// 90 s grace, 45 s stall, 25 s settle, ...) are covered by the node unit tests.
// This is Chromium: it has getVideoPlaybackQuality and requestVideoFrameCallback but not the
// Firefox-only moz* counters. The soft restart has only ever been exercised here, not in Firefox.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { authenticate, openDashboard, DEEP_QUERY_ALL } = require('./helpers');

const SOURCE = fs.readFileSync(path.join(__dirname, '../www/kiosk-video-guard.js'), 'utf8');
const SCRIPT_URL = '/__kvg-test/kiosk-video-guard.js';
const FAST = {
  tickMs: 1000, graceMs: 15000, firstSummaryMs: 20000, summaryEveryMs: 600000,
  stallMs: 8000, neverStartedMs: 40000, settleMs: 8000, verifyFreshMs: 5000, cooldownMs: 30000,
  logGapMs: 600000, globalBackoffMs: 60000, logToHA: false,
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

const filterHls = (errors) => errors.filter((e) => !/^Failed to load resource.*\[\/api\/hls\//.test(e));

// Tag the six camera <video> elements so we can prove which were replaced. Done only once all six are
// playing: HA's own player swaps <video> elements while the page settles after load.
const tagVideos = (page) =>
  page.evaluate((walk) => {
    window.__marker = 'alive';
    const vids = eval(walk)(document, []).filter((v) => v.getBoundingClientRect().width > 0);
    vids.forEach((v, i) => (v.__tag = i + 1));
    return vids.length;
  }, WALK);

const waitAllLive = (page) =>
  expect
    .poll(async () => {
      const s = await status(page);
      return s && s.videos.length === VIDEOS && s.videos.every((v) => v.live.includes('tvf') && v.live.includes('rvfc') && v.signals.rvfc.ageMs < 3000);
    }, { timeout: 35000, intervals: [1000] })
    .toBe(true);

// Stall the first visible video the way a stuck decoder would look: paused and its stream dropped.
// No listener is left behind (a leftover 'play' handler would fight the soft restart).
const stallOne = (page) =>
  page.evaluate((walk) => {
    const v = eval(walk)(document, []).find((x) => x.getBoundingClientRect().width > 0);
    v.pause();
    v.srcObject = null;
    for (let n = v; n; n = n.parentNode || n.host) if (n.stateObj?.entity_id) return n.stateObj.entity_id;
  }, WALK);

// Per-entity frames counter and element tag, read live (the element may be reused or replaced).
const probe = (page) =>
  page.evaluate((walk) => {
    const out = {};
    for (const v of eval(walk)(document, []).filter((x) => x.getBoundingClientRect().width > 0)) {
      let id;
      for (let n = v; n; n = n.parentNode || n.host) if (n.stateObj?.entity_id) { id = n.stateObj.entity_id; break; }
      out[id] = { tag: v.__tag || null, frames: v.getVideoPlaybackQuality().totalVideoFrames, paused: v.paused, hasSrc: !!v.srcObject };
    }
    return out;
  }, WALK);

test.describe('kiosk video guard v3', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
  });

  test('OBSERVE mode: logs WOULD-SOFT-RESTART for a stalled video and changes NOTHING', async ({ page }) => {
    await inject(page, { ...FAST, mode: 'observe', allowedPaths: ['/kiosk-candidate'] });
    const errors = await openDashboard(page, 'kiosk-candidate');
    await waitAllLive(page);
    expect(await tagVideos(page)).toBe(VIDEOS);
    const s = await status(page);
    expect(s.mode).toBe('observe');
    expect(s.videos.every((v) => /^camera\./.test(v.entity) && v.verdict === 'ok')).toBe(true);
    expect(s.videos.every((v) => v.signals.painted === undefined && v.signals.decoded === undefined)).toBe(true); // Chromium: no moz*

    const stalledKey = await stallOne(page);
    await expect.poll(async () => (await logs(page)).some((l) => l.kind === 'would-restart'), { timeout: 40000, intervals: [1000] }).toBe(true);
    await expect.poll(async () => (await logs(page)).some((l) => l.kind === 'summary'), { timeout: 30000, intervals: [1000] }).toBe(true);
    const all = await logs(page);
    const wr = all.filter((l) => l.kind === 'would-restart');
    console.log('would-restart:', JSON.stringify(wr));
    expect(wr).toHaveLength(1);
    expect(wr[0].entity).toBe(stalledKey);
    expect(wr[0].message).toMatch(new RegExp(`^WOULD-SOFT-RESTART ${stalledKey.replace('.', '\\.')}: flat for \\d+ s on tvf,rvfc$`));
    const sum = all.find((l) => l.kind === 'summary');
    console.log('summary:', sum.message);
    expect(sum.message).toMatch(/^(Chrome|Firefox) [\d.]+ \| mode=observe \| 6 videos \| camera\.bi_\w+: tvf=\d+(\(stale \d+s\))? painted=n\/a decoded=n\/a parsed=n\/a rvfc=\d+(\(stale \d+s\))? ct=ok \d+x\d+ rs=\d paused=[01] trk=\S+ live=tvf,rvfc( ; |$)/);
    expect(all.some((l) => ['restarted', 'escalate'].includes(l.kind))).toBe(false);

    // Observe: still paused with its stream dropped, every element still tagged, no navigation, no storage.
    const p = await probe(page);
    expect(Object.keys(p)).toHaveLength(VIDEOS);
    expect(Object.values(p).every((v) => v.tag)).toBe(true);
    expect(p[stalledKey]).toMatchObject({ paused: true, hasSrc: false });
    expect(await page.evaluate(() => window.__marker)).toBe('alive');
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /kioskVideoGuard/.test(k)))).toEqual([]);
    expect(filterHls(errors)).toEqual([]);
  });

  test('ACT mode: soft-restarts ONLY the stalled stream; the other five and the page are untouched', async ({ page }) => {
    await inject(page, { ...FAST, mode: 'act', allowedPaths: ['/kiosk-candidate'] });
    const errors = await openDashboard(page, 'kiosk-candidate');
    await waitAllLive(page);
    expect(await tagVideos(page)).toBe(VIDEOS);
    const before = await probe(page);

    const stalledKey = await stallOne(page);
    const t0 = Date.now();
    await expect.poll(async () => (await logs(page)).some((l) => l.kind === 'restarted'), { timeout: 40000, intervals: [500] }).toBe(true);
    console.log(`soft restart logged ${Math.round((Date.now() - t0) / 1000)} s after the stall`);

    // The stalled camera recovers: stream back, playing, frames advancing again.
    await expect
      .poll(async () => {
        const p = (await probe(page))[stalledKey];
        return !!p && !p.paused && p.hasSrc && p.frames > 0;
      }, { timeout: 20000, intervals: [500] })
      .toBe(true);
    const f1 = (await probe(page))[stalledKey].frames;
    await page.waitForTimeout(3000);
    const after = await probe(page);
    expect(after[stalledKey].frames).toBeGreaterThan(f1);

    // Past the settle period the guard has verified it: no failures, no escalation, one restart only.
    await expect.poll(async () => (await status(page)).cams[stalledKey]?.verifying, { timeout: 20000, intervals: [500] }).toBe(false);
    const st = await status(page);
    expect(st.cams[stalledKey].failures).toEqual([]);
    const all = await logs(page);
    const restarts = all.filter((l) => l.kind === 'restarted');
    console.log('restarted:', JSON.stringify(restarts));
    expect(restarts).toHaveLength(1);
    expect(restarts[0].entity).toBe(stalledKey);
    expect(restarts[0].message).toMatch(new RegExp(`^Soft-restarted ${stalledKey.replace('.', '\\.')} \\(flat for \\d+ s on tvf,rvfc\\)$`));
    expect(all.some((l) => l.kind === 'escalate')).toBe(false);

    // The other five: same elements (untouched), frames kept counting, never restarted.
    for (const k of Object.keys(before).filter((k) => k !== stalledKey)) {
      expect(after[k].tag, k).toBe(before[k].tag);
      expect(after[k].frames, k).toBeGreaterThan(before[k].frames);
      expect(restarts.some((r) => r.entity === k)).toBe(false);
    }
    // No navigation, no full reload, no storage written.
    expect(await page.evaluate(() => window.__marker)).toBe('alive');
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /kioskVideoGuard/.test(k)))).toEqual([]);
    expect(filterHls(errors)).toEqual([]);
  });

  test('is a complete no-op outside its allowed paths (even in act mode)', async ({ page }) => {
    // Default allow-list (/kiosk-main) against the candidate URL, thresholds short enough that an
    // active guard would have acted by now.
    const served = await inject(page, { ...FAST, mode: 'act', graceMs: 1000, firstSummaryMs: 2000, stallMs: 2000 });
    await openDashboard(page, 'kiosk-candidate');
    await page.evaluate(() => (window.__beforeReload = true));
    await stallOne(page); // an active guard in act mode would have soft-restarted this by now
    await page.waitForTimeout(12000);
    expect(served.count).toBe(1); // the module did load and run; it chose to do nothing
    expect(await page.evaluate(() => window.__beforeReload)).toBe(true);
    expect(await page.evaluate(() => 'kioskVideoGuard' in window)).toBe(false);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /kioskVideoGuard/.test(k)))).toEqual([]);
  });
});
