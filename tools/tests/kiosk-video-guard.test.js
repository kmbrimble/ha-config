// Unit tests for the pure logic in www/kiosk-video-guard.js. Run: npm run test:unit
// (The module is ESM; importing it in node is a no-op for the browser side: no window/document.)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '../../www/kiosk-video-guard.js')).href);
const S = 1000;

// Drive a video through samples ([secondsSinceStart, frames, time]) and return the final entry.
async function run(samples, cfgOver = {}) {
  const m = await load();
  const cfg = { ...m.DEFAULTS, ...cfgOver };
  let e;
  for (const [t, frames, time] of samples) e = m.updateEntry(e, { frames, time }, t * S, cfg);
  return { m, cfg, e };
}

test('path allow-list: kiosk-main and sub-paths only', async () => {
  const { pathAllowed } = await load();
  const p = ['/kiosk-main'];
  assert.ok(pathAllowed('/kiosk-main', p));
  assert.ok(pathAllowed('/kiosk-main/0', p));
  for (const bad of ['/wall-main', '/kiosk-mainx', '/kiosk-candidate', '/lovelace/0', '/']) {
    assert.ok(!pathAllowed(bad, p), bad);
  }
  assert.ok(pathAllowed('/kiosk-candidate', ['/kiosk-main', '/kiosk-candidate']));
});

test('not stalled while frames advance', async () => {
  const { m, cfg, e } = await run([[0, 0, 0], [10, 250, 10], [100, 2500, 100]]);
  assert.equal(m.isStalled(e, 100 * S, cfg), false);
});

test('stalled at exactly 45 s without progress, not at 44 s', async () => {
  const { m, cfg, e } = await run([[0, 0, 0], [10, 250, 10], [20, 500, 20]]); // last progress t=20
  assert.equal(m.isStalled(e, 64 * S, cfg), false);
  assert.equal(m.isStalled(e, 65 * S, cfg), true);
});

test('frames alone count as progress', async () => {
  const { e } = await run([[0, 5, 1], [10, 6, 1]]); // frames moving, time stuck
  assert.equal(e.lastProgress, 10 * S);
});

test('currentTime advancing with frozen frames is stalled at 45 s', async () => {
  const { m, cfg, e } = await run([[0, 5, 1], [10, 50, 10], [20, 50, 20], [30, 50, 30], [64, 50, 64]]);
  assert.equal(e.lastProgress, 10 * S); // last real progress: frames at t=10
  assert.equal(m.isStalled(e, 54 * S, cfg), false);
  assert.equal(m.isStalled(e, 55 * S, cfg), true);
});

test('useCurrentTime:true opt-in lets currentTime count even with frames available', async () => {
  const { e } = await run([[0, 5, 1], [10, 5, 2]], { useCurrentTime: true });
  assert.equal(e.lastProgress, 10 * S);
});

test('API absent (frames null): currentTime is the fallback, by default', async () => {
  const { m, cfg, e } = await run([[0, null, 1], [10, null, 2]]);
  assert.equal(e.lastProgress, 10 * S);
  assert.equal(m.isStalled(e, 54 * S, cfg), false);
  assert.equal(m.isStalled(e, 55 * S, cfg), true);
});

test('never started: stalled at 90 s since first seen, not before', async () => {
  const { m, cfg, e } = await run([[5, 0, 0], [30, 0, 0], [60, 0, 0]]); // first seen t=5
  assert.equal(e.lastProgress, null);
  assert.equal(m.isStalled(e, 94 * S, cfg), false);
  assert.equal(m.isStalled(e, 95 * S, cfg), true);
});

test('findStalled returns only the stalled ids', async () => {
  const m = await load();
  const ok = (await run([[0, 0, 0], [60, 900, 60]])).e;
  const bad = (await run([[0, 0, 0], [10, 100, 10]])).e;
  assert.deepEqual(m.findStalled([['ok', ok], ['bad', bad]], 60 * S), ['bad']);
});

const base = { stalledCount: 1, visible: true, sinceLoadMs: 200 * S, now: 10_000 * S, reloads: [], lastLogAt: null };

test('decide: nothing stalled, hidden page, and grace period all mean no action', async () => {
  const { decide } = await load();
  assert.equal(decide({ ...base, stalledCount: 0 }), 'none');
  assert.equal(decide({ ...base, visible: false }), 'none');
  assert.equal(decide({ ...base, sinceLoadMs: 89 * S }), 'none');
  assert.equal(decide({ ...base, sinceLoadMs: 90 * S }), 'reload');
});

test('decide: at most one reload per 5 min', async () => {
  const { decide } = await load();
  assert.equal(decide({ ...base, reloads: [base.now - 299 * S] }), 'wait');
  assert.equal(decide({ ...base, reloads: [base.now - 300 * S] }), 'reload');
});

test('decide: 3 reloads within 30 min stops reloading and logs, throttled', async () => {
  const { decide } = await load();
  const three = [base.now - 25 * 60 * S, base.now - 15 * 60 * S, base.now - 6 * 60 * S];
  assert.equal(decide({ ...base, reloads: three }), 'log');
  assert.equal(decide({ ...base, reloads: three, lastLogAt: base.now - 60 * S }), 'none');
  assert.equal(decide({ ...base, reloads: three, lastLogAt: base.now - 301 * S }), 'log');
  // Two recent plus one older than 30 min is not capped.
  assert.equal(decide({ ...base, reloads: [base.now - 31 * 60 * S, base.now - 15 * 60 * S, base.now - 6 * 60 * S] }), 'reload');
});
