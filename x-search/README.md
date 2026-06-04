# x-search

轻量版实时搜索 skill，适合放进：

```text
ai-skills/
└─ x-search/
```

下载后，把整个目录复制到：

```text
~/.agents/skills/x-search
```

## 依赖

- Node.js 18+
- Tavily API Key
- Grok API Key 可选

## 配置

复制一份：

```text
.env.example -> .env
runtime.conf.example -> runtime.conf
```

然后填 `.env`：

```text
GROK_API_URL=https://your-grok-api.example.com/v1
GROK_API_KEY=your_grok_key
GROK_MODEL=grok-4.20-fast
TAVILY_API_URL=https://your-tavily-api.example.com
TAVILY_API_KEY=your_tavily_key
```

## 常用命令

```bash
node scripts/x_search_cli.js search "Next.js 15 cache changes"
node scripts/x_search_cli.js search "React 19 和 Vue 3.5 对比" --plan auto
node scripts/x_search_cli.js fetch "https://example.com/page"
node scripts/x_search_cli.js map "https://docs.example.com" --depth 2 --limit 20
node scripts/x_search_cli.js config
```

## 安装位置

仓库里保持：

```text
ai-skills/
└─ x-search/
```

实际使用时放到：

```text
~/.agents/skills/x-search
```

Windows 例子：

```powershell
Copy-Item .\x-search $HOME\.agents\skills\ -Recurse -Force
```
