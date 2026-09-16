"""Create a Generic camera config entry for a Blue Iris RTSP restream, via HA's config-flow API.

Usage: make_generic_cam.py <bi_short_name>
Reads HA_TOKEN, BI_USER, BI_PASS from the environment (see .env). Prints the new entry.
"""
import json, os, sys, urllib.error, urllib.request

HA = "http://192.168.0.21:8123"
HDR = {"Authorization": f"Bearer {os.environ['HA_TOKEN']}", "Content-Type": "application/json"}


def call(method, path, body=None):
    req = urllib.request.Request(HA + path, method=method, headers=HDR,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} on {path}: {e.read().decode()[:500]}")


cam = sys.argv[1]
flow = call("POST", "/api/config/config_entries/flow",
            {"handler": "generic", "show_advanced_options": True})
fid = flow["flow_id"]
step = call("POST", f"/api/config/config_entries/flow/{fid}", {
    "stream_source": f"rtsp://192.168.0.20:81/{cam}",
    "username": os.environ["BI_USER"],
    "password": os.environ["BI_PASS"],
    "advanced": {"framerate": 2, "verify_ssl": False, "rtsp_transport": "tcp",
                 "authentication": "digest"},
})
print("step1:", step.get("type"), step.get("step_id"), step.get("errors"),
      [f["name"] for f in step.get("data_schema", [])])
if step.get("step_id") == "user_confirm":
    step = call("POST", f"/api/config/config_entries/flow/{fid}", {"confirmed_ok": True})
res = step.get("result")
print("final:", step.get("type"), step.get("title"), step.get("errors"),
      res.get("entry_id") if isinstance(res, dict) else res)
