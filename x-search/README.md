# x-search

Node.js 实时搜索 skill：Grok 与 Tavily 并行独立搜索，Context7 补充库文档，最终由调用 Agent 比较和综合各 Provider 的结果。

## 要求

- Node.js 18+
- 配置 Grok 或 Tavily API Key（至少一个）
- 无需 `npm install`

## 配置

```powershell
Copy-Item .env.example .env
```

在 `.env` 中填写 Key。

## 常用命令

```powershell
node .\scripts\x_search_cli.js config
node .\scripts\x_search_cli.js search "今日 AI 新闻"
node .\scripts\x_search_cli.js search "React 19 和 Vue 3.5 对比" --timeout-ms 30000
node .\scripts\x_search_cli.js search "OpenAI Responses API" --format json
node .\scripts\x_search_cli.js fetch "https://example.com"
node .\scripts\x_search_cli.js map "https://docs.example.com"
node .\scripts\x_search_cli.js cache 7
node .\scripts\x_search_cli.js cache off
```

详细参数见 `SKILL.md` 或运行 `node .\scripts\x_search_cli.js doc`。`fetch` 需要配置 `TAVILY_API_KEY`（页面由 Tavily 抓取并转为 markdown）。

## 验证

```powershell
node --test .\tests\fetch.test.js
```
