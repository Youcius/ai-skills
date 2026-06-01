#!/usr/bin/env node
/**
 * X-Search CLI — Node.js (zero-dependency)
 * Commands: search | fetch | map | sources | config | model | doc
 */

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ── Paths ──────────────────────────────────────────
const SKILL_DIR = path.resolve(__dirname, '..');
const ENV_FILE = path.join(SKILL_DIR, '.env');
const CONFIG_FILE = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.config', 'x-search', 'config.json');
const CACHE_DIR = path.join(SKILL_DIR, '.cache');

// ── Load .env ──────────────────────────────────────
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  fs.readFileSync(ENV_FILE, 'utf8')
    .split(/\r?\n/)
    .forEach(line => {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)/);
      if (m && !m[1].startsWith('#')) process.env[m[1]] = m[2].trim();
    });
}
loadEnv();

// ── Config helpers ─────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ── Env defaults ───────────────────────────────────
const GROK_API_URL = process.env.GROK_API_URL || 'https://grok.star21.cc/v1';
const GROK_API_KEY = process.env.GROK_API_KEY || '';
const DEFAULT_MODEL = process.env.GROK_MODEL || 'grok-4.20-fast';
const TAVILY_API_URL = process.env.TAVILY_API_URL || 'https://tavily.star21.cc';
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';

// ── HTTP helper ────────────────────────────────────
function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: opts.timeout || 30000,
      rejectUnauthorized: false
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        else resolve({ status: res.statusCode, data: body, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── Cache ──────────────────────────────────────────
function cacheSources(sessionId, sources) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `${sessionId}.json`), JSON.stringify({ sources, ts: Date.now() }));
}

function getCachedSources(sessionId) {
  const f = path.join(CACHE_DIR, `${sessionId}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// ════════════════════════════════════════════════════
//  COMMANDS
// ════════════════════════════════════════════════════

// ── search ─────────────────────────────────────────
async function cmdSearch(query, opts) {
  const model = opts.model || loadConfig().model || DEFAULT_MODEL;
  const start = Date.now();

  const systemPrompt = [
    'You are a helpful AI assistant with web search capability.',
    'Search the web and provide a comprehensive, accurate answer.',
    'Cite sources with [1], [2] etc. when referencing specific facts.',
    opts.platform ? `Focus results on ${opts.platform}.` : ''
  ].filter(Boolean).join(' ');

  const payload = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query }
    ],
    stream: false
  });

  const result = await request(`${GROK_API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: payload,
    timeout: 120000
  });

  const data = JSON.parse(result.data);
  const answer = data.choices?.[0]?.message?.content || '';
  const usage = data.usage || {};

  // Extra sources via Tavily
  let sources = [];
  const extraSources = opts.extra_sources ?? 3;
  if (extraSources > 0 && TAVILY_API_KEY) {
    try {
      const tr = await request(`${TAVILY_API_URL}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAVILY_API_KEY}` },
        body: JSON.stringify({ query, max_results: extraSources, search_depth: 'basic' }),
        timeout: 30000
      });
      sources = JSON.parse(tr.data).results || [];
    } catch { /* Tavily is best-effort */ }
  }

  const sessionId = `grok_${Date.now()}`;
  cacheSources(sessionId, sources);

  const elapsed = Date.now() - start;

  // Output
  console.log(`## Search Results (${sources.length} sources, ${elapsed}ms)\n`);
  console.log(answer);
  if (sources.length > 0) {
    console.log(`\n---\n### Sources (${sources.length})\n`);
    sources.forEach((s, i) => console.log(`${i + 1}. [${s.title || 'Untitled'}](${s.url})`));
  }
  console.log(`\n<!-- session_id: ${sessionId} | model: ${model} | tokens: ${usage.total_tokens || '?'} -->`);
}

// ── fetch ──────────────────────────────────────────
async function cmdFetch(url) {
  const start = Date.now();

  // Try Grok API first for AI-enhanced extraction
  let content;
  try {
    const result = await request(`${GROK_API_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [
          { role: 'system', content: 'Extract the main content from the following URL and return it as clean Markdown. Include the title, headings, key paragraphs, and any code blocks. Strip navigation, ads, and boilerplate.' },
          { role: 'user', content: `Extract content from: ${url}` }
        ],
        stream: false
      }),
      timeout: 60000
    });
    content = JSON.parse(result.data).choices?.[0]?.message?.content || '';
  } catch {
    // Fallback: direct fetch + basic HTML strip
    try {
      const r = await request(url, { timeout: 30000 });
      content = r.data
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, '\n')
        .trim()
        .slice(0, 50000);
    } catch (e2) {
      console.error(`Fetch failed: ${e2.message}`);
      process.exit(1);
    }
  }

  const elapsed = Date.now() - start;
  console.log(content);
  console.log(`\n<!-- fetched in ${elapsed}ms -->`);
}

// ── map ────────────────────────────────────────────
async function cmdMap(url, opts) {
  const depth = opts.depth ?? 1;
  const breadth = opts.breadth ?? 20;
  const limit = opts.limit ?? 50;
  const instructions = opts.instructions || '';
  const start = Date.now();

  const visited = new Set();
  const results = [];

  async function crawl(u, d) {
    if (d > depth || visited.size >= limit) return;
    if (visited.has(u)) return;
    visited.add(u);

    try {
      const r = await request(u, { timeout: 15000 });
      const links = [];
      const linkRe = /href\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = linkRe.exec(r.data)) !== null) {
        try {
          const resolved = new URL(m[1], u).href;
          if (resolved.startsWith('http') && !visited.has(resolved)) links.push(resolved);
        } catch {}
      }

      const title = (r.data.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || u;
      results.push({ url: u, title: title.trim(), links: links.slice(0, breadth) });

      if (d < depth) {
        const toVisit = links.slice(0, breadth);
        for (const next of toVisit) await crawl(next, d + 1);
      }
    } catch {}
  }

  await crawl(url, 0);

  const elapsed = Date.now() - start;

  // Output as Markdown
  console.log(`## Site Map: ${new URL(url).hostname}\n`);
  console.log(`Depth: ${depth} | Breadth: ${breadth} | Pages: ${results.length} | Time: ${elapsed}ms\n`);
  results.forEach((r, i) => {
    const indent = '  '.repeat(r.url.split('/').length - 3);
    console.log(`${i + 1}. [${r.title}](${r.url})`);
  });
}

// ── sources ────────────────────────────────────────
function cmdSources(sessionId) {
  const cached = getCachedSources(sessionId);
  if (!cached) {
    console.error(`No cached sources for session: ${sessionId}`);
    process.exit(1);
  }
  console.log(`## Cached Sources (${cached.sources.length})\n`);
  cached.sources.forEach((s, i) => {
    console.log(`${i + 1}. **${s.title || 'Untitled'}**`);
    console.log(`   ${s.url}`);
    if (s.content) console.log(`   > ${s.content.slice(0, 200)}...`);
  });
}

// ── config ─────────────────────────────────────────
async function cmdConfig() {
  const cfg = loadConfig();
  console.log('## X-Search Configuration\n');
  console.log(`| Setting | Value |`);
  console.log(`|---------|-------|`);
  console.log(`| GROK_API_URL | \`${GROK_API_URL}\` |`);
  console.log(`| GROK_API_KEY | \`${GROK_API_KEY ? GROK_API_KEY.slice(0, 4) + '***' + GROK_API_KEY.slice(-4) : 'not set'}\` |`);
  console.log(`| GROK_MODEL (env) | \`${DEFAULT_MODEL}\` |`);
  console.log(`| GROK_MODEL (config) | \`${cfg.model || 'not set'}\` |`);
  console.log(`| TAVILY_ENABLED | \`${TAVILY_API_KEY ? 'yes' : 'no'}\` |`);

  // Connection test
  console.log(`\n### Connection Test`);
  try {
    const start = Date.now();
    await request(`${GROK_API_URL}/models`, {
      headers: { 'Authorization': `Bearer ${GROK_API_KEY}` },
      timeout: 10000
    });
    const ms = Date.now() - start;
    console.log(`✅ Connected (${ms}ms)`);
  } catch (e) {
    console.log(`❌ Failed: ${e.message}`);
  }
}

// ── model ──────────────────────────────────────────
async function cmdModel(modelName) {
  if (!modelName) {
    // List available models
    try {
      const r = await request(`${GROK_API_URL}/models`, {
        headers: { 'Authorization': `Bearer ${GROK_API_KEY}` },
        timeout: 10000
      });
      const data = JSON.parse(r.data);
      console.log('## Available Models\n');
      (data.data || data.models || []).forEach(m => console.log(`- \`${m.id || m}\``));
    } catch (e) {
      console.error(`Failed to list models: ${e.message}`);
    }
    return;
  }

  const cfg = loadConfig();
  cfg.model = modelName;
  saveConfig(cfg);
  console.log(`✅ Model switched to: \`${modelName}\``);
}

// ── doc ────────────────────────────────────────────
function cmdDoc() {
  const doc = `
## X-Search CLI — Interface Specification

### Commands

| Command | Description |
|---------|-------------|
| \`search <query>\` | AI-powered web search via Grok model |
| \`fetch <url>\` | Extract page content as Markdown |
| \`map <url>\` | Crawl site structure (graph map) |
| \`sources <id>\` | Retrieve cached sources by session_id |
| \`config\` | Show config + test API connectivity |
| \`model [name]\` | List or switch active model |
| \`doc\` | Show this documentation |

### search — AI-powered web search

\`\`\`bash
node x_search_cli.js search "quantum computing breakthroughs 2025"
node x_search_cli.js search "react 19 new features" --platform GitHub --extra_sources 5
\`\`\`

Options:
  --platform, -p     Target platform (GitHub, Twitter, Reddit…)
  --model, -m        Override model for this request
  --extra_sources, -e  Extra Tavily results (0-10, default 3)

Returns: Markdown with answer + source list + session metadata.

### fetch — Extract page content

\`\`\`bash
node x_search_cli.js fetch "https://example.com/docs"
\`\`\`

Returns: Page content as Markdown (max 50K chars).

### map — Site structure crawl

\`\`\`bash
node x_search_cli.js map "https://docs.example.com" --depth 2 --breadth 15 --limit 60
\`\`\`

Options:
  --depth, -d        Max crawl depth (default 1)
  --breadth, -b      Max links per page (default 20)
  --limit, -l        Max total pages (default 50)
  --instructions, -i Natural-language filter (e.g. "only API docs")

### sources — Get cached sources

\`\`\`bash
node x_search_cli.js sources grok_1717000000000
\`\`\`

### config — Configuration & connection test

\`\`\`bash
node x_search_cli.js config
\`\`\`

Shows current settings, API key status, and runs a connection test.

### model — Model management

\`\`\`bash
node x_search_cli.js model              # List available models
node x_search_cli.js model grok-4-fast  # Switch model
\`\`\`

### Anonymous / Key-less usage

The CLI works without an API key but with lower limits.
To configure: create \`.env\` in the skill directory:

\`\`\`
GROK_API_KEY=your_key_here
GROK_MODEL=grok-4.20-fast
\`\`\`

Key priority: \`--model\` flag > \`.config/x-search/config.json\` > \`.env\` > environment variable.
`;

  console.log(doc.trim());
}

// ════════════════════════════════════════════════════
//  MAIN
// ════════════════════════════════════════════════════

function parseArgs(argv) {
  const command = argv[0];
  const opts = { _args: [] };

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform' || a === '-p') opts.platform = argv[++i];
    else if (a === '--model' || a === '-m') opts.model = argv[++i];
    else if (a === '--extra_sources' || a === '-e') opts.extra_sources = parseInt(argv[++i]);
    else if (a === '--depth' || a === '-d') opts.depth = parseInt(argv[++i]);
    else if (a === '--breadth' || a === '-b') opts.breadth = parseInt(argv[++i]);
    else if (a === '--limit' || a === '-l') opts.limit = parseInt(argv[++i]);
    else if (a === '--instructions' || a === '-i') opts.instructions = argv[++i];
    else if (a === '--help' || a === '-h') { command === 'help' ? null : opts._help = true; }
    else opts._args.push(a);
  }
  return [command, opts];
}

(async () => {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return cmdDoc();
  }

  const [command, opts] = parseArgs(args);
  if (opts._help) return cmdDoc();

  try {
    switch (command) {
      case 'search':
        if (opts._args.length === 0) { console.error('Usage: x_search_cli.js search <query>'); process.exit(1); }
        await cmdSearch(opts._args.join(' '), opts);
        break;
      case 'fetch':
        if (opts._args.length === 0) { console.error('Usage: x_search_cli.js fetch <url>'); process.exit(1); }
        await cmdFetch(opts._args[0]);
        break;
      case 'map':
        if (opts._args.length === 0) { console.error('Usage: x_search_cli.js map <url>'); process.exit(1); }
        await cmdMap(opts._args[0], opts);
        break;
      case 'sources':
        if (opts._args.length === 0) { console.error('Usage: x_search_cli.js sources <session_id>'); process.exit(1); }
        cmdSources(opts._args[0]);
        break;
      case 'config':
        await cmdConfig();
        break;
      case 'model':
        await cmdModel(opts._args[0]);
        break;
      case 'doc':
        cmdDoc();
        break;
      default:
        console.error(`Unknown command: ${command}\nRun 'x_search_cli.js doc' for help.`);
        process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
})();
