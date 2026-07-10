'use strict';

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');
const { getSafeLookup } = require('./network');

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETRIES = 2;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Make an HTTP(S) request and return raw response body.
 */
async function request(url, options = {}) {
  const config = {
    blockPrivate: options.blockPrivate === true,
    maxRedirects: toNonNegativeInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS),
    maxResponseBytes: toPositiveInteger(
      options.maxResponseBytes ?? options.maxResponseSize,
      DEFAULT_MAX_RESPONSE_BYTES
    ),
    retries: toNonNegativeInteger(options.retries, DEFAULT_RETRIES),
    retryDelay: toNonNegativeNumber(options.retryDelay, 250),
    timeout: toPositiveInteger(options.timeout, 30000),
  };

  let currentUrl = parseHttpUrl(url);
  let method = String(options.method || 'GET').toUpperCase();
  let headers = { ...(options.headers || {}) };
  let body = options.body;
  let redirects = 0;
  let retries = 0;

  while (true) {
    let result;
    try {
      const lookup = await getSafeLookup(currentUrl, config.blockPrivate);
      result = await makeRequest(currentUrl, {
        body,
        canRetry: retries < config.retries,
        headers,
        lookup,
        maxResponseBytes: config.maxResponseBytes,
        method,
        timeout: config.timeout,
      });
    } catch (err) {
      if (retries >= config.retries || !isRetryableNetworkError(err)) throw err;
      await delay(retryDelay(config.retryDelay, retries));
      retries += 1;
      continue;
    }

    if (result.redirect) {
      if (redirects >= config.maxRedirects) {
        throw new Error(`Too many redirects (maximum ${config.maxRedirects})`);
      }

      const nextUrl = parseHttpUrl(new URL(result.redirect, currentUrl));
      const nextRequest = redirectRequest(result.status, method, body, headers);
      headers = nextRequest.headers;
      method = nextRequest.method;
      body = nextRequest.body;

      if (currentUrl.origin !== nextUrl.origin) {
        headers = removeHeaders(headers, ['authorization', 'cookie', 'proxy-authorization']);
      }
      headers = removeHeaders(headers, ['host']);
      currentUrl = nextUrl;
      redirects += 1;
      continue;
    }

    if (result.retry) {
      const waitMs = result.retryAfter ?? retryDelay(config.retryDelay, retries);
      await delay(waitMs);
      retries += 1;
      continue;
    }

    return result.response;
  }
}

function makeRequest(url, options) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const headers = withAcceptEncoding(options.headers);
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    const requestOptions = {
      hostname: stripIpv6Brackets(url.hostname),
      port: url.port,
      path: url.pathname + url.search,
      method: options.method,
      headers,
    };
    if (options.lookup) requestOptions.lookup = options.lookup;

    const req = lib.request(requestOptions, (res) => {
      const status = res.statusCode || 0;

      if (REDIRECT_STATUS_CODES.has(status) && res.headers.location) {
        res.resume();
        finish(resolve, { redirect: res.headers.location, status });
        return;
      }

      if (options.canRetry && RETRYABLE_STATUS_CODES.has(status)) {
        const retryAfter = parseRetryAfter(res.headers['retry-after']);
        res.resume();
        finish(resolve, { retry: true, retryAfter });
        return;
      }

      collectBody(res, options.maxResponseBytes).then(
        (data) => {
          if (status >= 400) {
            finish(reject, new Error(`HTTP ${status}: ${data.slice(0, 400)}`));
            return;
          }
          finish(resolve, {
            response: { status, data, headers: res.headers },
          });
        },
        (err) => finish(reject, err)
      );
    });

    req.on('error', (err) => finish(reject, err));
    req.setTimeout(options.timeout, () => {
      const err = new Error(`Request timed out after ${options.timeout}ms`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });

    if (options.body !== undefined && options.body !== null) req.write(options.body);
    req.end();
  });
}

function collectBody(res, maxResponseBytes) {
  return new Promise((resolve, reject) => {
    const streams = [res];
    let stream = res;
    const encodings = String(res.headers['content-encoding'] || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    for (const encoding of encodings.reverse()) {
      const decoder = createDecoder(encoding);
      if (!decoder) continue;
      stream = stream.pipe(decoder);
      streams.push(decoder);
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    res.on('aborted', () => {
      const err = new Error('Response aborted');
      err.code = 'ECONNRESET';
      fail(err);
    });
    for (const item of streams) item.on('error', fail);

    stream.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxResponseBytes) {
        const err = new Error(`Response exceeds ${maxResponseBytes} byte limit`);
        err.code = 'ERR_RESPONSE_TOO_LARGE';
        settled = true;
        for (const item of streams) item.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size).toString('utf8'));
    });
  });
}

function createDecoder(encoding) {
  if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.createGunzip();
  if (encoding === 'deflate') return zlib.createInflate();
  if (encoding === 'br') return zlib.createBrotliDecompress();
  return null;
}

function redirectRequest(status, method, body, headers) {
  const switchToGet = (status === 303 && method !== 'HEAD') ||
    ((status === 301 || status === 302) && method === 'POST');
  if (!switchToGet) return { method, body, headers };
  return {
    method: 'GET',
    body: undefined,
    headers: removeHeaders(headers, ['content-length', 'content-type', 'transfer-encoding']),
  };
}

function withAcceptEncoding(headers) {
  if (hasHeader(headers, 'accept-encoding')) return { ...headers };
  return { ...headers, 'Accept-Encoding': 'gzip, deflate, br' };
}

function hasHeader(headers, name) {
  const lowerName = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lowerName);
}

function removeHeaders(headers, names) {
  const blocked = new Set(names.map((name) => name.toLowerCase()));
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase()))
  );
}

function parseRetryAfter(value) {
  if (Array.isArray(value)) value = value[0];
  if (value === undefined) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

function isRetryableNetworkError(err) {
  return Boolean(err && RETRYABLE_ERROR_CODES.has(err.code));
}

function retryDelay(baseDelay, retryNumber) {
  return Math.min(baseDelay * (2 ** retryNumber), 30000);
}

function delay(milliseconds) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseHttpUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  return url;
}

function stripIpv6Brackets(hostname) {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
  return hostname;
}

function toNonNegativeInteger(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error('Expected a non-negative integer option');
  return number;
}

function toPositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error('Expected a positive integer option');
  return number;
}

function toNonNegativeNumber(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('Expected a non-negative number option');
  return number;
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
