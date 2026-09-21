#!/usr/bin/env python3
"""Detect bursts of go2rtc/stream errors on the kiosk's dual-lens "sub" camera
streams (subsideyard, subbottomyard, subfront, subtopyard, subbackgate). See
kmbrimble/ha-config#22 and claude/kiosk-camera-framerate.md.

go2rtc's ffmpeg-wrapped RTSP producer for these five streams periodically dies
with `error=EOF` and go2rtc reconnects it. An isolated reconnect usually
recovers on its own, but a burst of them in a short window is what tends to
leave the kiosk's WebRTC <video> element stuck on a stale frame (the browser
side never renegotiates on its own).

A real Blue Iris/network outage on 22 Sep 2026 showed this isn't the only
failure shape: go2rtc logged "Operation timed out" / "Invalid data found when
processing input" instead of "error=EOF", which the original EOF-only match
missed, and two of the five streams (subsideyard, subfront) failed to
self-recover afterward while the other three did. So this also counts HA's
own per-camera `stream` component errors (`homeassistant.components.stream.
stream.camera.bi_<sub>`), which fire directly and unambiguously when one of
these cameras' RTSP source can't be opened at all - see the matching logic
below for both signals.

HA's system_log entries are DEDUPED: one object per unique message text, with
a cumulative `count` since `first_occurred` (which only resets on an HA
restart) rather than a per-occurrence timestamp list. To turn that into a
"how many just happened" signal, this script keeps a tiny state file recording
the count it saw last time, and prints the delta (new occurrences since the
last check) — a plain integer, so it can drive a numeric command_line sensor.

Reads the long-lived token from /config/tools/.ha_token (git-ignored,
live-config only — see tools/deploy_lock.py and .gitignore). Talks to HA's
own websocket API on 127.0.0.1, same as tools/haws.py, but self-contained so
it can run as a command_line command inside the HA process itself.
"""
import base64
import json
import os
import socket
import struct
import sys
import time

STATE_FILE = "/config/tools/.go2rtc_eof_state.json"
TOKEN_FILE = "/config/tools/.ha_token"
HOST, PORT = "127.0.0.1", 8123
SUB_CAMERAS = ("subsideyard", "subbottomyard", "subfront", "subtopyard", "subbackgate")


def ws_connect():
    s = socket.create_connection((HOST, PORT), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET /api/websocket HTTP/1.1\r\nHost: {HOST}:{PORT}\r\nUpgrade: websocket\r\n"
        f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
    s.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        d = s.recv(4096)
        if not d:
            raise RuntimeError("handshake closed")
        buf += d
    return s, buf.split(b"\r\n\r\n", 1)[1]


def ws_send(s, obj):
    payload = json.dumps(obj).encode()
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    length = len(payload)
    if length < 126:
        header = struct.pack("!BB", 0x81, 0x80 | length)
    else:
        header = struct.pack("!BBH", 0x81, 0x80 | 126, length)
    s.sendall(header + mask + masked)


def ws_recv_frame(s, leftover):
    buf = leftover
    while len(buf) < 2:
        buf += s.recv(4096)
    b1, b2 = buf[0], buf[1]
    masked = b2 & 0x80
    length = b2 & 0x7F
    idx = 2
    if length == 126:
        while len(buf) < idx + 2:
            buf += s.recv(4096)
        length = struct.unpack("!H", buf[idx : idx + 2])[0]
        idx += 2
    elif length == 127:
        while len(buf) < idx + 8:
            buf += s.recv(4096)
        length = struct.unpack("!Q", buf[idx : idx + 8])[0]
        idx += 8
    if masked:
        while len(buf) < idx + 4:
            buf += s.recv(4096)
        mask = buf[idx : idx + 4]
        idx += 4
    while len(buf) < idx + length:
        buf += s.recv(4096)
    payload = buf[idx : idx + length]
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return payload, buf[idx + length :]


def ws_recv_json(s, leftover):
    payload, leftover = ws_recv_frame(s, leftover)
    return json.loads(payload), leftover


def main():
    token = open(TOKEN_FILE).read().strip()
    s, leftover = ws_connect()
    try:
        msg, leftover = ws_recv_json(s, leftover)  # auth_required
        ws_send(s, {"type": "auth", "access_token": token})
        msg, leftover = ws_recv_json(s, leftover)  # auth_ok / auth_invalid
        if msg.get("type") != "auth_ok":
            print("0")  # fail closed: no signal rather than a crash
            return
        ws_send(s, {"id": 1, "type": "system_log/list"})
        msg, leftover = ws_recv_json(s, leftover)
        entries = msg.get("result", []) or []
    finally:
        s.close()

    stream_loggers = {f"homeassistant.components.stream.stream.camera.bi_{cam}" for cam in SUB_CAMERAS}

    total_count = 0
    for e in entries:
        name = e.get("name", "")
        text = " ".join(e.get("message", [])) if isinstance(e.get("message"), list) else e.get("message", "")
        if name == "homeassistant.components.go2rtc.server" and any(cam in text for cam in SUB_CAMERAS):
            # Catches the ffmpeg-producer EOF churn (kmbrimble/ha-config#22) *and*
            # any other error go2rtc logs for these streams (timeouts, "Invalid
            # data found" during a real Blue Iris outage, etc.) - widened
            # 22 Sep 2026 after a real BI outage produced "Operation timed out" /
            # "Invalid data found when processing input" instead of "error=EOF",
            # which the original EOF-only match missed entirely.
            total_count += e.get("count", 0)
        elif name in stream_loggers:
            # HA's own `stream` component logs per-camera when its worker can't
            # open the RTSP source at all - a direct, unambiguous per-entity
            # signal that this exact camera's feed just failed, seen firing for
            # camera.bi_subsideyard / camera.bi_subfront specifically on 22 Sep
            # 2026 when they didn't recover from a Blue Iris blip that the other
            # four cameras shrugged off.
            total_count += e.get("count", 0)

    prev_count, prev_ts = 0, time.time()
    try:
        with open(STATE_FILE) as f:
            state = json.load(f)
            prev_count, prev_ts = state.get("count", 0), state.get("ts", time.time())
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        pass

    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump({"count": total_count, "ts": time.time()}, f)

    # A restart resets HA's own dedup counters to 0, which would otherwise read
    # as a huge negative delta. Treat any decrease as "no new occurrences".
    delta = max(0, total_count - prev_count)
    print(delta)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # command_line sensor: fail closed, not crash-loud
        print("0", file=sys.stdout)
        print(f"go2rtc_eof_check error: {exc}", file=sys.stderr)
