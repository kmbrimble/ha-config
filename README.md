# ha-config

Version-controlled configuration for a Home Assistant OS instance, currently scoped to two
YAML-mode dashboards (Kiosk and WallPanel) plus the surrounding `configuration.yaml` context
they depend on.

This repo is edited by an autonomous Claude Code agent via the `/feature` workflow, as well as
by hand. See `CLAUDE.md` for the full project context the agent relies on — test commands,
non-negotiable constraints, the candidate-dashboard testing workflow, and known traps. Read that
file before making changes, whether you're a human or an agent.

## What lives here

- `dashboards/kiosk-main.yaml` — the live Kiosk display (3440x1440, wall-mounted PC)
- `dashboards/wall-main.yaml` — the live WallPanel display (2000x1200 tablet, landscape)
- `dashboards/kiosk-candidate.yaml`, `dashboards/wall-candidate.yaml` — hidden scratch
  dashboards used to test changes against a live HA instance before promoting to the dashboards
  above
- `configuration.yaml` — core Home Assistant configuration file.
- `CHANGELOG.md` — factual log of what changed and why, in the versioning scheme described in
  `CLAUDE.md` (integer MINOR, e.g. 0.9 → 0.10, never 1.0 without an explicit milestone).

`secrets.yaml` is deliberately **not** in this repo (see `.gitignore`) — it's edited directly on
the HA host and never committed.

## Why YAML mode

Home Assistant's default dashboard storage (JSON blobs in `.storage/`) can't be diffed
meaningfully or safely edited outside the UI. Kiosk and WallPanel were converted to YAML mode so
they're version-controlled like normal config. The other dashboards on this HA instance remain
UI-managed (storage mode) deliberately — this repo does not touch them.

## How changes get deployed

There is no CI build for this repo and no container to rebuild — HA reads these files directly
off a Samba-mounted `/config` share. The deploy step is copying a verified file onto that mount
and triggering an HA reload (currently: `ha core check` + `ha core restart` — see the "Reloading"
note in `CLAUDE.md` for the current understanding of what does and doesn't need a full restart).

Full detail on the test-before-deploy loop, the candidate-dashboard mechanism, and testing
constraints (what can and can't be meaningfully automated for a visual dashboard) is in
`CLAUDE.md`.

## Known gotchas

See `CLAUDE.md` → "Kiosk-mode (header/sidebar hiding) — known trap" for a real example: HACS's
own resource registration was not sufficient to load several custom cards (kiosk-mode, card-mod,
button-card, stack-in-card, layout-card, wallpanel) under YAML-mode dashboards. They're now
loaded explicitly via `frontend: extra_module_url:` in `configuration.yaml`. If a dashboard
starts rendering with unstyled or broken cards after a HACS update, check that list and its
`?v=` cache-busting suffixes before assuming a config regression.
