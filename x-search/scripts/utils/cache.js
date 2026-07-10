'use strict';

const fs = require('fs');
const path = require('path');

const SKILL_DIR = path.resolve(__dirname, '..', '..');
const CACHE_DIR = path.join(SKILL_DIR, '.cache');

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function checkedAt(payload, file) {
  const value = payload?.checked_at || payload?.created_at;
  const parsed = value ? Date.parse(value) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  try { return fs.statSync(file).mtimeMs; } catch { return Date.now(); }
}

function cleanupCache(ttlDays) {
  if (!fs.existsSync(CACHE_DIR)) return;
  const days = Math.max(0, Number(ttlDays) || 0);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(CACHE_DIR)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(CACHE_DIR, name);
    if (days === 0) {
      fs.rmSync(file, { force: true });
      continue;
    }
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (checkedAt(payload, file) < cutoff) fs.rmSync(file, { force: true });
  }
}

function cacheSession(sessionId, payload, ttlDays) {
  cleanupCache(ttlDays);
  if (Number(ttlDays) <= 0) return false;
  ensureCacheDir();
  fs.writeFileSync(path.join(CACHE_DIR, `${sessionId}.json`), JSON.stringify(payload, null, 2), 'utf8');
  return true;
}

function readSession(sessionId, ttlDays) {
  cleanupCache(ttlDays);
  if (Number(ttlDays) <= 0) return null;
  const file = path.join(CACHE_DIR, `${sessionId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { ensureCacheDir, cleanupCache, cacheSession, readSession };
