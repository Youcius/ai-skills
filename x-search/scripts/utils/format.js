'use strict';

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'dclid', 'msclkid']);

function normalizeSourceUrl(value) {
  const raw = String(value || '').trim().replace(/[.,;:)\]）]+$/, '');
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return raw;

    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey.startsWith('utm_') || TRACKING_PARAMS.has(normalizedKey)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();

    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}${url.search}`;
  } catch {
    return raw;
  }
}

function rankDate(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function rankScore(value) {
  if (value === undefined || value === null || value === '') return Number.NEGATIVE_INFINITY;
  const score = Number(value);
  return Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY;
}

function dedupeSources(results) {
  const ranked = results.map((item, index) => {
    const url = normalizeSourceUrl(item.url || item.link);
    return {
      index,
      date: rankDate(item.published_date),
      score: rankScore(item.score),
      source: {
        title: item.title || 'Untitled',
        url,
        content: String(item.content || item.snippet || '').trim(),
        score: item.score,
        query: item.query,
        published_date: item.published_date,
      },
    };
  }).filter((item) => item.source.url);

  ranked.sort((a, b) => {
    if (a.date !== b.date) return b.date - a.date;
    if (a.score !== b.score) return b.score - a.score;
    return a.index - b.index;
  });

  const seen = new Set();
  const merged = [];
  for (const item of ranked) {
    if (seen.has(item.source.url)) continue;
    seen.add(item.source.url);
    merged.push(item.source);
  }
  return merged;
}

function sourceTable(sources) {
  if (!sources.length) return '未找到来源';
  const lines = ['| 编号 | 标题 | 日期 | 链接 |', '|---|---|---|---|'];
  sources.forEach((source, index) => lines.push(`| [${index + 1}] | ${String(source.title).replace(/\|/g, '\\|')} | ${source.published_date || '-'} | ${source.url} |`));
  return lines.join('\n');
}

function formatSourceList(sources) {
  if (!sources.length) return '未找到来源';
  return sources.map((source, index) => `${index + 1}. [${source.title}](${source.url})`).join('\n');
}

function providerEntries(session) {
  if (session.provider_results && typeof session.provider_results === 'object') {
    return Object.values(session.provider_results);
  }
  return [{
    provider: session.provider || 'Search',
    status: session.provider_status?.[0]?.ok ? 'success' : 'unknown',
    ok: Boolean(session.provider_status?.some((item) => item.ok)),
    elapsed_ms: null,
    answer: session.answer || '',
    sources: session.sources || [],
  }];
}

function printSearchResult(session, format) {
  const entries = providerEntries(session);
  if (format === 'json') return console.log(JSON.stringify(session, null, 2));
  if (format === 'compact') {
    const summary = entries
      .map((entry) => `${entry.provider}: ${entry.status}/${(entry.sources || []).length} source(s)`)
      .join(' | ');
    return console.log(`${session.session_id} | ${summary}`);
  }

  console.log('# x-search\n');
  console.log(`- 查询: ${session.query}`);
  console.log(`- checked_at: ${session.checked_at}`);
  console.log('- mode: independent provider results');
  console.log(`- session_id: ${session.session_id}\n`);
  console.log('## Provider 状态\n');
  (session.provider_status || []).forEach((status) => {
    console.log(`- ${status.name}: ${status.ok ? '✅' : '❌'}${status.detail ? ` — ${status.detail}` : ''}`);
  });

  entries.forEach((entry) => {
    console.log(`\n## ${entry.provider} 原始结果\n`);
    console.log(`- status: ${entry.status || (entry.ok ? 'success' : 'failed')}`);
    if (entry.elapsed_ms !== null && entry.elapsed_ms !== undefined) {
      console.log(`- elapsed_ms: ${entry.elapsed_ms}`);
    }
    if (entry.detail) console.log(`- detail: ${entry.detail}`);
    if (entry.source_note) console.log(`- source_note: ${entry.source_note}`);
    if (entry.queries?.length) console.log(`- queries: ${entry.queries.join(' | ')}`);
    if (entry.answer) {
      console.log(`\n### ${entry.provider} response\n\n${entry.answer}\n`);
    }
    if (Array.isArray(entry.sources)) {
      console.log('### Sources\n');
      console.log(sourceTable(entry.sources));
    }
  });
}

function printSources(session, format) {
  if (session.provider_results && typeof session.provider_results === 'object') {
    if (format === 'json') return console.log(JSON.stringify(session, null, 2));
    if (format === 'compact') {
      const summary = providerEntries(session)
        .map((entry) => `${entry.provider}: ${entry.status}/${(entry.sources || []).length} source(s)`)
        .join(' | ');
      return console.log(`${session.session_id} | ${summary}`);
    }
    console.log(`# Cached independent results for ${session.session_id}\n`);
    console.log(`- Query: ${session.query}`);
    console.log(`- checked_at: ${session.checked_at || '-'}\n`);
    providerEntries(session).forEach((entry) => {
      console.log(`## ${entry.provider}\n`);
      if (entry.answer) console.log(`${entry.answer}\n`);
      if (Array.isArray(entry.sources)) console.log(`${sourceTable(entry.sources)}\n`);
    });
    return;
  }

  if (format === 'json') return console.log(JSON.stringify(session.sources || [], null, 2));
  if (format === 'compact') return console.log(`${(session.sources || []).length} source(s)`);
  console.log(`# Sources for ${session.session_id}\n`);
  console.log(`- Query: ${session.query}`);
  console.log(`- Provider: ${session.provider}`);
  console.log(`- checked_at: ${session.checked_at || session.created_at || '-'}\n`);
  console.log(sourceTable(session.sources || []));
}

module.exports = { dedupeSources, normalizeSourceUrl, formatSourceList, printSearchResult, printSources };
