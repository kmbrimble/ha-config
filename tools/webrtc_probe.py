"""Probe a HA camera over WebRTC exactly as the frontend does, and report frames received.

Usage: /tmp/cvenv/bin/python tools/webrtc_probe.py camera.x [seconds]   (needs aiortc + aiohttp)
"""
import asyncio, os, sys, time
import aiohttp
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceCandidate
from aiortc.sdp import candidate_from_sdp

ENT = sys.argv[1]; DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 10


async def main():
    pc = RTCPeerConnection()
    pc.addTransceiver("video", direction="recvonly")
    pc.addTransceiver("audio", direction="recvonly")
    stats = {"frames": 0, "first": None, "size": None}
    t0 = time.monotonic()

    @pc.on("connectionstatechange")
    def _cs():
        if os.environ.get("VERBOSE"): print("pc state", pc.connectionState, round(time.monotonic()-t0,2))

    @pc.on("track")
    def on_track(track):
        if os.environ.get("VERBOSE"): print("track", track.kind)
        if track.kind != "video":
            return
        async def pull():
            while True:
                try:
                    f = await track.recv()
                except Exception as e:
                    if os.environ.get("VERBOSE"): print("track recv ended:", repr(e))
                    return
                if stats["first"] is None:
                    stats["first"] = time.monotonic() - t0
                stats["frames"] += 1
                stats["size"] = (f.width, f.height)
        asyncio.ensure_future(pull())

    await pc.setLocalDescription(await pc.createOffer())
    async with aiohttp.ClientSession() as s, s.ws_connect("ws://192.168.0.21:8123/api/websocket") as ws:
        await ws.receive_json()
        await ws.send_json({"type": "auth", "access_token": os.environ["HA_TOKEN"]})
        assert (await ws.receive_json())["type"] == "auth_ok"
        await ws.send_json({"id": 1, "type": "camera/webrtc/offer", "entity_id": ENT,
                            "offer": pc.localDescription.sdp})
        deadline = time.monotonic() + DUR + 15
        answered = False
        while time.monotonic() < deadline:
            try:
                msg = await asyncio.wait_for(ws.receive_json(), timeout=1)
            except asyncio.TimeoutError:
                if answered and stats["first"] is not None and time.monotonic() - t0 - stats["first"] > DUR:
                    break
                continue
            if msg.get("type") == "result" and not msg.get("success"):
                print(ENT, "offer rejected:", msg.get("error")); return
            ev = msg.get("event") or {}
            if os.environ.get("VERBOSE"): print("<<", str(msg)[:160])
            if ev.get("type") == "answer":
                await pc.setRemoteDescription(RTCSessionDescription(ev["answer"], "answer")); answered = True
            elif ev.get("type") == "candidate":
                c = ev["candidate"]
                if c.get("candidate"):
                    cand = candidate_from_sdp(c["candidate"].split(":", 1)[1])
                    cand.sdpMid = c.get("sdpMid"); cand.sdpMLineIndex = c.get("sdpMLineIndex")
                    await pc.addIceCandidate(cand)
            elif ev.get("type") == "error":
                print(ENT, "error:", ev); return
    try:
        rep = await pc.getStats()
        for r in rep.values():
            if r.type == "inbound-rtp":
                print(f"  inbound-rtp {r.kind}: packets={r.packetsReceived}")
    except Exception as e:
        print("  stats error", e)
    f = stats["first"]
    fps = stats["frames"] / DUR if f is not None else 0
    print(f"{ENT}: first frame after {f if f is None else round(f,2)}s, {stats['frames']} frames in {DUR:.0f}s "
          f"({fps:.1f} fps), size {stats['size']}")
    await pc.close()

asyncio.run(main())
