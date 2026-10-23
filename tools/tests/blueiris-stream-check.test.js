// Tests for tools/blueiris_stream_check.py - the Blue Iris stream health probe.
// Each case runs the real script against a throwaway local HTTP server; nothing touches live HA.
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TOOL = path.resolve(__dirname, '..', 'blueiris_stream_check.py');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
// What Blue Iris serves for a dead session: its HTML login page, 19043 bytes starting "<!D".
const LOGIN_PAGE = Buffer.concat([Buffer.from('<!DOCTYPE html><html>'), Buffer.alloc(200, 0x20)]);

const TOKEN = 'abc.def-123';
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    // Like HA's camera proxy: a wrong or missing token is a 401, whatever the camera.
    if (req.url.includes('/camera.') && !req.url.endsWith('?token=' + TOKEN) && !req.url.includes('camera.hang')) {
      res.writeHead(401); res.end('unauthorized');
    } else if (req.url.startsWith('/api/camera_proxy/camera.good')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(JPEG);
    } else if (req.url.startsWith('/api/camera_proxy/camera.stale')) {
      // The real failure: HTML login page served with an image content type.
      res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(LOGIN_PAGE);
    } else if (req.url.startsWith('/api/camera_proxy/camera.hang')) {
      // never answers: the probe must give up on its own
    } else {
      res.writeHead(404); res.end('nope');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('python3', [TOOL, ...args], { env: { ...process.env, BLUEIRIS_CHECK_BASE: base, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr }));
  });
}

describe('blueiris_stream_check.py', () => {
  test('a real JPEG reads ok', async () => {
    const r = await run(['camera.good', TOKEN]);
    assert.deepStrictEqual([r.code, r.stdout], [0, 'ok']);
  });

  test('the token really is sent: a wrong token reads bad', async () => {
    const r = await run(['camera.good', 'wrongtoken']);
    assert.deepStrictEqual([r.code, r.stdout], [0, 'bad']);
  });

  test('the stale-session HTML login page reads bad even with an image content type', async () => {
    const r = await run(['camera.stale', TOKEN]);
    assert.deepStrictEqual([r.code, r.stdout], [0, 'bad']);
  });

  test('an HTTP error reads bad', async () => {
    const r = await run(['camera.missing', TOKEN]);
    assert.deepStrictEqual([r.code, r.stdout], [0, 'bad']);
  });

  test('nothing listening (BI/HA down) reads bad, not a crash', async () => {
    const r = await run(['camera.good', TOKEN], { BLUEIRIS_CHECK_BASE: 'http://127.0.0.1:1' });
    assert.deepStrictEqual([r.code, r.stdout], [0, 'bad']);
  });

  test('an unavailable camera (missing or empty token) reads bad', async () => {
    for (const args of [[], [''], ['camera.good'], ['camera.good', '']]) {
      const r = await run(args);
      assert.deepStrictEqual([r.code, r.stdout], [0, 'bad'], JSON.stringify(args));
    }
  });

  test('malformed arguments are refused before any request is made', async () => {
    for (const args of [
      ['../etc/passwd', TOKEN], ['camera.good', 'a b'], ['camera.good', 'x;rm'],
      ['camera.good', '/api/camera_proxy/camera.good?token=' + TOKEN], ['Camera.Good', TOKEN],
    ]) {
      const r = await run(args);
      assert.deepStrictEqual([r.code, r.stdout], [0, 'bad'], JSON.stringify(args));
    }
  });

  test('a hung response is abandoned inside the sensor command_timeout (10 s)', async () => {
    const t0 = Date.now();
    const r = await run(['camera.hang', TOKEN]);
    assert.deepStrictEqual([r.code, r.stdout], [0, 'bad']);
    assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
  });

  test('stdout carries exactly one word so payload_on/payload_off always match', async () => {
    for (const args of [['camera.good', TOKEN], ['camera.stale', TOKEN], []]) {
      const r = await run(args);
      assert.match(r.stdout, /^(ok|bad)$/);
    }
  });
});
