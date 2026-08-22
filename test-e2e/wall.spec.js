// WallPanel dashboard — 2000x1200 landscape, Lenovo Tab P11 running the WallPanel app.
// Bound to the `wall` project in playwright.config.js, which pins that viewport. The layout is
// designed for this resolution and is not correct at any other, so do not run this file under a
// different project.
const { dashboardTests } = require('./dashboard-tests');

dashboardTests('wall', { candidate: 'wall-candidate', live: 'wall-main' });
