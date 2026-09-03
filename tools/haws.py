#!/usr/bin/env python3
"""Minimal stdlib Home Assistant WebSocket client.
Usage: echo '[{"type":"..."} , ...]' | python3 haws.py
Prints a JSON array of results, one per command, in order.
"""
import base64, json, os, socket, ssl, struct, sys, urllib.parse

BASE  = os.environ.get("HA_BASE_URL", "http://192.168.0.21:8123")
TOKEN = os.environ["HA_TOKEN"]

class WS:
    def __init__(self, url):
        u = urllib.parse.urlparse(url)
        secure = u.scheme in ("https", "wss")
        port = u.port or (443 if secure else 80)
        self.s = socket.create_connection((u.hostname, port), timeout=60)
        if secure:
            self.s = ssl.create_default_context().wrap_socket(self.s, server_hostname=u.hostname)
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path or "/"
        req = (f"GET {path} HTTP/1.1\r\nHost: {u.hostname}:{port}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.s.sendall(req.encode())
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            d = self.s.recv(4096)
            if not d: raise RuntimeError("handshake closed")
            self.buf += d
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        if b"101" not in head.split(b"\r\n")[0]:
            raise RuntimeError("upgrade failed: " + head.decode(errors="replace")[:200])

    def _read(self, n):
        while len(self.buf) < n:
            d = self.s.recv(65536)
            if not d: raise RuntimeError("connection closed")
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        chunks, opcode = [], None
        while True:
            b1, b2 = self._read(2)
            fin, op = b1 & 0x80, b1 & 0x0F
            masked, ln = b2 & 0x80, b2 & 0x7F
            if ln == 126: ln = struct.unpack(">H", self._read(2))[0]
            elif ln == 127: ln = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if masked else None
            data = self._read(ln)
            if mask:
                data = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
            if op == 0x8: raise RuntimeError("server closed")
            if op == 0x9:  # ping -> pong
                self._send_frame(0xA, data); continue
            if op in (0x1, 0x2): opcode = op
            chunks.append(data)
            if fin: break
        return b"".join(chunks).decode()

    def _send_frame(self, op, payload):
        n = len(payload)
        hdr = bytes([0x80 | op])
        if n < 126: hdr += bytes([0x80 | n])
        elif n < 65536: hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else: hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        m = os.urandom(4)
        self.s.sendall(hdr + m + bytes(c ^ m[i % 4] for i, c in enumerate(payload)))

    def send(self, obj): self._send_frame(0x1, json.dumps(obj).encode())
    def close(self):
        try: self._send_frame(0x8, b"")
        except Exception: pass
        self.s.close()

def main():
    cmds = json.load(sys.stdin)
    if isinstance(cmds, dict): cmds = [cmds]
    ws = WS(BASE.replace("http", "ws", 1).rstrip("/") + "/api/websocket")
    msg = json.loads(ws.recv())
    if msg.get("type") != "auth_required": raise RuntimeError("unexpected: " + str(msg)[:200])
    ws.send({"type": "auth", "access_token": TOKEN})
    msg = json.loads(ws.recv())
    if msg.get("type") != "auth_ok": raise RuntimeError("auth failed: " + str(msg)[:300])
    out, pending = {}, {}
    for i, c in enumerate(cmds, start=1):
        c = dict(c); c["id"] = i; pending[i] = c.get("type")
        ws.send(c)
    while pending:
        m = json.loads(ws.recv())
        if m.get("type") != "result": continue
        i = m["id"]; pending.pop(i, None)
        out[i] = {"cmd": cmds[i-1].get("type"), "success": m.get("success"),
                  "result": m.get("result") if m.get("success") else m.get("error")}
    ws.close()
    json.dump([out[k] for k in sorted(out)], sys.stdout, indent=1)
    print()

main()
