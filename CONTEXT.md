# Context — ai-skills / x-search

## 术语表

### 搜索提供商 (Search Provider)

| 术语 | 含义 | 优先级 |
|:---|:---|:---:|
| **Grok Search** | Grok API 调用（中转端点内置联网搜索，无需显式传 tools 参数）。不用 `web_search` 工具。 | 1 (主力) |
| **Tavily Search** | 通过 Tavily API 实现的通用搜索。Grok 失败时的兜底。 | 2 (兜底) |
| **Context7** | 通过 Context7 API 实现的库/框架文档搜索。由 Grok 识别用户是否在问库相关问题时，按需调用。 | 按需 |

### API Key 场景

| 场景 | Grok Key | Tavily Key | Context7 Key | 行为 |
|:---|:---:|:---:|:---:|:---|
| 全配 | ✅ | ✅ | ✅ | Grok 主力 → Tavily 兜底 → Context7 按需 |
| 仅 Grok | ✅ | ❌ | ❌ | 纯 Grok 搜索 |
| 仅 Grok+Tavily | ✅ | ✅ | ❌ | Grok 主力 → Tavily 兜底 |
| 仅 Tavily | ❌ | ✅ | ❌ | 纯 Tavily 搜索（当前行为） |
| 全无 | ❌ | ❌ | ❌ | 提示配置，优雅退出 |

### 处理流程

```
用户输入
    │
    ▼
① Grok 搜索（内置联网，prompt 含 LIBRARY 标注指令）
   ├─ 成功 → 解析 LIBRARY: xxx，剥离标记后输出
   │         └─ 有库名？→ 调 Context7 补充文档
   │
   └─ 失败/无 Key → Tavily 兜底 → 统一格式输出
       └─ Grok Key 存在？→ 单独 detectLibrary → Context7
```

### 库检测策略

- Grok 搜索成功的路径：**在搜索 prompt 里嵌入 LIBRARY 标注指令**，一次调用完成搜索+库识别
- Tavily 兜底路径：Grok Key 存在时单独调 detectLibrary

### 架构设计

- **多文件拆分**: `providers/grok.js`, `providers/tavily.js`, `providers/context7.js`
- **输出统一**: 无论哪个提供商，最终输出 = 结论 + 要点 + 来源
- **运行时检测**: Grok 调用失败自动切 Tavily，无需用户配置

### 命令

| 命令 | 说明 |
|:---|:---|
| **search** | 通用搜索。Grok 主力 → Tavily 兜底。 |
| **docs** | 库文档查询。调 Context7。 |
| **fetch** | 页面内容提取。 |
| **map** | 站点结构浏览。 |
| **config** | 检查配置和连通性。 |

### 架构决策记录

- **ADR-001**: 多文件拆分结构。`providers/` 目录按搜索商隔离，入口只做 CLI 路由。
- **ADR-002**: Grok 不需要显式传 `tools`。中转端点已内置联网，传了反而不兼容。
- **ADR-003**: Context7 由 Grok 识别触发。不单独维护库名列表，减少维护成本。
- **ADR-004**: Context7 API 端点为 `https://context7.com/api/v2`。`/libs/search` 搜索库，`/context` 获取文档（返回 `{codeSnippets, infoSnippets}` 结构）。
- **ADR-005**: 库检测嵌入搜索 prompt。Grok 搜索时通过 `LIBRARY: xxx` 标注，一次调用完成搜索+识别，避免额外 API 调用。
