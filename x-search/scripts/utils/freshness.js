'use strict';

const FRESHNESS_RULES = [
  { pattern: /(?:今日|今天|刚刚)|\btoday\b/iu, days: 1 },
  { pattern: /本周/iu, days: 7 },
  { pattern: /(?:最新)|\blatest\b/iu, days: 3 },
  { pattern: /(?:新闻)|\bnews\b/iu, days: 7 },
];

function detectFreshness(query) {
  const text = String(query || '').trim();
  const rule = FRESHNESS_RULES.find((item) => item.pattern.test(text));
  return rule
    ? { isFresh: true, topic: 'news', days: rule.days }
    : { isFresh: false, topic: 'general' };
}

module.exports = { detectFreshness };
