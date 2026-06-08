'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Make an HTTP(S) request and return raw response body.
 */
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 30000,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 400)}`));
            return;
          }
          resolve({ status: res.statusCode, data: body, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Make an HTTP(S) request and parse JSON response.
 */
function requestJson(url, options = {}) {
  return request(url, options).then((res) => {
    try {
      return JSON.parse(res.data);
    } catch {
      throw new Error(`Invalid JSON from ${url}`);
    }
  });
}

module.exports = { request, requestJson };
