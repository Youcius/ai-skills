#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ── Load .env BEFORE any provider modules ──
const SKILL_DIR = path.resolve(__dirname, '..');
const ENV_CANDIDATES = [
  path.join(SKILL_DIR, '.env'),
  path.join(process.env.HOME || process.env.USERPROFILE || '', '.agents', 'skills', 'x-search', '.env'),
];
function loadEnv() {
  for (const envFile of ENV_CANDIDATES) {
    if (fs.existsSync(envFile)) {
      const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
      }
      break;
    }
  }
}
loadEnv();

// ── Utils (no env dependency) ──
const { request } = require('./utils/fetch');
const { ensureCacheDir, cacheSession, readSession } = require('./utils/cache');
const { dedupeSources, printUnifiedResult } = require('./utils/format');

// ── Providers (need env loaded first) ──
const grok = require('./providers/grok');
const tavily = require('./providers/tavily');
const context7 = require('./providers/context7');

// ── Config ──
const CONFIG_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.config',
  'x-search',
  'config.json'
);

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

loadEnv();

// ── Sanitize ──
function sanitizeQuery(query) {
  return String(query || '').replace(/\s+/g, ' ').trim();
}

// ── Fallback fetch (when Tavily extract fails) ──
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

// ── State tracking for unified session ──
function buildSession(query, provider, queries, sources, answer, context7Result) {
  return {
    session_id: `xsearch_${Date.now()}`,
    query,
    provider,
    queries,
    sources,
    answer,
    context7: context7Result || null,
    created_at: new Date().toISOString(),
  };
}

// ── Commands ──

async function cmdSearch(query, options) {
  const cleanQuery = sanitizeQuery(query);
  if (!cleanQuery) throw new Error('query is required');

  const config = loadConfig();
  const model = options.model || config.model || grok.getDefaultModel();

  let answer = '';
  let sources = [];
  let provider = '';
  let queries = [cleanQuery];

  // ── Step 1: Try Grok (primary) ──
  const grokResult = await grok.search(cleanQuery, model);
  let detectedLibrary = null;
  if (grokResult.success) {
    answer = grokResult.answer;
    provider = 'Grok';
    detectedLibrary = grokResult.detectedLibrary;
    // Strip the LIBRARY: marker before output
    answer = answer.replace(/\n?LIBRARY:\s*[^\n]*$/m, '');
    // Extract all URLs from Grok's answer
    const urlRegex = /https?:\/\/[^\s)\]）]+/g;
    let match;
    const extractedUrls = new Set();
    while ((match = urlRegex.exec(answer)) !== null) {
      const url = match[0].replace(/[\.\,;]+$/, '');
      if (!extractedUrls.has(url)) {
        extractedUrls.add(url);
        sources.push({ title: `Source ${sources.length + 1}`, url, content: '' });
      }
    }
    sources = dedupeSources(sources);
  } else {
    // ── Step 2: Fall back to Tavily ──
    if (!tavily.hasTavily()) {
      throw new Error('No search provider available. Configure GROK_API_KEY or TAVILY_API_KEY.');
    }

    provider = 'Tavily (Grok fallback)';
    const planMode = options.plan || 'auto';
    const maxResults = options.max_results || 5;
    const maxQueries = options.max_queries || 3;

    const usePlan = grok.shouldPlan(cleanQuery, planMode);
    queries = usePlan ? await grok.planQueries(cleanQuery, maxQueries, model) : [cleanQuery];

    const allResults = [];
    for (const q of queries) {
      const results = await tavily.search(q, maxResults);
      results.forEach((item) => allResults.push({ ...item, query: q }));
    }

    sources = dedupeSources(allResults);
    answer = await grok.synthesizeAnswer(cleanQuery, queries, sources, model);
  }

  // ── Step 3: Context7 (on-demand library docs) ──
  let context7Result = null;
  if (context7.hasContext7()) {
    let libName = detectedLibrary;
    // Tavily fallback path: Grok key exists but search failed; try detect separately
    if (!libName && grok.hasGrok()) {
      try {
        libName = await grok.detectLibrary(cleanQuery, model);
      } catch {}
    }
    if (libName) {
      try {
        context7Result = await context7.searchDocs(cleanQuery, libName);
      } catch {}
    }
  }

  // ── Step 4: Cache and output ──
  const session = buildSession(cleanQuery, provider, queries, sources, answer, context7Result);
  cacheSession(session.session_id, session);

  printUnifiedResult(cleanQuery, provider, answer, sources, session.session_id);

  // Append Context7 docs if available
  if (context7Result && context7Result.found) {
    console.log(context7.formatDocsResult(context7Result));
  }
}

async function cmdFetch(url) {
  const target = sanitizeQuery(url);
  if (!target) throw new Error('url is required');

  let content = '';
  if (tavily.hasTavily()) {
    try {
      content = await tavily.extract(target);
    } catch {
      // fall through
    }
  }
  if (!content) content = await fallbackFetch(target);
  console.log(content || '未提取到内容');
}

async function cmdMap(url, options) {
  if (!tavily.hasTavily()) throw new Error('TAVILY_API_KEY not set');
  const results = await tavily.siteMap(url, options);

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

  const { formatSourceList } = require('./utils/format');
  console.log(`## Sources for ${sessionId}\n`);
  console.log(`Query: ${cached.query}\n`);
  console.log(`Provider: ${cached.provider}\n`);
  console.log(formatSourceList(cached.sources || []));
}

async function cmdConfig() {
  const config = loadConfig();
  const model = config.model || grok.getDefaultModel();

  console.log('## X-Search Config\n');
  console.log(`### Grok`);
  console.log(`- URL: ${grok.getApiUrl()}`);
  console.log(`- Key: ${grok.hasGrok() ? '✅ configured' : '❌ not set'}`);
  console.log(`- Model: ${model}`);

  console.log(`\n### Tavily`);
  console.log(`- URL: ${tavily.getApiUrl()}`);
  console.log(`- Key: ${tavily.hasTavily() ? '✅ configured' : '❌ not set'}`);

  console.log(`\n### Context7`);
  console.log(`- URL: ${process.env.CONTEXT7_API_URL || 'https://context7.com/api'}`);
  console.log(`- Key: ${process.env.CONTEXT7_API_KEY ? '✅ configured' : 'ℹ️  optional (higher rate limits with API key)'}`);

  // Test connectivity
  console.log('\n### Connectivity');
  if (grok.hasGrok()) {
    try {
      await grok.grokChat([{ role: 'user', content: 'Hi' }], model);
      console.log('- Grok: ✅ ok');
    } catch (err) {
      console.log(`- Grok: ❌ failed (${err.message})`);
    }
  } else {
    console.log('- Grok: ⏭️  skipped');
  }

  if (tavily.hasTavily()) {
    try {
      await tavily.search('hello', 1);
      console.log('- Tavily: ✅ ok');
    } catch (err) {
      console.log(`- Tavily: ❌ failed (${err.message})`);
    }
  } else {
    console.log('- Tavily: ⏭️  skipped');
  }
}

async function cmdModel(name) {
  if (!name) {
    const config = loadConfig();
    console.log(config.model || grok.getDefaultModel());
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

// ── CLI Parser ──

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

// ── Main ──

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
