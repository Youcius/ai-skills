'use strict';

const fs = require('fs');
const path = require('path');

const SKILL_DIR = path.resolve(__dirname, '..', '..');
const CACHE_DIR = path.join(SKILL_DIR, '.cache');

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * Save a search session to cache.
 */
function cacheSession(sessionId, payload) {
  ensureCacheDir();
  fs.writeFileSync(path.join(CACHE_DIR, `${sessionId}.json`), JSON.stringify(payload, null, 2));
}

/**
 * Read a cached search session.
 */
function readSession(sessionId) {
  const file = path.join(CACHE_DIR, `${sessionId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { ensureCacheDir, cacheSession, readSession };
