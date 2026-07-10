---
name: x-search
description: 实时搜索与网页读取 skill。用于需求调研、方案设计、漏洞修复、架构升级、报错排查、官方文档查阅、新技术学习、最新新闻/版本/趋势查询、URL 正文提取、docs/官网站点结构浏览；自动识别时效查询，支持 Grok/Tavily/Context7、来源规范化、HTTP 重试与安全限制，缓存可配置或关闭。
version: 3.2.1
authors:
  - Youcius
credentials:
  - name: GROK_API_KEY
    required: false
    description: Grok API Key。未配置或不可用时会退化为 Tavily 搜索。
    storage: ".env file or environment variable"
  - name: TAVILY_API_KEY
    required: false
    description: Tavily API Key。Grok 不可用时的兜底搜索。
    storage: ".env file or environment variable"
---

## 什么时候用

用户需要联网搜索、实时信息查询，或出现下面任一场景时，调用本 skill：

1. **需求调研**：竞品分析、行业实践、技术选型对比
2. **方案设计**：最佳实现方式、开源方案对比、API / 架构参考
3. **漏洞修复**：安全漏洞详情、依赖安全问题、修复方案
4. **架构升级**：版本迁移指南、架构演进实践、兼容性踩坑经验
5. **报错排查**：搜索错误信息、异常日志、社区解决方案
6. **文档查阅**：官方文档、版本变更、使用说明、API 参考
7. **新技术学习**：教程、入门指南、最佳实践
8. **时效性信息**：今日新闻、最新资讯、版本发布、趋势变化
9. **页面读取**：用户给了 URL，需要读取页面正文
10. **站点结构**：用户要看某个 docs / 官网有哪些页面

## 调用入口

默认命令来自 `runtime.conf`：

```bash
node <skill_dir>/scripts/x_search_cli.js
```

## 常用命令

```bash
<cmd> search "query"
<cmd> search "query" --plan auto
<cmd> search "query" --format json
<cmd> fetch "https://example.com/page"
<cmd> map "https://docs.example.com" --depth 2 --limit 30
<cmd> sources <session_id>
<cmd> config
<cmd> model grok-4
<cmd> cache 7
<cmd> cache off
<cmd> doc
```

## 命令选择

### `search`

用于查资料、最新信息、报错和对比。含“今日、今天、最新、新闻、刚刚、本周、today、latest、news”等词时，会自动使用新闻时效模式。

```bash
<cmd> search "今日 AI 新闻"
<cmd> search "React 19 和 Vue 3.5 对比" --plan auto
<cmd> search "pnpm Error: xxx" --plan force
<cmd> search "OpenAI Responses API" --max-results 10
```

参数：

- `--plan off|auto|force`：是否拆成多个搜索问题
- `--max-results N` / `--max_results N`：每个问题最多返回多少来源
- `--max-queries N` / `--max_queries N`：最多拆成多少个搜索问题
- `--model MODEL`：指定 Grok 模型
- `--format markdown|json|compact`：输出格式

### `fetch`

读取明确 URL 的正文。默认禁止访问 localhost、私网和云元数据地址。

```bash
<cmd> fetch "https://example.com/page"
<cmd> fetch "http://127.0.0.1:3000" --allow-private
```

只有用户明确要求读取本机或内网地址时，才使用 `--allow-private`。

### `map`

查看站点页面结构，需要 Tavily API Key。

```bash
<cmd> map "https://docs.example.com" --depth 2 --limit 30
```

### `sources`

查看某次搜索缓存的来源。

```bash
<cmd> sources <session_id>
```

### `config`

真实检测 Grok、Tavily、Context7 的连通性，并显示状态、耗时和失败原因。

```bash
<cmd> config
<cmd> config --format json
```

### `model`

```bash
<cmd> model
<cmd> model grok-4
```

### `cache`

默认缓存 1 天，设置为 `off` 或 `0` 表示不缓存。

```bash
<cmd> cache
<cmd> cache 7
<cmd> cache off
```

## 输出要求

默认用 Markdown；需要机器读取时用 JSON：

```bash
<cmd> search "query" --format json
```

输出包含查询时间、实际 Provider、Provider 状态、session_id 和编号来源。来源会去除跟踪参数、合并重复 URL，并优先显示较新和高分结果。

## 回退规则

- Grok 不可用时自动切 Tavily
- Tavily 不可用时提示配置错误
- Context7 失败不影响主搜索
- `fetch` 优先 Tavily 抽取，失败后使用支持重定向、压缩和重试的普通抓取
- 缓存到期后自动清理
