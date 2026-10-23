#!/usr/bin/env python3
"""Health probe for the Blue Iris camera streams (packages/blueiris_stream_watchdog.yaml).

Fetches one camera through HA's own camera proxy - the same path the dashboards use - and
prints `ok` if the body starts with the JPEG magic number FF D8 FF, otherwise `bad`.

Usage:  blueiris_stream_check.py <camera entity_id> <camera access token>
        e.g. blueiris_stream_check.py camera.cameras_subfront 735664dd...   (64 hex chars)

Why a script, and why the URL is built here rather than passed in
----------------------------------------------------------------
The command_line integration (2026.10) runs a *templated* command without a shell and raises
the "Command with a template uses shell features" repair, which becomes a hard break in HA
2027.4.0, if the ASSEMBLED command contains any of  | & ; < > ( ) $ ` * ? [ ] { } ~ #  or a
newline. The old inline `python -c ... 2>/dev/null || echo bad` tripped that, and so would
passing the camera's `entity_picture` (`/api/camera_proxy/<id>?token=...`) as one argument,
because of the `?`. So the template supplies only the token (hex, no metacharacters) and the
fixed `/api/camera_proxy/<id>?token=` shape is built in here. If HA ever changes the token's
format the argument check below rejects it and this reads `bad`, so that failure is loud.

Fails closed, deliberately. A stale Blue Iris session makes the proxy serve BI's HTML login
page (starts with "<!D") with an image content type, so anything that is not a real JPEG -
dead session, BI down, PC off, proxy error, timeout, an unavailable camera, a missing or
malformed argument - reads as `bad`. The watchdog automation's job is to retry until the
picture is real again, whatever the cause. Always exits 0 so the sensor never goes `unknown`
from a crash.
"""
import os
import re
import sys
import urllib.request

JPEG_MAGIC = b"\xff\xd8\xff"
DEFAULT_BASE = "http://127.0.0.1:8123"
TIMEOUT = 8  # seconds; the sensor's command_timeout is 10
CAMERA_RE = re.compile(r"camera\.[a-z0-9_]+")
TOKEN_RE = re.compile(r"[A-Za-z0-9._~-]+")


def healthy(camera, token, base=DEFAULT_BASE, timeout=TIMEOUT):
    """True only if the camera proxy returns a body that starts with a JPEG header."""
    # An unavailable camera renders the template as "", so the token argument goes missing.
    if not CAMERA_RE.fullmatch(camera or "") or not TOKEN_RE.fullmatch(token or ""):
        return False
    try:
        with urllib.request.urlopen(
            f"{base}/api/camera_proxy/{camera}?token={token}", timeout=timeout
        ) as response:
            return response.read(3) == JPEG_MAGIC
    except Exception:  # noqa: BLE001 - every failure means "not healthy"
        return False


def main(argv):
    camera = argv[1] if len(argv) > 1 else ""
    token = argv[2] if len(argv) > 2 else ""
    base = os.environ.get("BLUEIRIS_CHECK_BASE", DEFAULT_BASE)  # overridable for tests only
    print("ok" if healthy(camera, token, base) else "bad")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
