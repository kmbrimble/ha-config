# Changelog

## [Unreleased]

### Changed
- **`apexcharts-card` dropped.** Removed from `lovelace: resources:` (applied with
  `lovelace.reload_resources`, no restart) and uninstalled from HACS, which deleted
  `www/community/apexcharts-card/`. Checked first against **all eight** dashboards, not just the
  YAML ones: the four storage-mode configs in `.storage` (`lovelace.lovelace`,
  `lovelace.dash_blinds`, `lovelace.dashboard_lights`, `lovelace.map`) were grepped read-only and
  none referenced it. Note `.storage/lovelace_resources` still lists the old URL - HACS does not
  clean that in `resource_mode: yaml`, and it is inert because HA reads resources from
  `configuration.yaml`. Left alone deliberately: `.storage` is never hand-edited.
- **Kiosk fuel cards show the last known price in italics during an API dropout** instead of an
  em dash. The em dash now only appears in the genuine no-data case - nothing live *and* nothing
  stored. Backed by two new trigger template sensors, `sensor.<station>_fuel_last_known_price`,
  which latch every successful numeric read (including reads that repeat the same price) and
  deliberately do **not** follow the source down when `qld_fuel` drops out.
- The cards' "Updated" line now reads from the fallback sensor while the source is down. The
  source's own `last_changed` is the moment it *went* down, which would have read as a fresh
  price sitting under an italicised stale one.

### Fixed
- **Correction to yesterday's entry: seeding those sensors with `POST /api/states` does not
  survive a reload, and the previous-price seeding claimed there had silently reverted.**
  Trigger-based template sensors restore the last value *the entity itself wrote*;
  `POST /api/states` writes straight into the state machine, bypassing the entity, so
  `RestoreEntity` never records it. Proven on 2026-09-04: Kenmore was POSTed to 221.9 at 10:08
  AEST and came back as 224.9 after a `reload_all` at 12:19, while Sunnybank - which had latched
  217.9 through its own trigger at 11:54 - restored intact. All four sensors now also listen for
  a `fuel_price_seed` event addressed by `unique_id`, so a correction is written *by the entity*
  and persists. Re-seeded and verified across a reload. The seeding recipe is in the package
  header; `.storage/core.restore_state` is never to be hand-edited to do this.
- `sensor.<station>_fuel_last_known_price` carries a `source_last_changed` attribute so a seeded
  value still reports when the price really moved rather than when it was seeded.

- **Kiosk fuel-price chart replaced: `custom:apexcharts-card` -> `custom:mini-graph-card`.**
  Two complaints drove this: the apex card sat on its loading spinner for hours on the Kiosk PC
  and sometimes never loaded, and the line broke into segments wherever `qld_fuel` dropped to
  `unknown`/`unavailable` (ApexCharts has no `connectNulls`). mini-graph-card filters non-numeric
  states out of history before bucketing and carries the last value forward into empty buckets,
  so the line is unbroken by construction and a change across a gap is drawn as one riser rather
  than a break. Same two entities, same `#4fc3f7` / `#ffb74d` colours, same 215px card height,
  and the committed card-geometry baseline is unchanged - nothing else in the column moved.
  Trade-off accepted: mini-graph-card has no x-axis, so the dd/MM date labels are gone.
- Installed `kalkih/mini-graph-card` v0.13.0 via HACS and registered
  `/hacsfiles/mini-graph-card/mini-graph-card-bundle.js?v=1` under `lovelace: resources:`.
  `lovelace.reload_resources` was enough - no restart. `apexcharts-card` is left registered
  pending a decision; after this change **no dashboard references it** (0 hits in `kiosk-main.yaml`
  and `wall-main.yaml`), so it can be dropped with another `reload_resources`.
- `packages/` is now tracked in this repo. It previously existed only on the mount, so the
  fuel-price template sensors were unversioned.

### Fixed
- **ROOT CAUSE of the endless chart loading spinner: the HACS cards' localforage/IndexedDB
  history cache, not the charting library.** Both apexcharts-card and mini-graph-card bundle
  localforage and both default `cache: true`. On this system that read never settles -
  mini-graph-card's `updateEntity` awaits `getCache` forever, so `updating` stays true,
  `Graph._history` stays undefined and `renderGraph` returns `<ha-spinner>` indefinitely.
  Measured 2026-09-04 at 3440x1440: with the cache on the card sat at 52px (spinner only) for a
  full 15s probe; with `cache: false` it rendered in under 1.5s. Caching bought nothing here
  anyway - the 14-day history fetch for both entities measures ~3ms. The apex card almost
  certainly had the same fault; **do not remove `cache: false` from any history-backed card.**
- **The Kiosk fuel trend arrow no longer disappears between price changes.** The previous-price
  template sensors in `packages/fuel_price_trends.yaml` fired on a bare `state` trigger, which
  also fires on the attribute-only rewrites `qld_fuel` performs every ~2 hours (`7_day_average`,
  `days_since_7_day_low`, ...). Each of those latched the *current* price as the "previous"
  price, so the arrow vanished until the next real change; both sensors were found sitting at
  exactly the current price. They now carry a condition so only a change in the numeric price
  latches, and transitions in and out of `unknown`/`unavailable` are ignored in both directions
  (so `221.9 -> unavailable -> 221.9` is not counted as two changes). The arrow now shows the
  direction of the last *real* move and holds until the next one.
- Seeded both previous-price sensors from recorder history with the true pre-change values
  (Kenmore 221.9, Sunnybank 216.9) so the arrows are correct immediately rather than from the
  next price move.
- **Kiosk fuel cards no longer render `$NaN`.** Both price templates now return an em dash when
  the sensor is `unknown`/`unavailable`, which `qld_fuel` does periodically (e.g. 2 Sep,
  01:20-05:20 UTC).

### Known
- The chart's `hours_to_show: 336` is wider than the available history: the `qld_fuel` entities
  were created 2026-08-29, and mini-graph-card back-fills pre-history buckets with the *earliest*
  recorded price rather than leaving them blank. Until ~2026-09-12 the left of the chart is a
  flat line at 221.9 / 212.9 that never actually happened. Accepted deliberately; there is no way
  to crop the x-axis to the data extent, `hours_to_show` fixes the window.
- The card's svg is aspect-locked (`viewBox 0 0 500 H`), so rendered graph height is
  `cardWidth * H / 500`, not `H` pixels. `height: 245` at this column's 407px width gives 199px
  of graph + 16px padding = the 215px the apex card occupied. Recompute if the column width changes.

### Changed
- **Network Cupboard sensor moved outdoors and renamed.** The ESP32 environment monitor
  (ESPHome node `networkcupboardtemp`) now measures the lower deck. In the HA registries the
  device became **Lower Deck** in the **Lower Deck** area, and its entities were renamed:
  `sensor.network_cupboard_temperature` → `sensor.lower_deck_temperature` ("Lower Deck Air
  Temperature") and `sensor.network_cupboard_humidity` → `sensor.lower_deck_humidity`
  ("Lower Deck Humidity"). The firmware update entity was renamed to match. The ESPHome YAML
  still carries the old `friendly_name` and "Server Exhaust" sensor names — changing those
  needs a rebuild and flash from the ESPHome add-on.
- **WallPanel Climate row** now points at the renamed entities and uses `mdi:balcony` in place
  of `mdi:ethernet`. (`mdi:deck` does not exist in the bundled MDI set.)

### Added
- **Kiosk "Outside" card.** A full-width (407x133) `custom:button-card` in the middle pane,
  directly above the Living Room / Bedroom temperature cards and below the blank space, showing
  the lower deck temperature on the left and humidity on the right in neon pink `#ff8ad9`.
  Its two halves are pixel-aligned with the centres of the two cards beneath it (8px flex gap
  matching the horizontal-stack gap), and its height matches theirs exactly.
- The middle pane's `margin-top: auto` selector moved from `nth-last-child(3)` to
  `nth-last-child(4)` so the blank space stays above the new card rather than above the
  temperature cards.

### Fixed
- **The WallPanel geometry test no longer false-fails on the camera cycle card.**
  `camera.cameras_wallpanel_cycle` card 1 legitimately renders at two heights — the card is sized
  so a standard 16:9 stream fills the available height, so the dual-lens camera's much wider view
  shrinks it vertically to keep scale. Sampling every 2s for 3.5 minutes produced exactly 591px
  and 293px and nothing else. `VARIABLE_CARD_HEIGHTS` in `dashboard-tests.js` now pins that card's
  x, y and width to the baseline as before while requiring its height to be one of those two
  values, so a card that genuinely breaks still fails. Verified 8/8 green across both heights, and
  verified failing (on the height assertion only, not on "cards moved") with a deliberately wrong
  allow-list.

### Removed
- Long-term statistics for both sensors, via `recorder/clear_statistics` — the accumulated
  history was indoor cupboard data and not meaningful as outdoor history. Short-term recorder
  state history was left in place.


## 0.2 - 2026-08-22

Removed the energy cost comparison feature, built the Playwright harness CLAUDE.md had been
describing as though it existed, and fixed a dashboard loading bug that harness uncovered.

### Removed
- **Energy cost comparison.** Deleted `packages/energy_comparison.yaml` (773 lines): ~100 template
  sensors pricing grid usage against nine retailers (AGL, Alinta, GloBird, Kogan, Lumo, Origin,
  OVO, Powershop, Red Energy) across flat/TOU/demand tariffs, plus the daily, monthly and
  previous-month variants, the "winner" sensors, the `Max 30m Grid Usage` statistics sensor, the
  two peak/shoulder/off-peak utility meters and the tariff-switcher automation.
- The `Grid Energy Daily Total` template sensor from `configuration.yaml`. It summed the three
  daily tariff buckets and could not survive the utility meters being removed.
- The `Energy Cost Comparison` storage-mode dashboard, via the `lovelace/dashboards/delete`
  websocket command. This was an explicit one-off waiver of the "never modify the storage-mode
  dashboards" constraint.
- The `Electricity` storage-mode dashboard, removed by the user. It was the only remaining
  consumer of `select.grid_energy_tariff_tracker` and `sensor.max_30m_grid_usage`, so its removal
  closes out the last dangling references to the deleted tariff tracker. Its five solar tiles
  went with it; solar remains on the built-in Energy dashboard. The storage-mode dashboard
  constraint now covers four dashboards, not six.
- The `bramkragten/weather-card` module from `frontend: extra_module_url`. No dashboard used it,
  and it threw on every page load. It was the only frontend resource still fetched from an
  external CDN.
- Two dead entries from `.storage/lovelace_resources`: a corrupted
  `/hacsfiles/light-entity-card/null` (literal "null" filename) and the weather-card CDN URL.

Solar was untouched throughout — the comparison package referenced no solar entity, and the
`sensor.solar_inverter_*` MQTT entities and the built-in Energy dashboard are unaffected. Grid
metering (`Total Grid Energy`, the Emerald MQTT sensors, `Grid Power Peak (24h)`) was retained.

### Added
- **Playwright end-to-end harness** (`test-e2e/`, `playwright.config.js`, `package.json`).
  Asserts that cards render, that there are no error cards or missing custom elements or
  entities, that the console is clean, that there is no horizontal overflow at the target width,
  and that card bounding boxes match a committed baseline. Screenshots are saved for human review
  and are never a pass/fail signal.
- Each dashboard is pinned to its display's resolution structurally, not by convention: one
  Playwright project per display bound to one spec file via `testMatch`, so `kiosk.spec.js` can
  only run at 3440x1440 and `wall.spec.js` only at 2000x1200.
- `lovelace: resources:` declaring the seven custom card modules — see Fixed below.

### Fixed
- **Wall dashboard rendered 34 "Configuration error" cards on roughly half of all loads.**
  `extra_module_url` is fire-and-forget — HA does not await it before building a dashboard — and
  every custom card module lived there with no `resources:` declared, so `button-card` frequently
  had not registered when the view built. Fixed by declaring the card modules under
  `lovelace: resources:`, which HA does await. Verified 10/10 clean cold loads, previously ~50%.
  This is believed to be the long-standing "red error symbol" on the WallPanel since the YAML
  conversion, and the same intermittent failure on the Kiosk's Google Maps cards, which are also
  `custom:button-card`.
- The above was latent for months and was exposed, not caused, by removing the weather-card CDN
  resource: that fetch's internet round-trip had been delaying rendering just enough to hide it.
- Re-synced `dashboards/wall-main.yaml` and `wall-candidate.yaml`, which were stale against a
  16 Aug edit to live that commented out a `visible: - user:` restriction. That restriction made
  the candidate render zero cards, which is indistinguishable from a broken dashboard.
- Re-synced `configuration.yaml` from live, dropping a corrupted `light-entity-card/null?v=1`
  resource line and a dead commented-out `http:`/`influxdb:`/`google_assistant:` block.

### Investigated and reverted
- Moving `card-mod` into `lovelace: resources:` alongside the card modules. It left the Kiosk
  layout bistable — `scrollWidth` 3456, overflowing the 3440 display, on some loads and a wrong
  1141px first card on others. `card-mod` is a global frontend patch like kiosk-mode, not a card
  type, so it stays in `extra_module_url`. Both failure modes are recorded in CLAUDE.md.

### Verified
- The Kiosk Google Maps cards load reliably: reproduced on the kiosk *candidate* by temporarily
  neutralising the two person-based conditionals that normally hide them, then restored. 10/10
  loads clean, sampled at 2s, 5s and 12s. The live Kiosk was never modified.
- **Editing a dashboard YAML needs no restart** — HA serves the change immediately. Only
  `configuration.yaml` changes do. This resolves a long-standing open question in CLAUDE.md.
- **`lovelace.reload_resources` works**, so `lovelace: resources:` changes need no restart either
  — confirmed in both directions by bumping a `?v=` cache-buster and back. `lovelace:
  dashboards:` still requires a restart.
- `homeassistant.reload_all` completes in ~1s without leaving `RUNNING`, versus 90-135s and a
  display blink for a restart. A domain can be reloaded if and only if it exposes a reload
  service; this instance has 26. `frontend:`, `lovelace: dashboards:`, `recorder:`, `http:`, auth
  providers and `utility_meter:` have none, which is why this session's restarts were needed.
- The `hassTokens` localStorage shape used by the test browser is correct for Core 2026.8.1,
  resolving another open item.

### Known issues
- Four stale `*_amber_simulated` entity registry entries predate this work, are defined in no
  YAML, and need manual removal.
- The Kiosk screenshot artefact always shows a large black region on the left. That is the
  MagicMirror iframe, whose host is LAN-only and unreachable from the agent container. It renders
  correctly on the actual Kiosk PC.
- `sensor.solar_inverter_*` entities read `unknown` because the ESPHome `solar-gateway` bridge at
  192.168.0.111 is unreachable. Pre-existing and unrelated to this session's changes.

## 0.1 - 2026-08-14
Initial repository. Captures the state of the HA config after converting the Kiosk and
WallPanel dashboards from storage mode to YAML mode.

Changes made manually during this migration (not yet run through the /feature workflow):
- Moved the MariaDB recorder credential from configuration.yaml into secrets.yaml.
- Converted dashboard_kiosk and dashboard_wall from storage-mode to YAML-mode dashboards
  (dashboards/kiosk-main.yaml, dashboards/wall-main.yaml), registered under lovelace: in
  configuration.yaml. Dashboard keys required hyphens (kiosk-main, not kiosk) per HA's
  URL path rules.
- Added kiosk-candidate and wall-candidate hidden dashboards for the pre-deploy test loop.
- Added explicit frontend: extra_module_url: entries for kiosk-mode, card-mod, button-card,
  stack-in-card, layout-card, and wallpanel -- the HACS-managed resource registration in
  .storage/lovelace_resources was not sufficient for YAML-mode dashboards to load these
  correctly; see CLAUDE.md for details.
