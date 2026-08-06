'use strict';

const { requestJson } = require('../utils/fetch');

const GROK_API_URL = process.env.GROK_API_URL || 'https://api.x.ai/v1';
const GROK_API_KEY = process.env.GROK_API_KEY || '';
const DEFAULT_MODEL = process.env.GROK_MODEL || 'grok-4.20-fast';
const DEFAULT_TIMEOUT_MS = 120000;

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
async function grokChat(messages, model, options = {}) {
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
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    retries: options.retries,
  });
  const content = data.choices?.[0]?.message?.content || '';
  return content;
}

const JSON_SYSTEM_PROMPT =
  'You are one independent web-search provider. Return your own findings for the query, with concrete dates and source URLs when available. Do not assume or describe results from any other provider. ' +
  'Respond with ONLY a JSON object (no markdown fences, no extra text) in exactly this shape: ' +
  '{"answer": "your findings as a single string, citing concrete dates", ' +
  '"sources": [{"title": "page title", "url": "https://example.com/page", "date": "as available"}], ' +
  '"library": "the name of the library, framework, or tool this query asks about (e.g. React, Vue, Next.js, PyTorch); set it to an empty string when the query is not about a specific library"}';

function parseJsonAnswer(text) {
  const clean = String(text || '').trim();
  const candidates = [clean];
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(clean.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {}
  }
  return null;
}

/**
 * Try Grok search (built-in web search).
 * Returns { success, answer, sources, detectedLibrary, structured }.
 * Grok is asked to respond with structured JSON; when it does not,
 * the CLI falls back to extracting URLs from the plain-text answer.
 */
async function search(query, model, options = {}) {
  if (!hasGrok()) {
    return { success: false, reason: 'GROK_API_KEY not set' };
  }
  try {
    const answer = await grokChat(
      [
        { role: 'system', content: JSON_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
      model,
      { timeout: options.timeout, retries: options.retries }
    );
    if (!answer) {
      return { success: false, reason: 'empty response' };
    }

    const parsed = parseJsonAnswer(answer);
    if (parsed) {
      const sources = Array.isArray(parsed.sources)
        ? parsed.sources
            .map((item) => {
              if (typeof item === 'string') {
                return { title: 'source', url: item, date: null };
              }
              if (!item || !item.url) return null;
              return {
                title: String(item.title || 'Untitled'),
                url: String(item.url),
                date: item.date !== undefined && item.date !== null ? String(item.date) : null,
              };
            })
            .filter(Boolean)
        : [];
      return {
        success: true,
        answer: parsed.answer !== undefined ? String(parsed.answer) : answer,
        sources,
        detectedLibrary: parsed.library ? String(parsed.library).trim() : null,
        structured: true,
      };
    }

    // 回退：模型未按 JSON 返回时保留原始回答与 LIBRARY 标注，来源由 CLI 正则提取
    const libMatch = answer.match(/LIBRARY:\s*(.+)\s*$/m);
    return {
      success: true,
      answer,
      sources: null,
      detectedLibrary: libMatch ? libMatch[1].trim() : null,
      structured: false,
    };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

module.exports = { hasGrok, getApiUrl, getDefaultModel, grokChat, search };
