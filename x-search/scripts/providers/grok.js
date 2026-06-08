'use strict';

const { requestJson } = require('../utils/fetch');

const GROK_API_URL = process.env.GROK_API_URL || 'https://api.x.ai/v1';
const GROK_API_KEY = process.env.GROK_API_KEY || '';
const DEFAULT_MODEL = process.env.GROK_MODEL || 'grok-4.20-fast';

function hasGrok() {
  return Boolean(GROK_API_KEY);
}

function getApiUrl() {
  return GROK_API_URL;
}

function getDefaultModel() {
  return DEFAULT_MODEL;
}

/**
 * Call Grok chat completions (endpoint has built-in web search).
 */
async function grokChat(messages, model) {
  const data = await requestJson(`${GROK_API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages,
      stream: false,
    }),
    timeout: 120000,
  });
  const content = data.choices?.[0]?.message?.content || '';
  return content;
}

/**
 * Break a query into sub-queries (for Tavily fallback scenario).
 */
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
    const queries = Array.isArray(parsed.queries) ? parsed.queries.map(s => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean) : [];
    return queries.slice(0, maxQueries).length ? queries.slice(0, maxQueries) : [query];
  } catch {
    return [query];
  }
}

/**
 * Decide whether a query needs sub-query planning.
 */
function shouldPlan(query, mode) {
  if (mode === 'force') return true;
  if (mode === 'off') return false;
  const q = query.toLowerCase();
  if (query.length > 36) return true;
  if (/vs\b|compare|comparison|difference|tradeoff|error|issue|best practice|migration/i.test(q)) return true;
  if (/[对比区别差异怎么解决报错原因迁移方案]/.test(query)) return true;
  return false;
}

/**
 * Try Grok search (built-in web search).
 * Returns { success, answer, detectedLibrary }.
 * If the query is about a library/framework, Grok annotates it
 * so we can trigger Context7 without an extra API call.
 */
async function search(query, model) {
  if (!hasGrok()) {
    return { success: false, reason: 'GROK_API_KEY not set' };
  }
  try {
    const answer = await grokChat(
      [
        {
          role: 'system',
          content:
            'You are a helpful assistant with web search. Answer the user question.\n' +
            'IMPORTANT: If the user is asking about a specific library, framework, or tool ' +
            '(e.g. React, Vue, Next.js, Express, Prisma, PyTorch, etc.), ' +
            'end your answer with a line like: LIBRARY: React\n' +
            'If not about a library, do not add this line.',
        },
        { role: 'user', content: query },
      ],
      model
    );
    if (answer) {
      // Extract library annotation
      const libMatch = answer.match(/LIBRARY:\s*(.+)\s*$/m);
      const detectedLibrary = libMatch ? libMatch[1].trim() : null;
      return { success: true, answer, detectedLibrary };
    }
    return { success: false, reason: 'empty response' };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

/**
 * Synthesize an answer from Tavily sources using Grok.
 */
async function synthesizeAnswer(originalQuery, queries, sources, model) {
  if (!hasGrok()) return '';
  const { buildSourceContext } = require('../utils/format');
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

/**
 * Ask Grok whether the query is about a specific library/framework.
 * Returns library name or null.
 */
async function detectLibrary(query, model) {
  if (!hasGrok()) return null;
  try {
    const text = await grokChat(
      [
        {
          role: 'system',
          content:
            'The user is asking about a library or framework. If they are, reply with ONLY the library/framework name (e.g. "React", "Next.js", "Vue"). If not, reply with "null". No explanation.',
        },
        { role: 'user', content: query },
      ],
      model
    );
    const name = text.trim();
    return name && name !== 'null' && name !== 'None' ? name : null;
  } catch {
    return null;
  }
}

module.exports = { hasGrok, getApiUrl, getDefaultModel, grokChat, planQueries, shouldPlan, search, synthesizeAnswer, detectLibrary };
