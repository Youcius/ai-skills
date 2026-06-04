#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const SKILL_DIR = path.resolve(__dirname, '..');
const ENV_FILE = path.join(SKILL_DIR, '.env');
const CACHE_DIR = path.join(SKILL_DIR, '.cache');
const CONFIG_FILE = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.config', 'x-search', 'config.json');

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

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

function requestJson(url, options = {}) {
  return request(url, options).then((res) => {
    try {
      return JSON.parse(res.data);
    } catch {
      throw new Error(`Invalid JSON from ${url}`);
    }
  });
}

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheSession(sessionId, payload) {
  ensureCacheDir();
  fs.writeFileSync(path.join(CACHE_DIR, `${sessionId}.json`), JSON.stringify(payload, null, 2));
}

function readSession(sessionId) {
  const file = path.join(CACHE_DIR, `${sessionId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

loadEnv();

const GROK_API_URL = process.env.GROK_API_URL || 'https://grok.star21.cc/v1';
const GROK_API_KEY = process.env.GROK_API_KEY || '';
const DEFAULT_MODEL = process.env.GROK_MODEL || 'grok-4.20-fast';
const TAVILY_API_URL = process.env.TAVILY_API_URL || 'https://tavily.star21.cc';
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';

function hasGrok() {
  return Boolean(GROK_API_KEY);
}

function hasTavily() {
  return Boolean(TAVILY_API_KEY);
}

function sanitizeQuery(query) {
  return String(query || '').replace(/\s+/g, ' ').trim();
}

function shouldPlan(query, mode) {
  if (mode === 'force') return true;
  if (mode === 'off') return false;
  const q = query.toLowerCase();
  if (query.length > 36) return true;
  if (/vs\b|compare|comparison|difference|tradeoff|error|issue|best practice|migration/i.test(q)) return true;
  if (/[对比区别差异怎么解决报错原因迁移方案]/.test(query)) return true;
  return false;
}

async function grokChat(messages, model) {
  const data = await requestJson(`${GROK_API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, stream: false }),
    timeout: 120000,
  });
  return data.choices?.[0]?.message?.content || '';
}

async function planQueries(query, maxQueries, model) {
  if (!hasGrok()) return [query];
  try {
    const text = await grokChat(
      [
        {
          role: 'system',
          content:
            'You break a user research query into a few non-overlapping web search queries. Return JSON only: {"queries":["..."]}. Keep each query short and specific. Max ' +
            maxQueries +
            ' queries.',
        },
        { role: 'user', content: query },
      ],
      model
    );
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [query];
    const parsed = JSON.parse(match[0]);
    const queries = Array.isArray(parsed.queries) ? parsed.queries.map(sanitizeQuery).filter(Boolean) : [];
    return queries.slice(0, maxQueries).length ? queries.slice(0, maxQueries) : [query];
  } catch {
    return [query];
  }
}

async function tavilySearch(query, maxResults) {
  if (!hasTavily()) throw new Error('TAVILY_API_KEY not set');
  const data = await requestJson(`${TAVILY_API_URL}/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TAVILY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: 'advanced',
      include_answer: false,
      include_raw_content: false,
      topic: 'general',
    }),
    timeout: 60000,
  });
  return Array.isArray(data.results) ? data.results : [];
}

function dedupeSources(results) {
  const seen = new Set();
  const merged = [];
  for (const item of results) {
    const url = item.url || item.link;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    merged.push({
      title: item.title || 'Untitled',
      url,
      content: String(item.content || item.snippet || '').trim(),
      score: item.score,
      query: item.query,
    });
  }
  return merged;
}

function buildSourceContext(sources) {
  return sources
    .map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\nSnippet: ${s.content || '(none)'}`)
    .join('\n\n');
}

async function synthesizeAnswer(originalQuery, queries, sources, model) {
  if (!hasGrok()) return '';
  const prompt = [
    'Answer the user using only the provided sources.',
    'Use citation markers like [1], [2].',
    'If the sources are insufficient, say so plainly.',
    'Prefer concrete dates for time-sensitive information.',
    '',
    `User question: ${originalQuery}`,
    `Search queries used: ${queries.join(' | ')}`,
    '',
    'Sources:',
    buildSourceContext(sources),
  ].join('\n');
  return grokChat(
    [
      { role: 'system', content: 'You are a concise research assistant.' },
      { role: 'user', content: prompt },
    ],
    model
  );
}

function formatSourceList(sources) {
  if (!sources.length) return '未找到来源';
  return sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n');
}

async function cmdSearch(query, options) {
  const cleanQuery = sanitizeQuery(query);
  if (!cleanQuery) throw new Error('query is required');
  if (!hasTavily()) throw new Error('TAVILY_API_KEY not set');

  const config = loadConfig();
  const model = options.model || config.model || DEFAULT_MODEL;
  const planMode = options.plan || 'auto';
  const maxResults = options.max_results || 5;
  const maxQueries = options.max_queries || 3;
  const usePlan = shouldPlan(cleanQuery, planMode);
  const queries = usePlan ? await planQueries(cleanQuery, maxQueries, model) : [cleanQuery];

  const allResults = [];
  for (const q of queries) {
    const results = await tavilySearch(q, maxResults);
    results.forEach((item) => allResults.push({ ...item, query: q }));
  }

  const sources = dedupeSources(allResults);
  const answer = await synthesizeAnswer(cleanQuery, queries, sources, model);
  const sessionId = `xsearch_${Date.now()}`;

  cacheSession(sessionId, {
    session_id: sessionId,
    query: cleanQuery,
    plan_mode: planMode,
    queries,
    model,
    sources,
    answer,
    created_at: new Date().toISOString(),
  });

  console.log(`## 搜索结果\n`);
  console.log(`- 查询: ${cleanQuery}`);
  console.log(`- 模式: ${usePlan ? 'plan' : 'direct'}`);
  console.log(`- 子查询: ${queries.length}`);
  console.log(`- 来源: ${sources.length}`);
  console.log(`- session_id: ${sessionId}\n`);

  if (answer) {
    console.log(answer.trim());
  } else {
    console.log(`### 来源摘要\n`);
    sources.slice(0, 8).forEach((s, i) => {
      console.log(`${i + 1}. ${s.title}`);
      console.log(`   ${s.url}`);
      if (s.content) console.log(`   ${s.content.slice(0, 240)}`);
    });
  }

  console.log(`\n---\n### 来源\n`);
  console.log(formatSourceList(sources));
}

async function tavilyExtract(url) {
  const data = await requestJson(`${TAVILY_API_URL}/extract`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TAVILY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      urls: [url],
      extract_depth: 'advanced',
      format: 'markdown',
    }),
    timeout: 60000,
  });
  const result = Array.isArray(data.results) ? data.results[0] : null;
  return result ? (result.raw_content || result.content || '').trim() : '';
}

async function fallbackFetch(url) {
  const response = await request(url, { timeout: 30000 });
  return response.data
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, '\n')
    .trim()
    .slice(0, 50000);
}

async function cmdFetch(url) {
  const target = sanitizeQuery(url);
  if (!target) throw new Error('url is required');
  let content = '';
  if (hasTavily()) {
    try {
      content = await tavilyExtract(target);
    } catch {}
  }
  if (!content) content = await fallbackFetch(target);
  console.log(content || '未提取到内容');
}

async function tavilyMap(url, options) {
  const data = await requestJson(`${TAVILY_API_URL}/map`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TAVILY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      max_depth: options.depth || 1,
      max_breadth: options.breadth || 20,
      limit: options.limit || 50,
      format: 'markdown',
    }),
    timeout: 60000,
  });
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.links)) return data.links.map((item) => ({ url: item }));
  return [];
}

async function cmdMap(url, options) {
  if (!hasTavily()) throw new Error('TAVILY_API_KEY not set');
  const results = await tavilyMap(url, options);
  console.log(`## Site Map\n`);
  if (!results.length) {
    console.log('未找到页面');
    return;
  }
  results.forEach((item, index) => {
    const title = item.title || item.url || `Page ${index + 1}`;
    const link = item.url || item;
    console.log(`${index + 1}. [${title}](${link})`);
  });
}

function cmdSources(sessionId) {
  const cached = readSession(sessionId);
  if (!cached) throw new Error(`session not found: ${sessionId}`);
  console.log(`## Sources for ${sessionId}\n`);
  console.log(`Query: ${cached.query}\n`);
  console.log(formatSourceList(cached.sources || []));
}

async function cmdConfig() {
  const config = loadConfig();
  console.log('## X-Search Config\n');
  console.log(`- GROK_API_URL: ${GROK_API_URL}`);
  console.log(`- GROK_API_KEY: ${hasGrok() ? `${GROK_API_KEY.slice(0, 4)}***${GROK_API_KEY.slice(-4)}` : 'not set'}`);
  console.log(`- GROK_MODEL: ${config.model || DEFAULT_MODEL}`);
  console.log(`- TAVILY_API_URL: ${TAVILY_API_URL}`);
  console.log(`- TAVILY_API_KEY: ${hasTavily() ? `${TAVILY_API_KEY.slice(0, 4)}***${TAVILY_API_KEY.slice(-4)}` : 'not set'}`);

  console.log('\n### Connectivity');
  try {
    if (hasTavily()) {
      await requestJson(`${TAVILY_API_URL}/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TAVILY_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: 'hello world', max_results: 1, search_depth: 'basic' }),
        timeout: 15000,
      });
      console.log('- Tavily: ok');
    } else {
      console.log('- Tavily: skipped');
    }
  } catch (error) {
    console.log(`- Tavily: failed (${error.message})`);
  }

  try {
    if (hasGrok()) {
      await requestJson(`${GROK_API_URL}/models`, {
        headers: { Authorization: `Bearer ${GROK_API_KEY}` },
        timeout: 15000,
      });
      console.log('- Grok: ok');
    } else {
      console.log('- Grok: skipped');
    }
  } catch (error) {
    console.log(`- Grok: failed (${error.message})`);
  }
}

async function cmdModel(name) {
  if (!name) {
    const config = loadConfig();
    console.log(config.model || DEFAULT_MODEL);
    return;
  }
  const config = loadConfig();
  config.model = name;
  saveConfig(config);
  console.log(`model = ${name}`);
}

function cmdDoc() {
  console.log(`
## x-search

Commands:
  search <query> [--plan off|auto|force] [--max_results N] [--max_queries N] [--model MODEL]
  fetch <url>
  map <url> [--depth N] [--breadth N] [--limit N]
  sources <session_id>
  config
  model [name]
  doc
`.trim());
}

function parseArgs(argv) {
  const command = argv[0];
  const options = { _args: [] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--plan') options.plan = argv[++i];
    else if (arg === '--max_results') options.max_results = Number(argv[++i]);
    else if (arg === '--max_queries') options.max_queries = Number(argv[++i]);
    else if (arg === '--model' || arg === '-m') options.model = argv[++i];
    else if (arg === '--depth' || arg === '-d') options.depth = Number(argv[++i]);
    else if (arg === '--breadth' || arg === '-b') options.breadth = Number(argv[++i]);
    else if (arg === '--limit' || arg === '-l') options.limit = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else options._args.push(arg);
  }
  return [command, options];
}

(async () => {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    cmdDoc();
    return;
  }

  const [command, options] = parseArgs(argv);
  if (options.help || command === 'doc') {
    cmdDoc();
    return;
  }

  try {
    if (command === 'search') await cmdSearch(options._args.join(' '), options);
    else if (command === 'fetch') await cmdFetch(options._args[0]);
    else if (command === 'map') await cmdMap(options._args[0], options);
    else if (command === 'sources') cmdSources(options._args[0]);
    else if (command === 'config') await cmdConfig();
    else if (command === 'model') await cmdModel(options._args[0]);
    else throw new Error(`unknown command: ${command}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
})();
