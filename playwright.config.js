const { defineConfig } = require('@playwright/test');

const HA_URL = process.env.HA_URL || 'http://192.168.0.21:8123';

// The two YAML dashboards are laid out for one display each and are only correct at that
// display's resolution. These are not arbitrary test viewports — see CLAUDE.md.
const DISPLAYS = {
  kiosk: { width: 3440, height: 1440 }, // WQHD ultrawide, Windows 11 PC at 192.168.0.16
  wall: { width: 2000, height: 1200 }, // Lenovo Tab P11 running the WallPanel app, landscape
};

module.exports = defineConfig({
  testDir: './test-e2e',
  // A dashboard that is slow to settle is a real problem, not a flaky test. Never retry.
  retries: 0,
  // These dashboards pull in a dozen HACS modules and live camera thumbnails over Wi-Fi. The
  // default 30s is not enough for a cold load at 3440x1440.
  timeout: 90000,
  // Both projects hit the same live HA. Run them one at a time so a slow load in one is not
  // blamed on contention with the other.
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: HA_URL,
    // Live sensor values, clocks and camera thumbnails mean video/trace add noise, not signal.
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    // testMatch binds each dashboard's spec to its own display resolution. This pairing is the
    // enforcement, not a convention: kiosk.spec.js can only ever run at 3440x1440 and
    // wall.spec.js can only ever run at 2000x1200.
    {
      name: 'kiosk',
      testMatch: /kiosk\.spec\.js/,
      use: {
        viewport: DISPLAYS.kiosk,
        deviceScaleFactor: 1,
        launchOptions: {
          args: [`--window-size=${DISPLAYS.kiosk.width},${DISPLAYS.kiosk.height}`, '--start-fullscreen'],
        },
      },
    },
    {
      name: 'wall',
      testMatch: /wall\.spec\.js/,
      use: {
        viewport: DISPLAYS.wall,
        deviceScaleFactor: 1,
        launchOptions: {
          args: [`--window-size=${DISPLAYS.wall.width},${DISPLAYS.wall.height}`, '--start-fullscreen'],
        },
      },
    },
  ],
});

module.exports.DISPLAYS = DISPLAYS;
module.exports.HA_URL = HA_URL;
