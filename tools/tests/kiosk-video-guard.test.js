// Unit tests for the pure logic in www/kiosk-video-guard.js (observe-only v2). Run: npm run test:unit
// The module is ESM; importing it in node is a no-op for the browser side (no window/document).
// Firefox-only signals cannot be exercised in Chromium, so they are tested here with fake elements.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const FILE = path.join(__dirname, '../../www/kiosk-video-guard.js');
const load = () => import(pathToFileURL(FILE).href);
const S = 1000;

const fakeVideo = (o = {}) => ({
  currentTime: 0, readyState: 4, paused: false, videoWidth: 1920, videoHeight: 536,
  srcObject: { getVideoTracks: () => [{ readyState: 'live', muted: false }] },
  ...o,
});

// Drive an entry through [secondsSinceStart, signals] samples.
async function run(samples) {
  const m = await load();
  let e;
  for (const [t, sig] of samples) e = m.updateEntry(e, sig, t * S);
  return { m, e };
}

test('observe-only by construction: no reload, no storage, no DOM mutation in the source', () => {
  const src = fs.readFileSync(FILE, 'utf8').replace(/\/\/.*$/gm, '');
  for (const bad of ['location.reload', 'localStorage', 'removeChild', 'appendChild', 'insertBefore', '.remove(', '.append(', 'srcObject =', '.pause(', '.play(', 'innerHTML']) {
    assert.ok(!src.includes(bad), bad);
  }
});

test('path allow-list: kiosk-main and sub-paths only', async () => {
  const { pathAllowed } = await load();
  const p = ['/kiosk-main'];
  assert.ok(pathAllowed('/kiosk-main', p) && pathAllowed('/kiosk-main/0', p));
  for (const bad of ['/wall-main', '/kiosk-mainx', '/kiosk-candidate', '/lovelace/0', '/']) assert.ok(!pathAllowed(bad, p), bad);
});

test('sampleOf: Chromium-like element (standard API only)', async () => {
  const { sampleOf } = await load();
  const v = fakeVideo({ getVideoPlaybackQuality: () => ({ totalVideoFrames: 812 }), currentTime: 5 });
  const { signals, meta } = sampleOf(v, 7);
  assert.deepEqual({ ...signals }, { tvf: 812, painted: null, decoded: null, parsed: null, rvfc: 7, ct: 5 });
  assert.deepEqual({ ...meta }, { rs: 4, paused: false, w: 1920, h: 536, trk: 'live/unmuted' });
});

test('sampleOf: Firefox-like element (tvf flat 0, moz* present, no rvfc)', async () => {
  const { sampleOf } = await load();
  const v = fakeVideo({ getVideoPlaybackQuality: () => ({ totalVideoFrames: 0 }), mozPaintedFrames: 812, mozDecodedFrames: 815, mozParsedFrames: 816 });
  const { signals } = sampleOf(v, null);
  assert.deepEqual({ ...signals }, { tvf: 0, painted: 812, decoded: 815, parsed: 816, rvfc: null, ct: 0 });
});

test('sampleOf: missing getVideoPlaybackQuality, no srcObject, muted track, odd values', async () => {
  const { sampleOf } = await load();
  assert.equal(sampleOf(fakeVideo({ srcObject: null })).meta.trk, 'no-src');
  assert.equal(sampleOf(fakeVideo({ srcObject: { getVideoTracks: () => [] } })).meta.trk, 'no-video-track');
  assert.equal(sampleOf(fakeVideo({ srcObject: { getVideoTracks: () => [{ readyState: 'ended', muted: true }] } })).meta.trk, 'ended/muted');
  const { signals } = sampleOf(fakeVideo({ mozPaintedFrames: 'x', mozDecodedFrames: NaN, getVideoPlaybackQuality: () => { throw new Error('no'); } }));
  assert.equal(signals.tvf, null);
  assert.equal(signals.painted, null);
  assert.equal(signals.decoded, null);
});

test('updateEntry tracks each signal independently; unsupported signals are absent', async () => {
  const { e } = await run([
    [0, { tvf: 0, painted: 10, rvfc: 0, ct: 1 }],
    [10, { tvf: 0, painted: 20, rvfc: 0, ct: 2 }],
    [20, { tvf: 0, painted: 20, rvfc: 5, ct: 3 }],
  ]);
  assert.deepEqual(Object.keys(e.sig).sort(), ['ct', 'painted', 'rvfc', 'tvf']);
  assert.equal(e.sig.tvf.last, null); // flat
  assert.equal(e.sig.painted.last, 10 * S);
  assert.equal(e.sig.rvfc.last, 20 * S);
  assert.equal(e.sig.ct.last, 20 * S);
});

test('wouldRestart: not while ANY real signal advances (Firefox: tvf flat but painted moving)', async () => {
  const { m, e } = await run([
    [0, { tvf: 0, painted: 1, ct: 0 }],
    [100, { tvf: 0, painted: 900, ct: 100 }],
  ]);
  assert.equal(m.wouldRestart(e, 100 * S), null);
});

test('wouldRestart: fires at 45 s when every real signal is flat, even though currentTime advances', async () => {
  const { m, e } = await run([
    [0, { tvf: 5, painted: 5, rvfc: 5, ct: 0 }],
    [10, { tvf: 50, painted: 50, rvfc: 50, ct: 10 }],
    [20, { tvf: 50, painted: 50, rvfc: 50, ct: 20 }],
    [64, { tvf: 50, painted: 50, rvfc: 50, ct: 64 }],
  ]);
  assert.equal(m.wouldRestart(e, 54 * S), null); // 44 s
  const w = m.wouldRestart(e, 55 * S);
  assert.deepEqual(w.signals, ['tvf', 'painted', 'rvfc']);
  assert.equal(w.minAge, 45 * S);
});

test('wouldRestart: one moving real signal (rvfc) prevents it', async () => {
  const { m, e } = await run([[0, { tvf: 0, rvfc: 0 }], [60, { tvf: 0, rvfc: 3 }]]);
  assert.equal(m.wouldRestart(e, 60 * S), null);
});

test('wouldRestart: never-started video counts from first seen', async () => {
  const { m, e } = await run([[5, { tvf: 0, rvfc: 0, ct: 0 }]]);
  assert.equal(m.wouldRestart(e, 49 * S), null);
  assert.ok(m.wouldRestart(e, 50 * S));
});

test('wouldRestart: with no real signal supported it falls back to currentTime', async () => {
  const { m, e } = await run([[0, { ct: 1 }], [10, { ct: 2 }]]);
  assert.equal(m.wouldRestart(e, 54 * S), null);
  assert.deepEqual(m.wouldRestart(e, 55 * S).signals, ['ct']);
});

test('schedule: first summary at 2 min, then every 30 min; WOULD-RESTART throttled to 5 min', async () => {
  const { summaryDue, restartLogDue } = await load();
  assert.equal(summaryDue({ sinceLoadMs: 119 * S, now: 0, lastSummaryAt: null }), false);
  assert.equal(summaryDue({ sinceLoadMs: 120 * S, now: 0, lastSummaryAt: null }), true);
  assert.equal(summaryDue({ sinceLoadMs: 999 * S, now: 1799 * S, lastSummaryAt: 0 }), false);
  assert.equal(summaryDue({ sinceLoadMs: 999 * S, now: 1800 * S, lastSummaryAt: 0 }), true);
  assert.equal(restartLogDue(null, 0), true);
  assert.equal(restartLogDue(0, 299 * S), false);
  assert.equal(restartLogDue(0, 300 * S), true);
});

test('describeEntry: summary line shape, flat/stale/n-a markers', async () => {
  const { m, e } = await run([
    [0, { tvf: 0, painted: 800, rvfc: 800, ct: 1 }],
    [10, { tvf: 0, painted: 812, rvfc: 815, ct: 11 }],
  ]);
  const meta = { rs: 4, paused: false, w: 1920, h: 536, trk: 'live/unmuted' };
  assert.equal(m.describeEntry(e, meta, 12 * S), 'tvf=0(flat) painted=812 decoded=n/a parsed=n/a rvfc=815 ct=ok 1920x536 rs=4 paused=0 trk=live/unmuted');
  assert.match(m.describeEntry(e, meta, 100 * S), /painted=812\(stale 90s\)/);
});

test('uaLabel extracts the Firefox (or Chrome) version, else a trimmed UA', async () => {
  const { uaLabel } = await load();
  assert.equal(uaLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0'), 'Firefox 132.0');
  assert.equal(uaLabel('X Chrome/131.0.0.0 Safari'), 'Chrome 131.0.0.0');
  assert.equal(uaLabel('SomethingElse/1'), 'SomethingElse/1');
  assert.equal(uaLabel(undefined), 'unknown UA');
});

test('attachRvfc: one loop per element, counts callbacks, records presentedFrames, survives errors', async () => {
  const { attachRvfc } = await load();
  const store = new WeakMap();
  let pending = null, registrations = 0;
  const v = { requestVideoFrameCallback(cb) { registrations++; pending = cb; return 1; } };
  attachRvfc(v, store);
  attachRvfc(v, store); // element reused by the player: must not double-register
  assert.equal(registrations, 1);
  for (let i = 1; i <= 3; i++) { const cb = pending; pending = null; cb(0, { presentedFrames: 100 + i }); }
  assert.equal(store.get(v).count, 3);
  assert.equal(store.get(v).presented, 103);
  assert.equal(registrations, 4); // re-registered after each frame
  // Unsupported element: nothing registered, nothing stored.
  const none = {};
  attachRvfc(none, store);
  assert.equal(store.has(none), false);
  // Throws on first registration: not stored, no exception.
  const bad = { requestVideoFrameCallback() { throw new Error('x'); } };
  attachRvfc(bad, store);
  assert.equal(store.has(bad), false);
});

test('importing in node (no window/document) starts nothing and throws nothing', async () => {
  const m = await load();
  assert.equal(typeof m.DEFAULTS.tickMs, 'number');
  assert.equal(m.DEFAULTS.logName, 'Kiosk video guard (observe)');
});
