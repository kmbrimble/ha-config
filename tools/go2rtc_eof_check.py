#!/usr/bin/env python3
"""Count NEW go2rtc / stream errors on the kiosk's dual-lens "sub" camera streams
(subsideyard, subbottomyard, subfront, subtopyard, subbackgate) since the last poll.
See kmbrimble/ha-config#22 and claude/kiosk-camera-framerate.md.

go2rtc's ffmpeg-wrapped RTSP producer for these streams periodically dies with
`error=EOF` and go2rtc reconnects it. An isolated reconnect usually recovers on
its own, but a sustained burst is what tends to leave the kiosk's WebRTC <video>
element stuck on a stale frame (the browser never renegotiates on its own).

HOW IT COUNTS (rewritten 28 Oct 2026)
-------------------------------------
It tails HA's own log file (/config/home-assistant.log, read-only) from the byte
offset it reached last time, and counts the lines that are

  * a WARNING/ERROR from `homeassistant.components.go2rtc.server` that names one
    of the sub cameras (the `error=EOF url=ffmpeg:rtsp://.../subfront` line, and
    also timeouts / "Invalid data found" seen during a real Blue Iris outage), or
  * a WARNING/ERROR from HA's per-camera stream worker
    `homeassistant.components.stream.stream.camera.bi_<sub>` (fires when that
    camera's RTSP source cannot be opened at all).

Why not system_log/list (the previous implementation)? HA dedupes system_log into
ONE object per source with a cumulative `count` and keeps only its last 5 distinct
messages. The old script added that whole cumulative count whenever any of the 5
retained messages named a sub camera, so the total jumped by hundreds whenever such a
message appeared, and fell again when it rotated out. A dominant `frontgate` EOF stream
(about 11/hour, ~30/hour in daylight) shared that entry, so the sensor read 67, 133 ...
496 "reconnects in 3 minutes" and the watchdog restarted the kiosk's Firefox 13 times in
two days for nothing. Counting individual log lines avoids all of that, and `frontgate`
(deliberately NOT in SUB_CAMERAS) can no longer inflate the number.

State file: {"offset": <bytes consumed>, "inode": <log inode>, "ts": <epoch>}.
  * first run / unreadable state / old-format state -> baseline at end of file, print 0
  * log shrank or its inode changed (HA restart rotates the log) -> read the new file
    from the start
Only complete lines are consumed (a half-written last line is left for the next poll).
The log is only ever READ. Prints a plain integer for a numeric command_line sensor
and fails closed (prints 0, message on stderr) rather than crashing.

Paths can be overridden with GO2RTC_EOF_LOG / GO2RTC_EOF_STATE (used by the tests).
"""
import json
import os
import re
import sys
import time

LOG_FILE = os.environ.get("GO2RTC_EOF_LOG", "/config/home-assistant.log")
STATE_FILE = os.environ.get("GO2RTC_EOF_STATE", "/config/tools/.go2rtc_eof_state.json")
SUB_CAMERAS = ("subsideyard", "subbottomyard", "subfront", "subtopyard", "subbackgate")
MAX_READ = 8 * 1024 * 1024  # never read more than this in one poll

_CAMS = "|".join(SUB_CAMERAS)
# HA log line: "2026-10-28 17:26:10.123 WARNING (MainThread) [logger.name] message"
_GO2RTC_RE = re.compile(
    r" (?:WARNING|ERROR|CRITICAL) .*\[homeassistant\.components\.go2rtc\.server\].*\b(?:%s)\b" % _CAMS
)
_STREAM_RE = re.compile(
    r" (?:WARNING|ERROR|CRITICAL) .*\[homeassistant\.components\.stream\.stream\.camera\.bi_(?:%s)\]" % _CAMS
)


def matches(line):
    return bool(_GO2RTC_RE.search(line) or _STREAM_RE.search(line))


def load_state():
    try:
        with open(STATE_FILE) as f:
            s = json.load(f)
        if isinstance(s.get("offset"), int) and isinstance(s.get("inode"), int):
            return s
    except (FileNotFoundError, json.JSONDecodeError, ValueError, AttributeError):
        pass
    return None


def save_state(offset, inode):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"offset": offset, "inode": inode, "ts": time.time()}, f)
    os.replace(tmp, STATE_FILE)


def count_new():
    st = os.stat(LOG_FILE)
    state = load_state()
    if state is None:
        save_state(st.st_size, st.st_ino)  # baseline: nothing counted on first run
        return 0

    offset = state["offset"]
    if st.st_ino != state["inode"] or st.st_size < offset:
        offset = 0  # rotated / replaced: everything in the new file is new
    if st.st_size - offset > MAX_READ:
        offset = st.st_size - MAX_READ  # catch-up cap; first (partial) line dropped below
        skip_first = True
    else:
        skip_first = False

    with open(LOG_FILE, "rb") as f:
        f.seek(offset)
        data = f.read(st.st_size - offset)

    end = data.rfind(b"\n")
    if end == -1:
        # no complete line yet: keep the offset where it was
        save_state(offset, st.st_ino)
        return 0
    complete = data[: end + 1]
    consumed = offset + len(complete)

    lines = complete.decode("utf-8", errors="replace").split("\n")
    if skip_first and lines:
        lines = lines[1:]
    n = sum(1 for line in lines if matches(line))
    save_state(consumed, st.st_ino)
    return n


if __name__ == "__main__":
    try:
        print(count_new())
    except Exception as exc:  # command_line sensor: fail closed, not crash-loud
        print("0")
        print(f"go2rtc_eof_check error: {exc}", file=sys.stderr)
