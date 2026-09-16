// Tests for tools/deploy_lock.py — the cross-session deploy lock (see CLAUDE.md, Deploy and verify).
//
// Every test works on a throwaway fixture lock directory and a fixture "live" tree. Nothing here
// touches the real /projects/.locks lock or the live Home Assistant share.
//
// The fixture lives on the same filesystem as the real lock (/projects, shfs/FUSE) when that
// exists, because the atomicity being tested is a property of the filesystem, not of the code.
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TOOL = path.resolve(__dirname, '..', 'deploy_lock.py');
const LOCK_NAME = 'ha-config.deploy.lock';
const LOG_NAME = 'ha-config.deploy.log';
const FIXTURE_PARENT = fs.existsSync('/projects/.locks') ? '/projects/.locks' : os.tmpdir();

let root;
before(() => { root = fs.mkdtempSync(path.join(FIXTURE_PARENT, '.test-deploy-lock-')); });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

let n = 0;
function fixture() {
  const dir = path.join(root, `case-${++n}`);
  fs.mkdirSync(dir);
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseEnv(lockDir, extra = {}) {
  const env = { ...process.env, HA_DEPLOY_LOCK_DIR: lockDir, ...extra };
  if (!('HA_DEPLOY_LOCK_TOKEN' in extra)) delete env.HA_DEPLOY_LOCK_TOKEN;
  return env;
}

// Start the tool without waiting for it. Resolves {code, signal, stdout, stderr} on exit.
function start(lockDir, args, { env = {} } = {}) {
  const child = spawn('python3', [TOOL, ...args], { env: baseEnv(lockDir, env) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  // Resolve on 'close', or shortly after 'exit': a SIGKILLed wrapper's orphaned section can
  // hold the stdio pipes open, and 'close' would then wait for it.
  child.done = new Promise((resolve) => {
    let exited = null;
    const finish = () => resolve({ ...exited, stdout, stderr });
    child.on('exit', (code, signal) => { exited = { code, signal }; setTimeout(finish, 300); });
    child.on('close', (code, signal) => { exited = exited || { code, signal }; finish(); });
  });
  return child;
}

function runSync(lockDir, args, { env = {}, input } = {}) {
  const r = spawnSync('python3', [TOOL, ...args], { env: baseEnv(lockDir, env), input, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const lockPath = (dir) => path.join(dir, LOCK_NAME);
const ownerPath = (dir) => path.join(lockPath(dir), 'owner.json');
const readOwner = (dir) => JSON.parse(fs.readFileSync(ownerPath(dir), 'utf8'));
const readLog = (dir) => (fs.existsSync(path.join(dir, LOG_NAME)) ? fs.readFileSync(path.join(dir, LOG_NAME), 'utf8') : '');

async function waitFor(pred, ms = 10000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (pred()) return; } catch { /* file mid-rename */ }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function starttime(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
}
const bootId = () => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

// Plant a lock as if another session held it.
function plantLock(dir, fields) {
  const owner = {
    version: 1,
    token: crypto.randomBytes(8).toString('hex'),
    pid: 1,
    pid_starttime: 0,
    boot_id: bootId(),
    hostname: os.hostname(),
    holder: 'planted by test',
    cwd: '/nowhere',
    acquired_at: Date.now() / 1000,
    child_pgid: null,
    ...fields,
  };
  fs.mkdirSync(lockPath(dir));
  fs.writeFileSync(ownerPath(dir), JSON.stringify(owner));
  return owner;
}

function deadPid() {
  const r = spawnSync('sh', ['-c', 'sh -c "echo \\$\\$" ']);
  return Number(String(r.stdout).trim());
}

function sleeper() {
  return spawn('sleep', ['30'], { stdio: 'ignore' });
}

describe('acquisition', () => {
  test('run takes the lock, records the wrapper as holder, and exports the token', async () => {
    const dir = fixture();
    const out = path.join(dir, 'seen.json');
    const script = `import json,os; json.dump({"token": os.environ.get("HA_DEPLOY_LOCK_TOKEN"), "ppid": os.getppid(), "lockdir": os.environ.get("HA_DEPLOY_LOCK_DIR"), "owner": json.load(open(${JSON.stringify(ownerPath(dir))}))}, open(${JSON.stringify(out)}, "w"))`;
    const r = await start(dir, ['run', '--holder', 'test: acquire', '--', 'python3', '-c', script]).done;
    assert.strictEqual(r.code, 0, r.stderr);
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    const o = seen.owner;
    for (const k of ['version', 'token', 'pid', 'pid_starttime', 'boot_id', 'hostname', 'holder', 'cwd', 'acquired_at', 'child_pgid']) {
      assert.ok(k in o, `owner.json missing ${k}`);
    }
    assert.strictEqual(o.holder, 'test: acquire');
    assert.strictEqual(o.hostname, os.hostname());
    assert.strictEqual(o.boot_id, bootId());
    assert.strictEqual(seen.token, o.token, 'token exported to the critical section');
    assert.strictEqual(seen.lockdir, dir);
    assert.strictEqual(o.pid, seen.ppid, 'recorded pid is the wrapper, which is the command\'s parent');
    assert.ok(o.pid_starttime > 0);
    assert.ok(Number.isInteger(o.child_pgid) && o.child_pgid > 0, 'child process group recorded before the command runs');
    assert.ok(!fs.existsSync(lockPath(dir)), 'released afterwards');
  });

  test('run without --holder is refused', () => {
    const dir = fixture();
    const r = runSync(dir, ['run', '--', 'true']);
    assert.notStrictEqual(r.code, 0);
    assert.ok(!fs.existsSync(lockPath(dir)));
  });

  test('the exit code of the critical section is passed through', async () => {
    const dir = fixture();
    const r = await start(dir, ['run', '--holder', 't', '--', 'sh', '-c', 'exit 7']).done;
    assert.strictEqual(r.code, 7);
  });
});

describe('contention', () => {
  test('eight racing acquisitions with no wait: exactly one wins', async () => {
    const dir = fixture();
    const kids = [];
    for (let i = 0; i < 8; i++) {
      kids.push(start(dir, ['run', '--holder', `racer ${i}`, '--wait', '0', '--', 'sleep', '2']));
    }
    const results = await Promise.all(kids.map((k) => k.done));
    const codes = results.map((r) => r.code).sort();
    assert.deepStrictEqual(codes, [0, 75, 75, 75, 75, 75, 75, 75], JSON.stringify(results.map((r) => [r.code, r.stderr])));
    const loser = results.find((r) => r.code === 75);
    assert.match(loser.stderr, /racer \d/, 'a loser names the holder');
  });

  test('waiting acquirers serialise: critical sections never overlap', async () => {
    const dir = fixture();
    const trace = path.join(dir, 'trace');
    const body = `echo "start $$" >> ${trace}; sleep 0.4; echo "end $$" >> ${trace}`;
    const kids = [];
    for (let i = 0; i < 6; i++) {
      kids.push(start(dir, ['run', '--holder', `w${i}`, '--wait', '60', '--poll', '0.1', '--', 'sh', '-c', body]));
    }
    const results = await Promise.all(kids.map((k) => k.done));
    for (const r of results) assert.strictEqual(r.code, 0, r.stderr);
    const lines = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n') : [];
    assert.strictEqual(lines.length, 12);
    for (let i = 0; i < lines.length; i += 2) {
      const [a, pa] = lines[i].split(' ');
      const [b, pb] = lines[i + 1].split(' ');
      assert.strictEqual(a, 'start', `overlap at line ${i}: ${lines.join(' | ')}`);
      assert.strictEqual(b, 'end', `overlap at line ${i}: ${lines.join(' | ')}`);
      assert.strictEqual(pa, pb, `interleaved sections: ${lines.join(' | ')}`);
    }
  });

  test('a busy lock times out with 75 once --wait expires', async () => {
    const dir = fixture();
    const holder = start(dir, ['run', '--holder', 'long holder', '--', 'sleep', '3']);
    await waitFor(() => fs.existsSync(ownerPath(dir)), 5000, 'holder');
    const t0 = Date.now();
    const r = await start(dir, ['run', '--holder', 'impatient', '--wait', '1', '--poll', '0.1', '--', 'true']).done;
    assert.strictEqual(r.code, 75);
    assert.ok(Date.now() - t0 >= 900, 'actually waited');
    assert.match(r.stderr, /long holder/);
    assert.strictEqual((await holder.done).code, 0);
  });
});

describe('stale detection and breaking', () => {
  test('status reports a free lock', () => {
    const dir = fixture();
    const r = runSync(dir, ['status']);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).held, false);
  });

  test('a lock whose holder pid is dead is stale, and is broken loudly', async () => {
    const dir = fixture();
    const pid = deadPid();
    const planted = plantLock(dir, { pid, pid_starttime: 12345, holder: 'crashed session' });
    const st = JSON.parse(runSync(dir, ['status']).stdout);
    assert.strictEqual(st.held, true);
    assert.strictEqual(st.stale, true, st.reason);
    const r = await start(dir, ['run', '--holder', 'next', '--wait', '0', '--', 'true']).done;
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stderr, /STALE DEPLOY LOCK BROKEN/);
    assert.match(r.stderr, /crashed session/);
    const log = readLog(dir);
    assert.match(log, /STALE DEPLOY LOCK BROKEN/);
    assert.ok(log.includes(planted.token), 'log names the broken token');
  });

  test('a live pid with the wrong start time (pid reuse) is stale', () => {
    const dir = fixture();
    plantLock(dir, { pid: process.pid, pid_starttime: starttime(process.pid) + 1 });
    const st = JSON.parse(runSync(dir, ['status']).stdout);
    assert.strictEqual(st.stale, true, st.reason);
  });

  test('a live holder is never broken, however old the lock', async () => {
    const dir = fixture();
    const s = sleeper();
    try {
      await waitFor(() => fs.existsSync(`/proc/${s.pid}/stat`));
      plantLock(dir, { pid: s.pid, pid_starttime: starttime(s.pid), acquired_at: Date.now() / 1000 - 5 * 3600 });
      const st = JSON.parse(runSync(dir, ['status']).stdout);
      assert.strictEqual(st.stale, false, st.reason);
      const r = await start(dir, ['run', '--holder', 'x', '--wait', '0', '--', 'true']).done;
      assert.strictEqual(r.code, 75);
      assert.ok(fs.existsSync(ownerPath(dir)), 'lock left in place');
    } finally { s.kill('SIGKILL'); }
  });

  test('a lock from a previous boot is stale', () => {
    const dir = fixture();
    plantLock(dir, { pid: process.pid, pid_starttime: starttime(process.pid), boot_id: '00000000-0000-0000-0000-000000000000' });
    assert.strictEqual(JSON.parse(runSync(dir, ['status']).stdout).stale, true);
  });

  test('a foreign-host lock is held until the backstop, then stale', () => {
    const young = fixture();
    plantLock(young, { hostname: 'some-other-container', acquired_at: Date.now() / 1000 - 600 });
    assert.strictEqual(JSON.parse(runSync(young, ['status']).stdout).stale, false);
    const old = fixture();
    plantLock(old, { hostname: 'some-other-container', acquired_at: Date.now() / 1000 - 3700 });
    const st = JSON.parse(runSync(old, ['status']).stdout);
    assert.strictEqual(st.stale, true);
    assert.match(st.reason, /backstop/i);
  });

  test('a lock with an unreadable owner is left alone until the backstop', () => {
    const dir = fixture();
    fs.mkdirSync(lockPath(dir));
    fs.writeFileSync(ownerPath(dir), '{not json');
    const st = JSON.parse(runSync(dir, ['status']).stdout);
    assert.strictEqual(st.held, true);
    assert.strictEqual(st.stale, false);
  });

  test('racing breakers: one stale lock, eight contenders, exactly one winner', async () => {
    const dir = fixture();
    plantLock(dir, { pid: deadPid(), pid_starttime: 1, holder: 'dead' });
    const kids = [];
    for (let i = 0; i < 8; i++) kids.push(start(dir, ['run', '--holder', `b${i}`, '--wait', '0', '--', 'sleep', '2']));
    const results = await Promise.all(kids.map((k) => k.done));
    const codes = results.map((r) => r.code).sort();
    assert.deepStrictEqual(codes, [0, 75, 75, 75, 75, 75, 75, 75], JSON.stringify(results.map((r) => [r.code, r.stderr])));
  });

  test('break refuses a verifiably live holder and breaks a dead one', () => {
    const live = fixture();
    const o = plantLock(live, { pid: process.pid, pid_starttime: starttime(process.pid) });
    const r1 = runSync(live, ['break', '--token', o.token, '--reason', 'test']);
    assert.notStrictEqual(r1.code, 0);
    assert.ok(fs.existsSync(ownerPath(live)));
    const dead = fixture();
    const d = plantLock(dead, { pid: deadPid(), pid_starttime: 1 });
    const r2 = runSync(dead, ['break', '--token', d.token, '--reason', 'test']);
    assert.strictEqual(r2.code, 0, r2.stderr);
    assert.ok(!fs.existsSync(lockPath(dead)));
    assert.match(readLog(dead), /BROKEN/);
  });
});

describe('release', () => {
  test('released after a failing critical section', async () => {
    const dir = fixture();
    const r = await start(dir, ['run', '--holder', 't', '--', 'false']).done;
    assert.strictEqual(r.code, 1);
    assert.ok(!fs.existsSync(lockPath(dir)));
    assert.match(readLog(dir), /released/);
  });

  test('SIGTERM to the wrapper stops the section and releases', async () => {
    const dir = fixture();
    const k = start(dir, ['run', '--holder', 't', '--grace', '2', '--', 'sleep', '30']);
    await waitFor(() => fs.existsSync(ownerPath(dir)) && readOwner(dir).child_pgid, 5000, 'child started');
    const t0 = Date.now();
    k.kill('SIGTERM');
    const r = await k.done;
    assert.ok(Date.now() - t0 < 5000, 'did not wait for sleep 30');
    assert.notStrictEqual(r.code, 0);
    assert.ok(!fs.existsSync(lockPath(dir)));
  });

  test('--max-seconds kills an overrunning section and releases', async () => {
    const dir = fixture();
    const t0 = Date.now();
    const r = await start(dir, ['run', '--holder', 't', '--max-seconds', '1', '--grace', '1', '--', 'sleep', '30']).done;
    assert.ok(Date.now() - t0 < 10000);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.stderr, /max-seconds|overran/i);
    assert.ok(!fs.existsSync(lockPath(dir)));
  });

  test('stragglers left in the background are stopped before release', async () => {
    const dir = fixture();
    const marker = path.join(dir, 'straggler');
    const ran = path.join(dir, 'ran');
    const r = await start(dir, ['run', '--holder', 't', '--grace', '1', '--', 'sh', '-c', `touch ${ran}; (sleep 3; touch ${marker}) & exit 0`]).done;
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(ran), 'the section ran');
    assert.match(r.stderr, /background processes/);
    assert.ok(!fs.existsSync(lockPath(dir)));
    await sleep(3500);
    assert.ok(!fs.existsSync(marker), 'background process outlived the lock');
  });

  test('SIGKILL leaves the lock; it is held while the section still runs, then stale', async () => {
    const dir = fixture();
    const k = start(dir, ['run', '--holder', 'killed', '--', 'sleep', '2']);
    await waitFor(() => fs.existsSync(ownerPath(dir)) && readOwner(dir).child_pgid, 5000, 'child started');
    k.kill('SIGKILL');
    await k.done;
    assert.ok(fs.existsSync(ownerPath(dir)), 'SIGKILL runs no cleanup');
    const during = JSON.parse(runSync(dir, ['status']).stdout);
    assert.strictEqual(during.stale, false, `orphaned section still running: ${during.reason}`);
    await sleep(2500);
    const afterwards = JSON.parse(runSync(dir, ['status']).stdout);
    assert.strictEqual(afterwards.stale, true, afterwards.reason);
    const r = await start(dir, ['run', '--holder', 'next', '--wait', '0', '--', 'true']).done;
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stderr, /STALE DEPLOY LOCK BROKEN/);
  });

  test('a section whose lock was taken from it says so loudly on release', async () => {
    const dir = fixture();
    const body = `python3 -c "import os,shutil; shutil.rmtree(os.environ['HA_DEPLOY_LOCK_DIR']+'/${LOCK_NAME}')"; mkdir ${lockPath(dir)}; echo '{"token":"intruder","hostname":"elsewhere","acquired_at":${Date.now() / 1000}}' > ${ownerPath(dir)}`;
    const r = await start(dir, ['run', '--holder', 't', '--', 'sh', '-c', body]).done;
    assert.notStrictEqual(r.code, 0);
    assert.match(r.stderr, /not ours|no longer held/i);
    assert.strictEqual(readOwner(dir).token, 'intruder', 'someone else\'s lock is left alone');
  });
});

describe('push', () => {
  function tree() {
    const dir = fixture();
    const live = path.join(dir, 'live');
    fs.mkdirSync(path.join(live, 'packages'), { recursive: true });
    fs.mkdirSync(path.join(live, '.storage'));
    const src = path.join(dir, 'src.yaml');
    fs.writeFileSync(src, 'sensor: []\n');
    fs.writeFileSync(path.join(live, 'packages', 'x.yaml'), 'old: true\n');
    return { dir, live, src };
  }
  const pushArgs = (live, src, rel, extra = []) => ['push', src, rel, '--live-root', live, ...extra];
  const liveFile = (live) => fs.readFileSync(path.join(live, 'packages/x.yaml'), 'utf8');

  test('refused without a lock token', () => {
    const { dir, live, src } = tree();
    const r = runSync(dir, pushArgs(live, src, 'packages/x.yaml', ['--backend', 'local', '--allow-non-cifs']));
    assert.strictEqual(r.code, 77, r.stderr);
    assert.strictEqual(liveFile(live), 'old: true\n');
  });

  test('refused with a token that is not the current holder\'s', async () => {
    const { dir, live, src } = tree();
    const s = sleeper();
    try {
      await waitFor(() => fs.existsSync(`/proc/${s.pid}/stat`));
      plantLock(dir, { pid: s.pid, pid_starttime: starttime(s.pid) });
      const r = runSync(dir, pushArgs(live, src, 'packages/x.yaml', ['--backend', 'local', '--allow-non-cifs']), { env: { HA_DEPLOY_LOCK_TOKEN: 'deadbeef' } });
      assert.strictEqual(r.code, 77);
      assert.strictEqual(liveFile(live), 'old: true\n');
    } finally { s.kill('SIGKILL'); }
  });

  test('refused when the matching lock is stale', () => {
    const { dir, live, src } = tree();
    const o = plantLock(dir, { pid: deadPid(), pid_starttime: 1 });
    const r = runSync(dir, pushArgs(live, src, 'packages/x.yaml', ['--backend', 'local', '--allow-non-cifs']), { env: { HA_DEPLOY_LOCK_TOKEN: o.token } });
    assert.strictEqual(r.code, 77);
    assert.strictEqual(liveFile(live), 'old: true\n');
  });

  test('local backend: replaces the file under the lock, leaves no temp file', async () => {
    const { dir, live, src } = tree();
    const tool = `python3 ${TOOL} ${pushArgs(live, src, 'packages/x.yaml', ['--backend', 'local', '--allow-non-cifs']).join(' ')}`;
    const r = await start(dir, ['run', '--holder', 't', '--', 'sh', '-c', tool]).done;
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(liveFile(live), 'sensor: []\n');
    assert.deepStrictEqual(fs.readdirSync(path.join(live, 'packages')), ['x.yaml']);
    assert.match(r.stdout, /md5/);
  });

  test('local backend refuses a live root that is not a CIFS mount', async () => {
    const { dir, live, src } = tree();
    const tool = `python3 ${TOOL} ${pushArgs(live, src, 'packages/x.yaml', ['--backend', 'local']).join(' ')}`;
    const r = await start(dir, ['run', '--holder', 't', '--', 'sh', '-c', tool]).done;
    assert.notStrictEqual(r.code, 0);
    assert.match(r.stderr, /cifs/i);
    assert.strictEqual(liveFile(live), 'old: true\n');
  });

  function fakeSsh(dir) {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // Records its argv, then runs the remote command locally, so the real remote script is exercised.
    fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
printf '%s\\n' "$@" > ${path.join(dir, 'ssh-argv')}
while [ $# -gt 1 ]; do shift; done
exec sh -c "$1"
`, { mode: 0o755 });
    return bin;
  }

  test('ssh backend (auto-selected when the live root is not CIFS) writes via the host', async () => {
    const { dir, live, src } = tree();
    const bin = fakeSsh(dir);
    const tool = `python3 ${TOOL} ${pushArgs(live, src, 'packages/x.yaml', ['--remote-root', live, '--ssh-host', 'root@unraid.test']).join(' ')}`;
    const r = await start(dir, ['run', '--holder', 't', '--', 'sh', '-c', tool], { env: { PATH: `${bin}:${process.env.PATH}` } }).done;
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /via ssh/);
    assert.strictEqual(liveFile(live), 'sensor: []\n');
    assert.deepStrictEqual(fs.readdirSync(path.join(live, 'packages')), ['x.yaml']);
    assert.match(fs.readFileSync(path.join(dir, 'ssh-argv'), 'utf8'), /root@unraid\.test/);
  });

  test('ssh backend is refused without the lock too', () => {
    const { dir, live, src } = tree();
    const bin = fakeSsh(dir);
    const r = runSync(dir, pushArgs(live, src, 'packages/x.yaml', ['--backend', 'ssh', '--remote-root', live]), { env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.strictEqual(r.code, 77);
    assert.ok(!fs.existsSync(path.join(dir, 'ssh-argv')), 'ssh never invoked');
    assert.strictEqual(liveFile(live), 'old: true\n');
  });

  for (const bad of ['.storage/core.config_entries', 'secrets.yaml', '../escape.yaml', '/etc/passwd', 'packages/../.storage/x', '.ha_run.lock', 'home-assistant_v2.db']) {
    test(`refuses forbidden destination ${bad}`, async () => {
      const { dir, live, src } = tree();
      const tool = `python3 ${TOOL} ${pushArgs(live, src, `'${bad}'`, ['--backend', 'local', '--allow-non-cifs']).join(' ')}`;
      const r = await start(dir, ['run', '--holder', 't', '--', 'sh', '-c', tool]).done;
      assert.notStrictEqual(r.code, 0);
      assert.match(r.stderr, /forbidden/i);
    });
  }
});
