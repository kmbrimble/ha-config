// Kiosk video guard (phase 1). Reloads the Kiosk page when a camera <video> freezes.
//
// Why: the Kiosk's WebRTC panes (picture-entity camera_view: live -> ha-camera-stream -> <video>)
// occasionally freeze on a stale frame while HA/go2rtc keep serving the stream fine. No server-side
// watchdog can see that; only the browser knows its <video> stopped advancing. So measure that.
//
// Deployed to /config/www/ and (phase 2) loaded as a `lovelace: resources:` entry
// (/local/kiosk-video-guard.js). Those are shared with the WallPanel dashboards, so everything
// below is a complete no-op unless location.pathname is one of CONFIG.allowedPaths.
//
// The decision logic is pure and exported, so tools/tests/kiosk-video-guard.test.js covers it in node.

export const DEFAULTS = {
  allowedPaths: ['/kiosk-main'], // tests also allow '/kiosk-candidate' via the override below
  tickMs: 10_000,
  graceMs: 90_000, // no action this long after page load (streams are still starting)
  stallMs: 45_000, // a video that was progressing and then stopped for this long is stalled
  neverStartedMs: 90_000, // a video that has never progressed for this long since first seen is stalled
  minReloadGapMs: 5 * 60_000, // at most one guard reload per this
  capCount: 3, // this many guard reloads...
  capWindowMs: 30 * 60_000, // ...within this and we stop reloading and only log
  logGapMs: 5 * 60_000, // in log-only mode, log at most this often
  logTimeoutMs: 1000, // never let the logbook call delay the reload longer than this
  logToHA: true, // tests turn this off: it would write to the live logbook
  // currentTime keeps advancing on some stalled MediaStream videos, which would hide a freeze.
  // Set false to judge by decoded frames alone (currentTime is then only a fallback where
  // getVideoPlaybackQuality is unavailable).
  useCurrentTime: true,
  storageKey: 'kioskVideoGuard.reloads',
};

// '/kiosk-main' matches '/kiosk-main', '/kiosk-main/0' but not '/kiosk-mainx'.
export function pathAllowed(pathname, prefixes) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

// Fold one sample ({frames, time}, either may be null) into a video's tracking entry.
// Entry: { firstSeen, lastProgress (null = never progressed), frames, time }.
export function updateEntry(entry, sample, now, cfg = DEFAULTS) {
  if (!entry) return { firstSeen: now, lastProgress: null, frames: sample.frames, time: sample.time };
  const framesMoved = sample.frames != null && entry.frames != null && sample.frames > entry.frames;
  const timeMoved =
    (cfg.useCurrentTime || sample.frames == null) && sample.time != null && entry.time != null && sample.time > entry.time;
  return {
    firstSeen: entry.firstSeen,
    lastProgress: framesMoved || timeMoved ? now : entry.lastProgress,
    frames: sample.frames,
    time: sample.time,
  };
}

export function msSinceProgress(entry, now) {
  return now - (entry.lastProgress ?? entry.firstSeen);
}

export function isStalled(entry, now, cfg = DEFAULTS) {
  const limit = entry.lastProgress == null ? cfg.neverStartedMs : cfg.stallMs;
  return msSinceProgress(entry, now) >= limit;
}

// entries: iterable of [id, entry]. Returns the ids that are stalled.
export function findStalled(entries, now, cfg = DEFAULTS) {
  const out = [];
  for (const [id, entry] of entries) if (isStalled(entry, now, cfg)) out.push(id);
  return out;
}

// What to do this tick. s = { stalledCount, visible, sinceLoadMs, now, reloads (timestamps of past
// guard reloads), lastLogAt }. Returns 'none' | 'wait' | 'reload' | 'log'.
//   wait   = stalled but a reload happened < minReloadGapMs ago; say nothing, check again next tick
//   log    = reload cap reached: record the stall, do not reload (avoids a reload loop)
export function decide(s, cfg = DEFAULTS) {
  if (!s.visible || s.stalledCount === 0 || s.sinceLoadMs < cfg.graceMs) return 'none';
  const recent = s.reloads.filter((t) => s.now - t < cfg.capWindowMs);
  if (recent.length >= cfg.capCount) return s.lastLogAt != null && s.now - s.lastLogAt < cfg.logGapMs ? 'none' : 'log';
  if (recent.some((t) => s.now - t < cfg.minReloadGapMs)) return 'wait';
  return 'reload';
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

function sampleOf(v) {
  let frames = null;
  try {
    frames = v.getVideoPlaybackQuality().totalVideoFrames;
  } catch {
    // unsupported: fall back to currentTime
  }
  return { frames, time: v.currentTime };
}

const readReloads = (cfg) => {
  try {
    const a = JSON.parse(localStorage.getItem(cfg.storageKey) || '[]');
    return Array.isArray(a) ? a.filter((t) => typeof t === 'number') : [];
  } catch {
    return [];
  }
};

// Returns false if the history could not be saved. Then we must not reload: with no record of it,
// the rate limit cannot work and a persistent stall would reload forever.
const writeReloads = (cfg, list) => {
  try {
    localStorage.setItem(cfg.storageKey, JSON.stringify(list));
    return localStorage.getItem(cfg.storageKey) === JSON.stringify(list);
  } catch {
    return false;
  }
};

function start() {
  const config = { ...DEFAULTS, ...(window.kioskVideoGuardOverrides || {}) };
  if (!pathAllowed(location.pathname, config.allowedPaths)) return;

  const loadedAt = Date.now();
  const tracked = new WeakMap(); // <video> -> entry
  let scan = []; // [{video, entity}] from the last tick, for status()
  let lastAction = null;
  let lastLogAt = null;
  let reloading = false;

  const act = (action, detail) => (lastAction = { action, at: Date.now(), ...detail });

  async function logToHA(message, entity) {
    if (!config.logToHA) return;
    try {
      const hass = document.querySelector('home-assistant')?.hass;
      const data = { name: 'Kiosk video guard', message };
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
    scan = deepVideos(document)
      .filter(isVisible)
      .map((video) => {
        tracked.set(video, updateEntry(tracked.get(video), sampleOf(video), now, config));
        return { video, entity: cameraEntity(video) };
      });

    const stalled = scan.filter((s) => isStalled(tracked.get(s.video), now, config));
    const reloads = readReloads(config);
    const action = decide(
      { stalledCount: stalled.length, visible: true, sinceLoadMs: now - loadedAt, now, reloads, lastLogAt },
      config,
    );
    if (action === 'none' || action === 'wait') return;

    const names = stalled.map((s) => s.entity || 'unknown video');
    const detail = { stalled: names };
    if (action === 'log') {
      lastLogAt = now;
      act('log', detail);
      await logToHA(`Video stalled (${names.join(', ')}); reload cap reached, not reloading.`, stalled[0].entity);
      return;
    }
    // reload: record it first; if that cannot be saved, do not reload at all.
    const kept = reloads.filter((t) => now - t < config.capWindowMs);
    if (!writeReloads(config, [...kept, now])) {
      act('skipped-no-storage', detail);
      return;
    }
    reloading = true;
    act('reload', detail);
    await logToHA(`Video stalled (${names.join(', ')}); reloading the Kiosk page.`, stalled[0].entity);
    location.reload();
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
    config,
    status() {
      const now = Date.now();
      return {
        sinceLoadMs: now - loadedAt,
        lastAction,
        reloads: readReloads(config),
        videos: scan.map(({ video, entity }) => {
          const e = tracked.get(video);
          return { entity, msSinceProgress: msSinceProgress(e, now), everProgressed: e.lastProgress != null };
        }),
      };
    },
  };
  loop();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') start();
