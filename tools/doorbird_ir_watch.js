#!/usr/bin/env node
/*
 * DoorBird IR watchdog / recovery tester (diagnostic, runs in the claude-code container).
 *
 * Why: the "Front Gate IR On at night" automation presses light-on.cgi every 2 min, but the IR
 * can stop responding to those presses (see claude/doorbird-ir-night-automation.md). This script
 * watches the actual IR state and, when it is off while the automation is pressing, tries
 * recovery steps IN ORDER with curl and logs which one works.
 *
 * IR state is read from Blue Iris stills through HA's camera proxy, so the DoorBird's own API is
 * only touched by the recovery attempts.
 *
 * Usage: node tools/doorbird_ir_watch.js <seconds to run> [sample interval s]
 * Needs: HA_TOKEN in /projects/ha-config/.env, and DoorBird creds in /tmp/db.env
 *        (DB_HOST/DB_USER/DB_PASS) or readable /ha-config/.storage/core.config_entries.
 * Log:   /tmp/dbir/irwatch.log
 */
const { chromium } = require('/projects/ha-config/node_modules/playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');

const HA = 'http://192.168.0.21:8123';
const LOG = '/tmp/dbir/irwatch.log';
const DUR = (+process.argv[2] || 36000) * 1000;
const STEP = (+process.argv[3] || 15) * 1000;
const OFF_HOTSPOT = 110;     // hotspot below this = IR not lit
const OFF_SAMPLES = 3;       // consecutive off samples before acting
const PRESS_FRESH_S = 240;   // automation counts as active if it pressed this recently

const env = (p) => Object.fromEntries(fs.readFileSync(p, 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const ha = env('/projects/ha-config/.env');
let db;
try { db = env('/tmp/db.env'); } catch {
  const e = JSON.parse(fs.readFileSync('/ha-config/.storage/core.config_entries', 'utf8'))
    .data.entries.find(x => x.domain === 'doorbird');
  db = { DB_HOST: e.data.host, DB_USER: e.data.username, DB_PASS: e.data.password };
}
const auth = `${db.DB_USER}:${db.DB_PASS}`;
const log = (...a) => {
  const line = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z ' + a.join(' ');
  console.log(line); fs.appendFileSync(LOG, line + '\n');
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const curl = (args, label) => {
  try { return execFileSync('curl', ['-s', '-m', '10', '-u', auth, ...args], { maxBuffer: 8e6 }).toString().replace(/\s+/g, ' ').slice(0, 120); }
  catch (e) { return `ERR ${label} ${e.message.slice(0, 80)}`; }
};
// Cheap reachability probe: distinguishes a software restart (connection refused, web
// server not up yet) from the device losing power (connect timeout / unreachable).
const net = require('net');
const probe = (port = 80, timeout = 2500) => new Promise((resolve) => {
  const sock = new net.Socket(); let done = false;
  const end = (r) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(r); } };
  sock.setTimeout(timeout);
  sock.once('connect', () => end('open'));
  sock.once('timeout', () => end('timeout'));
  sock.once('error', (e) => end(e.code === 'ECONNREFUSED' ? 'refused' : (e.code || 'error').toLowerCase()));
  sock.connect(port, db.DB_HOST);
});

const lastPressAgeS = () => {
  try {
    const s = JSON.parse(execFileSync('curl', ['-s', '-m', '10', '-H', `Authorization: Bearer ${ha.HA_TOKEN}`,
      `${HA}/api/states/button.front_gate_ir`], { maxBuffer: 1e6 }).toString());
    return (Date.now() - Date.parse(s.state)) / 1000;
  } catch { return null; }
};

const lightOn = (scheme = 'http') => curl([scheme === 'https' ? '-k' : '-s', `${scheme}://${db.DB_HOST}/bha-api/light-on.cgi`], 'light-on');
const haPost = (domain, service, body) => {
  try {
    return execFileSync('curl', ['-s', '-m', '15', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST',
      '-H', `Authorization: Bearer ${ha.HA_TOKEN}`, '-H', 'Content-Type: application/json',
      '-d', JSON.stringify(body), `${HA}/api/services/${domain}/${service}`]).toString();
  } catch (e) { return 'ERR ' + e.message.slice(0, 60); }
};
const ALLOW_RESTART = process.env.ALLOW_RESTART === '1';

const STEPS = [
  ['A image+light-on (http)', () => curl([`http://${db.DB_HOST}/bha-api/image.cgi`, '-o', '/dev/null', '-w', 'image=%{http_code}'], 'image') + ' | ' + lightOn()],
  ['B light-on only (http)', () => lightOn()],
  ['C session+video+light-on', () => {
    const a = curl([`http://${db.DB_HOST}/bha-api/getsession.cgi`, '-o', '/dev/null', '-w', 'session=%{http_code}'], 'session');
    let b;
    try { b = 'video=' + execFileSync('curl', ['-s', '-m', '6', '-u', auth, '-o', '/dev/null', '-w', '%{size_download}B', `http://${db.DB_HOST}/bha-api/video.cgi`]).toString(); }
    catch (e) { b = 'video=timeout-as-expected'; }
    return a + ' ' + b + ' | ' + lightOn();
  }],
  ['D light-on over https', () => lightOn('https')],
  ['E let the 3 min timer lapse, then press', async () => {
    const reenable = () => haPost('automation', 'turn_on', { entity_id: 'automation.front_gate_ir_on_at_night' });
    process.once('SIGTERM', reenable); process.once('SIGINT', reenable); process.once('exit', reenable);
    const off = haPost('automation', 'turn_off', { entity_id: 'automation.front_gate_ir_on_at_night' });
    await sleep(230e3);
    const on = haPost('automation', 'turn_on', { entity_id: 'automation.front_gate_ir_on_at_night' });
    const press = haPost('button', 'press', { entity_id: 'button.front_gate_ir' });
    return `automation off=${off} on=${on} press=${press}`;
  }],
  ['F restart.cgi (device reboot, ~120 s)', async () => {
    if (!ALLOW_RESTART) return 'skipped (ALLOW_RESTART not set)';
    // A warm reboot was proven not to fix the IR on 13 Sep (switch log shows the device
    // really did reboot at 19:04 and the LEDs stayed dark), so it is skippable.
    if (process.env.SKIP_WARM_RESTART === '1') return 'skipped (SKIP_WARM_RESTART=1)';
    // Log the HTTP status too: restart.cgi needs the "API operator" permission and a 401
    // comes back with an empty body, which is indistinguishable from success otherwise.
    const r = curl([`http://${db.DB_HOST}/bha-api/restart.cgi`, '-w', ' http=%{http_code}'], 'restart');
    await sleep(150e3);
    return `restart -> ${r}; after wait light-on -> ${lightOn()}`;
  }, true],
  ['G PoE cold boot on the switch port', async () => {
    if (!ALLOW_RESTART) return 'skipped (ALLOW_RESTART not set)';
    let out;
    try { out = execFileSync('/projects/ha-config/tools/doorbird_poe_cycle.sh', ['15'], { timeout: 300e3 }).toString().replace(/\s+/g, ' ').slice(-200); }
    catch (e) { out = 'ERR ' + e.message.slice(0, 120); }
    await sleep(120e3);
    return `${out} | after boot light-on -> ${lightOn()}`;
  }, true],
];
// Steps flagged true are destructive and run at most once per watchdog run.
const ONCE = new Set(STEPS.map(([n, , once]) => (once ? n : null)).filter(Boolean));
const used = new Set();

(async () => {
  let browser = await chromium.launch(), page = await browser.newPage();
  const stat = async () => {
    const buf = execFileSync('curl', ['-s', '-m', '10', '-H', `Authorization: Bearer ${ha.HA_TOKEN}`,
      `${HA}/api/camera_proxy/camera.cameras_front_gate`], { maxBuffer: 8e6 });
    if (buf.slice(0, 3).toString('hex') !== 'ffd8ff') throw new Error('not a jpeg (' + buf.length + 'B)');
    return page.evaluate(async (src) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let all = 0, na = 0, hot = 0, nh = 0, ch = 0;
      for (let y = 0; y < c.height; y += 2) for (let xx = 0; xx < c.width; xx += 2) {
        const i = (y * c.width + xx) * 4, l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        all += l; na++; ch += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
        if (y > c.height * 0.625 && y < c.height * 0.75 && xx > c.width * 0.375 && xx < c.width * 0.625) { hot += l; nh++; }
      }
      return { luma: +(all / na).toFixed(0), hotspot: +(hot / nh).toFixed(0), chroma: +(ch / na).toFixed(1) };
    }, 'data:image/jpeg;base64,' + buf.toString('base64'));
  };

  log(`watchdog start, ${DUR / 1000}s, sample ${STEP / 1000}s`);
  const t0 = Date.now();
  let offRun = 0, ladder = 0, cooldownUntil = 0, fails = 0, notifyAfter = 0;
  while (Date.now() - t0 < DUR) {
    let s = null;
    try { s = await stat(); fails = 0; }
    catch (e) {
      log('sample error:', e.message.slice(0, 90)); fails++;
      if (fails >= 3) { try { await browser.close(); } catch {} browser = await chromium.launch(); page = await browser.newPage(); log('browser relaunched'); fails = 0; }
    }
    if (s) {
      const tcp80 = await probe(80), tcp554 = await probe(554);
      log(`state luma=${s.luma} hotspot=${s.hotspot} chroma=${s.chroma} tcp80=${tcp80} tcp554=${tcp554}`);
      const lit = s.hotspot > OFF_HOTSPOT;
      if (lit) { if (offRun >= OFF_SAMPLES) log(`recovered after step ${ladder}`); offRun = 0; ladder = 0; }
      else offRun++;
      if (!lit && offRun >= OFF_SAMPLES && Date.now() > cooldownUntil) {
        const age = lastPressAgeS();
        if (age === null || age > PRESS_FRESH_S) {
          log(`IR off but automation not pressing (last press ${age}s ago) - not acting`);
          cooldownUntil = Date.now() + 300e3;
        } else {
          let idx = Math.min(ladder, STEPS.length - 1);
          while (idx < STEPS.length && ONCE.has(STEPS[idx][0]) && used.has(STEPS[idx][0])) idx++;
          if (idx >= STEPS.length) idx = 0;   // everything one-shot is spent: fall back to the cheap step
          const [name, fn] = STEPS[idx];
          if (ONCE.has(name)) used.add(name);
          log(`IR off ${offRun} samples (last press ${Math.round(age)}s ago) -> trying ${name}`);
          log(`  ${name} ->`, await fn());
          ladder++;
          if (ladder >= STEPS.length) {
            cooldownUntil = Date.now() + 1800e3;
            log('  ladder exhausted, 30 min cooldown');
            if (Date.now() > notifyAfter) {
              notifyAfter = Date.now() + 6 * 3600e3;
              log('  notifying HA ->', haPost('persistent_notification', 'create', {
                title: 'DoorBird IR stuck',
                message: 'The front gate IR is not lighting and none of the API recovery steps worked. Opening the DoorBird app is the known cure. See /tmp/dbir/irwatch.log in the claude-code container.',
                notification_id: 'doorbird_ir_stuck',
              }));
            }
          }
          else cooldownUntil = Date.now() + 25e3;
          offRun = OFF_SAMPLES; // keep acting on the next evaluation
        }
      }
    }
    await sleep(STEP - ((Date.now() - t0) % STEP));
  }
  log('watchdog finished');
  await browser.close();
})();
