# ha-config — project context

Version-controlled Home Assistant configuration, currently scoped to the two display-only
dashboards: the **Kiosk** dashboard and the **WallPanel** dashboard.

Use British/Australian English in all writing and UI text.

**This project deploys to a live system.** There is no build artefact and no container to
rebuild. The "deploy" step is copying a file onto a running Home Assistant instance. Read the
Deploy and verify section carefully before changing anything.

## Environment

| Item | Value |
|---|---|
| HA host | `192.168.0.21:8123` (Home Assistant OS 18.2, Core 2026.8.1) |
| Timezone | Australia/Brisbane |
| Repo (in container) | `/projects/ha-config` — **source of truth** |
| Live HA config (in container) | `/ha-config` — SMB mount of HA's `/config` share |
| Kiosk display | 3440x1440 (WQHD), Windows 11 PC at `192.168.0.16`, Wi-Fi |
| WallPanel display | Tablet, 2000x1200, landscape |

The git repository lives at `/projects/ha-config` on fast local storage. It is **never** created
on the SMB mount — git over CIFS is unreliable. Files are copied from the repo to the mount as
the deploy step.

## Repo layout

```
/projects/ha-config/
├── dashboards/
│   ├── kiosk-main.yaml         # live Kiosk dashboard
│   ├── kiosk-candidate.yaml    # scratch copy used for testing
│   ├── wall-main.yaml          # live WallPanel dashboard
│   └── wall-candidate.yaml     # scratch copy used for testing
├── test-e2e/
│   ├── kiosk.spec.js           # bound to the 3440x1440 project
│   ├── wall.spec.js            # bound to the 2000x1200 project
│   ├── dashboard-tests.js      # the shared suite both spec files build from
│   ├── helpers.js              # auth, settle-and-load, shadow-DOM card geometry
│   ├── baselines/              # committed card-geometry baselines
│   └── screenshots/            # artefacts for the human (gitignored)
├── playwright.config.js
├── package.json
├── CHANGELOG.md
└── CLAUDE.md
```

The dashboard filenames match the dashboard KEY in `configuration.yaml`, hence the `-main` /
`-candidate` suffixes rather than `.candidate.yaml`.

Corresponding paths on the live system, via the mount:
`/ha-config/dashboards/<same filenames>`

## The candidate-dashboard workflow (this project's core mechanism)

Home Assistant has no dashboard preview API, so a dashboard cannot be rendered without being
served by HA. To keep the live displays safe, HA registers **four** YAML-mode dashboards: the two
live ones, and two hidden candidates.

The loop for any dashboard change:

1. Edit `dashboards/<name>.candidate.yaml` in the repo. **Never edit the live `.yaml` directly
   during development.**
2. Copy the candidate to the mount: `cp dashboards/<name>.candidate.yaml /ha-config/dashboards/`
3. Trigger a reload so HA picks up the change (see "Reloading" below).
4. Run the Playwright tests against the **candidate** dashboard URL.
5. Only when green: copy candidate over live in the repo, commit, then copy the live file to the
   mount and reload.

At no point does a failing change reach the Kiosk or WallPanel display.

### Dashboard URLs

- Kiosk live: `http://192.168.0.21:8123/kiosk-main`
- Kiosk candidate: `http://192.168.0.21:8123/kiosk-candidate`
- Wall live: `http://192.168.0.21:8123/wall-main`
- Wall candidate: `http://192.168.0.21:8123/wall-candidate`

The dashboard KEY under `lovelace: dashboards:` in `configuration.yaml` (not just the
`filename:`) must contain a hyphen — HA rejects single-word keys like `kiosk:` with "Url path
needs to contain a hyphen." This is why the live dashboards are `kiosk-main`/`wall-main` rather
than `kiosk`/`wall`. If a future change needs a new dashboard key, it must be hyphenated too.

### Reloading

**RESOLVED — it depends on which file changed:**

- **Editing a dashboard YAML** (`dashboards/*.yaml`) — **no restart needed.** Copy the file to the
  mount and HA serves the new config immediately; confirmed 2026-08-22 by editing
  `kiosk-candidate.yaml` and reading it straight back over the websocket
  (`{"type":"lovelace/config","url_path":"kiosk-candidate"}`). A browser refresh picks it up.
  This is the common case in the candidate workflow, so most dashboard iteration needs no restart.
- **Editing `configuration.yaml`** — **try a reload first, restart only if that cannot work.**
  See the decision rule below. A restart is ~90-135s and blinks both displays; a reload is ~1s
  and HA never leaves `RUNNING`, so the reload is always worth attempting when the rule allows it.
  When a restart really is needed: validate with the REST config-check endpoint first (see
  constraint #1), then — `ha core check` / `ha core restart` are not reachable from this
  container — call the `homeassistant.restart` service and poll `/api/config` until `state` is
  `RUNNING`. It reports `NOT_RUNNING` for ~90-135s during startup, and **the API answers before
  the restart has taken effect**, so poll for `RUNNING`, never just for an HTTP 200.

### Reload or restart? The rule

**A domain can be reloaded if and only if it exposes a reload service.** Check against the live
instance rather than guessing:

```
curl -s -H "Authorization: Bearer $HA_TOKEN" http://192.168.0.21:8123/api/services \
  | python3 -c "import json,sys;[print(f\"{d['domain']}.{s}\") for d in json.load(sys.stdin) for s in d['services'] if 'reload' in s]"
```

`homeassistant.reload_all` runs every one of them at once and is the right default first step.
Validate the config **before** reloading — a reload applies the change just as a restart does, so
the config-check gate in constraint #1 applies equally.

As of 2026-08-22 this instance exposes 26 reload services, including `template`, `automation`,
`script`, `scene`, `statistics`, `mqtt`, `person`, `zone`, `group`, all `input_*`, and
`lovelace.reload_resources`.

**Reloadable — try `homeassistant.reload_all` first:** `template:`, `automation:`, `script:`,
`scene:`, `sensor:` statistics platforms, `mqtt:` manual entities, `group:`, `person:`, `zone:`,
`input_*:`, and anything in `packages/` made only of those.

**Restart required — no reload service exists:** `frontend:` (including `extra_module_url`),
`lovelace:` `dashboards:`, `recorder:`, `http:`, auth providers, `utility_meter:`, and adding a
domain that was not previously loaded at all.

That last group is why today's changes each needed a restart: the energy-comparison package
contained a `utility_meter:` (no reload service), and the weather-card fix touched `frontend:`
and `lovelace:`. Note `lovelace.reload_resources` exists and may cover later edits to the
`lovelace: resources:` list — **untested**, so verify it took effect before trusting it, and
update this note either way.
- **The first dashboard load after a restart can fail** while the frontend is cold. Re-check
  before treating it as a real failure.

## Test command

- `npm run test:e2e` — both dashboards, against the **candidate** copies (the development loop)
- `TARGET=live npm run test:e2e` — same suite against the **live** copies, for a post-deploy check
- `npm run test:e2e:kiosk` / `npm run test:e2e:wall` — one display only
- `npm run test:e2e:baseline` — rewrite the card-geometry baselines after an intended layout change

### Each dashboard is pinned to its display's resolution

The two dashboards are laid out for one display each and are **only correct at that display's
resolution** — any other viewport produces a layout that is wrong in ways the tests will either
miss or falsely flag.

| Dashboard | Resolution | Real display |
|---|---|---|
| Kiosk | 3440x1440, fullscreen | WQHD ultrawide, Windows 11 PC at `192.168.0.16` |
| WallPanel | 2000x1200, landscape | Lenovo Tab P11 running the WallPanel app |

This is enforced structurally, not by convention: `playwright.config.js` defines one project per
display and binds it to one spec file with `testMatch`, so `kiosk.spec.js` can only ever run at
3440x1440 and `wall.spec.js` only ever at 2000x1200. **Do not add a shared spec that runs under
both projects** — that is what the config is shaped to prevent. The other dashboards are
storage-mode, flexible, and not covered here.

### Authentication for the test browser

HA requires authentication. Do **not** add the unRAID host IP (`192.168.0.10`) to
`trusted_networks` — the agent container is NAT'd behind the host, so that would grant bypass
login to every container on the server.

Instead, inject a long-lived access token into `localStorage` before page load. The token lives
in `/projects/ha-config/.env` as `HA_TOKEN` (already gitignored) and is supplied via that
environment variable — it must never be committed, and never be printed to the console/output
(e.g. via `cat`, `echo`, `env`, or a debug print) even for verification. To check it's present
without exposing it: `grep -q '^HA_TOKEN=' .env && echo found`.

This is implemented once in `test-e2e/helpers.js` (`authenticate()`) — use it rather than
re-injecting the token in a spec.

**RESOLVED — the `hassTokens` shape above is correct for Core 2026.8.1** (verified 2026-08-22).
Two things about the injection that are not obvious:

- **Wrap the `localStorage.setItem` in try/catch.** `addInitScript` runs in *every* frame, and the
  Kiosk dashboard embeds sandboxed iframes whose `localStorage` throws `SecurityError` on access.
  Without the guard, every run reports phantom page errors from frames that never needed a token.
- **A view with a `visible: - user: <id>` restriction renders zero cards** for any other user,
  including the token's. That looks identical to a broken dashboard. If a dashboard suddenly
  renders nothing, check for a `visible:` block before hunting for a card error.

### What the tests must assert

Deterministic assertions only. These are the ones that carry real signal:

- The dashboard renders — a known card or view container is present.
- **No error cards.** Assert absence of `hui-error-card`, and of the text "Custom element
  doesn't exist" and "Entity not found".
- **Browser console is clean** of errors during load.
- **No horizontal overflow** at the target viewport (3440x1440 for Kiosk, 2000x1200 for
  WallPanel). Assert `document.documentElement.scrollWidth <= viewport width`.
- **Bounding-box assertions** on cards that the change was NOT supposed to move — this is what
  catches collateral layout damage.

All of these are implemented. Two mechanics worth knowing before editing the suite:

- **Card geometry is baselined**, not asserted inline. `test-e2e/baselines/<display>-<target>.json`
  holds every card's rounded box; the suite writes it on first run (and skips), then compares on
  every run after. Card geometry is stable between runs even though the values inside the cards
  are not. After an *intended* layout change, re-run with `UPDATE_BASELINE=1` and commit the new
  baseline — the diff in that file is a readable record of what moved.
- **Nothing in `page.evaluate` can use `document.querySelectorAll` or `body.innerText`.** Every HA
  card lives inside nested shadow roots, which neither crosses — an `innerText` check for
  "Entity not found" silently passes on a page full of them. Use Playwright locators (which
  pierce shadow DOM natively) for counting and text, and the `DEEP_QUERY_ALL` walker in
  `helpers.js` for anything that genuinely needs to run in the page.

### What the tests must NOT try to assert

- **Whether the change "looks right".** That is a human judgement. Do not write a test that
  claims to verify it, and do not report visual correctness as verified.
- **Naive full-page screenshot diffs.** These dashboards contain live sensor values, clocks, and
  camera thumbnails, so a pixel diff fails on every run for reasons unrelated to the change.
  Screenshot comparison is only acceptable with the intentionally-changed region masked out, and
  is used to detect *unintended* movement elsewhere.

Always capture a screenshot at the target resolution and save it to `test-e2e/screenshots/` for
the user to review, but treat it as an artefact for the human, not as a pass/fail signal.

**The Kiosk screenshot always has a large black region on the left — this is not a fault.** Card 0
is a 1720px-wide iframe onto `http://magicmirror.kiztigs.com`, which is LAN-only and unreachable
from the agent container, so it falls back to the card's styled black background. On the actual
Kiosk PC it renders MagicMirror. Do not "fix" it, and do not report the Kiosk as broken because of
it. The same caveat applies to any future card embedding a LAN-only host.

### Known pre-existing failures the suite deliberately tolerates

`KNOWN_ISSUES` in `test-e2e/dashboard-tests.js` lists real errors that fire on every dashboard,
including known-good ones, so the suite can still give a signal on *new* breakage. These are bugs
to fix, not noise to keep. **It is currently empty — keep it that way if you can.** Its one
original entry (the `bramkragten/weather-card` CDN module) was fixed by removal rather than
tolerated.

### The suite settles on card geometry, not card count

`openDashboard()` waits until the full set of card bounding boxes stops changing, not until the
card count stops changing. Two things arrive late and both have burned this suite: HACS card
modules register after the view starts building (count climbs), and card-mod applies its styles
after that (count already final, but every card then reflows). Waiting on the count alone returns
while the page is at its *unstyled* geometry — the Kiosk cards measure 16px right and falsely
report horizontal overflow.

Settling on the same signature the tests then assert means the wait cannot be satisfied by a state
the assertions would reject. **If you add an assertion about something that settles later than
geometry, extend the settle signature to cover it too.**

One caveat: the first dashboard load after an HA restart can still fail, because the frontend is
cold and HA is still warming. Re-run rather than chasing it.

## Non-negotiable constraints

1. **Direct edits to live HA config files are allowed, gated by backup-validate-retry-restore.**
   `configuration.yaml`, `scripts.yaml`, `automations.yaml`, and other live config files on the
   mount may be edited and deployed directly — `secrets.yaml`, `.storage/`, and any database or
   log file are still off limits (see constraints 2–4). Before touching any such file:
   1. **Backup first.** Copy the current version of every file about to be touched to
      `/projects/ha-config/backups/<filename>-YYYYMMDD-HHMMSS.bak` (same convention as the
      dashboard backups below) before making any edit.
   2. **Edit, then validate before reload/restart.** After editing, validate before triggering any
      reload or restart that would apply the change live. **`ha core check` is not reachable from
      this container** — no Supervisor CLI or SSH access to the HA host is configured here (confirmed
      2026-08-21). Use the REST config-check endpoint instead, with the token from `.env`:
      `curl -s -X POST -H "Authorization: Bearer $HA_TOKEN" http://192.168.0.21:8123/api/config/core/check_config`
      — a `{"result":"valid",...}` response is the pass condition. If a future session finds `ha`
      or SSH available, prefer it and update this note.
   3. **Retry on failure, up to 3 attempts total.** If validation fails, revise the edit and
      re-validate — up to 3 attempts total (initial attempt + 2 retries), each informed by the
      previous attempt's validation output, not blind repetition.
   4. **Restore and report if still failing after 3 attempts.** Restore the affected file(s) from
      the timestamped backup, confirm via another config-check (see above) that the restored
      config is valid, and report the failure to the user: what was attempted, why each attempt failed, and
      the backup path used to restore. Never leave HA in a broken/unvalidated state — restoring
      last-known-good takes priority over any partial progress.
   5. **Never reload/restart on unvalidated config.** A passing config-check is a hard gate
      before any live reload — this is what replaces the old stop-and-hand-back behaviour as the
      actual safety mechanism.
2. **Never commit secrets.** `secrets.yaml`, tokens, and the recorder database URL must not enter
   the repo or its history. `.gitignore` must cover `secrets.yaml`, `*.db`, `*.log`,
   `.storage/`, and `test-e2e/screenshots/`.
3. **Never modify the five storage-mode dashboards.** Only Kiosk and WallPanel are YAML-mode;
   the others (`lovelace`, `dash_blinds`, `dashboard_electricity`, `dashboard_lights`, `map`)
   remain UI-managed and are off limits. (`energy_cost_comparison` was deleted on 2026-08-22 with
   the energy comparison feature, on explicit one-off approval from the user.)
4. **Never touch `trusted_networks` or any auth configuration.**
5. **The live dashboard file is only ever written from a green candidate.** No direct edits.

## Pre-change backup

Before the first write of a session, copy the current live dashboard file to
`/projects/ha-config/backups/<name>-YYYYMMDD-HHMMSS.yaml`. The git checkpoint commit is the
primary rollback mechanism; this is a belt-and-braces copy of what was actually live at the time,
which may differ from the repo if it was edited elsewhere.

To revert: `git checkout <commit> -- dashboards/<name>.yaml`, then copy to the mount and reload.

The same `/projects/ha-config/backups/` directory is the backup location for direct edits to
`configuration.yaml`, `scripts.yaml`, `automations.yaml`, and other live config files under the
backup-validate-retry-restore process in constraint #1 — see that section for the full procedure.

## Deploy and verify

There is **no CI build and no container to update**. Do not run `gh run watch` in this project.

1. Commit and push to `main` (GitHub repo is private).
2. Copy the verified live file to the mount:
   `cp dashboards/<name>.yaml /ha-config/dashboards/`
3. Trigger the reload.
4. Hand back to the user with: the screenshot path, what changed, and a request to eyeball the
   actual display — the Kiosk PC at 3440x1440 or the WallPanel tablet — since visual correctness
   is not machine-verifiable.

## Kiosk-mode (header/sidebar hiding) — known trap

The Kiosk and WallPanel dashboards rely on the HACS **kiosk-mode** custom module
(`/hacsfiles/kiosk-mode/kiosk-mode.js`) to hide the HA header and sidebar, via a `kiosk_mode:`
block placed top-level in each dashboard YAML (sibling of `views:`).

Migrating these dashboards from storage mode to YAML mode broke header-hiding even though:
- the `kiosk_mode:` block was present and correctly placed in the YAML,
- the module was registered in `.storage/lovelace_resources` (the HACS-managed resource list),
- and a hard refresh / fresh incognito window did not fix it.

**Root cause:** the HACS-managed resource registration is not sufficient for YAML-mode
dashboards. The fix was adding the module explicitly under the existing `frontend:` key in
`configuration.yaml`:

```yaml
frontend:
  themes: !include_dir_merge_named themes
  extra_module_url:
    - /hacsfiles/kiosk-mode/kiosk-mode.js?v=1
```

**If kiosk-mode is ever updated via HACS, bump the `?v=1` query string** — this is the
documented cache-busting mechanism; without it, HA/the browser can keep serving the old cached
module after an update. If header-hiding silently breaks again after a kiosk-mode update, check
this version string first before assuming a config regression.

## Where a frontend module goes: `resources:` vs `extra_module_url`

This split matters and is not interchangeable. Get it wrong and cards fail intermittently.

| Kind of module | Goes under | Why |
|---|---|---|
| A custom **card** (referenced by a card's `type: custom:…`) | `lovelace: resources:` | HA **awaits** these before building a dashboard, so the element is registered when the view renders |
| A global **frontend patch** (kiosk-mode, card-mod, wallpanel) | `frontend: extra_module_url` | Not referenced by any `type:`; losing the race only delays their effect |

`extra_module_url` is **fire-and-forget** — HA does not await it before rendering. Every card
module used to live there with no `resources:` declared at all, which raced: on ~50% of loads the
Wall dashboard's 34 `custom:button-card` cards rendered "Configuration error" because button-card
had not yet registered. It was masked for a long time by a dead `cdn.jsdelivr.net` weather-card
fetch in `extra_module_url` whose internet round-trip delayed rendering just enough; removing that
dead resource on 2026-08-22 exposed the race. Fixed by declaring the card modules as `resources:`
(verified 10/10 clean cold loads, previously ~50%).

**Do not move `card-mod` into `resources:`.** It was tried on 2026-08-22 and left the Kiosk
bistable: `scrollWidth` 3456 (overflowing the 3440 display) on some loads, a wrong 1141px first
card on others. It is a global patch, same category as kiosk-mode. Reverted.

`.storage/lovelace_resources` is **inert** while `resource_mode: yaml` is set — HA does not read
it, and the `lovelace/resources/*` websocket commands return `unknown_command` because the
resource collection is never loaded. Two dead entries (a corrupted
`/hacsfiles/light-entity-card/null` and the weather-card CDN URL) were removed from it by hand on
2026-08-22; HA did not rewrite the file afterwards, as expected in this mode. It still mirrors
what HACS installed, so if `resource_mode` is ever switched back to `storage`, review it first —
its entries would come back to life.

Do not add a second top-level `frontend:` key if one needs to change again — merge into the
existing block, the same caution as for `lovelace:` elsewhere in this file.

## Context notes

- Config uses `packages: !include_dir_named packages`, so configuration is already modular.
- `custom_components` present: `aemo_nem`, `blueiris`, `hacs`, `hass_agent`, `meross_lan`,
  `presence_simulation`, `smartir`, `smartlife`, `spook`, `spook_inverse`, `sun2`, `tuya_local`.
  Custom cards used by the dashboards come from HACS — if a card is missing at render time the
  cause is usually a missing HACS resource, not a YAML error.
- The `blueiris` custom component is scheduled for retirement as part of the Frigate migration.
  Do not build new dashboard functionality on it.
- The Kiosk PC boots, waits for a successful ping to HA, then opens the dashboard URL. It
  authenticates via `trusted_networks` on `192.168.0.16` with `allow_bypass_login`. This is why
  the live Kiosk dashboard must never be left in a broken state — there is no login screen to
  interrupt a bad load.

## Reading the HA error log

**Since HA Core 2025.11, the plaintext log is no longer written to `/config`.** The files on the
mount (`home-assistant.log.1`, `.old`) stop dead at 7 Nov 2025 — that's when this install crossed
the 2025.11 boundary — and nothing has landed there since. Don't trust their contents as current.

To see current errors/warnings:
- **In the UI:** Settings → System → Logs → Home Assistant Core, then enable "Show Raw Log file"
  for the old plaintext view, or just read the structured log list.
- **Programmatically:** the REST `/api/error_log` endpoint is also gone. Use the **websocket API**
  instead — send `{"type": "system_log/list"}` over `ws://<host>:8123/api/websocket` after
  authenticating. This returns deduplicated JSON entries (name, level, message, count,
  first_occurred, timestamp, exception) — the same data source as the UI's Logs page. A
  long-lived access token (same as `HA_TOKEN` used for Playwright tests) is needed either way.
