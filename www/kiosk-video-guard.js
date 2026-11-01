// Kiosk video guard, v2: OBSERVE-ONLY.
//
// v1 reloaded the page when decoded frames stopped. On the real Kiosk Firefox it misfired: Firefox
// returns 0 for getVideoPlaybackQuality().totalVideoFrames on MediaStream video (Mozilla bug
// 1586505), so every camera looked "never started". Chromium implements it, which is why the tests
// passed. v2 therefore ONLY OBSERVES and logs what each progress signal really does in Firefox, so a
// reliable freeze rule can be chosen from evidence.
//
// It never reloads, never detaches or re-attaches anything, never mutates the DOM, and never touches
// localStorage. The only thing it adds to a <video> is one requestVideoFrameCallback registration
// (read-only; it does not affect playback). Everything is wrapped in try/catch.
//
// Loaded as a `lovelace: resources:` entry (/local/kiosk-video-guard.js), shared with the WallPanel
// dashboards, so it is a complete no-op unless location.pathname is one of allowedPaths.
//
// The decision logic is pure and exported; tools/tests/kiosk-video-guard.test.js covers it in node.

export const DEFAULTS = {
  allowedPaths: ['/kiosk-main'], // tests also allow '/kiosk-candidate' via the override below
  tickMs: 10_000,
  graceMs: 90_000, // nothing is logged this long after page load
  firstSummaryMs: 120_000, // first summary line this long after page load
  summaryEveryMs: 30 * 60_000, // then one every 30 min
  wouldRestartMs: 45_000, // no progress on every supported real signal for this long
  wouldRestartGapMs: 5 * 60_000, // WOULD-RESTART at most this often per camera
  logTimeoutMs: 1000, // never let the logbook call hang the tick longer than this
  logToHA: true, // tests turn this off: it would write to the live logbook
  logName: 'Kiosk video guard (observe)',
};

// Signals that mean "a new frame was decoded/painted/presented". currentTime is tracked and reported
// but is not "real": a frozen live MediaStream video can keep advancing it.
export const REAL = ['tvf', 'painted', 'decoded', 'parsed', 'rvfc'];
export const SIGNALS = [...REAL, 'ct'];

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

// If every supported real signal has been flat for >= wouldRestartMs, returns
// { signals: [names], ages: { name: ms }, minAge }. Otherwise null. With no real signal supported at
// all, falls back to currentTime.
export function wouldRestart(entry, now, cfg = DEFAULTS) {
  const real = REAL.filter((n) => entry.sig[n]);
  const use = real.length ? real : entry.sig.ct ? ['ct'] : [];
  if (!use.length) return null;
  const ages = Object.fromEntries(use.map((n) => [n, ageOf(entry, n, now)]));
  const minAge = Math.min(...Object.values(ages));
  return minAge >= cfg.wouldRestartMs ? { signals: use, ages, minAge } : null;
}

export const summaryDue = (s, cfg = DEFAULTS) =>
  s.sinceLoadMs >= cfg.firstSummaryMs && (s.lastSummaryAt == null || s.now - s.lastSummaryAt >= cfg.summaryEveryMs);

export const restartLogDue = (lastAt, now, cfg = DEFAULTS) => lastAt == null || now - lastAt >= cfg.wouldRestartGapMs;

// "tvf=0(flat) painted=812 rvfc=815 ct=ok 1920x536 rs=4 paused=0 trk=live/unmuted"
//   (flat)      = this signal has never changed since the video was first seen
//   (stale NNs) = it has not changed for >= wouldRestartMs
//   n/a         = not supported by this browser/element
export function describeEntry(entry, meta, now, cfg = DEFAULTS) {
  const part = (n) => {
    const s = entry.sig[n];
    if (!s) return `${n}=n/a`;
    const val = n === 'ct' ? (s.last == null ? 'flat' : 'ok') : s.value;
    if (n === 'ct') return `ct=${val}`;
    if (s.last == null) return `${n}=${s.value}(flat)`;
    const age = ageOf(entry, n, now);
    return age >= cfg.wouldRestartMs ? `${n}=${s.value}(stale ${Math.round(age / 1000)}s)` : `${n}=${s.value}`;
  };
  return [...REAL.map(part), part('ct'), `${meta.w}x${meta.h}`, `rs=${meta.rs}`, `paused=${meta.paused ? 1 : 0}`, `trk=${meta.trk}`].join(' ');
}

export function uaLabel(ua) {
  const m = /(Firefox|Chrome)\/([\d.]+)/.exec(ua || '');
  return m ? `${m[1]} ${m[2]}` : String(ua || 'unknown UA').slice(0, 80);
}

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

// ---------------------------------------------------------------- browser side

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

function start() {
  const config = { ...DEFAULTS, ...(window.kioskVideoGuardOverrides || {}) };
  if (!pathAllowed(location.pathname, config.allowedPaths)) return;

  const loadedAt = Date.now();
  const rvfc = new WeakMap(); // <video> -> { count, presented }
  const tracked = new WeakMap(); // <video> -> entry
  let scan = []; // [{ video, key, entity, meta }] from the last tick, for status()
  let lastSummaryAt = null;
  const lastRestartLog = new Map(); // entity key -> time of last WOULD-RESTART
  const logs = []; // last 20 log payloads, for status()/tests

  async function logToHA(kind, message, entity) {
    logs.push({ at: Date.now(), kind, message, entity: entity || null });
    if (logs.length > 20) logs.shift();
    if (!config.logToHA) return;
    try {
      const hass = document.querySelector('home-assistant')?.hass;
      const data = { name: config.logName, message };
      if (entity) data.entity_id = entity;
      await Promise.race([
        hass.callService('logbook', 'log', data),
        new Promise((r) => setTimeout(r, config.logTimeoutMs)),
      ]);
    } catch {
      // best effort only
    }
  }

  async function tick() {
    const now = Date.now();
    if (document.visibilityState !== 'visible') {
      // Hidden pages legitimately pause video. Forget progress so the first visible tick starts clean.
      scan = [];
      for (const v of deepVideos(document)) tracked.delete(v);
      return;
    }
    const seen = new Map(); // key -> true, to give each camera one slot
    scan = [];
    for (const video of deepVideos(document).filter(isVisible)) {
      attachRvfc(video, rvfc);
      const entity = cameraEntity(video);
      const { signals, meta } = sampleOf(video, rvfc.has(video) ? rvfc.get(video).count : null);
      tracked.set(video, updateEntry(tracked.get(video), signals, now));
      let key = entity || `video-${scan.length}`;
      if (seen.has(key)) key = `${key}#${scan.length}`;
      seen.set(key, true);
      scan.push({ video, key, entity, meta });
    }

    const sinceLoadMs = now - loadedAt;
    if (sinceLoadMs < config.graceMs) return;

    if (summaryDue({ sinceLoadMs, now, lastSummaryAt }, config)) {
      lastSummaryAt = now;
      const lines = scan.map((s) => `${s.key}: ${describeEntry(tracked.get(s.video), s.meta, now, config)}`);
      await logToHA('summary', `${uaLabel(navigator.userAgent)} | ${scan.length} videos | ${lines.join(' ; ')}`);
    }

    for (const s of scan) {
      const entry = tracked.get(s.video);
      const w = wouldRestart(entry, now, config);
      if (!w || !restartLogDue(lastRestartLog.get(s.key), now, config)) continue;
      lastRestartLog.set(s.key, now);
      const ages = w.signals.map((n) => `${n}=${Math.round(w.ages[n] / 1000)}s`).join(' ');
      await logToHA(
        'would-restart',
        `WOULD-RESTART ${s.key}: no progress on ${w.signals.join(',')} for ${Math.round(w.minAge / 1000)} s (${ages})`,
        s.entity,
      );
    }
  }

  function loop() {
    setTimeout(async () => {
      try {
        await tick();
      } catch (e) {
        console.warn('kiosk-video-guard tick failed', e);
      }
      loop();
    }, config.tickMs);
  }

  window.kioskVideoGuard = {
    observeOnly: true,
    config,
    logs,
    status() {
      const now = Date.now();
      return {
        observeOnly: true,
        sinceLoadMs: now - loadedAt,
        lastSummaryAt,
        videos: scan.map(({ video, key, entity, meta }) => {
          const e = tracked.get(video);
          const r = rvfc.get(video);
          return {
            key,
            entity,
            meta,
            rvfcPresented: r ? r.presented : null,
            signals: Object.fromEntries(
              Object.entries(e.sig).map(([n, s]) => [n, { value: s.value, ageMs: ageOf(e, n, now), everProgressed: s.last != null }]),
            ),
            wouldRestart: !!wouldRestart(e, now, config),
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
