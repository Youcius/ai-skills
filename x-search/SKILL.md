---
name: x-search
description: 实时搜索 skill。适合查最新信息、版本变化、报错方案、官方文档、对比分析、单页抓取、站点结构浏览。用户一旦提到“搜一下 / 查一下 / 最新 / 官方文档 / 报错怎么解决 / 对比一下 / 看这个网页内容 / 看这个站有哪些页面”，就该优先用它。
version: 3.1.0
authors:
  - Youcius
credentials:
  - name: GROK_API_KEY
    required: false
    description: Grok API Key。未配置时会退化为 Tavily 搜索。
    storage: ".env file or environment variable"
  - name: TAVILY_API_KEY
    required: false
    description: Tavily API Key。Grok 不可用时的兜底搜索。
    storage: ".env file or environment variable"
---

## 什么时候用

用户需要以下任一能力时，调用本 skill：

1. 查最新信息、新闻、发布、变更
2. 查官方文档、版本差异、升级说明
3. 查报错、兼容性、社区解法
4. 做对比、分析、调研
5. 用户给了 URL，需要读取页面正文
6. 用户要看某个 docs / 官网的站点结构
7. 用户问具体库、框架、SDK、CLI、云服务的当前用法

## 调用入口

默认命令来自 `runtime.conf`：

```bash
<skill_dir>/bin/x-search.exe
```

开发调试时可用：

```bash
cargo run --quiet --manifest-path <skill_dir>/Cargo.toml --
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
<cmd> model
<cmd> model grok-4
<cmd> doc
```

## 命令选择

### `search`

默认搜索命令。用于查资料、查最新信息、查报错、做对比。

```bash
<cmd> search "Next.js 15 cache changes"
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

用户给了明确 URL，要读取正文时用。

```bash
<cmd> fetch "https://example.com/page"
```

### `map`

用户要看一个站点有哪些页面时用。

```bash
<cmd> map "https://docs.example.com" --depth 2 --limit 30
```

### `sources`

查看某次搜索缓存下来的来源。

```bash
<cmd> sources <session_id>
```

### `config`

检查 Key、模型、连通性。

```bash
<cmd> config
```

### `model`

查看或切换默认模型。

```bash
<cmd> model
<cmd> model grok-4
```

## 输出要求

默认用 Markdown。需要机器读取时用 JSON：

```bash
<cmd> search "query" --format json
```

Markdown 默认包含：

- `checked_at`：本次查询时间
- `provider`：实际使用的搜索路径
- `provider_status`：Grok / Tavily / Context7 成功或失败原因
- `session_id`：可用 `sources <session_id>` 回看来源
- `来源`：固定编号 `[1] [2] ...`
- 缓存只保留 24 小时，过期会自动清理

## 回退规则

- Grok 不可用时，自动切 Tavily
- Tavily 不可用时，提示配置错误
- Context7 失败不影响主搜索，只在 `provider_status` 显示原因
- `fetch` 优先 Tavily 抽取，失败后退回普通网页抓取
- `map` 需要 Tavily API Key
