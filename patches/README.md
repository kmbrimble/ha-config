# Local patches to HACS-installed custom components

Files here are **not** loaded from this repo. They are copies of patches applied by hand
to `/config/custom_components/<component>/` on the HA host, kept under version control so
they can be re-applied — **a HACS update of the component will silently overwrite them.**

## blueiris — camera session refresh (2026-09-05)

`custom_components/blueiris` builds each camera's still-image and stream URL once, at
entity construction, embedding the Blue Iris session ID that was current at that moment
(`managers/entity_manager.py`, `.../image/{cam}?session={session_id}`).

Blue Iris invalidates sessions — on a BI or PC restart, and on its own session timeout.
The API layer copes: `async_verified_post()` re-logs in and gets a fresh session ID. The
camera entities do not: `self._still_image_url` is never re-read, so every image fetch
keeps using the dead session forever.

The failure is silent. BI answers a dead session with a 302 to `/login.htm`, aiohttp
follows it into a 200, and the entity caches that HTML as its camera image — which HA
then serves to the frontend as `image/jpeg`. Entities stay `idle`, nothing goes
`unavailable`, and the dashboards just show broken pictures until the config entry is
reloaded.

`camera.py` here rewrites the `session` query parameter at request time from
`self.api.session_id`, rejects any response that is not an image, and re-authenticates
and retries once (rate limited to one attempt per 30s per camera) when a fetch fails.

- Applied to: `/config/custom_components/blueiris/camera.py`
- Original backed up to `backups/blueiris-camera.py-<timestamp>.bak`
- `camera.py` is the full patched file; `camera.py.patch` is the diff against 1.0.23
- Upstream: elad-bar/ha-blueiris

To re-apply after a HACS update:
`cp patches/blueiris/camera.py /config/custom_components/blueiris/camera.py` then restart HA.

`packages/blueiris_stream_watchdog.yaml` plus the "Cameras - Blue Iris stream watchdog"
automation remain in place as the safety net — they cover the case where the patch has
been overwritten, as well as BI being genuinely down.
