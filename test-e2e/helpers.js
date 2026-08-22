const fs = require('fs');
const path = require('path');

const HA_URL = process.env.HA_URL || 'http://192.168.0.21:8123';

/**
 * Read HA_TOKEN from the environment, falling back to .env so `npx playwright test` works
 * without a wrapper. The token is never logged — only its presence is ever reported.
 */
function haToken() {
  if (process.env.HA_TOKEN) return process.env.HA_TOKEN;
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) {
    const line = fs.readFileSync(envFile, 'utf8').split('\n').find((l) => l.startsWith('HA_TOKEN='));
    if (line) return line.slice('HA_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('HA_TOKEN not set and not found in .env — see CLAUDE.md, Authentication for the test browser');
}

/**
 * HA authenticates the frontend from a `hassTokens` blob in localStorage. Injecting it before
 * page load avoids needing trusted_networks for the agent container (see CLAUDE.md — adding the
 * unRAID host IP there would grant bypass login to every container on the server).
 *
 * Shape verified against Core 2026.8.1 on 2026-08-22.
 *
 * The try/catch is required, not defensive padding: addInitScript runs in every frame, and the
 * Kiosk dashboard embeds sandboxed iframes whose localStorage throws SecurityError on access.
 * Without it, every run reports phantom page errors from frames that never needed a token.
 */
async function authenticate(page) {
  const token = haToken();
  await page.addInitScript(
    ([tok, url]) => {
      try {
        window.localStorage.setItem(
          'hassTokens',
          JSON.stringify({
            access_token: tok,
            token_type: 'Bearer',
            expires_in: 1800,
            expires: Date.now() + 1800 * 1000,
            hassUrl: url,
            clientId: null,
            refresh_token: '',
          }),
        );
      } catch {
        // Sandboxed iframe — it does not talk to the HA API and does not need the token.
      }
    },
    [token, HA_URL],
  );
}

/**
 * The HA frontend renders cards deep inside nested shadow roots, and neither
 * document.querySelectorAll nor body.innerText cross a shadow boundary. Anything running inside
 * page.evaluate therefore has to walk the roots explicitly. (Playwright's own locators pierce
 * shadow DOM natively, so counting is done with locators, not this.)
 */
const DEEP_QUERY_ALL = `
  (selector) => {
    const out = [];
    const walk = (root) => {
      out.push(...root.querySelectorAll(selector));
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return out;
  }
`;

/**
 * Load a dashboard and wait for it to actually settle. Returns collected console errors.
 *
 * Errors are captured from page load onward, so anything the dashboard logs while rendering is
 * caught — this is the check that catches a broken custom card that still renders a box.
 */
async function openDashboard(page, urlPath) {
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto(`/${urlPath}`, { waitUntil: 'domcontentloaded' });

  // If auth did not take we land on the login form rather than the dashboard. Fail loudly here
  // rather than letting every downstream assertion report a confusing "no cards found".
  if (await page.locator('ha-authorize, ha-auth-form').count()) {
    throw new Error(
      'Landed on the HA login page — the injected hassTokens blob was rejected. The shape is version-dependent; re-verify it against the running Core version.',
    );
  }

  // Custom cards from HACS register late, so wait for the card count to stop changing rather
  // than guessing at a fixed sleep. A dashboard that renders zero cards never settles here and
  // times out — which is the correct outcome, because zero cards is a broken dashboard.
  let previous = -1;
  await page
    .waitForFunction(
      ([deepQuery, prev]) => {
        const n = eval(deepQuery)('ha-card').length;
        const settled = n > 0 && n === window.__cardCount;
        window.__cardCount = n;
        return settled;
      },
      [DEEP_QUERY_ALL, previous],
      { timeout: 45000, polling: 1000 },
    )
    .catch(async () => {
      const n = await page.locator('ha-card').count();
      throw new Error(
        `Dashboard /${urlPath} did not settle: ${n} cards rendered after 45s. Zero cards means the view failed to build — check the page errors reported alongside this.`,
      );
    });

  return consoleErrors;
}

/**
 * Bounding boxes of every card, in document order, rounded to whole pixels.
 *
 * This is the collateral-damage detector: a change meant to touch one card that silently shifts
 * another shows up here. Live sensor values do not move card geometry in these layouts, so the
 * boxes are stable between runs even though the text inside them is not.
 */
async function cardBoxes(page) {
  return page.evaluate((deepQuery) => {
    return eval(deepQuery)('ha-card').map((el) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });
  }, DEEP_QUERY_ALL);
}

module.exports = { HA_URL, haToken, authenticate, openDashboard, cardBoxes, DEEP_QUERY_ALL };
