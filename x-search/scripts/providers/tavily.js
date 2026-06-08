'use strict';

const { requestJson } = require('../utils/fetch');

const TAVILY_API_URL = process.env.TAVILY_API_URL || 'https://api.tavily.com';
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';

function hasTavily() {
  return Boolean(TAVILY_API_KEY);
}

function getApiUrl() {
  return TAVILY_API_URL;
}

/**
 * Search via Tavily API.
 */
async function search(query, maxResults) {
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

/**
 * Extract page content via Tavily.
 */
async function extract(url) {
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

/**
 * Map site structure via Tavily.
 */
async function siteMap(url, options) {
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
  if (Array.isArray(data.links)) return data.links.map(item => ({ url: item }));
  return [];
}

module.exports = { hasTavily, getApiUrl, search, extract, siteMap };
