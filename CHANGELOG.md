# Changelog

## [Unreleased]

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
