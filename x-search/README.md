# x-search

Node.js 实时搜索 skill：Grok 主搜索，Tavily 兜底，Context7 补充库文档。

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
node .\scripts\x_search_cli.js fetch "https://example.com"
node .\scripts\x_search_cli.js map "https://docs.example.com"
node .\scripts\x_search_cli.js cache 7
node .\scripts\x_search_cli.js cache off
```

详细参数见 `SKILL.md` 或运行 `node .\scripts\x_search_cli.js doc`。
