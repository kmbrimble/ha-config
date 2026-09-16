#!/usr/bin/env python3
"""Cross-session lock around deploys to the live Home Assistant.

Git worktrees isolate each session's working copy; they do not isolate the deploy target. Every
session that writes to the live HA config does so inside ONE critical section — push, config
check, reload (or restore), verify — held with:

    tools/deploy_lock.py run --holder "<who/what>" -- bash -c '...'

and copies files only with `tools/deploy_lock.py push`, which refuses to run outside that section.
See CLAUDE.md, "Deploy and verify", for the procedure. Stdlib only, like tools/haws.py.

Design (the "why" is in CLAUDE.md; the short form):

* The lock is the DIRECTORY <lock-dir>/ha-config.deploy.lock containing owner.json. It lives on
  /projects (outside every worktree, and not on /ha-config, which can go stale). It is created by
  writing owner.json into a private staging directory and rename()ing that onto the lock path.
  rename() of a directory onto a non-empty directory fails with ENOTEMPTY, so exactly one racer
  wins and a reader never sees a lock without a complete owner.json. Verified on shfs (FUSE) on
  2026-09-17: 200 rounds x 16 racers, one winner every round. flock() is deliberately not used.
* owner.json records pid + /proc start time (defeats pid reuse, e.g. after a container restart),
  boot_id, hostname, a free-text holder, and the process group of the critical section.
* Liveness, not a timeout, decides staleness: the lock is held while the wrapper is alive, or,
  if the wrapper was SIGKILLed, while anything in the critical section's process group still
  runs. A one-hour backstop applies only where liveness cannot be checked (another host, an
  unreadable owner.json) or to orphans that outlive it. A live wrapper enforces --max-seconds
  itself, so a verifiably live holder is never broken.
* Breaking and releasing are serialised by a second, short-lived lock (…lock.breaking), so a
  breaker can never remove a lock other than the stale one it judged. Every break is logged
  loudly to stderr and to <lock-dir>/ha-config.deploy.log.

Exit codes: the critical section's own code; 75 lock busy after --wait; 77 push refused;
70 internal/lock-integrity error; 124 critical section overran --max-seconds.
"""
import argparse
import errno
import hashlib
import json
import os
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

DEFAULT_LOCK_DIR = "/projects/.locks"
LOCK_NAME = "ha-config.deploy.lock"
BREAK_NAME = "ha-config.deploy.lock.breaking"
LOG_NAME = "ha-config.deploy.log"
OWNER = "owner.json"

BACKSTOP_SECONDS = 3600
BREAK_MUTEX_BACKSTOP = 60

DEFAULT_LIVE_ROOT = "/ha-config"
DEFAULT_SSH_HOST = "root@192.168.0.10"
DEFAULT_SSH_KEY = "/root/.ssh/unraid_secretsman"
DEFAULT_REMOTE_ROOT = "/mnt/remotes/192.168.0.21_config"

EX_SOFTWARE = 70
EX_BUSY = 75
EX_NOPERM = 77
EX_OVERRAN = 124

# Never written by push: HA's own state, credentials, databases and logs (CLAUDE.md constraints).
FORBIDDEN_TOP = {".storage"}
FORBIDDEN_NAMES = {"secrets.yaml", ".ha_run.lock"}
FORBIDDEN_SUFFIXES = (".db", ".db-shm", ".db-wal", ".log")


class LockError(Exception):
    pass


# --------------------------------------------------------------------------- process facts

def now():
    return time.time()


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).astimezone().isoformat(timespec="seconds")


def _stat(pid):
    """Fields of /proc/<pid>/stat from field 3 (state) onwards, or None."""
    try:
        with open(f"/proc/{int(pid)}/stat") as f:
            s = f.read()
    except (OSError, ValueError):
        return None
    return s[s.rindex(")") + 2:].split()


def proc_starttime(pid):
    """Start time in clock ticks since boot (field 22), or None if not running (zombies count as dead)."""
    f = _stat(pid)
    if not f or f[0] in ("Z", "X"):
        return None
    return int(f[19])


def group_alive(pgid, not_before):
    """Is any live process in process group `pgid` that started no earlier than `not_before`?"""
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        f = _stat(d)
        if not f or f[0] in ("Z", "X"):
            continue
        if int(f[2]) == pgid and int(f[19]) >= not_before:
            return True
    return False


def boot_id():
    with open("/proc/sys/kernel/random/boot_id") as f:
        return f.read().strip()


def hostname():
    return socket.gethostname()


def new_owner(holder):
    pid = os.getpid()
    t = now()
    return {
        "version": 1,
        "token": secrets.token_hex(8),
        "pid": pid,
        "pid_starttime": proc_starttime(pid),
        "boot_id": boot_id(),
        "hostname": hostname(),
        "holder": holder,
        "cwd": os.getcwd(),
        "acquired_at": t,
        "acquired_at_iso": iso(t),
        "child_pgid": None,
    }


# --------------------------------------------------------------------------- lock files

def log(parent, msg, loud=False):
    if loud:
        bar = "!" * 78
        sys.stderr.write(f"{bar}\n{msg}\n{bar}\n")
    else:
        sys.stderr.write(f"deploy_lock: {msg}\n")
    try:
        with open(parent / LOG_NAME, "a") as f:
            f.write(f"{iso(now())} pid={os.getpid()} {msg}\n")
    except OSError as e:
        sys.stderr.write(f"deploy_lock: could not append to {parent / LOG_NAME}: {e}\n")


def write_json(path, obj):
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def read_owner(lockpath):
    """('absent', None) | ('ok', owner) | ('corrupt', None)."""
    try:
        with open(lockpath / OWNER) as f:
            data = f.read()
    except (FileNotFoundError, NotADirectoryError):
        return ("corrupt", None) if lockpath.exists() else ("absent", None)
    try:
        o = json.loads(data)
    except ValueError:
        return "corrupt", None
    if not isinstance(o, dict) or "token" not in o:
        return "corrupt", None
    return "ok", o


def describe(o, reason=""):
    tail = f": {reason}" if reason else ""
    if not o:
        return f"held (owner.json unreadable){tail}"
    since = o.get("acquired_at_iso") or o.get("acquired_at")
    return (f"held by {o.get('holder')!r} (pid {o.get('pid')} on {o.get('hostname')}, "
            f"since {since}, token {o.get('token')}){tail}")


def _alive_here(o):
    """True/False when liveness is checkable from this host, else None."""
    if o.get("hostname") != hostname() or o.get("boot_id") != boot_id():
        return None
    pid, st = o.get("pid"), o.get("pid_starttime")
    return isinstance(pid, int) and pid > 0 and proc_starttime(pid) == st


def judge(lockpath, status, o, backstop=BACKSTOP_SECONDS):
    """(stale, reason) for a lock that exists."""
    t = now()
    if status != "ok":
        try:
            age = t - lockpath.stat().st_mtime
        except FileNotFoundError:
            return False, "lock vanished while being inspected"
        if age > backstop:
            return True, f"owner.json unreadable and the lock is older than the {backstop}s backstop"
        return False, f"owner.json unreadable; left alone until the {backstop}s backstop ({int(age)}s so far)"

    try:
        age = max(0.0, t - float(o.get("acquired_at")))
    except (TypeError, ValueError):
        age = backstop + 1.0
    over = age > backstop
    pid, st = o.get("pid"), o.get("pid_starttime")

    if o.get("hostname") == hostname():
        if o.get("boot_id") != boot_id():
            return True, "the lock was taken before this host last booted"
        if _alive_here(o):
            return False, f"holder pid {pid} is alive"
        pgid = o.get("child_pgid")
        if isinstance(pgid, int) and pgid > 0 and isinstance(st, int) and group_alive(pgid, st):
            if over:
                return True, (f"holder pid {pid} is dead and its orphaned critical section "
                              f"(pgid {pgid}) has outlived the {backstop}s backstop")
            return False, f"holder pid {pid} is dead but its critical section (pgid {pgid}) is still running"
        cur = proc_starttime(pid) if isinstance(pid, int) and pid > 0 else None
        if cur is None:
            return True, f"holder pid {pid} is not running"
        return True, f"pid {pid} is running but started at tick {cur}, not {st}: the pid was reused"

    if over:
        return True, (f"held from another host ({o.get('hostname')}) whose liveness cannot be checked, "
                      f"and older than the {backstop}s backstop")
    return False, (f"held from another host ({o.get('hostname')}); liveness cannot be checked from here, "
                   f"so it is left alone until the {backstop}s backstop ({int(age)}s so far)")


def try_place(parent, target, owner):
    """Atomically create `target` holding owner.json. False if it already exists."""
    stage = parent / f".stage-{owner['token']}-{secrets.token_hex(4)}"
    stage.mkdir()
    try:
        write_json(stage / OWNER, owner)
        os.rename(stage, target)
        return True
    except OSError as e:
        if e.errno in (errno.ENOTEMPTY, errno.EEXIST, errno.EISDIR, errno.ENOTDIR, errno.EBUSY):
            return False
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)


def take_aside(parent, target, expected_token, tag):
    """Rename `target` aside iff it is the lock we expect; put anything else back.

    Returns (result, owner_found, aside_path): result is 'gone', 'taken', 'restored' or
    'displaced' (someone else's lock was moved and could not be put back).
    """
    aside = parent / f".{tag}-{secrets.token_hex(6)}"
    try:
        os.rename(target, aside)
    except FileNotFoundError:
        return "gone", None, None
    _, got = read_owner(aside)
    if (got or {}).get("token") == expected_token:
        return "taken", got, aside
    try:
        os.rename(aside, target)
        return "restored", got, None
    except OSError:
        return "displaced", got, aside


class BreakMutex:
    """Serialises breaking and releasing, so neither can remove a lock it did not inspect."""

    def __init__(self, parent):
        self.parent = parent
        self.path = parent / BREAK_NAME
        self.token = None

    def __enter__(self):
        deadline = now() + 2 * BREAK_MUTEX_BACKSTOP + 10
        while True:
            me = new_owner("break mutex")
            if try_place(self.parent, self.path, me):
                self.token = me["token"]
                return self
            st, o = read_owner(self.path)
            if st == "absent":
                continue
            stale, reason = judge(self.path, st, o, BREAK_MUTEX_BACKSTOP)
            if stale:
                r, got, aside = take_aside(self.parent, self.path, (o or {}).get("token"), "stale-breakmutex")
                if r == "taken":
                    log(self.parent, f"!!! STALE BREAK MUTEX REMOVED: {reason}. Owner: {json.dumps(got)}", loud=True)
                    shutil.rmtree(aside, ignore_errors=True)
                continue
            if now() > deadline:
                raise LockError(f"break mutex {self.path} {describe(o, reason)}")
            time.sleep(0.05)

    def __exit__(self, *exc):
        r, got, aside = take_aside(self.parent, self.path, self.token, "released-breakmutex")
        if r == "taken":
            shutil.rmtree(aside, ignore_errors=True)
        else:
            log(self.parent, f"!!! BREAK MUTEX WAS NOT OURS AT RELEASE ({r}); found {json.dumps(got)}", loud=True)
        return False


def break_lock(parent, expected_token, by, manual_reason=None):
    """Remove the lock iff it still carries `expected_token` and is stale (or, by hand, not verifiably alive)."""
    target = parent / LOCK_NAME
    with BreakMutex(parent):
        st, o = read_owner(target)
        if st == "absent" or (o or {}).get("token") != expected_token:
            return False
        stale, reason = judge(target, st, o)
        if manual_reason is None and not stale:
            return False
        if manual_reason is not None and o and _alive_here(o):
            raise LockError(f"refusing to break a verifiably live lock: {describe(o, reason)}")
        r, got, aside = take_aside(parent, target, expected_token, "stale-lock")
        if r != "taken":
            log(parent, f"!!! DEPLOY LOCK CHANGED WHILE BEING BROKEN ({r}); found {json.dumps(got)}", loud=True)
            return False
        prev = json.dumps(got) if got else "(owner.json unreadable)"
        if manual_reason is None:
            msg = f"!!! STALE DEPLOY LOCK BROKEN by {by!r}: {reason}. Previous owner: {prev}"
        else:
            msg = (f"!!! DEPLOY LOCK BROKEN BY HAND by {by!r} ({manual_reason}); automatic verdict was: "
                   f"{reason}. Previous owner: {prev}")
        log(parent, msg, loud=True)
        shutil.rmtree(aside, ignore_errors=True)
        return True


def acquire(parent, holder, wait, poll):
    parent.mkdir(parents=True, exist_ok=True)
    target = parent / LOCK_NAME
    deadline = now() + wait
    announced = False
    while True:
        me = new_owner(holder)
        if try_place(parent, target, me):
            return me
        st, o = read_owner(target)
        if st == "absent":
            continue
        stale, reason = judge(target, st, o)
        if stale:
            break_lock(parent, (o or {}).get("token"), holder)
            continue
        if now() >= deadline:
            sys.stderr.write(f"deploy_lock: BUSY: deploy lock {describe(o, reason)}. Gave up after {wait:g}s.\n")
            return None
        if not announced:
            sys.stderr.write(f"deploy_lock: waiting up to {wait:g}s; deploy lock {describe(o, reason)}\n")
            announced = True
        time.sleep(max(0.01, min(poll, deadline - now())))


def release(parent, token):
    target = parent / LOCK_NAME
    with BreakMutex(parent):
        st, o = read_owner(target)
        if (o or {}).get("token") != token:
            current = "nothing" if st == "absent" else describe(o)
            log(parent, f"!!! DEPLOY LOCK NOT OURS AT RELEASE: token {token} is no longer held "
                        f"(current: {current}). Another session may have deployed concurrently.", loud=True)
            return False
        r, got, aside = take_aside(parent, target, token, "released-lock")
        if r != "taken":
            log(parent, f"!!! DEPLOY LOCK CHANGED DURING RELEASE ({r}); found {json.dumps(got)}", loud=True)
            return False
        shutil.rmtree(aside, ignore_errors=True)
    log(parent, f"released token {token}")
    return True


# --------------------------------------------------------------------------- run

def _killpg(pgid, sig):
    try:
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def supervise(parent, me, cmd, a):
    pgid = [None]
    got = []

    def on_signal(signum, _frame):
        got.append(signum)
        if pgid[0]:
            _killpg(pgid[0], signum)

    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(s, on_signal)

    # The child waits on a pipe until its process group is recorded in owner.json, so there is
    # no window in which a SIGKILLed wrapper leaves a running section the lock cannot see. The
    # wait has to happen after exec (a preexec_fn would deadlock Popen), hence the sh shim.
    r, w = os.pipe()
    shim = ('fd=$1; shift; IFS= read -r g <&"$fd" || exit 125; [ "$g" = go ] || exit 125; '
            'eval "exec $fd<&-"; exec "$@"')
    env = dict(os.environ, HA_DEPLOY_LOCK_TOKEN=me["token"], HA_DEPLOY_LOCK_DIR=str(parent))
    try:
        child = subprocess.Popen(["/bin/sh", "-c", shim, "deploy_lock-gate", str(r), *cmd],
                                 env=env, process_group=0, pass_fds=(r,))
    except (OSError, subprocess.SubprocessError) as e:
        os.close(r)
        os.close(w)
        sys.stderr.write(f"deploy_lock: could not start {cmd[0]!r}: {e}\n")
        return 127
    os.close(r)
    pgid[0] = child.pid
    try:
        me["child_pgid"] = child.pid
        st, cur = read_owner(parent / LOCK_NAME)
        if (cur or {}).get("token") != me["token"]:
            raise LockError("lock lost before the critical section started")
        write_json(parent / LOCK_NAME / OWNER, me)
    except BaseException:
        _killpg(child.pid, signal.SIGKILL)
        os.close(w)
        child.wait()
        raise
    os.write(w, b"go\n")
    os.close(w)
    if got:
        _killpg(child.pid, got[0])

    deadline = now() + a.max_seconds
    overran = False
    stop_at = None
    rc = None
    while rc is None:
        try:
            rc = child.wait(timeout=0.1)
        except subprocess.TimeoutExpired:
            if not overran and now() > deadline:
                overran = True
                log(parent, f"!!! CRITICAL SECTION OVERRAN --max-seconds {a.max_seconds:g} "
                            f"(holder {me['holder']!r}); stopping it", loud=True)
                _killpg(child.pid, signal.SIGTERM)
            if (overran or got) and stop_at is None:
                stop_at = now()
            if stop_at is not None and now() - stop_at > a.grace:
                _killpg(child.pid, signal.SIGKILL)

    # Anything the section left running in the background must not outlive the lock.
    if group_alive(child.pid, me["pid_starttime"]):
        sys.stderr.write("deploy_lock: stopping background processes left by the critical section\n")
        _killpg(child.pid, signal.SIGTERM)
        end = now() + a.grace
        while now() < end and group_alive(child.pid, me["pid_starttime"]):
            time.sleep(0.05)
        if group_alive(child.pid, me["pid_starttime"]):
            _killpg(child.pid, signal.SIGKILL)
            end = now() + 2
            while now() < end and group_alive(child.pid, me["pid_starttime"]):
                time.sleep(0.05)

    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(s, signal.SIG_DFL)

    if rc < 0:
        rc = 128 - rc
    if overran:
        return EX_OVERRAN
    if got and rc == 0:
        return 128 + got[0]
    return rc


def lock_dir(a):
    return Path(a.lock_dir or os.environ.get("HA_DEPLOY_LOCK_DIR") or DEFAULT_LOCK_DIR)


def cmd_run(a):
    cmd = list(a.command)
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        sys.stderr.write("deploy_lock run: no command given (usage: run --holder DESC -- CMD ...)\n")
        return 64
    if not a.holder.strip():
        sys.stderr.write("deploy_lock run: --holder must describe the session and task\n")
        return 64
    parent = lock_dir(a)
    me = acquire(parent, a.holder, a.wait, a.poll)
    if me is None:
        return EX_BUSY
    log(parent, f"acquired token {me['token']} holder={me['holder']!r} cwd={me['cwd']}")
    rc = EX_SOFTWARE
    try:
        rc = supervise(parent, me, cmd, a)
    finally:
        ok = release(parent, me["token"])
    if not ok:
        return rc if rc != 0 else EX_SOFTWARE
    return rc


def cmd_status(a):
    target = lock_dir(a) / LOCK_NAME
    st, o = read_owner(target)
    out = {"lock": str(target), "held": st != "absent"}
    if st != "absent":
        stale, reason = judge(target, st, o)
        out.update(stale=stale, reason=reason, owner=o)
    print(json.dumps(out, indent=2))
    return 0


def cmd_break(a):
    parent = lock_dir(a)
    target = parent / LOCK_NAME
    st, o = read_owner(target)
    if st == "absent":
        print("no deploy lock is held")
        return 0
    current = (o or {}).get("token") or "UNREADABLE"
    if a.token != current:
        sys.stderr.write(f"deploy_lock break: --token {a.token} does not match the current lock "
                         f"({current}); run `status` and try again\n")
        return 1
    try:
        done = break_lock(parent, (o or {}).get("token"), f"break by hand from pid {os.getpid()}", a.reason)
    except LockError as e:
        sys.stderr.write(f"deploy_lock break: {e}\n")
        return 1
    if not done:
        sys.stderr.write("deploy_lock break: the lock changed underneath; run `status` again\n")
        return 1
    return 0


# --------------------------------------------------------------------------- push

def refuse(msg):
    sys.stderr.write(f"deploy_lock push: REFUSED: {msg}\n")
    return EX_NOPERM


def mount_fstype(path):
    real = os.path.realpath(path)
    best, fstype = "", None
    with open("/proc/mounts") as f:
        for line in f:
            parts = line.split()
            if len(parts) < 3:
                continue
            mnt = parts[1].encode().decode("unicode_escape")
            if (real == mnt or real.startswith(mnt.rstrip("/") + "/")) and len(mnt) >= len(best):
                best, fstype = mnt, parts[2]
    return fstype


def md5_bytes(b):
    return hashlib.md5(b).hexdigest()


def push_local(src_bytes, dest, token):
    if not dest.parent.is_dir():
        raise LockError(f"destination directory {dest.parent} does not exist")
    tmp = dest.parent / f".{dest.name}.deploy-{token}.tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(src_bytes)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, dest)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    return md5_bytes(dest.read_bytes())


def push_ssh(src, rel, token, a):
    remote = PurePosixPath(a.remote_root) / rel
    tmp = remote.parent / f".{remote.name}.deploy-{token}.tmp"
    q = shlex.quote
    script = (
        f"set -e; d={q(str(remote))}; t={q(str(tmp))}; "
        f"test -d {q(str(remote.parent))} || {{ echo 'remote directory missing' >&2; exit 3; }}; "
        "trap 'rm -f \"$t\"' EXIT; cat > \"$t\"; mv -f \"$t\" \"$d\"; trap - EXIT; md5sum \"$d\""
    )
    cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
    if a.ssh_key:
        cmd += ["-i", a.ssh_key]
    cmd += [a.ssh_host, script]
    with open(src, "rb") as f:
        p = subprocess.run(cmd, stdin=f, capture_output=True, timeout=120)
    if p.returncode != 0:
        raise LockError(f"ssh push failed ({p.returncode}): {p.stderr.decode(errors='replace').strip()}")
    return p.stdout.decode().split()[0], f"{a.ssh_host}:{remote}"


def check_dest(rel):
    p = PurePosixPath(rel)
    if (p.is_absolute() or not p.parts or ".." in p.parts or rel.strip() != rel
            or p.parts[0] in FORBIDDEN_TOP or p.name in FORBIDDEN_NAMES
            or p.name.endswith(FORBIDDEN_SUFFIXES)):
        return False
    return True


def cmd_push(a):
    parent = lock_dir(a)
    token = os.environ.get("HA_DEPLOY_LOCK_TOKEN")
    if not token:
        return refuse("not inside `deploy_lock.py run` (HA_DEPLOY_LOCK_TOKEN is unset)")
    target = parent / LOCK_NAME
    st, o = read_owner(target)
    if st != "ok" or o.get("token") != token:
        return refuse(f"HA_DEPLOY_LOCK_TOKEN does not match the current deploy lock "
                      f"({'none held' if st == 'absent' else describe(o)})")
    stale, reason = judge(target, st, o)
    if stale:
        return refuse(f"the deploy lock is stale: {reason}")
    if not check_dest(a.dest):
        return refuse(f"forbidden destination {a.dest!r} (must be relative to /config, no '..', "
                      "and never .storage/, secrets.yaml, .ha_run.lock, databases or logs)")
    src = Path(a.src)
    if not src.is_file():
        sys.stderr.write(f"deploy_lock push: source {src} is not a file\n")
        return 1
    data = src.read_bytes()
    want = md5_bytes(data)

    backend = a.backend
    fstype = mount_fstype(a.live_root) if os.path.isdir(a.live_root) else None
    if backend == "auto":
        backend = "local" if fstype == "cifs" else "ssh"
        if backend == "ssh":
            sys.stderr.write(f"deploy_lock push: {a.live_root} is {fstype or 'missing'}, not cifs "
                             "(stale bind mount?); using the unRAID ssh path\n")
    try:
        if backend == "local":
            if fstype != "cifs" and not a.allow_non_cifs:
                sys.stderr.write(f"deploy_lock push: {a.live_root} is {fstype or 'missing'}, not a cifs mount; "
                                 "refusing to write into what may be a stale bind. Use --backend ssh.\n")
                return 1
            dest = Path(a.live_root) / a.dest
            got = push_local(data, dest, token)
            where = str(dest)
        else:
            got, where = push_ssh(src, a.dest, token, a)
    except (LockError, OSError, subprocess.SubprocessError) as e:
        sys.stderr.write(f"deploy_lock push: FAILED: {e}\n")
        return 1
    if got != want:
        sys.stderr.write(f"deploy_lock push: MD5 MISMATCH at {where}: local {want}, live {got}\n")
        return 1
    print(f"pushed {src} -> {where} via {backend} (md5 {got})")
    return 0


# --------------------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--lock-dir", help=f"directory holding the lock (env HA_DEPLOY_LOCK_DIR, default {DEFAULT_LOCK_DIR})")
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="hold the deploy lock while running a command")
    r.add_argument("--holder", required=True, help="who and what, e.g. 'cowork session: kiosk fuel cards'")
    r.add_argument("--wait", type=float, default=300, help="seconds to wait for a busy lock (default 300)")
    r.add_argument("--poll", type=float, default=2, help="seconds between checks while waiting")
    r.add_argument("--max-seconds", type=float, default=1200, help="stop the section after this long (default 1200)")
    r.add_argument("--grace", type=float, default=8, help="seconds between SIGTERM and SIGKILL")
    r.add_argument("command", nargs=argparse.REMAINDER)
    r.set_defaults(func=cmd_run)

    s = sub.add_parser("status", help="print the current holder and whether it is stale (read-only)")
    s.set_defaults(func=cmd_status)

    b = sub.add_parser("break", help="remove a lock by hand (never a verifiably live one)")
    b.add_argument("--token", required=True, help="token from `status` (UNREADABLE for a corrupt owner.json)")
    b.add_argument("--reason", required=True)
    b.set_defaults(func=cmd_break)

    p = sub.add_parser("push", help="copy one file onto the live config; only inside `run`")
    p.add_argument("src")
    p.add_argument("dest", help="path relative to HA's /config, e.g. packages/foo.yaml")
    p.add_argument("--backend", choices=("auto", "local", "ssh"), default="auto")
    p.add_argument("--live-root", default=DEFAULT_LIVE_ROOT)
    p.add_argument("--allow-non-cifs", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--ssh-host", default=DEFAULT_SSH_HOST)
    p.add_argument("--ssh-key", default=DEFAULT_SSH_KEY)
    p.add_argument("--remote-root", default=DEFAULT_REMOTE_ROOT)
    p.set_defaults(func=cmd_push)

    a = ap.parse_args(argv)
    try:
        return a.func(a)
    except LockError as e:
        sys.stderr.write(f"deploy_lock: ERROR: {e}\n")
        return EX_SOFTWARE


if __name__ == "__main__":
    sys.exit(main())
