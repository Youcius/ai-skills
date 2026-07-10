#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SKILL_DIR = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.config', 'x-search', 'config.json');
const DEFAULT_CACHE_TTL_DAYS = 1;

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

const { request } = require('./utils/fetch');
const { cacheSession, readSession, cleanupCache } = require('./utils/cache');
const { dedupeSources, printSearchResult, printSources } = require('./utils/format');
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

function fallbackAnswer(sources) {
  if (!sources.length) return '## 结论\n\n未找到足够来源。\n\n## 不确定或缺口\n\n- 没有可用来源。';
  const lines = ['## 结论', '', '已找到相关来源，但当前没有可用模型生成综合结论。', '', '## 关键要点', ''];
  sources.slice(0, 5).forEach((source, index) => {
    const text = sanitize(source.content || source.title).slice(0, 180);
    lines.push(`- ${text} [${index + 1}]`);
  });
  lines.push('', '## 不确定或缺口', '', '- 未经过模型综合，只展示来源摘要。');
  return lines.join('\n');
}

async function fallbackFetch(url, allowPrivate = false) {
  const response = await request(url, {
    timeout: 30000,
    retries: 2,
    maxRedirects: 5,
    maxResponseBytes: 10 * 1024 * 1024,
    blockPrivate: !allowPrivate,
  });
  return response.data
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, '\n')
    .trim()
    .slice(0, 50000);
}

async function cmdSearch(query, options) {
  const cleanQuery = sanitize(query);
  if (!cleanQuery) throw new Error('query is required');

  const config = loadConfig();
  const model = options.model || config.model || grok.getDefaultModel();
  let provider = '';
  let answer = '';
  let sources = [];
  let queries = [cleanQuery];
  let detectedLibrary = null;
  const statuses = [];

  const grokResult = await grok.search(cleanQuery, model);
  if (grokResult.success) {
    provider = 'Grok';
    answer = grokResult.answer.replace(/\n?LIBRARY:\s*[^\n]*$/m, '').trim();
    detectedLibrary = grokResult.detectedLibrary;
    sources = extractSources(answer);
    statuses.push(providerStatus('Grok', true, 'primary search succeeded'));
  } else {
    statuses.push(providerStatus('Grok', false, grokResult.reason || 'search failed'));
    if (!tavily.hasTavily()) throw new Error('No search provider available. Configure GROK_API_KEY or TAVILY_API_KEY.');

    const maxResults = options.max_results || 5;
    const maxQueries = options.max_queries || 3;
    queries = grok.shouldPlan(cleanQuery, options.plan || 'auto')
      ? await grok.planQueries(cleanQuery, maxQueries, model)
      : [cleanQuery];

    const batches = await Promise.all(queries.map(async (item) => {
      const results = await tavily.search(item, maxResults);
      return results.map((result) => ({ ...result, query: item }));
    }));
    sources = dedupeSources(batches.flat());
    statuses.push(providerStatus('Tavily', true, `${sources.length} unique source(s)`));

    if (grok.hasGrok()) {
      try {
        answer = await grok.synthesizeAnswer(cleanQuery, queries, sources, model);
        provider = 'Tavily + Grok synthesis';
      } catch (error) {
        statuses.push(providerStatus('Grok synthesis', false, error.message));
        answer = fallbackAnswer(sources);
        provider = 'Tavily';
      }
    } else {
      answer = fallbackAnswer(sources);
      provider = 'Tavily';
    }
  }

  let context7Result = null;
  if (context7.hasContext7()) {
    let libraryName = detectedLibrary;
    if (!libraryName && grok.hasGrok()) {
      try { libraryName = await grok.detectLibrary(cleanQuery, model); } catch {}
    }
    if (libraryName) {
      try {
        context7Result = await context7.searchDocs(cleanQuery, libraryName);
        statuses.push(providerStatus('Context7', Boolean(context7Result?.found), context7Result?.found ? 'docs found' : 'no docs found'));
      } catch (error) {
        statuses.push(providerStatus('Context7', false, error.message));
      }
    }
  }

  const session = {
    schema_version: 'x-search.session.v2',
    session_id: `xsearch_${Date.now()}`,
    query: cleanQuery,
    queries,
    provider,
    provider_status: statuses,
    answer: sanitize(answer) ? answer.trim() : fallbackAnswer(sources),
    sources,
    context7: context7Result,
    checked_at: new Date().toISOString(),
  };

  cacheSession(session.session_id, session, cacheTtlDays(config));
  printSearchResult(session, options.format || 'markdown');
  if ((options.format || 'markdown') === 'markdown' && context7Result?.found) {
    console.log(context7.formatDocsResult(context7Result));
  }
}

async function cmdFetch(url, options) {
  const target = sanitize(url);
  if (!target) throw new Error('url is required');
  new URL(target);

  let content = '';
  let method = 'direct HTTP fallback';
  if (tavily.hasTavily()) {
    try {
      content = await tavily.extract(target);
      if (content) method = 'Tavily extract';
    } catch {}
  }
  if (!content) content = await fallbackFetch(target, options.allow_private === true);

  const result = { url: target, method, checked_at: new Date().toISOString(), chars: content.length, content };
  if (options.format === 'json') console.log(JSON.stringify(result, null, 2));
  else if (options.format === 'compact') console.log(`${method} | ${content.length} chars | ${target}`);
  else console.log(`# x-search fetch\n\n- URL: ${target}\n- method: ${method}\n- checked_at: ${result.checked_at}\n- chars: ${content.length}\n\n## 正文\n\n${content}`);
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
    cleanupCache(days);
  }
  const days = cacheTtlDays(config);
  console.log(days ? `cache = ${days} day(s)` : 'cache = off');
}

function cmdDoc() {
  console.log(`x-search\n\nCommands:\n  search <query> [--plan off|auto|force] [--max-results N] [--max-queries N] [--model MODEL] [--format markdown|json|compact]\n  fetch <url> [--allow-private] [--format markdown|json|compact]\n  map <url> [--depth N] [--breadth N] [--limit N] [--format markdown|json|compact]\n  sources <session_id> [--format markdown|json|compact]\n  config [--format markdown|json|compact]\n  model [name]\n  cache [days|off]\n  doc`);
}

function parseArgs(argv) {
  const command = argv[0];
  const options = { _args: [], format: 'markdown' };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--plan') options.plan = argv[++i];
    else if (arg === '--max-results' || arg === '--max_results') options.max_results = Number(argv[++i]);
    else if (arg === '--max-queries' || arg === '--max_queries') options.max_queries = Number(argv[++i]);
    else if (arg === '--model' || arg === '-m') options.model = argv[++i];
    else if (arg === '--depth' || arg === '-d') options.depth = Number(argv[++i]);
    else if (arg === '--breadth' || arg === '-b') options.breadth = Number(argv[++i]);
    else if (arg === '--limit' || arg === '-l') options.limit = Number(argv[++i]);
    else if (arg === '--format') options.format = argv[++i];
    else if (arg === '--allow-private') options.allow_private = true;
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
