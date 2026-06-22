---
name: improve-codebase-architecture
description: Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through whichever one you pick.
disable-model-invocation: true
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

This command is _informed_ by the project's domain model and built on a shared design vocabulary:

- Run the `/codebase-design` skill for the architecture vocabulary (**module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**) and its principles (the deletion test, "the interface is the test surface", "one adapter = hypothetical seam, two = real"). Use these terms exactly in every suggestion — don't drift into "component," "service," "API," or "boundary."
- The domain language in `CONTEXT.md` gives names to good seams; ADRs in `docs/adr/` record decisions this command should not re-litigate.

## Process

### 1. Explore

Read the project's domain glossary (`CONTEXT.md`) and any ADRs in the area you're touching first.

Then use the Agent tool with `subagent_type=Explore` to walk the codebase. Don't follow rigid heuristics — explore organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.

### 2. 以 HTML 报告形式呈现候选方案

将自包含 HTML 文件写入系统临时目录，不污染代码仓库。解析临时目录路径：`$TMPDIR`，回退到 `/tmp`（Windows 为 `%TEMP%`），写入 `<tmpdir>/architecture-review-<timestamp>.html`。为用户打开它 —— Linux 用 `xdg-open <path>`，macOS 用 `open <path>`，Windows 用 `start <path>` —— 并告知绝对路径。

报告使用 **Tailwind CDN** 进行布局和样式，**Mermaid CDN** 处理图形化图表。混合使用 Mermaid 和手写 CSS/SVG —— 当关系是图形化的（调用图、依赖图、序列图）用 Mermaid，当需要更具表现力的可视化（质量图、横截面图、坍缩动画）用手写 div/SVG。每个候选方案都有**改造前/改造后可视化**。

每个候选方案渲染一个卡片，包含：

- **涉及文件** — 哪些文件/模块受影响
- **问题分析** — 为什么当前架构造成摩擦
- **解决方案** — 白话描述改变什么
- **收益** — 用局部性和杠杆解释，以及测试如何改善
- **改造前/改造后图** — 并排手绘，展示浅模块如何变深
- **推荐强度** — `强烈推荐`、`值得探索`、`待定`，以标签形式呈现

报告以**最终建议**部分结束：先做哪个候选方案，为什么。

**使用 CONTEXT.md 中的领域术语，以及 `/codebase-design` 中的架构术语。** 如果 `CONTEXT.md` 定义了"订单"，就说"订单处理模块"——不是"FooBarHandler"，也不是"订单服务"。

**ADR 冲突**：如果候选方案与现有 ADR 矛盾，仅在摩擦足够大值得重新审视时才标出。在卡片中明确标记（如黄色告知框：_"与 ADR-0007 矛盾——但值得重新讨论，因为…"_）。不要列出 ADR 禁止的每个理论重构。

详见 [HTML-REPORT.md](HTML-REPORT.md) 的完整 HTML 模板、图表模式和样式指导。

此时不要提出接口设计。文件写入后，问用户："你想探索哪个候选方案？"

### 3. 质询循环

用户选择候选方案后，运行 `/grilling` 技能与其一起探索设计树——约束、依赖、深模块的形状、seam 背后是什么、哪些测试保留。

随着决策具体化，副作用内联发生——运行 `/domain-modeling` 技能保持领域模型最新：

- **为深模块命名时用的概念不在 `CONTEXT.md` 中？** 将术语添加到 `CONTEXT.md`。懒创建文件（如果不存在）。
- **对话中锐化了模糊术语？** 立即更新 `CONTEXT.md`。
- **用户以重要理由拒绝候选方案？** 提供 ADR，框架为：_"要我记录为 ADR 吗？这样未来的架构审查不会重新建议它？"_ 仅在理由确实需要未来的探索者知道时才提供——跳过临时理由（"现在不值得"）和自明理由。
- **想为深模块探索替代接口？** 运行 `/codebase-design` 技能，使用其设计两次并行子代理模式。
