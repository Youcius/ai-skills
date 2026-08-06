'use strict';

const fs = require('fs');
const path = require('path');

const SKILL_DIR = path.resolve(__dirname, '..', '..');
const CACHE_DIR = path.join(SKILL_DIR, '.cache');
// 缓存文件物理保留的上限（天）：防止目录无限膨胀；命中过期判断由调用方按 TTL 控制
const MAX_PHYSICAL_AGE_DAYS = 30;

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function checkedAt(payload, file) {
  const value = payload?.checked_at || payload?.created_at;
  const parsed = value ? Date.parse(value) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  try { return fs.statSync(file).mtimeMs; } catch { return Date.now(); }
}

function cleanupCache(maxAgeDays = MAX_PHYSICAL_AGE_DAYS) {
  if (!fs.existsSync(CACHE_DIR)) return;
  const cutoff = Date.now() - Math.max(0, Number(maxAgeDays) || MAX_PHYSICAL_AGE_DAYS) * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(CACHE_DIR)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(CACHE_DIR, name);
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (checkedAt(payload, file) < cutoff) fs.rmSync(file, { force: true });
  }
}

function cacheSession(sessionId, payload, ttlDays) {
  cleanupCache();
  if (Number(ttlDays) <= 0) return false;
  ensureCacheDir();
  fs.writeFileSync(path.join(CACHE_DIR, `${sessionId}.json`), JSON.stringify(payload, null, 2), 'utf8');
  return true;
}

function readSession(sessionId, ttlDays) {
  cleanupCache();
  if (Number(ttlDays) <= 0) return null;
  const file = path.join(CACHE_DIR, `${sessionId}.json`);
  if (!fs.existsSync(file)) return null;
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const ageMs = Date.now() - checkedAt(payload, file);
  if (ageMs > Number(ttlDays) * 24 * 60 * 60 * 1000) {
    fs.rmSync(file, { force: true });
    return null;
  }
  return payload;
}

module.exports = { ensureCacheDir, cleanupCache, cacheSession, readSession };
