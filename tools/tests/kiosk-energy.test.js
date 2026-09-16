// Unit tests for www/kiosk-energy.js. Run: npm run test:unit
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The module runs in its own vm realm, so its objects fail deepStrictEqual's prototype check.
const plain = (v) => JSON.parse(JSON.stringify(v));

function loadModule() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../www/kiosk-energy.js'), 'utf8'), { window });
  return window.kioskEnergy;
}

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 8, 1, 14); // local midnight, Brisbane
const ids = loadModule()._internal.STATISTIC_IDS;
const rows = (vals) => vals.map((v, i) => (v === undefined ? null : { start: T0 + i * DAY, change: v })).filter(Boolean);
const RESULT = {
  [ids.grid]: rows([10, 20, 15, 5]),
  [ids.controlled_load]: rows([2, undefined, 1, 0]),
  [ids.export]: rows([0.5, 1, undefined, 0]),
};

test('days combine metrics and treat a missing metric as zero', () => {
  const { toDays } = loadModule()._internal;
  const days = toDays(RESULT);
  assert.equal(days.length, 4);
  assert.deepEqual(plain(days[1]), { start: T0 + DAY, grid: 20, controlled_load: 0, export: 1 });
});

test('a day with no grid row is dropped rather than counted as zero usage', () => {
  const { toDays } = loadModule()._internal;
  const days = toDays({ [ids.grid]: rows([10]), [ids.export]: rows([1, 2]) });
  assert.equal(days.length, 1);
});

test('summary uses grid + controlled load over complete days only', () => {
  const { toDays, summarise } = loadModule()._internal;
  const stats = summarise(toDays(RESULT), T0 + 3 * DAY); // day 4 is "today"
  assert.deepEqual(plain(stats), { min: 12, max: 20, avg: (12 + 20 + 16) / 3 });
  assert.equal(summarise([], T0), null);
});

test('columns are centred on midday, windowed, and export is negative', () => {
  const { toDays, toSeries } = loadModule()._internal;
  const days = toDays(RESULT);
  const start = new Date(T0 + DAY);
  const end = new Date(T0 + 3 * DAY);
  assert.deepEqual(plain(toSeries(days, null, 'grid', start, end)), [[T0 + DAY + DAY / 2, 20], [T0 + 2 * DAY + DAY / 2, 15]]);
  assert.deepEqual(plain(toSeries(days, null, 'export', start, end).map((p) => p[1])), [-1, 0]);
});

test('the oldest day survives the 1ms-past-midnight start apexcharts-card passes', () => {
  const { toDays, toSeries } = loadModule()._internal;
  const days = toDays(RESULT);
  const start = new Date(T0 + 1); // what the card actually sent on 2026-09-16
  const end = new Date(T0 + 4 * DAY);
  assert.equal(toSeries(days, null, 'grid', start, end).length, 4);
});

test('reference lines span the window, and are empty with no history', () => {
  const { toSeries } = loadModule()._internal;
  const start = new Date(T0);
  const end = new Date(T0 + 14 * DAY);
  assert.deepEqual(plain(toSeries([], { min: 1, max: 3, avg: 2 }, 'avg', start, end)), [[T0, 2], [T0 + 14 * DAY, 2]]);
  assert.equal(toSeries([], null, 'max', start, end).length, 0);
});

test('series() shares one fetch across calls and retries after a failure', async () => {
  const k = loadModule();
  let calls = 0;
  const failing = { callWS: async () => { calls += 1; throw new Error('boom'); } };
  await assert.rejects(k.series(failing, 'grid', new Date(T0), new Date(T0 + DAY)));
  await new Promise((r) => setImmediate(r));
  const ok = { callWS: async () => { calls += 1; return RESULT; } };
  const [a, b] = await Promise.all([
    k.series(ok, 'grid', new Date(T0), new Date(T0 + 4 * DAY)),
    k.series(ok, 'max', new Date(T0), new Date(T0 + 4 * DAY)),
  ]);
  assert.equal(calls, 2, 'one failed call, then one shared call');
  assert.equal(a.length, 4);
  assert.equal(b.length, 2);
});
