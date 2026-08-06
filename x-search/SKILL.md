---
name: x-search
description: 实时搜索与网页读取 skill。让 Grok 与 Tavily 并行独立检索，并将各自的原始回答、结构化来源、状态和错误返回给 Agent；支持 Context7 文档补充、来源规范化、HTTP 重试与安全限制。用于需求调研、方案设计、漏洞修复、架构升级、报错排查、官方文档查阅、新技术学习、最新新闻/版本/趋势查询和 URL 正文提取。
version: 3.3.1
authors:
  - Youcius
credentials:
  - name: GROK_API_KEY
    required: false
    description: Grok API Key。用于独立的 Grok 搜索；未配置时只跳过 Grok，不影响 Tavily。
    storage: ".env file or environment variable"
  - name: TAVILY_API_KEY
    required: false
    description: Tavily API Key。用于独立的 Tavily 搜索；未配置时只跳过 Tavily，不影响 Grok。
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

`search` 默认进入独立 Provider 模式：Grok 和 Tavily 同时搜索，各自的回答、来源、耗时和错误会分别返回给调用 Agent。CLI 不负责把两边内容综合成最终结论。


## 常用命令

```bash
<cmd> search "query"
<cmd> search "query" --timeout-ms 30000
<cmd> search "query" --max-results 10 --format json
<cmd> fetch "https://example.com/page"
<cmd> map "https://docs.example.com" --depth 2 --limit 30
<cmd> sources <session_id>
<cmd> config
<cmd> model grok-4
<cmd> cache 7
<cmd> cache off
<cmd> doc
```

`search` 的默认结果包含独立的 `Grok` 和 `Tavily` 两个结果块。需要机器读取时使用 `--format json`，Agent 应从 `provider_results.grok` 和 `provider_results.tavily` 分别读取内容。


## 命令选择

### `search`

用于查资料、最新信息、报错和对比。Grok 与 Tavily 会并行执行，彼此不互相兜底、不共享规划结果，也不在 CLI 内综合答案。

```bash
<cmd> search "今日 AI 新闻"
<cmd> search "React 19 和 Vue 3.5 对比" --max-results 10
<cmd> search "OpenAI Responses API" --timeout-ms 30000
```

参数：

- `--max-results N` / `--max_results N`：Tavily 最多返回多少个来源
- `--timeout-ms N` / `--timeout_ms N`：应用于单次请求，范围为 1000-120000，默认 30000；Grok 和 Tavily 都在 CLI 内最多重试 2 次（指数退避），各自独立，互不阻塞
- `--model MODEL`：指定 Grok 模型
- `--format markdown|json|compact`：输出格式

Tavily 结果块包含 `answer` 字段——Tavily AI 根据搜索结果生成的直接回答摘要（`include_answer=advanced`），可作为综合起点，但应以结构化 sources 为核验依据。

`--plan` 和 `--max-queries` 仍被解析以兼容旧命令，但 independent mode 不再调用 Grok 为 Tavily 规划查询；两个 Provider 默认都收到同一个原始查询。

### `fetch`

读取明确 URL 的正文。需要 `TAVILY_API_KEY`：页面由 Tavily 抓取并转为 markdown 返回。默认会先阻止 localhost、私网、常见 IANA 特殊地址和云元数据地址——私网地址一律阻断，不会发送给 Tavily。

```bash
<cmd> fetch "https://example.com/page"
```

本 skill 不再支持本机/内网地址的抓取；需要读取本机或内网资源时请使用其他工具。

### `map`

查看站点页面结构，需要 Tavily API Key。

```bash
<cmd> map "https://docs.example.com" --depth 2 --limit 30
```

### `sources`

查看某次搜索缓存的完整独立 Provider 结果。v3 的 JSON 输出会保留 `provider_results`，包括 Grok 原始回答、Tavily 结构化来源和各自状态；不会降级为一份合并来源列表。

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

缓存按**查询内容**命中：相同 query 在 TTL 内直接复用结果，不重复调用 API。默认缓存 1 天，设置为 `off` 或 `0` 表示不缓存；时效性查询（新闻/最新，命中 freshness 检测）缓存上限为 1 小时，避免旧闻命中。缓存文件物理保留最长 30 天。

```bash
<cmd> cache
<cmd> cache 7
<cmd> cache off
```

## Agent 处理原则

`search` 不生成最终综合结论。调用 Agent 应按以下方式处理结果：

1. 先读取 `provider_status`，区分成功、失败和未配置的 Provider。
2. 分别读取 `provider_results.grok` 和 `provider_results.tavily`，不要把一个 Provider 的失败当成整个搜索失败。
3. 把 Tavily 的结构化来源作为可核验来源；Grok 的 `answer` 是独立 Provider 的原始回答，`sources` 是 Grok JSON 返回的结构化候选来源（`{title, url, date}`），未经 CLI 独立核验，不能自动视为已验证证据；若 Grok 未按 JSON 返回，`sources` 会退化为从回答中正则提取的 URL。
4. 比较两边结论、日期和来源；有冲突时明确列出冲突，不要静默选择一边。
5. 最终回答中保留来源、检查时间和不确定性。

`provider_results.context7`（如果存在）是独立的库文档补充，不参与 Grok/Tavily 的综合。

## 输出要求

默认用 Markdown；需要机器读取时用 JSON：

```bash
<cmd> search "query" --format json
```

JSON 会包含 `schema_version: x-search.session.v3`、查询时间、Provider 状态以及按 Provider 分开的结果。CLI 会刻意省略顶层 `answer`，表示它不替 Agent 做最终综合；兼容用途的顶层 `sources` 可能包含去重后的合并来源，但 Agent 应优先使用 `provider_results`。


## 回退规则

- Grok 和 Tavily 默认并行执行，不采用“Grok 成功就不调用 Tavily”的串行回退。
- 单个 Provider 超时、限流、网络错误或返回空结果时，只标记该 Provider 失败，保留另一个 Provider 的结果；Grok 和 Tavily 都在 CLI 内重试最多 2 次（指数退避），重试各自独立、并行进行，不互相阻塞。
- 两个已配置 Provider 都失败时，返回各自的错误和耗时，供 Agent 决定是否重试或更换查询。
- Tavily 搜索不再依赖 Grok 的查询规划；Grok 不可用时，Tavily 仍然独立执行原始查询。
- Context7 失败不影响 Grok/Tavily 主搜索。
- `fetch` 仅使用 Tavily 抽取；私网地址一律阻断，不发送给 Tavily。
- 缓存到期后自动清理。
