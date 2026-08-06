#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKILL_DIR = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.config', 'x-search', 'config.json');
const DEFAULT_CACHE_TTL_DAYS = 1;
// 时效性查询（新闻/最新）的缓存上限：1 小时，避免新闻变旧闻还命中缓存
const FRESH_CACHE_TTL_DAYS = 1 / 24;

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function stripInlineComment(value) {
  let quote = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === '"' || char === "'") && value[i - 1] !== '\\') {
      quote = quote === char ? '' : quote || char;
    } else if (char === '#' && !quote) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

function loadEnv() {
  const candidates = [path.join(SKILL_DIR, '.env'), path.join(SKILL_DIR, '.env.local')];
  for (const envFile of candidates) {
    if (!fs.existsSync(envFile)) continue;
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = unquote(stripInlineComment(match[2].trim()));
    }
    break;
  }
}
loadEnv();

const { getSafeLookup } = require('./utils/network');
const { cacheSession, readSession, cleanupCache } = require('./utils/cache');
const { dedupeSources, printSearchResult, printSources } = require('./utils/format');
const { detectFreshness } = require('./utils/freshness');
const grok = require('./providers/grok');
const tavily = require('./providers/tavily');
const context7 = require('./providers/context7');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function cacheTtlDays(config = loadConfig()) {
  const value = Number(config.cache_ttl_days ?? DEFAULT_CACHE_TTL_DAYS);
  return Number.isFinite(value) ? Math.max(0, value) : DEFAULT_CACHE_TTL_DAYS;
}

function sanitize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function queryHash(query) {
  return crypto.createHash('md5').update(query, 'utf8').digest('hex').slice(0, 12);
}

function providerStatus(name, ok, detail) {
  return { name, ok, detail: detail || null };
}

function extractSources(answer) {
  const found = [];
  const regex = /https?:\/\/[^\s)\]）>"]+/g;
  let match;
  while ((match = regex.exec(answer)) !== null) {
    const url = match[0].replace(/[.,;:)\]）]+$/, '');
    let title = 'source';
    try { title = new URL(url).hostname; } catch {}
    found.push({ title, url, content: '' });
  }
  return dedupeSources(found);
}

function skippedProvider(name, detail) {
  return {
    provider: name,
    ok: false,
    status: 'skipped',
    elapsed_ms: 0,
    detail,
    answer: '',
    sources: [],
  };
}

async function runProvider(name, action) {
  const startedAt = Date.now();
  try {
    const value = await action();
    return {
      provider: name,
      ok: true,
      status: 'success',
      elapsed_ms: Date.now() - startedAt,
      value,
    };
  } catch (error) {
    return {
      provider: name,
      ok: false,
      status: 'failed',
      elapsed_ms: Date.now() - startedAt,
      detail: error.message,
      value: null,
    };
  }
}

function normalizeGrokResult(attempt) {
  const base = {
    provider: 'Grok',
    ok: attempt.ok,
    status: attempt.status,
    elapsed_ms: attempt.elapsed_ms,
  };
  if (!attempt.ok) {
    return {
      ...base,
      detail: attempt.detail || 'Grok request failed',
      answer: '',
      sources: [],
      detected_library: null,
      source_note: 'Grok unavailable',
    };
  }

  const value = attempt.value || {};
  if (!value.success) {
    return {
      ...base,
      ok: false,
      status: 'failed',
      detail: value.reason || 'Grok returned no result',
      answer: '',
      sources: [],
      detected_library: null,
      source_note: 'Grok unavailable',
    };
  }

  const answer = String(value.answer || '')
    .replace(/\n?LIBRARY:\s*[^\n]*$/m, '')
    .trim();
  const structured = value.structured === true && Array.isArray(value.sources);
  const sources = structured
    ? dedupeSources(
        value.sources.map((item) => ({
          title: item.title,
          url: item.url,
          published_date: item.date,
          content: '',
        }))
      )
    : extractSources(answer);
  return {
    ...base,
    detail: `${sources.length} source(s) in ${attempt.elapsed_ms}ms${structured ? '' : ' (regex fallback)'}`,
    answer,
    sources,
    detected_library: value.detectedLibrary || null,
    source_note: structured
      ? 'Structured sources returned by Grok in JSON response'
      : 'URLs extracted from the Grok response; not merged or independently verified by this CLI',
  };
}

function normalizeTavilyResult(attempt, query) {
  const base = {
    provider: 'Tavily',
    ok: attempt.ok,
    status: attempt.status,
    elapsed_ms: attempt.elapsed_ms,
  };
  if (!attempt.ok) {
    return {
      ...base,
      detail: attempt.detail || 'Tavily request failed',
      queries: [query],
      answer: '',
      sources: [],
      source_note: 'Tavily unavailable',
    };
  }

  const value = attempt.value || {};
  const rawSources = Array.isArray(value.results) ? value.results : [];
  const sources = dedupeSources(rawSources.map((item) => ({ ...item, query })));
  return {
    ...base,
    detail: `${sources.length} structured source(s) in ${attempt.elapsed_ms}ms`,
    queries: [query],
    answer: value.answer || '',
    sources,
    source_note: 'Structured results returned directly by Tavily; answer is Tavily AI-generated',
  };
}

function providerStatusFromResult(result) {
  const detail = result.ok
    ? result.detail || `success in ${result.elapsed_ms}ms`
    : `${result.status}: ${result.detail || 'unavailable'}`;
  return providerStatus(result.provider, result.ok, detail);
}

function resolveSearchTimeout(config, options) {
  const value = options.timeout_ms ?? config.search_timeout_ms ?? 30000;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
    throw new Error('timeout-ms must be an integer between 1000 and 120000');
  }
  return timeout;
}

async function cmdSearch(query, options) {
  const cleanQuery = sanitize(query);
  if (!cleanQuery) throw new Error('query is required');

  const config = loadConfig();
  const model = options.model || config.model || grok.getDefaultModel();
  const timeout = resolveSearchTimeout(config, options);
  const maxResults = options.max_results || 5;
  const format = options.format || 'markdown';

  if (!grok.hasGrok() && !tavily.hasTavily()) {
    throw new Error('No search provider available. Configure GROK_API_KEY or TAVILY_API_KEY.');
  }

  // 缓存按查询内容命中（相同 query 复用结果，省 API 调用）；
  // 时效性查询（新闻/最新）使用更短的缓存时间，避免旧闻命中。
  const freshness = detectFreshness(cleanQuery);
  const ttlDays = freshness.isFresh
    ? Math.min(cacheTtlDays(config), FRESH_CACHE_TTL_DAYS)
    : cacheTtlDays(config);
  const sessionId = `xsearch_${queryHash(cleanQuery)}`;

  const cached = readSession(sessionId, ttlDays);
  if (cached) {
    printSearchResult(cached, format);
    if (format === 'markdown' && cached.context7?.found) {
      console.log(context7.formatDocsResult(cached.context7));
    }
    return;
  }

  // Start both providers before awaiting either one. A failure or timeout in
  // one provider must not prevent the other provider from returning evidence.
  const [grokAttempt, tavilyAttempt] = await Promise.all([
    grok.hasGrok()
      ? runProvider('Grok', () => grok.search(cleanQuery, model, { timeout, retries: 2 }))
      : Promise.resolve(skippedProvider('Grok', 'GROK_API_KEY not set')),
    tavily.hasTavily()
      ? runProvider('Tavily', () => tavily.search(cleanQuery, maxResults, { timeout, retries: 2 }))
      : Promise.resolve(skippedProvider('Tavily', 'TAVILY_API_KEY not set')),
  ]);

  const grokResult = normalizeGrokResult(grokAttempt);
  const tavilyResult = normalizeTavilyResult(tavilyAttempt, cleanQuery);
  const providerResults = { grok: grokResult, tavily: tavilyResult };
  const statuses = [providerStatusFromResult(grokResult), providerStatusFromResult(tavilyResult)];

  // Context7 remains an independent documentation supplement. It only runs
  // when Grok explicitly identifies a library; it never synthesizes either
  // search result and never decides whether the main search succeeded.
  let context7Result = null;
  if (context7.hasContext7() && grokResult.ok && grokResult.detected_library) {
    const attempt = await runProvider('Context7', () => context7.searchDocs(cleanQuery, grokResult.detected_library));
    const value = attempt.value || {};
    context7Result = attempt.ok
      ? {
          provider: 'Context7',
          ok: true,
          status: 'success',
          elapsed_ms: attempt.elapsed_ms,
          found: Boolean(value.found),
          library: value.library || null,
          docs: Array.isArray(value.docs) ? value.docs : [],
          detail: value.found ? 'documentation found' : 'no documentation found',
        }
      : {
          provider: 'Context7',
          ok: false,
          status: 'failed',
          elapsed_ms: attempt.elapsed_ms,
          found: false,
          library: null,
          docs: [],
          detail: attempt.detail || 'Context7 request failed',
        };
    providerResults.context7 = context7Result;
    statuses.push(providerStatusFromResult(context7Result));
  }

  const legacySources = dedupeSources([
    ...grokResult.sources,
    ...tavilyResult.sources,
  ]);
  const session = {
    schema_version: 'x-search.session.v3',
    session_id: sessionId,
    query: cleanQuery,
    queries: [cleanQuery],
    provider: 'independent',
    provider_status: statuses,
    provider_results: providerResults,
    // No top-level answer: the calling agent receives the independent
    // provider results and decides how to compare or summarize them.
    sources: legacySources,
    context7: context7Result,
    search_timeout_ms: timeout,
    checked_at: new Date().toISOString(),
  };

  cacheSession(sessionId, session, ttlDays);
  printSearchResult(session, format);
  if (format === 'markdown' && context7Result?.found) {
    console.log(context7.formatDocsResult(context7Result));
  }
}

async function cmdFetch(url, options) {
  const target = sanitize(url);
  if (!target) throw new Error('url is required');
  const targetUrl = new URL(target);
  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    throw new Error(`Unsupported protocol: ${targetUrl.protocol}`);
  }
  if (!tavily.hasTavily()) {
    throw new Error('TAVILY_API_KEY not set; fetch requires Tavily');
  }
  // 私网/内网地址一律阻断：不把内网 URL 发送给第三方抽取服务，也没有本地抓取兜底。
  await getSafeLookup(targetUrl, true);

  const content = await tavily.extract(targetUrl.href);
  if (!content) throw new Error(`Tavily returned no content for ${target}`);

  const result = { url: targetUrl.href, method: 'Tavily extract', checked_at: new Date().toISOString(), chars: content.length, content };
  if (options.format === 'json') console.log(JSON.stringify(result, null, 2));
  else if (options.format === 'compact') console.log(`${result.method} | ${content.length} chars | ${target}`);
  else console.log(`# x-search fetch\n\n- URL: ${target}\n- method: ${result.method}\n- checked_at: ${result.checked_at}\n- chars: ${content.length}\n\n## 正文\n\n${content}`);
}

async function cmdMap(url, options) {
  if (!tavily.hasTavily()) throw new Error('TAVILY_API_KEY not set');
  const results = await tavily.siteMap(url, options);
  if (options.format === 'json') {
    console.log(JSON.stringify({ url, count: results.length, pages: results, checked_at: new Date().toISOString() }, null, 2));
    return;
  }
  if (options.format === 'compact') {
    console.log(`${url} | ${results.length} page(s)`);
    return;
  }
  console.log(`# Site Map\n\n- URL: ${url}\n- pages: ${results.length}\n`);
  results.forEach((item, index) => {
    const link = item.url || item;
    console.log(`${index + 1}. [${item.title || link || `Page ${index + 1}`}](${link})`);
  });
}

function cmdSources(sessionId, options) {
  const config = loadConfig();
  const cached = readSession(sessionId, cacheTtlDays(config));
  if (!cached) throw new Error(`session not found: ${sessionId}`);
  printSources(cached, options.format || 'markdown');
}

async function cmdConfig(options) {
  const config = loadConfig();
  const model = config.model || grok.getDefaultModel();
  const check = async (name, configured, action) => {
    if (!configured) {
      return { ...providerStatus(name, false, 'key not set'), state: 'skipped', latency_ms: null };
    }
    const startedAt = Date.now();
    try {
      await action();
      const latency = Date.now() - startedAt;
      return { ...providerStatus(name, true, `ok (${latency}ms)`), state: 'ok', latency_ms: latency };
    } catch (error) {
      const latency = Date.now() - startedAt;
      return { ...providerStatus(name, false, error.message), state: 'failed', latency_ms: latency };
    }
  };
  const connectivity = await Promise.all([
    check('Grok', grok.hasGrok(), () => grok.grokChat([{ role: 'user', content: 'Reply with OK only.' }], model)),
    check('Tavily', tavily.hasTavily(), () => tavily.search('connectivity check', 1)),
    check('Context7', true, () => context7.checkConnectivity()),
  ]);
  const report = {
    grok_url: grok.getApiUrl(),
    grok_key_configured: grok.hasGrok(),
    model,
    tavily_url: tavily.getApiUrl(),
    tavily_key_configured: tavily.hasTavily(),
    context7_url: context7.getApiUrl(),
    context7_key_configured: context7.hasContext7Key(),
    cache_ttl_days: cacheTtlDays(config),
    skill_dir: SKILL_DIR,
    connectivity,
  };

  if (options.format === 'json') return console.log(JSON.stringify(report, null, 2));
  if (options.format === 'compact') {
    const status = connectivity.map((item) => `${item.name}: ${item.state}`).join(' | ');
    return console.log(`${status} | model: ${model} | cache: ${report.cache_ttl_days ? `${report.cache_ttl_days} day(s)` : 'off'}`);
  }

  console.log(`# X-Search Config\n\n- Grok: ${report.grok_key_configured ? '✅ configured' : '❌ not set'}\n- Tavily: ${report.tavily_key_configured ? '✅ configured' : '❌ not set'}\n- Context7: ${report.context7_key_configured ? '✅ configured' : 'ℹ️ optional'}\n- Model: ${model}\n- Cache: ${report.cache_ttl_days ? `${report.cache_ttl_days} day(s)` : 'off'}\n- skill_dir: ${SKILL_DIR}\n\n## Connectivity\n`);
  connectivity.forEach((item) => {
    const icon = item.state === 'ok' ? '✅' : item.state === 'skipped' ? '⏭️' : '❌';
    console.log(`- ${item.name}: ${icon} — ${item.detail}`);
  });
}

function cmdModel(name) {
  const config = loadConfig();
  if (!name) return console.log(config.model || grok.getDefaultModel());
  config.model = name;
  saveConfig(config);
  console.log(`model = ${name}`);
}

function cmdCache(value) {
  const config = loadConfig();
  if (value !== undefined) {
    const normalized = String(value).trim().toLowerCase();
    const days = ['off', 'false', 'none', 'no', 'disable', 'disabled'].includes(normalized) ? 0 : Number(normalized);
    if (!Number.isInteger(days) || days < 0) throw new Error('cache value must be a non-negative integer, or off');
    config.cache_ttl_days = days;
    saveConfig(config);
    if (days === 0) cleanupCache(0);
  }
  const days = cacheTtlDays(config);
  console.log(days ? `cache = ${days} day(s)` : 'cache = off');
}

function cmdDoc() {
  console.log(`x-search\n\nCommands:\n  search <query> [--max-results N] [--timeout-ms N] [--model MODEL] [--format markdown|json|compact]\n  fetch <url> [--format markdown|json|compact]\n  map <url> [--depth N] [--breadth N] [--limit N] [--format markdown|json|compact]\n  sources <session_id> [--format markdown|json|compact]\n  config [--format markdown|json|compact]\n  model [name]\n  cache [days|off]\n  doc\n\nSearch mode: Grok and Tavily run independently and return separate provider results.\nThe calling agent is responsible for comparison and synthesis.\n--timeout-ms applies independently to one request per provider (1000-120000); main search requests are not retried by the CLI.`);
}

function parseArgs(argv) {
  const command = argv[0];
  const options = { _args: [], format: 'markdown' };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--plan') options.plan = argv[++i];
    else if (arg === '--max-results' || arg === '--max_results') options.max_results = Number(argv[++i]);
    else if (arg === '--max-queries' || arg === '--max_queries') options.max_queries = Number(argv[++i]);
    else if (arg === '--timeout-ms' || arg === '--timeout_ms') options.timeout_ms = Number(argv[++i]);
    else if (arg === '--model' || arg === '-m') options.model = argv[++i];
    else if (arg === '--depth' || arg === '-d') options.depth = Number(argv[++i]);
    else if (arg === '--breadth' || arg === '-b') options.breadth = Number(argv[++i]);
    else if (arg === '--limit' || arg === '-l') options.limit = Number(argv[++i]);
    else if (arg === '--format') options.format = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else options._args.push(arg);
  }
  if (!['markdown', 'json', 'compact'].includes(options.format)) throw new Error('format must be markdown, json, or compact');
  return [command, options];
}

(async () => {
  try {
    const argv = process.argv.slice(2);
    if (!argv.length) return cmdDoc();
    const [command, options] = parseArgs(argv);
    if (options.help || command === 'doc' || command === 'docs') return cmdDoc();
    if (command === 'search') await cmdSearch(options._args.join(' '), options);
    else if (command === 'fetch') await cmdFetch(options._args[0], options);
    else if (command === 'map') await cmdMap(options._args[0], options);
    else if (command === 'sources') cmdSources(options._args[0], options);
    else if (command === 'config') await cmdConfig(options);
    else if (command === 'model') cmdModel(options._args[0]);
    else if (command === 'cache') cmdCache(options._args[0]);
    else throw new Error(`unknown command: ${command}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
})();
