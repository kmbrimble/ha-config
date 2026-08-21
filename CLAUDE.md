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
│   ├── kiosk.yaml              # live Kiosk dashboard
│   ├── kiosk.candidate.yaml    # scratch copy used for testing
│   ├── wall.yaml               # live WallPanel dashboard
│   └── wall.candidate.yaml     # scratch copy used for testing
├── test-e2e/                   # Playwright tests
├── CHANGELOG.md
└── CLAUDE.md
```

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

**RESOLVED:** YAML-mode dashboards did NOT reliably pick up changes without a restart in
practice. `ha core check` followed by `ha core restart` was required after editing
`configuration.yaml`'s `lovelace:` block. Whether a plain dashboard-file edit (not touching
`configuration.yaml`) reloads without a restart is still unconfirmed — assume a restart is
needed unless a future session establishes otherwise, and update this note if so.

## Test command

- **Playwright:** `npm run test:e2e` — tests in `test-e2e/`

### Authentication for the test browser

HA requires authentication. Do **not** add the unRAID host IP (`192.168.0.10`) to
`trusted_networks` — the agent container is NAT'd behind the host, so that would grant bypass
login to every container on the server.

Instead, inject a long-lived access token into `localStorage` before page load. The token is
supplied via the `HA_TOKEN` environment variable and must never be committed.

```js
await page.addInitScript((token) => {
  window.localStorage.setItem('hassTokens', JSON.stringify({
    access_token: token,
    token_type: 'Bearer',
    expires_in: 1800,
    expires: Date.now() + 1800 * 1000,
    hassUrl: 'http://192.168.0.21:8123',
    clientId: null,
    refresh_token: '',
  }));
}, process.env.HA_TOKEN);
```

**OPEN ITEM — the exact `hassTokens` object shape is version-dependent.** Verify it against
Core 2026.8.1 on first use and correct this file if the shape differs.

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

### What the tests must NOT try to assert

- **Whether the change "looks right".** That is a human judgement. Do not write a test that
  claims to verify it, and do not report visual correctness as verified.
- **Naive full-page screenshot diffs.** These dashboards contain live sensor values, clocks, and
  camera thumbnails, so a pixel diff fails on every run for reasons unrelated to the change.
  Screenshot comparison is only acceptable with the intentionally-changed region masked out, and
  is used to detect *unintended* movement elsewhere.

Always capture a screenshot at the target resolution and save it to `test-e2e/screenshots/` for
the user to review, but treat it as an artefact for the human, not as a pass/fail signal.

## Non-negotiable constraints

1. **Direct edits to live HA config files are allowed, gated by backup-validate-retry-restore.**
   `configuration.yaml`, `scripts.yaml`, `automations.yaml`, and other live config files on the
   mount may be edited and deployed directly — `secrets.yaml`, `.storage/`, and any database or
   log file are still off limits (see constraints 2–4). Before touching any such file:
   1. **Backup first.** Copy the current version of every file about to be touched to
      `/projects/ha-config/backups/<filename>-YYYYMMDD-HHMMSS.bak` (same convention as the
      dashboard backups below) before making any edit.
   2. **Edit, then validate before reload/restart.** After editing, run `ha core check` (this is
      a Home Assistant OS/supervised install, so this is the correct command, not the standalone
      `check_config` script) before triggering any reload or restart that would apply the change
      live.
   3. **Retry on failure, up to 3 attempts total.** If validation fails, revise the edit and
      re-validate — up to 3 attempts total (initial attempt + 2 retries), each informed by the
      previous attempt's validation output, not blind repetition.
   4. **Restore and report if still failing after 3 attempts.** Restore the affected file(s) from
      the timestamped backup, confirm via another `ha core check` that the restored config is
      valid, and report the failure to the user: what was attempted, why each attempt failed, and
      the backup path used to restore. Never leave HA in a broken/unvalidated state — restoring
      last-known-good takes priority over any partial progress.
   5. **Never reload/restart on unvalidated config.** A passing `ha core check` is a hard gate
      before any live reload — this is what replaces the old stop-and-hand-back behaviour as the
      actual safety mechanism.
2. **Never commit secrets.** `secrets.yaml`, tokens, and the recorder database URL must not enter
   the repo or its history. `.gitignore` must cover `secrets.yaml`, `*.db`, `*.log`,
   `.storage/`, and `test-e2e/screenshots/`.
3. **Never modify the six storage-mode dashboards.** Only Kiosk and WallPanel are YAML-mode;
   the others (`lovelace`, `dash_blinds`, `dashboard_electricity`, `dashboard_lights`,
   `energy_cost_comparison`, `map`) remain UI-managed and are off limits.
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
