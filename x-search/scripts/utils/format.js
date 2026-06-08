'use strict';

/**
 * Deduplicate sources by URL.
 */
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

/**
 * Build a source context string for Grok synthesis.
 */
function buildSourceContext(sources) {
  return sources
    .map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\nSnippet: ${s.content || '(none)'}`)
    .join('\n\n');
}

/**
 * Format source list as Markdown.
 */
function formatSourceList(sources) {
  if (!sources.length) return '未找到来源';
  return sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n');
}

/**
 * Print unified search output.
 * Format: 结论 + 要点 + 来源
 */
function printUnifiedResult(query, provider, answer, sources, sessionId) {
  console.log(`## 搜索结果\n`);
  console.log(`- 查询: ${query}`);
  console.log(`- 搜索来源: ${provider}`);
  console.log(`- 结果数: ${sources.length}`);
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

module.exports = { dedupeSources, buildSourceContext, formatSourceList, printUnifiedResult };
