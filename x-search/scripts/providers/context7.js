'use strict';

const { requestJson } = require('../utils/fetch');

// Context7 API base (no trailing slash)
const CONTEXT7_API_URL = (process.env.CONTEXT7_API_URL || 'https://context7.com/api/v2').replace(/\/+$/, '');

function hasContext7() {
  // Context7 public API doesn't require a key for basic usage
  return true;
}

/**
 * Search for libraries by name.
 */
async function searchLibraries(query, libraryName) {
  try {
    const data = await requestJson(
      `${CONTEXT7_API_URL}/libs/search?libraryName=${encodeURIComponent(libraryName)}&query=${encodeURIComponent(query)}&fast=true`,
      { timeout: 15000 }
    );
    return Array.isArray(data.results) ? data.results : [];
  } catch {
    return [];
  }
}

/**
 * Get documentation context for a library.
 * API returns { codeSnippets: [...], infoSnippets: [...] }
 */
async function getDocs(query, libraryId) {
  try {
    const url = `${CONTEXT7_API_URL}/context?query=${encodeURIComponent(query)}&libraryId=${encodeURIComponent(libraryId)}&type=json`;
    const data = await requestJson(url, { timeout: 15000 });
    const snippets = [];
    if (Array.isArray(data.codeSnippets)) {
      data.codeSnippets.forEach(function(s) {
        snippets.push({
          title: s.pageTitle || s.codeTitle || 'Code Example',
          content: (s.codeDescription || '') + '\n```' + (s.codeLanguage || '') + '\n' + (Array.isArray(s.codeList) ? s.codeList.map(function(c) { return c.code; }).join('\n') : '') + '\n```',
          source: s.codeId || '',
        });
      });
    }
    if (Array.isArray(data.infoSnippets)) {
      data.infoSnippets.forEach(function(s) {
        snippets.push({
          title: s.pageTitle || s.infoTitle || 'Info',
          content: s.content || '',
          source: s.source || '',
        });
      });
    }
    return snippets;
  } catch {
    return [];
  }
}

/**
 * Search library documentation for a query.
 * Returns docs snippets or null if no library matched.
 */
async function searchDocs(query, libraryName) {
  if (!libraryName) return { found: false, docs: [] };

  // First search for the library
  const libraries = await searchLibraries(query, libraryName);
  if (!libraries.length) return { found: false, docs: [] };

  // Get docs from the top matching library
  const lib = libraries[0];
  const docs = await getDocs(query, lib.id);

  return {
    found: docs.length > 0,
    library: lib,
    docs: docs.slice(0, 5), // Top 5 snippets
  };
}

/**
 * Format Context7 results for display.
 */
function formatDocsResult(result) {
  if (!result.found || !result.docs.length) return '';
  const lines = [];
  lines.push(`\n### 📚 库文档参考 (${result.library.title})\n`);
  result.docs.forEach((doc, i) => {
    lines.push(`**${i + 1}. ${doc.title}**`);
    // Clean content - keep first 300 chars
    const content = (doc.content || '').replace(/\s+/g, ' ').trim();
    lines.push(`   ${content.slice(0, 300)}...`);
    if (doc.source) lines.push(`   来源: \`${doc.source}\``);
    lines.push('');
  });
  return lines.join('\n');
}

module.exports = { hasContext7, searchLibraries, getDocs, searchDocs, formatDocsResult };
