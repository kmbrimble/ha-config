# Changelog

## [Unreleased]

### Added
- **`Climate` Matter bridge in home-assistant-matter-hub, exposing both air conditioners to Google
  Home.** Bridge id `0b65a0e3c4f04b8492c1eb756579a421`, port 5543, filter `domain: climate`. Both
  `climate.bedroom_ac` and `climate.living_room_ac` come through as Matter **RoomAirConditioner**
  endpoints carrying `onOff`, `thermostat` (heating + cooling, no autoMode), `fanControl` and
  `relativeHumidityMeasurement`.
  - This lives **outside this repo** — the hub is the `home-assistant-matter-hub` container on
    unRAID (2.0.56, `/mnt/user/appdata/home-assistant-matter-hub`), not HA's own `matter`
    integration, whose config entry on this instance has `source: ignore` and is not loaded.
    Recorded here because nothing else in the repo would show it exists.
  - Bridge creation via `POST /api/matter/bridges` accepts **only** `name`, `port` and `filter` —
    `icon`, `priority`, `featureFlags` and `basicInformation` are rejected with
    `must NOT have additional properties`. Updates go through `PUT /api/matter/bridges/:id` and
    the body must repeat the `id`; there is no `PATCH`.
  - Known cosmetic wart: the Matter root node's `nodeLabel` is fixed at bridge-construction time,
    so a bridge renamed after creation keeps the old label until the whole app restarts. Neither
    `actions/restart` nor `actions/factory-reset` clears it. Create bridges under their final name.

- **`packages/ups_runtime.yaml` — battery runtime with long-term statistics, for both UPSes.**
  The NUT integration gives `battery.runtime` a `device_class: duration` and unit `s` but **no
  `state_class`**, and `state_class` is what gates the recorder's `statistics`/
  `statistics_short_term` tables. So the single most useful number for watching a VRLA battery age
  was the one number HA was keeping only in short-term state history, to be purged with everything
  else. Two template mirrors — `sensor.cupboard_ups_runtime` and `sensor.garage_ups_runtime` —
  carry `state_class: measurement` and read in minutes rather than seconds.
  - The NUT sensors cannot be fixed in place: `state_class` comes from the integration's
    `SensorEntityDescription`, not from the entity registry, so `config/entity_registry/update`
    has nothing to change. Mirrors are the only route.
  - Both appear in `recorder/list_statistic_ids` with `has_mean: true` (verified 2026-09-12).
  - Each mirror carries an `availability:` guard on `is_number`. NUT drops these sensors to
    `unavailable` whenever `upsd` is unreachable — a driver restart on either host does it — and
    without the guard the template logs a float-conversion error every poll for the duration.

- **Wake-on-LAN for the cameras PC when mains returns** — `wake_on_lan` config entry
  "Wake cameras PC (Blue Iris)" (`button.wake_cameras_pc`, MAC `6c:3c:8c:30:84:b4`, broadcast
  `255.255.255.255:9`) plus the automation `cameras_pc_wake_on_power_restore` in
  `automations.yaml`.
  - **Why it is needed at all:** the cameras PC and the PoE switch sit on an EcoFlow River 3 Plus
    in UPS mode, and the EcoFlow has no killpower equivalent — it will not cut its own output
    after the PC shuts down. So on a typical outage the PC's outlet stays live the whole time,
    there is never an AC transition, and the machine's BIOS `AC Recovery = On` never fires. It
    only self-heals if the outage outlasts the entire battery.
  - **`wake_on_lan` has a config flow as of 2026.9** — worth knowing, because the YAML-only past
    of this integration is what sends people to `shell_command`. Added over
    `POST /api/config/config_entries/flow`, options amended over the options-flow endpoint, entity
    and entry retitled over the websocket registry commands. No `configuration.yaml` edit and no
    restart. A first pass did use a `shell_command` python one-liner; that was abandoned because
    **`homeassistant.reload_all` does not set up a YAML integration that was not already
    loaded** — introducing `shell_command:` for the first time needs a restart, exactly like
    `wake_on_lan:` would have, so the reason for preferring it evaporated.
  - **`192.168.0.255` is NOT the broadcast address on this network.** The LAN is a **/22**
    (`192.168.0.0/22`, confirmed on three hosts), so `192.168.0.255` is an ordinary unicast host
    address: a magic packet sent there would ARP for a host that does not exist and be dropped,
    silently. Fixed to `255.255.255.255`, the limited broadcast, which is always flooded to the
    local segment and never routed. **Any future broadcast-dependent config on this LAN wants
    `255.255.255.255` or `192.168.3.255`, never `192.168.0.255`.**
  - **Verified on the wire**, not just by a service call returning 200: a UDP listener on port 9
    on a third host (the garagepi) received a 102-byte packet from `192.168.0.21` carrying six
    `FF` sync bytes and the target MAC repeated — for both the button press and a direct
    `wake_on_lan.send_magic_packet` call.
  - **Two triggers, because power returns to that group two different ways.** A real outage takes
    the Meross "Network Cupboard" plug down with it (it is upstream of the EcoFlow on mains), so
    its power sensor goes `unavailable` and comes back — guarded by a 30s dwell test so an HA
    restart, which blips every sensor through `unavailable`, does not fire it. A *test* that
    switches the plug's relay instead leaves the plug online reporting 0 W, so a second
    `numeric_state above: 20` trigger covers that. Steady draw is ~120 W, so crossing 20 W upward
    only ever follows an interruption. Note `switch.smart_plug_..._outlet` is **disabled by user**
    on this instance, so a plug-relay test needs it re-enabled first.
  - Prerequisites set on the PC itself (Dell OptiPlex 5000) via the `DellBIOSProvider` PowerShell
    module: BIOS `WakeOnLan` `Disabled` → `LanOnly`, `DeepSleepCtrl` `S4AndS5` → `Disabled`, and
    Windows Fast Startup off (`HiberbootEnabled` `1` → `0`). That last one is the trap —
    Microsoft documents that Windows **deliberately disables WoL on a hybrid-shutdown
    transition**, so a NIC reporting `WakeOnMagicPacket = Enabled` proves nothing on its own.

- **`ping` config entry for the cameras PC → `binary_sensor.cameras_pc_online`**, and a rewrite of
  `cameras_pc_wake_on_power_restore` around it. The first version of that automation **would never
  have fired**, for a reason worth recording: both its triggers were plug transitions that HA has
  to *observe*, and **HA is not running when mains returns** — it goes down with unRAID at 35%
  battery. It boots after power is back, finds the Meross plug already online, and sees nothing. On
  a cold start HA writes an entity's first state with no previous state, so `from: unavailable`
  cannot match, and `numeric_state` needs a crossing it never observes. It would only have worked
  in the case where HA stayed up, which is the case where nothing shut down and no wake is needed.
  - Fixed with an explicit **`homeassistant` / `event: start`** trigger, which sidesteps the
    startup semantics entirely: on every start, check whether the NVR is reachable and wake it if
    not. The plug triggers are kept for the plug-relay test path. **Any future automation that must
    act on "power came back" wants a start trigger, not a state transition.**
  - ICMP had to be allowed first. **Both NICs on the cameras PC are on the Windows *Public*
    firewall profile**, which drops echo requests — the box was unpingable while perfectly alive
    (the OptiPlex answers fine). A scoped rule was added rather than enabling the broad
    `FPS-ICMP4-ERQ-In`: `New-NetFirewallRule -Name 'ICMP4-ERQ-In-LAN' -Direction Inbound -Protocol
    ICMPv4 -IcmpType 8 -Action Allow -Profile Any -RemoteAddress 192.168.0.0/22`.
  - The automation waits 60 s (ping sensor needs a reading; a machine booting on its own gets a
    chance), presses only if the NVR is not confirmed up, then retries up to five times 90 s apart
    until the ping answers. Verified by manual trigger with the NVR up: stopped cleanly at the
    guard, trace `last_step: action/1`, nothing sent.
  - Known behaviour: deliberately shutting the NVR down and then restarting HA will wake it.
  - `switch.smart_plug_..._outlet` must stay disabled, and the EcoFlow outage test must be done at
    the plug's own button or by unplugging — **not from HA**. The PoE switch feeding the WAPs runs
    through that plug and the plug is a Wi-Fi device, so switching it off remotely leaves no path
    to switch it back on.

### Changed
- **Dropped the dangling `power_sensor: binary_sensor.ac_power` from both SmartIR climate
  platforms** in `configuration.yaml`. That entity does not exist on this instance and never has —
  `/api/states` has no record of it — so both `climate.bedroom_ac` and `climate.living_room_ac`
  were registering a state-change listener against nothing. One shared power sensor for two
  physically separate air conditioners could not have been right in either case.
  - It was **inert**, not broken: in SmartIR 1.18.1 `power_sensor` is read only at `climate.py:110`
    and used only to register `_async_power_sensor_changed` (`climate.py:191-193`, handler at
    `:412`). `send_command()` does not consult it, so IR transmission was never gated by it. The
    cost was that HA's idea of each AC's on/off state is assumed rather than observed — which it
    still is, since these are hardwired Fujitsu splits with no power monitoring to point at.
  - Config-checked `valid` and deployed to the mount, but **not applied** — YAML `climate:`
    platforms have no reload service, so this takes effect on the next HA restart for any other
    reason. Nothing changes in the meantime.
- **Cards inside `conditional:` blocks are excluded from the card-geometry baseline.**
  `IN_CONDITIONAL` in `test-e2e/helpers.js` walks up through shadow boundaries and `cardBoxes()`
  filters on it. HA removes a conditional card from the DOM when its conditions are false, so the
  Kiosk's two presence-keyed `conditional:` blocks made the baseline a function of who was home —
  it held 15 cards and the suite failed `card count changed (15 -> 13)` on both `kiosk-candidate`
  and `kiosk-main` with both people home, with nothing actually broken. Kiosk baselines
  re-captured at 13 cards; the WallPanel dashboard has no conditional cards and its baseline is
  untouched. The excluded cards are still asserted on by the render / no-error-card /
  console-clean test. The settle wait still counts them, so a late-arriving conditional card is
  waited out before the boxes are read.
  - Found while doing this: with Kieren away and T home the conditional block rendered three cards
    and pushed the right-hand column down 78px, giving `scrollHeight` 1498 on a 1440px display.
    Fixed separately in `ff3e254`; see below.

### Fixed
- **DoorBird IR dropping out at night and not coming back until the DoorBird app was opened.**
  `automations.yaml` → "Front Gate IR On at night" now requests a live image from the DoorBird
  (`camera.snapshot` on `camera.front_gate_live`, which is `image.cgi`, saved to `/media` so it is
  not web-served) and waits 1.5 s before pressing `button.front_gate_ir` (`light-on.cgi`).
  - Reproduced 2026-09-11 with a torch on the lens: the IR went off, the camera stayed in night
    mode, and HA's 2-minutely press was accepted but did nothing. An `image.cgi` then
    `light-on.cgi` from the container, as the same DoorBird user, restored it within 1 s — twice.
    DoorBird's LAN API doc says light-on assumes the user "watches the live image", and opening
    the app (a live view) was the known cure.
  - Not isolated: whether the image request is what matters, or something else about a curl
    request versus HA's aiohttp one. If the IR still sticks, the next step is sending both
    requests with curl from a `shell_command` (needs the DoorBird credentials in `secrets.yaml`).
  - HA's DoorBird button discards the device's `RETURNCODE`/`IR-STATUS`, so a press that the
    device ignores still shows as a successful automation run — the traces cannot show this fault.
  - Also observed: the IR timer is ~3 min from the *last* press (each press extends it); a bare
    press does light the IR from the normal expired/colour state; and `video.cgi`, `getsession.cgi`
    and `image.cgi` on their own do not.
- **The Kiosk right-hand column no longer overflows the display when Kieren is away and T is
  home.** The Kieren-away `conditional:` block carried a third `person.t` button-card - `name:
  'T:'` and the `aspect_ratio: 1/1` map fused into one card - alongside Kieren's own name bar and
  map, a leftover from building the block by copying the T-away one. The symmetric T-away block
  always had the correct two cards. Removing it drops `scrollHeight` from 1498 to 1440 on the
  1440px display and leaves the non-conditional cards at identical coordinates in all three
  presence states, so the Kiosk geometry baseline is now presence-invariant rather than merely
  count-invariant. No re-baseline was needed - conditional cards are excluded from it. The suite
  still asserts horizontal overflow only, so an asymmetry reintroduced between the two blocks
  would not be caught.

### Added
- **WallPanel motion alert while the house is empty.** New automation
  `automation.security_wallpanel_motion_while_both_away` sends a time-sensitive push
  (`data.push.interruption-level: time-sensitive`, so it breaks through Focus) to
  `notify.mobile_app_kierens_iphone_17` and `notify.mobile_app_kierens_work_iphone_15` when
  `binary_sensor.my_wall_panel_motion_detected_2` goes `off` -> `on`.
  - Trigger is pinned to the `off` -> `on` edge specifically. The tablet sensor drops to
    `unavailable` when the panel disconnects, and `unavailable` -> `on` would otherwise fire an
    alert every time it came back.
  - "Away" is `states(...) not in ['home', 'unknown', 'unavailable']` for both `person.kieren` and
    `person.t`, not `not_home`. `person.t` sits in named zones (e.g. `Sunnybank`), which a
    `not_home` test would miss; excluding `unknown`/`unavailable` means a dropped tracker fails
    safe (no alert) rather than raising a false one.
  - 10-minute cooldown via `this.attributes.last_triggered`, which is the *action script's*
    attribute and so only advances when the actions actually run - a trigger blocked by a
    condition does not restart the cooldown. Verified: a conditions-enforced run while home
    stopped at `condition/2` with `last_triggered` still `null`.
  - The mute switch is `input_boolean.wallpanel_motion_alert_enabled`, defined in
    `packages/wallpanel_motion_alert.yaml` rather than as a UI helper, because UI helpers live in
    `.storage/` which this project never hand-edits. It has no `initial:`, so it restores its last
    state across restarts. The automation itself stays in `automations.yaml` so it remains
    UI-editable.
  - Both pushes carry the same `tag`, so a repeat replaces the earlier banner instead of stacking,
    and `url: /wall-main` opens the WallPanel dashboard (cameras) on tap.

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
