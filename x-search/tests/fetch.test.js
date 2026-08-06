'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI = path.resolve(__dirname, '..', 'scripts', 'x_search_cli.js');
const { isPrivateAddress } = require('../scripts/utils/network');

let tavilyServer;
let tavilyUrl;
let tempHome;
let tavilyCalls = 0;

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        GROK_API_KEY: 'test-grok',
        TAVILY_API_KEY: 'test-tavily',
        TAVILY_API_URL: tavilyUrl,
      },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test.before(async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'x-search-fetch-test-'));

  tavilyServer = http.createServer((request, response) => {
    tavilyCalls += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url.startsWith('/extract')) {
      response.end(JSON.stringify({ results: [{ raw_content: 'tavily markdown body' }] }));
      return;
    }
    response.end(JSON.stringify({ results: [] }));
  });

  tavilyServer.listen(0, '127.0.0.1');
  await once(tavilyServer, 'listening');
  tavilyUrl = `http://127.0.0.1:${tavilyServer.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => tavilyServer.close(resolve));
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test('blocks a private target before contacting Tavily', { concurrency: false }, async () => {
  tavilyCalls = 0;
  // 私网地址在 SSRF 检查阶段即被阻断，不会真的发起连接，端口号随意
  const result = await runCli(['fetch', 'http://127.0.0.1:1/page', '--format', 'json']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Blocked private or local network address/);
  assert.equal(tavilyCalls, 0);
});

test('fetches page content via Tavily for a public URL', { concurrency: false }, async () => {
  tavilyCalls = 0;
  // 8.8.8.8 是公网 IP：不依赖 DNS 解析，且不会被真实访问（Tavily 是本地 mock）
  const result = await runCli(['fetch', 'http://8.8.8.8/page', '--format', 'json']);

  const payload = JSON.parse(result.stdout);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(tavilyCalls, 1);
  assert.equal(payload.url, 'http://8.8.8.8/page');
  assert.equal(payload.method, 'Tavily extract');
  assert.equal(payload.chars, 20);
  assert.equal(payload.content, 'tavily markdown body');
  assert.match(payload.checked_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('blocks common non-public address ranges', () => {
  for (const address of [
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '2001:db8::1',
    'fec0::1',
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});
