// Kiosk video guard, v3: restarts ONLY a stalled camera stream, not the whole page.
//
// History: v1 reloaded the page when decoded frames stopped and misfired on the real Kiosk Firefox,
// because Firefox returns 0 for getVideoPlaybackQuality().totalVideoFrames on MediaStream video
// (Mozilla bug 1586505). v2 only observed. The v2 logs showed what Firefox 153 really does on the
// Kiosk: totalVideoFrames, mozDecodedFrames and mozParsedFrames stay at 0; mozPaintedFrames and
// requestVideoFrameCallback count up (~14 fps). So v3 is self-calibrating: a signal only counts once
// it has advanced at least once on that element ("live"), and a video is stalled when it has live
// signals and ALL of them have been flat for stallMs. currentTime is never used.
//
// MODES (config.mode):
//   'observe' (shipped default): never mutates the DOM or reloads. Logs summaries and
//             WOULD-SOFT-RESTART lines to the logbook.
//   'act':    soft-restarts the stalled camera: detach and re-attach its ha-camera-stream element in
//             the same tick. HA's ha-web-rtc-player tears down its RTCPeerConnection on disconnect and
//             renegotiates on reconnect (verified in Chromium; the <video> node is reused). To switch
//             modes edit `mode` below and bump the ?v= in configuration.yaml.
// config.fallbackReload (default false): after repeated failed soft restarts, also allow the old full
// page reload (1 per 5 min, max 3 per 30 min, tracked in localStorage).
//
// Loaded as a `lovelace: resources:` entry (/local/kiosk-video-guard.js), shared with the WallPanel
// dashboards, so it is a complete no-op unless location.pathname is one of allowedPaths.
// The decision logic is pure and exported; tools/tests/kiosk-video-guard.test.js covers it in node.

export const DEFAULTS = {
  mode: 'observe', // 'observe' | 'act'
  fallbackReload: false,
  allowedPaths: ['/kiosk-main'], // tests also allow '/kiosk-candidate' via the override below
  tickMs: 10_000,
  graceMs: 90_000, // no logging or action this long after page load
  firstSummaryMs: 120_000, // first summary line this long after page load
  summaryEveryMs: 30 * 60_000, // then one every 30 min
  stallMs: 45_000, // every live signal flat for this long => stalled
  neverStartedMs: 90_000, // no signal has EVER advanced for this long since first seen => stalled
  settleMs: 25_000, // after a soft restart, don't judge that camera for this long
  verifyFreshMs: 15_000, // at the end of the settle period a live signal must have advanced this recently
  cooldownMs: 2 * 60_000, // min time between soft restarts of one camera
  escalateFailures: 2, // this many failed restarts...
  failureWindowMs: 10 * 60_000, // ...within this => ESCALATE (and stop soft-restarting that camera)
  globalBackoffMs: 5 * 60_000, // after a restart round when ALL videos were stalled
  logGapMs: 5 * 60_000, // WOULD-SOFT-RESTART / ESCALATE per camera at most this often
  minReloadGapMs: 5 * 60_000, // fallbackReload rate limit...
  capCount: 3, // ...and cap:
  capWindowMs: 30 * 60_000,
  storageKey: 'kioskVideoGuard.reloads',
  logTimeoutMs: 1000, // never let the logbook call hang the tick longer than this
  logToHA: true, // tests turn this off: it would write to the live logbook
  logName: 'Kiosk video guard',
  observeLogName: 'Kiosk video guard (observe)',
};

// Frame-based signals that can make a video "live". currentTime is tracked for the summary only: a
// frozen live MediaStream video can keep advancing it. `parsed` is shown in summaries but not used.
export const DETECT = ['tvf', 'painted', 'decoded', 'rvfc'];
export const SIGNALS = ['tvf', 'painted', 'decoded', 'parsed', 'rvfc', 'ct'];

// '/kiosk-main' matches '/kiosk-main', '/kiosk-main/0' but not '/kiosk-mainx'.
export function pathAllowed(pathname, prefixes) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// Read every signal from a <video> (or a fake of one). A signal that is not available is null.
// rvfcCount is the number of requestVideoFrameCallback calls so far, or null if unsupported.
export function sampleOf(v, rvfcCount = null) {
  let tvf = null;
  try {
    tvf = num(v.getVideoPlaybackQuality().totalVideoFrames);
  } catch {
    // API missing
  }
  let trk = 'no-src';
  try {
    const t = v.srcObject && v.srcObject.getVideoTracks && v.srcObject.getVideoTracks()[0];
    if (v.srcObject) trk = t ? `${t.readyState}/${t.muted ? 'muted' : 'unmuted'}` : 'no-video-track';
  } catch {
    trk = 'err';
  }
  return {
    signals: {
      tvf,
      painted: num(v.mozPaintedFrames),
      decoded: num(v.mozDecodedFrames),
      parsed: num(v.mozParsedFrames),
      rvfc: num(rvfcCount),
      ct: num(v.currentTime),
    },
    meta: { rs: v.readyState, paused: !!v.paused, w: v.videoWidth, h: v.videoHeight, trk },
  };
}

// Fold a sample's signals into a video's entry: { firstSeen, sig: { name: { value, last } } }, where
// last = when the value last changed (null = never has). A changed value counts as progress, so a
// counter that resets because the stream restarted does too.
export function updateEntry(entry, signals, now) {
  const sig = {};
  for (const n of SIGNALS) {
    const v = signals[n];
    if (v == null) continue;
    const p = entry && entry.sig[n];
    sig[n] = { value: v, last: p ? (v !== p.value ? now : p.last) : null };
  }
  return { firstSeen: entry ? entry.firstSeen : now, sig };
}

export const ageOf = (entry, name, now) => now - (entry.sig[name].last ?? entry.firstSeen);
export const liveSignals = (entry) => DETECT.filter((n) => entry.sig[n] && entry.sig[n].last != null);

// Self-calibrating verdict for one video.
//   live      = detection signals that have advanced at least once on this element
//   stalled   = has live signals and ALL of them are flat for >= stallMs
//   never-started = no detection signal has EVER advanced, and >= neverStartedMs since first seen
//   fresh     = some live signal advanced within verifyFreshMs (used to confirm a restart worked)
export function videoState(entry, now, cfg = DEFAULTS) {
  const live = liveSignals(entry);
  if (!live.length) {
    const age = now - entry.firstSeen;
    return { verdict: age >= cfg.neverStartedMs ? 'never-started' : 'ok', live, ages: {}, minAge: age, fresh: false };
  }
  const ages = Object.fromEntries(live.map((n) => [n, ageOf(entry, n, now)]));
  const minAge = Math.min(...Object.values(ages));
  return { verdict: minAge >= cfg.stallMs ? 'stalled' : 'ok', live, ages, minAge, fresh: minAge < cfg.verifyFreshMs };
}

const secs = (ms) => Math.round(ms / 1000);

// "flat for 47 s on painted,rvfc" / "no progress on any signal for 95 s" / "previous soft restart did not recover it"
export function stallText(o) {
  if (o.verdict === 'never-started') return `no progress on any signal for ${secs(o.minAge)} s`;
  if (o.verdict === 'stalled') return `flat for ${secs(o.minAge)} s on ${o.live.join(',')}`;
  return 'previous soft restart did not recover it';
}

export const summaryDue = (s, cfg = DEFAULTS) =>
  s.sinceLoadMs >= cfg.firstSummaryMs && (s.lastSummaryAt == null || s.now - s.lastSummaryAt >= cfg.summaryEveryMs);

const due = (lastAt, now, gap) => lastAt == null || now - lastAt >= gap;

// "tvf=0(flat) painted=812 decoded=0(flat) parsed=n/a rvfc=815 ct=ok 1920x536 rs=4 paused=0 trk=live/unmuted live=painted,rvfc"
//   (flat)      = this signal has never changed since the video was first seen
//   (stale NNs) = it has not changed for >= stallMs
//   n/a         = not supported by this browser/element
export function describeEntry(entry, meta, now, cfg = DEFAULTS) {
  const part = (n) => {
    const s = entry.sig[n];
    if (!s) return `${n}=n/a`;
    if (n === 'ct') return `ct=${s.last == null ? 'flat' : 'ok'}`;
    if (s.last == null) return `${n}=${s.value}(flat)`;
    const age = ageOf(entry, n, now);
    return age >= cfg.stallMs ? `${n}=${s.value}(stale ${secs(age)}s)` : `${n}=${s.value}`;
  };
  const live = liveSignals(entry);
  return [
    ...['tvf', 'painted', 'decoded', 'parsed', 'rvfc', 'ct'].map(part),
    `${meta.w}x${meta.h}`, `rs=${meta.rs}`, `paused=${meta.paused ? 1 : 0}`, `trk=${meta.trk}`,
    `live=${live.length ? live.join(',') : 'none'}`,
  ].join(' ');
}

export function uaLabel(ua) {
  const m = /(Firefox|Chrome)\/([\d.]+)/.exec(ua || '');
  return m ? `${m[1]} ${m[2]}` : String(ua || 'unknown UA').slice(0, 80);
}

// ---------------------------------------------------------------- policy (pure)

export const newState = () => ({ cams: new Map(), globalBackoffUntil: 0 });
const newCam = () => ({ lastRestartAt: null, settleUntil: 0, verifying: false, forced: false, failures: [], lastWouldAt: null, lastEscalateAt: null });

// Decide this tick's actions. MUTATES st (the per-camera bookkeeping) and returns a list of actions:
//   { type: 'would-restart', key, o }                     observe mode only
//   { type: 'restart', key, o, global }                   act mode only: caller soft-restarts + logs
//   { type: 'escalate', key, failures, reload }           act mode only; reload = config.fallbackReload
// observed: [{ key, ...videoState(...) }]. In observe mode nothing but 'would-restart' is ever returned.
export function plan(st, observed, now, cfg = DEFAULTS) {
  const act = cfg.mode === 'act';
  const actions = [];
  const needs = new Set();

  for (const o of observed) {
    if (!st.cams.has(o.key)) st.cams.set(o.key, newCam());
    const c = st.cams.get(o.key);
    c.failures = c.failures.filter((t) => now - t < cfg.failureWindowMs);

    // End of the settle period after a soft restart: did it recover?
    if (act && c.verifying && now >= c.settleUntil) {
      c.verifying = false;
      if (!o.fresh) {
        c.failures.push(now);
        c.forced = true; // judge it stalled again without waiting stallMs
        if (c.failures.length >= cfg.escalateFailures && due(c.lastEscalateAt, now, cfg.logGapMs)) {
          c.lastEscalateAt = now;
          actions.push({ type: 'escalate', key: o.key, failures: c.failures.length, reload: !!cfg.fallbackReload });
        }
      }
    }
    if (c.forced && o.fresh) c.forced = false;
    if (now >= c.settleUntil && (o.verdict !== 'ok' || c.forced)) needs.add(o.key);
  }

  const stalled = observed.filter((o) => needs.has(o.key));

  if (!act) {
    for (const o of stalled) {
      const c = st.cams.get(o.key);
      if (!due(c.lastWouldAt, now, cfg.logGapMs)) continue;
      c.lastWouldAt = now;
      actions.push({ type: 'would-restart', key: o.key, o });
    }
    return actions;
  }

  // Everything stalled at once is more likely a server/network event than N separate freezes: one
  // round of soft restarts, then back off.
  const global = observed.length > 1 && stalled.length === observed.length;
  if (global && now < st.globalBackoffUntil) return actions;
  let restarted = 0;
  for (const o of stalled) {
    const c = st.cams.get(o.key);
    if (c.failures.length >= cfg.escalateFailures) continue; // suspended until the failures age out
    if (!due(c.lastRestartAt, now, cfg.cooldownMs)) continue;
    c.lastRestartAt = now;
    c.settleUntil = now + cfg.settleMs;
    c.verifying = true;
    restarted++;
    actions.push({ type: 'restart', key: o.key, o, global });
  }
  if (global && restarted) st.globalBackoffUntil = now + cfg.globalBackoffMs;
  return actions;
}

// Full-page-reload rate limit (fallbackReload only): 'reload' | 'wait' | 'cap'
export function reloadVerdict(reloads, now, cfg = DEFAULTS) {
  const recent = reloads.filter((t) => now - t < cfg.capWindowMs);
  if (recent.length >= cfg.capCount) return 'cap';
  return recent.some((t) => now - t < cfg.minReloadGapMs) ? 'wait' : 'reload';
}

// ---------------------------------------------------------------- DOM helpers

// Register ONE requestVideoFrameCallback loop per <video> element (the same element is reused by
// HA's player across restarts, so a second registration would double-count). store: WeakMap.
export function attachRvfc(v, store) {
  if (typeof v.requestVideoFrameCallback !== 'function' || store.has(v)) return;
  const st = { count: 0, presented: null };
  store.set(v, st);
  const cb = (_now, md) => {
    st.count++;
    if (md && typeof md.presentedFrames === 'number') st.presented = md.presentedFrames;
    try {
      v.requestVideoFrameCallback(cb);
    } catch {
      // element gone
    }
  };
  try {
    v.requestVideoFrameCallback(cb);
  } catch {
    store.delete(v);
  }
}

// The ha-camera-stream ancestor of a <video>, crossing shadow roots.
export function cameraStreamHost(v) {
  for (let n = v; n; n = n.parentNode || n.host) if (n.localName === 'ha-camera-stream') return n;
  return null;
}

// THE ONLY DOM MUTATION IN THIS FILE. Detach and re-attach the stream element at the same position, in
// one tick. HA's ha-web-rtc-player closes its RTCPeerConnection on disconnect and renegotiates on
// reconnect. Leaves no listeners or handlers behind. Returns false if there was nothing to restart.
export function softRestart(v) {
  const host = cameraStreamHost(v);
  const parent = host && host.parentNode;
  if (!parent) return false;
  const next = host.nextSibling;
  parent.removeChild(host);
  parent.insertBefore(host, next);
  return true;
}

function deepVideos(root, out = []) {
  out.push(...root.querySelectorAll('video'));
  for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepVideos(el.shadowRoot, out);
  return out;
}

function isVisible(v) {
  if (!v.isConnected) return false;
  const r = v.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
}

// The camera entity is on an ancestor's stateObj (ha-camera-stream); walk up through shadow hosts.
function cameraEntity(v) {
  for (let n = v; n; n = n.parentNode || n.host) {
    const id = n.stateObj && n.stateObj.entity_id;
    if (typeof id === 'string' && id.startsWith('camera.')) return id;
  }
  return null;
}

const readReloads = (cfg) => {
  try {
    const a = JSON.parse(localStorage.getItem(cfg.storageKey) || '[]');
    return Array.isArray(a) ? a.filter((t) => typeof t === 'number') : [];
  } catch {
    return [];
  }
};

// false if the history could not be saved: then we must not reload (the rate limit could not work).
const writeReloads = (cfg, list) => {
  try {
    localStorage.setItem(cfg.storageKey, JSON.stringify(list));
    return localStorage.getItem(cfg.storageKey) === JSON.stringify(list);
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- browser side

function start() {
  const config = { ...DEFAULTS, ...(window.kioskVideoGuardOverrides || {}) };
  if (!pathAllowed(location.pathname, config.allowedPaths)) return;

  const loadedAt = Date.now();
  const rvfc = new WeakMap(); // <video> -> { count, presented }
  const tracked = new WeakMap(); // <video> -> entry
  const st = newState();
  let scan = []; // [{ video, key, entity, meta }] from the last tick, for status()
  let lastSummaryAt = null;
  let reloading = false;
  const logs = []; // last 30 log payloads, for status()/tests

  async function logToHA(kind, message, entity, observe) {
    logs.push({ at: Date.now(), kind, message, entity: entity || null });
    if (logs.length > 30) logs.shift();
    if (!config.logToHA) return;
    try {
      const hass = document.querySelector('home-assistant')?.hass;
      const data = { name: observe ? config.observeLogName : config.logName, message };
      if (entity) data.entity_id = entity;
      await Promise.race([
        hass.callService('logbook', 'log', data),
        new Promise((r) => setTimeout(r, config.logTimeoutMs)),
      ]);
    } catch {
      // best effort only
    }
  }

  function fallbackReload(now) {
    const reloads = readReloads(config);
    if (reloadVerdict(reloads, now, config) !== 'reload') return 'rate-limited';
    const kept = reloads.filter((t) => now - t < config.capWindowMs);
    if (!writeReloads(config, [...kept, now])) return 'no-storage';
    reloading = true;
    location.reload();
    return 'reloading';
  }

  async function tick() {
    const now = Date.now();
    if (document.visibilityState !== 'visible') {
      // Hidden pages legitimately pause video. Forget progress so the first visible tick starts clean.
      scan = [];
      for (const v of deepVideos(document)) tracked.delete(v);
      return;
    }
    const seen = new Set();
    scan = [];
    for (const video of deepVideos(document).filter(isVisible)) {
      attachRvfc(video, rvfc);
      const entity = cameraEntity(video);
      const { signals, meta } = sampleOf(video, rvfc.has(video) ? rvfc.get(video).count : null);
      tracked.set(video, updateEntry(tracked.get(video), signals, now));
      let key = entity || `video-${scan.length}`;
      if (seen.has(key)) key = `${key}#${scan.length}`;
      seen.add(key);
      scan.push({ video, key, entity, meta });
    }

    const sinceLoadMs = now - loadedAt;
    if (sinceLoadMs < config.graceMs) return;

    if (summaryDue({ sinceLoadMs, now, lastSummaryAt }, config)) {
      lastSummaryAt = now;
      const lines = scan.map((s) => `${s.key}: ${describeEntry(tracked.get(s.video), s.meta, now, config)}`);
      await logToHA('summary', `${uaLabel(navigator.userAgent)} | mode=${config.mode} | ${scan.length} videos | ${lines.join(' ; ')}`, null, true);
    }

    const observed = scan.map((s) => ({ key: s.key, ...videoState(tracked.get(s.video), now, config) }));
    for (const a of plan(st, observed, now, config)) {
      const s = scan.find((x) => x.key === a.key);
      if (a.type === 'would-restart') {
        await logToHA('would-restart', `WOULD-SOFT-RESTART ${a.key}: ${stallText(a.o)}`, s.entity, true);
      } else if (a.type === 'restart') {
        let ok = false;
        try {
          ok = softRestart(s.video);
        } catch {
          // fall through: logged as failed
        }
        tracked.delete(s.video); // judge the new stream afresh
        await logToHA('restarted', ok ? `Soft-restarted ${a.key} (${stallText(a.o)}${a.global ? '; all videos stalled' : ''})` : `Could not soft-restart ${a.key}: no ha-camera-stream to re-attach`, s.entity, false);
      } else if (a.type === 'escalate') {
        const r = a.reload ? fallbackReload(now) : 'fallbackReload off';
        await logToHA('escalate', `ESCALATE ${a.key}: ${a.failures} soft restarts failed within ${secs(config.failureWindowMs)} s (${r})`, s && s.entity, false);
      }
    }
  }

  function loop() {
    setTimeout(async () => {
      try {
        if (!reloading) await tick();
      } catch (e) {
        console.warn('kiosk-video-guard tick failed', e);
      }
      loop();
    }, config.tickMs);
  }

  window.kioskVideoGuard = {
    mode: config.mode,
    config,
    logs,
    status() {
      const now = Date.now();
      return {
        mode: config.mode,
        sinceLoadMs: now - loadedAt,
        lastSummaryAt,
        cams: Object.fromEntries([...st.cams].map(([k, c]) => [k, { ...c, failures: c.failures.slice() }])),
        videos: scan.filter((x) => tracked.get(x.video)).map(({ video, key, entity, meta }) => {
          const e = tracked.get(video);
          const r = rvfc.get(video);
          const vs = videoState(e, now, config);
          return {
            key, entity, meta,
            rvfcPresented: r ? r.presented : null,
            live: vs.live,
            verdict: vs.verdict,
            signals: Object.fromEntries(
              Object.entries(e.sig).map(([n, s]) => [n, { value: s.value, ageMs: ageOf(e, n, now), everProgressed: s.last != null }]),
            ),
          };
        }),
      };
    },
  };
  loop();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  try {
    start();
  } catch (e) {
    console.warn('kiosk-video-guard failed to start', e);
  }
}
