# AI Skills

个人 AI agent 技能合集，适用于 Claude Code、Cursor、Codex、Pi 等编码 agent。

## 技能列表

| 技能 | 说明 | 运行环境 |
|:---|:---|:---:|
| [x-search](./x-search/) | 轻量实时搜索，支持 Grok → Tavily → Context7 多提供商自动切换 | Node.js |

## 安装

```bash
# 以 x-search 为例
cp -r x-search ~/.agents/skills/x-search
cd ~/.agents/skills/x-search
cp .env.example .env   # 编辑配置
```

## 使用

agent 会自动发现技能，读取 `SKILL.md` 获取使用说明。
