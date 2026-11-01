// Unit tests for the pure logic in www/kiosk-video-guard.js (v3). Run: npm run test:unit
// The module is ESM; importing it in node is a no-op for the browser side (no window/document).
// Firefox-only signals and the DOM restart cannot be exercised in Chromium CI, so they use fakes here.
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

// Fold [seconds, signals] samples into an entry.
async function run(samples) {
  const m = await load();
  let e;
  for (const [t, sig] of samples) e = m.updateEntry(e, sig, t * S);
  return { m, e };
}

// Firefox-like samples for a healthy camera up to t=20 s, then frozen painted/rvfc (tvf/decoded flat 0).
const ffFrozenAt20 = [
  [0, { tvf: 0, painted: 100, decoded: 0, rvfc: 100, ct: 0 }],
  [10, { tvf: 0, painted: 240, decoded: 0, rvfc: 240, ct: 10 }],
  [20, { tvf: 0, painted: 380, decoded: 0, rvfc: 380, ct: 20 }],
  [200, { tvf: 0, painted: 380, decoded: 0, rvfc: 380, ct: 200 }], // time moves on, frames do not
];

test('structure: exactly one DOM mutation and one reload call, no listeners, no pause/play', () => {
  const src = fs.readFileSync(FILE, 'utf8').replace(/\/\/.*$/gm, '');
  const count = (s) => src.split(s).length - 1;
  assert.equal(count('removeChild'), 1);
  assert.equal(count('insertBefore'), 1);
  assert.equal(count('location.reload'), 1);
  for (const bad of ['addEventListener', '.pause(', '.play(', 'srcObject =', 'innerHTML', '.append(', 'appendChild']) assert.equal(count(bad), 0, bad);
});

test('path allow-list: kiosk-main and sub-paths only', async () => {
  const { pathAllowed } = await load();
  const p = ['/kiosk-main'];
  assert.ok(pathAllowed('/kiosk-main', p) && pathAllowed('/kiosk-main/0', p));
  for (const bad of ['/wall-main', '/kiosk-mainx', '/kiosk-candidate', '/lovelace/0', '/']) assert.ok(!pathAllowed(bad, p), bad);
});

test('shipped defaults: act mode, fallbackReload off', async () => {
  const { DEFAULTS } = await load();
  assert.equal(DEFAULTS.mode, 'act');
  assert.equal(DEFAULTS.fallbackReload, false);
  assert.deepEqual([DEFAULTS.stallMs, DEFAULTS.neverStartedMs, DEFAULTS.settleMs, DEFAULTS.cooldownMs, DEFAULTS.graceMs], [45000, 90000, 25000, 120000, 90000]);
});

test('sampleOf: Chromium-like and Firefox-like elements; odd values; missing APIs', async () => {
  const { sampleOf } = await load();
  const chromium = sampleOf(fakeVideo({ getVideoPlaybackQuality: () => ({ totalVideoFrames: 812 }), currentTime: 5 }), 7);
  assert.deepEqual({ ...chromium.signals }, { tvf: 812, painted: null, decoded: null, parsed: null, rvfc: 7, ct: 5 });
  assert.deepEqual({ ...chromium.meta }, { rs: 4, paused: false, w: 1920, h: 536, trk: 'live/unmuted' });
  const ff = sampleOf(fakeVideo({ getVideoPlaybackQuality: () => ({ totalVideoFrames: 0 }), mozPaintedFrames: 812, mozDecodedFrames: 0, mozParsedFrames: 0 }), null);
  assert.deepEqual({ ...ff.signals }, { tvf: 0, painted: 812, decoded: 0, parsed: 0, rvfc: null, ct: 0 });
  assert.equal(sampleOf(fakeVideo({ srcObject: null })).meta.trk, 'no-src');
  assert.equal(sampleOf(fakeVideo({ srcObject: { getVideoTracks: () => [] } })).meta.trk, 'no-video-track');
  const odd = sampleOf(fakeVideo({ mozPaintedFrames: 'x', mozDecodedFrames: NaN, getVideoPlaybackQuality: () => { throw new Error('no'); } }));
  assert.deepEqual([odd.signals.tvf, odd.signals.painted, odd.signals.decoded], [null, null, null]);
});

test('Firefox-like: tvf/decoded flat forever, painted+rvfc moving => live=painted,rvfc, never stalled', async () => {
  const { m, e } = await run([
    [0, { tvf: 0, painted: 1, decoded: 0, rvfc: 0, ct: 0 }],
    [100, { tvf: 0, painted: 1400, decoded: 0, rvfc: 1390, ct: 100 }],
  ]);
  assert.deepEqual(m.liveSignals(e), ['painted', 'rvfc']);
  const v = m.videoState(e, 100 * S);
  assert.equal(v.verdict, 'ok');
  assert.deepEqual(m.plan(m.newState(), [{ key: 'camera.a', ...v }], 100 * S, { ...m.DEFAULTS, mode: 'act' }), []);
});

test('stalled when every live signal is flat for 45 s (not at 44 s); currentTime ignored', async () => {
  const { m, e } = await run(ffFrozenAt20); // last frame progress t=20; ct keeps moving
  assert.equal(m.videoState(e, 64 * S).verdict, 'ok');
  const v = m.videoState(e, 65 * S);
  assert.equal(v.verdict, 'stalled');
  assert.deepEqual(v.live, ['painted', 'rvfc']);
  assert.equal(m.stallText(v), 'flat for 45 s on painted,rvfc');
});

test('one still-moving live signal prevents a stall', async () => {
  const { m, e } = await run([[0, { painted: 1, rvfc: 0 }], [10, { painted: 5, rvfc: 3 }], [100, { painted: 5, rvfc: 90 }]]);
  assert.equal(m.videoState(e, 100 * S).verdict, 'ok');
});

test('self-calibration: a signal that never advanced is ignored; one that starts later joins', async () => {
  const { m, e } = await run([[0, { tvf: 0, painted: 10 }], [10, { tvf: 0, painted: 20 }], [30, { tvf: 0, painted: 20 }]]);
  assert.deepEqual(m.liveSignals(e), ['painted']); // tvf is 0 forever: not live
  const { e: e2 } = await run([[0, { painted: 10, rvfc: 0 }], [10, { painted: 20, rvfc: 0 }], [60, { painted: 20, rvfc: 4 }]]);
  assert.deepEqual(m.liveSignals(e2), ['painted', 'rvfc']);
  assert.equal(m.videoState(e2, 60 * S).verdict, 'ok'); // rvfc moved at 60
});

test('never-started: no detection signal ever advanced => stalled at 90 s since first seen, not 89 s', async () => {
  const { m, e } = await run([[5, { tvf: 0, painted: 0, rvfc: 0, ct: 0 }], [60, { tvf: 0, painted: 0, rvfc: 0, ct: 55 }]]);
  assert.equal(m.videoState(e, 94 * S).verdict, 'ok');
  const v = m.videoState(e, 95 * S);
  assert.equal(v.verdict, 'never-started');
  assert.equal(m.stallText(v), 'no progress on any signal for 90 s');
});

test('counter reset (stream restarted) counts as progress', async () => {
  const { m, e } = await run([[0, { painted: 900 }], [10, { painted: 3 }]]);
  assert.equal(e.sig.painted.last, 10 * S);
  assert.equal(m.videoState(e, 20 * S).verdict, 'ok');
});

// --- policy: plan()

const obs = (m, key, verdict, extra = {}) => ({ key, verdict, live: ['painted', 'rvfc'], ages: {}, minAge: 50 * S, fresh: false, ...extra });
const ACT = (m, o = {}) => ({ ...m.DEFAULTS, mode: 'act', ...o });
const OBS = (m, o = {}) => ({ ...m.DEFAULTS, mode: 'observe', ...o });

test('observe mode: only would-restart, throttled to once per 5 min per camera, never anything else', async () => {
  const m = await load();
  const st = m.newState();
  const stalled = [obs(m, 'camera.a', 'stalled'), obs(m, 'camera.b', 'ok')];
  let a = m.plan(st, stalled, 1000 * S, OBS(m));
  assert.deepEqual(a.map((x) => [x.type, x.key]), [['would-restart', 'camera.a']]);
  assert.deepEqual(m.plan(st, stalled, 1299 * S, OBS(m)), []);
  assert.equal(m.plan(st, stalled, 1300 * S, OBS(m)).length, 1);
  // Even a global stall, a never-started video, and many ticks produce only would-restart lines.
  const all = [obs(m, 'camera.a', 'stalled'), obs(m, 'camera.b', 'never-started')];
  for (let t = 5000; t < 20000; t += 10) for (const x of m.plan(st, all, t * S, OBS(m, { fallbackReload: true }))) assert.equal(x.type, 'would-restart');
  assert.equal(st.globalBackoffUntil, 0);
});

test('act mode: stalled camera is restarted once, then settles (not judged) for 25 s', async () => {
  const m = await load();
  const st = m.newState();
  const cams = [obs(m, 'camera.a', 'stalled'), obs(m, 'camera.b', 'ok')];
  const a = m.plan(st, cams, 1000 * S, ACT(m));
  assert.deepEqual(a.map((x) => [x.type, x.key, x.global]), [['restart', 'camera.a', false]]);
  assert.deepEqual(m.plan(st, cams, 1010 * S, ACT(m)), []); // settling
  assert.deepEqual(m.plan(st, cams, 1024 * S, ACT(m)), []); // still settling
});

test('act mode: recovered restart leaves no failures; later stall is restarted after the 2 min cooldown', async () => {
  const m = await load();
  const st = m.newState();
  m.plan(st, [obs(m, 'camera.a', 'stalled'), obs(m, 'camera.b', 'ok')], 1000 * S, ACT(m));
  m.plan(st, [obs(m, 'camera.a', 'ok', { fresh: true }), obs(m, 'camera.b', 'ok')], 1026 * S, ACT(m)); // verified
  assert.equal(st.cams.get('camera.a').failures.length, 0);
  // Stalls again 60 s after the first restart: cooldown (120 s) blocks it...
  assert.deepEqual(m.plan(st, [obs(m, 'camera.a', 'stalled'), obs(m, 'camera.b', 'ok')], 1060 * S, ACT(m)), []);
  // ...until it has passed.
  assert.equal(m.plan(st, [obs(m, 'camera.a', 'stalled'), obs(m, 'camera.b', 'ok')], 1120 * S, ACT(m)).length, 1);
});

test('act mode: two failed restarts within 10 min => ESCALATE; no reload when fallbackReload is false', async () => {
  const m = await load();
  const st = m.newState();
  const cams = (v, f) => [obs(m, 'camera.a', v, { fresh: f }), obs(m, 'camera.b', 'ok')];
  assert.equal(m.plan(st, cams('stalled', false), 1000 * S, ACT(m))[0].type, 'restart');
  // End of settle (1025): not fresh => failure 1, forced; cooldown still blocks the next restart.
  assert.deepEqual(m.plan(st, cams('ok', false), 1025 * S, ACT(m)), []);
  assert.equal(st.cams.get('camera.a').failures.length, 1);
  // After the cooldown the camera is restarted again even though its verdict reads ok (forced).
  assert.equal(m.plan(st, cams('ok', false), 1120 * S, ACT(m))[0].type, 'restart');
  const esc = m.plan(st, cams('ok', false), 1145 * S, ACT(m));
  assert.deepEqual(esc.map((x) => [x.type, x.key, x.failures, x.reload]), [['escalate', 'camera.a', 2, false]]);
  // Suspended: no further soft restarts while 2 failures are inside the window; escalate is throttled.
  assert.deepEqual(m.plan(st, cams('stalled', false), 1300 * S, ACT(m)), []);
  assert.deepEqual(m.plan(st, cams('stalled', false), 1500 * S, ACT(m)), []);
  // Failures age out after 10 min and it is tried again.
  assert.equal(m.plan(st, cams('stalled', false), 1800 * S, ACT(m))[0].type, 'restart');
});

test('act mode: ESCALATE asks for a reload only when fallbackReload is true', async () => {
  const m = await load();
  const st = m.newState();
  const cfg = ACT(m, { fallbackReload: true });
  const cams = [obs(m, 'camera.a', 'stalled'), obs(m, 'camera.b', 'ok')];
  m.plan(st, cams, 1000 * S, cfg);
  m.plan(st, [obs(m, 'camera.a', 'ok'), obs(m, 'camera.b', 'ok')], 1025 * S, cfg);
  m.plan(st, [obs(m, 'camera.a', 'ok'), obs(m, 'camera.b', 'ok')], 1120 * S, cfg);
  const esc = m.plan(st, [obs(m, 'camera.a', 'ok'), obs(m, 'camera.b', 'ok')], 1145 * S, cfg);
  assert.equal(esc[0].type, 'escalate');
  assert.equal(esc[0].reload, true);
});

test('act mode: ALL videos stalled => one restart round, then 5 min back-off', async () => {
  const m = await load();
  const st = m.newState();
  const all = ['a', 'b', 'c'].map((k) => obs(m, `camera.${k}`, 'stalled'));
  const a = m.plan(st, all, 1000 * S, ACT(m));
  assert.equal(a.length, 3);
  assert.ok(a.every((x) => x.type === 'restart' && x.global));
  // Still all stalled after settle + cooldown, but inside the 5 min back-off: nothing.
  assert.deepEqual(m.plan(st, all, 1200 * S, ACT(m)).filter((x) => x.type === 'restart'), []);
  assert.equal(m.plan(st, all, 1300 * S, ACT(m)).filter((x) => x.type === 'restart').length, 3);
});

test('act mode: a subset stalled is not "global", even while a global back-off runs', async () => {
  const m = await load();
  const st = m.newState();
  m.plan(st, ['a', 'b'].map((k) => obs(m, `camera.${k}`, 'stalled')), 1000 * S, ACT(m)); // global round, back-off to 1300
  const subset = [obs(m, 'camera.a', 'ok', { fresh: true }), obs(m, 'camera.b', 'stalled')];
  m.plan(st, subset, 1026 * S, ACT(m));
  const a = m.plan(st, subset, 1130 * S, ACT(m));
  assert.deepEqual(a.map((x) => [x.type, x.key, x.global]), [['restart', 'camera.b', false]]);
});

test('reloadVerdict: one per 5 min, cap 3 per 30 min', async () => {
  const m = await load();
  const now = 10000 * S;
  assert.equal(m.reloadVerdict([], now), 'reload');
  assert.equal(m.reloadVerdict([now - 299 * S], now), 'wait');
  assert.equal(m.reloadVerdict([now - 300 * S], now), 'reload');
  assert.equal(m.reloadVerdict([now - 25 * 60 * S, now - 15 * 60 * S, now - 6 * 60 * S], now), 'cap');
});

// --- DOM helpers with fakes

function fakeTree() {
  const calls = [];
  const next = { name: 'sibling' };
  const host = { localName: 'ha-camera-stream', nextSibling: next };
  const parent = {
    localName: 'div',
    removeChild(n) { calls.push(['remove', n.localName]); },
    insertBefore(n, ref) { calls.push(['insertBefore', n.localName, ref && ref.name]); },
  };
  host.parentNode = parent;
  const shadowRoot = { nodeType: 11, host };          // video lives in ha-camera-stream's shadow root
  const player = { localName: 'ha-web-rtc-player', parentNode: shadowRoot };
  const video = { localName: 'video', parentNode: player };
  return { calls, host, video, next };
}

test('softRestart: detaches and re-attaches the ha-camera-stream host at the same position, nothing else', async () => {
  const m = await load();
  const t = fakeTree();
  assert.equal(m.cameraStreamHost(t.video), t.host);
  assert.equal(m.softRestart(t.video), true);
  assert.deepEqual(t.calls, [['remove', 'ha-camera-stream'], ['insertBefore', 'ha-camera-stream', 'sibling']]);
});

test('softRestart: no ha-camera-stream ancestor or no parent => false, no mutation', async () => {
  const m = await load();
  assert.equal(m.softRestart({ localName: 'video', parentNode: { localName: 'div' } }), false);
  const t = fakeTree();
  t.host.parentNode = null;
  assert.equal(m.softRestart(t.video), false);
  assert.deepEqual(t.calls, []);
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
  assert.equal(registrations, 4);
  const none = {};
  attachRvfc(none, store);
  assert.equal(store.has(none), false);
  const bad = { requestVideoFrameCallback() { throw new Error('x'); } };
  attachRvfc(bad, store);
  assert.equal(store.has(bad), false);
});

test('summary schedule and line shape (live signals shown, flat/stale/n-a markers)', async () => {
  const m = await load();
  assert.equal(m.summaryDue({ sinceLoadMs: 119 * S, now: 0, lastSummaryAt: null }), false);
  assert.equal(m.summaryDue({ sinceLoadMs: 120 * S, now: 0, lastSummaryAt: null }), true);
  assert.equal(m.summaryDue({ sinceLoadMs: 999 * S, now: 1799 * S, lastSummaryAt: 0 }), false);
  assert.equal(m.summaryDue({ sinceLoadMs: 999 * S, now: 1800 * S, lastSummaryAt: 0 }), true);
  const { e } = await run([
    [0, { tvf: 0, painted: 800, decoded: 0, rvfc: 800, ct: 1 }],
    [10, { tvf: 0, painted: 812, decoded: 0, rvfc: 815, ct: 11 }],
  ]);
  const meta = { rs: 4, paused: false, w: 1920, h: 536, trk: 'live/unmuted' };
  assert.equal(m.describeEntry(e, meta, 12 * S), 'tvf=0(flat) painted=812 decoded=0(flat) parsed=n/a rvfc=815 ct=ok 1920x536 rs=4 paused=0 trk=live/unmuted live=painted,rvfc');
  assert.match(m.describeEntry(e, meta, 100 * S), /painted=812\(stale 90s\)/);
});

test('uaLabel extracts the Firefox (or Chrome) version, else a trimmed UA', async () => {
  const { uaLabel } = await load();
  assert.equal(uaLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0'), 'Firefox 153.0');
  assert.equal(uaLabel('X Chrome/131.0.0.0 Safari'), 'Chrome 131.0.0.0');
  assert.equal(uaLabel(undefined), 'unknown UA');
});
