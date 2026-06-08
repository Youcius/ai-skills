---
name: x-search
description: 轻量实时搜索 skill。适合查最新信息、版本变化、报错方案、官方文档、对比分析、单页抓取、站点结构浏览。用户一旦提到"搜一下 / 查一下 / 最新 / 官方文档 / 报错怎么解决 / 对比一下 / 看这个网页内容 / 看这个站有哪些页面"，就该优先用它。
version: 3.0.0
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

## 概览

`x-search` 是一个轻量版搜索 skill，支持多搜索提供商自动切换：

- **Grok** — 主力搜索（端点已内置联网能力）
- **Tavily** — 兜底搜索（Grok 不可用时自动切换）
- **Context7** — 按需库文档查询（Grok 识别到库/框架问题时自动调用）
- 不用 MCP 常驻进程
- 按需运行
- 支持 `search / fetch / map / sources / config / docs`

## 架构

```
scripts/
├── x_search_cli.js         # 入口 + CLI 路由
├── providers/
│   ├── grok.js             # Grok 搜索（主力）
│   ├── tavily.js           # Tavily 搜索（兜底）
│   └── context7.js         # Context7 文档搜索（按需）
└── utils/
    ├── fetch.js            # HTTP 请求工具
    ├── cache.js            # 会话缓存
    └── format.js           # 统一输出格式
```

### 处理流程

```
用户输入
    │
    ▼
① Grok 搜索（内置联网）
   ├─ 成功 → 统一格式输出（结论 + 要点 + 来源）
   │        同时检测是否涉及库 → 调 Context7 补充文档
   │
   └─ 失败/无 Key → Tavily 兜底
       └─ Grok 规划子查询 → Tavily 搜索 → Grok 汇总
```

## 触发

出现下面这些场景就用：

1. 查**最新信息**、新闻、发布、变更
2. 查**官方文档**、版本差异、升级说明
3. 查**报错**、兼容性、社区解法
4. 做**对比**、分析、调研
5. 用户给了一个 URL，要你**读页面正文**
6. 用户要看某个 docs / 官网的**站点结构**
7. 用户问具体某个库/框架（自动调 Context7 补充文档）

## 入口

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

默认命令。优先走 Grok（内置联网），失败自动切 Tavily。

```bash
<cmd> search "Next.js 15 cache changes"
<cmd> search "React 19 和 Vue 3.5 对比" --plan auto
<cmd> search "pnpm Error: xxx" --plan force
<cmd> search "OpenAI Responses API" --max_results 8
```

参数：

- `--plan off|auto|force`：是否拆子问题（仅 Tavily 兜底时有效）
- `--max_results N`：每子查询最大结果数
- `--max_queries N`：最大子查询数
- `--model MODEL`：指定 Grok 模型

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

需要 Tavily API Key。

### 4. `sources`

查看上一次搜索缓存下来的来源：

```bash
<cmd> sources <session_id>
```

### 5. `config`

检查配置、连通性、当前模型。会测试所有配置的提供商是否可用。

```bash
<cmd> config
```

### 6. `model`

查看或切换模型：

```bash
<cmd> model          # 显示当前模型
<cmd> model grok-4  # 切换模型
```

## 配置

配置详见 `.env.example` 文件。

## 输出格式

统一输出：**结论 → 要点 → 来源**

如果涉及库文档，会在末尾追加 `📚 库文档参考` 区块。

## 回退规则

- **Grok 失败** → 自动切 Tavily，Grok 仍用于规划子查询和汇总答案
- **Tavily 失败** → 提示错误
- **Context7 失败** → 静默忽略（不影响主搜索结果）
- **fetch 失败** → 退回普通网页抓取
- **map 失败** → 提示站点结构获取失败
