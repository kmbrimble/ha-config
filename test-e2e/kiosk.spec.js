// Kiosk dashboard — 3440x1440 ultrawide, Windows 11 PC at 192.168.0.16, fullscreen browser.
// Bound to the `kiosk` project in playwright.config.js, which pins that viewport. The layout is
// designed for this resolution and is not correct at any other, so do not run this file under a
// different project.
const { dashboardTests } = require('./dashboard-tests');

dashboardTests('kiosk', { candidate: 'kiosk-candidate', live: 'kiosk-main' });
