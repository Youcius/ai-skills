# x-search

实时搜索 skill。Grok 主力 → Tavily 兜底 → Context7 按需补充库文档。

## 依赖

- Node.js 18+
- API Key：Grok 和/或 Tavily（至少一个）

## 安装

```bash
cp -r x-search ~/.agents/skills/x-search
cd ~/.agents/skills/x-search
cp .env.example .env   # 填入你的 API Key
```

## 快速开始

```bash
node scripts/x_search_cli.js config          # 检查配置
node scripts/x_search_cli.js search "xxx"    # 搜索
node scripts/x_search_cli.js doc             # 查看全部命令
```

详细说明见 `SKILL.md`。
