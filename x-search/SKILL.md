---
name: x-search
description: 轻量实时搜索 skill。适合查最新信息、版本变化、报错方案、官方文档、对比分析、单页抓取、站点结构浏览。用户一旦提到“搜一下 / 查一下 / 最新 / 官方文档 / 报错怎么解决 / 对比一下 / 看这个网页内容 / 看这个站有哪些页面”，就该优先用它。
version: 2.0.0
authors:
  - Youcius
credentials:
  - name: GROK_API_KEY
    required: false
    description: 用于答案整合。未配置时会退化为仅返回搜索结果摘要。
    storage: ".env file or environment variable"
  - name: TAVILY_API_KEY
    required: true
    description: 用于实时搜索、抽取页面、站点 map。
    storage: ".env file or environment variable"
---

## 概览

`x-search` 是一个轻量版搜索 skill：

- **不用 MCP 常驻进程**
- **按需运行**
- **尽量保留 MCP 的效果**
  - 简单问题直接搜
  - 复杂问题自动拆子问题
  - 汇总多来源
  - 支持 `search / fetch / map / sources / config`

推荐直接调用 `runtime.conf` 里的命令。不要每次先读全文档。

## 触发

出现下面这些场景就用：

1. 查**最新信息**、新闻、发布、变更
2. 查**官方文档**、版本差异、升级说明
3. 查**报错**、兼容性、社区解法
4. 做**对比**、分析、调研
5. 用户给了一个 URL，要你**读页面正文**
6. 用户要看某个 docs / 官网的**站点结构**

## 入口

优先用：

```bash
<cmd> search "query"
<cmd> search "query" --plan auto
<cmd> fetch "https://example.com/page"
<cmd> map "https://docs.example.com"
<cmd> sources <session_id>
<cmd> config
```

其中 `<cmd>` 来自 `runtime.conf`，通常是：

```bash
node <skill_dir>/scripts/x_search_cli.js
```

## 怎么选命令

### 1. `search`

默认命令。适合：

- 查最新
- 查官方文档
- 查报错
- 查对比
- 查调研结论

常用写法：

```bash
<cmd> search "Next.js 15 cache changes"
<cmd> search "React 19 和 Vue 3.5 对比" --plan auto
<cmd> search "pnpm Error: xxx" --plan force
<cmd> search "OpenAI Responses API tools" --max_results 8
```

参数：

- `--plan off|auto|force`
  - `off`：直接搜
  - `auto`：自动判断
  - `force`：先拆子问题再搜
- `--max_results N`
- `--max_queries N`
- `--model MODEL`

### 2. `fetch`

用户给了明确链接，要看正文时用：

```bash
<cmd> fetch "https://example.com/page"
```

优先走 Tavily 抽取；失败再退回普通抓取。

### 3. `map`

要看一个站点大致有哪些页面时用：

```bash
<cmd> map "https://docs.example.com" --depth 2 --limit 30
```

### 4. `sources`

查看上一次搜索缓存下来的来源：

```bash
<cmd> sources <session_id>
```

### 5. `config`

检查配置、连通性、当前模型。

## 搜索规则

### 简单问题

直接搜 1 次：

- “React 19 什么时候发布的”
- “OpenAI Responses API 官方文档”

### 中等问题

拆成 2~3 个子问题再汇总：

- “React 19 和 Vue 3.5 的近况对比”
- “这个报错现在主流解决方案是什么”

### 复杂问题

先拆问题，再按需补 `fetch` 或 `map`：

- “对比 A 和 B 在 2026 年的能力、生态、迁移成本”
- “读完这个 docs 站后总结接入方案”

## 输出要求

默认按这个顺序组织：

1. **结论**
2. **要点**
3. **来源**

如果是时效信息，要尽量带**具体日期**。  
如果来源不足、答案不稳，要直接说。

## 回退规则

- Tavily 不通：明确告诉用户实时搜索不可用
- Grok 不通：继续返回搜索结果和来源，但不做 AI 汇总
- `fetch` 失败：退回普通网页抓取
- `map` 失败：提示站点结构获取失败

## 仓库分发

这个 skill 适合放在：

```text
ai-skills/
└─ x-search/
```

用户下载后，把整个 `x-search` 目录复制到：

```text
~/.agents/skills/x-search
```

即可使用。
