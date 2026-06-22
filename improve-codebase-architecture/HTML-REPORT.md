# HTML 报告格式

架构审查报告以单个自包含 HTML 文件形式生成在系统临时目录中。使用 Tailwind 和 Mermaid CDN。Mermaid 处理图形化图表（流程图、依赖关系图），手写 div 和内联 SVG 处理更具表现力的可视化（质量图、横截面图）。混合使用两种方式。

## 报告模板

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>架构审查报告 — {{repo name}}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
  
  <script>
    mermaid.initialize({ 
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        primaryColor: '#161e28',
        primaryTextColor: '#e6edf3',
        primaryBorderColor: '#00ff9d',
        lineColor: '#00ff9d',
        secondaryColor: '#1e2832',
        tertiaryColor: '#111820',
        fontFamily: 'Space Grotesk, sans-serif',
        fontSize: '12px'
      },
      flowchart: { curve: 'basis', padding: 20, nodeSpacing: 60, rankSpacing: 70 }
    });
  </script>
  
  <style>
    :root {
      --bg-void: #0a0f16;
      --bg-deep: #111820;
      --bg-surface: #161e28;
      --bg-elevated: #1e2832;
      --bg-card: rgba(22, 30, 40, 0.95);
      --border-faint: rgba(0, 255, 157, 0.08);
      --border-normal: rgba(0, 255, 157, 0.15);
      --border-bright: rgba(0, 255, 157, 0.3);
      --neon-green: #00ff9d;
      --neon-green-dim: rgba(0, 255, 157, 0.4);
      --neon-green-glow: rgba(0, 255, 157, 0.15);
      --text-primary: #e6edf3;
      --text-secondary: #8b949e;
      --text-muted: #484f58;
      --danger: #f85149;
      --warning: #d29922;
      --success: #3fb950;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body { 
      background: var(--bg-void); 
      color: var(--text-primary); 
      font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
      line-height: 1.7;
      min-height: 100vh;
    }

    /* 星空背景 */
    body::before {
      content: '';
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background: 
        radial-gradient(ellipse at 20% 30%, rgba(0, 255, 157, 0.03) 0%, transparent 50%),
        radial-gradient(ellipse at 80% 70%, rgba(0, 150, 255, 0.02) 0%, transparent 50%),
        radial-gradient(1px 1px at 20% 30%, rgba(255,255,255,0.15) 0%, transparent 100%),
        radial-gradient(1px 1px at 40% 70%, rgba(255,255,255,0.1) 0%, transparent 100%),
        radial-gradient(1px 1px at 60% 20%, rgba(255,255,255,0.12) 0%, transparent 100%),
        radial-gradient(1px 1px at 80% 50%, rgba(255,255,255,0.08) 0%, transparent 100%);
      pointer-events: none;
      z-index: 0;
    }

    /* 卡片系统 */
    .card { 
      background: var(--bg-card); 
      border: 1px solid var(--border-faint); 
      border-radius: 4px;
      position: relative;
      overflow: hidden;
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--neon-green), transparent);
      opacity: 0;
      transition: opacity 0.4s ease;
    }
    .card:hover { 
      border-color: var(--border-normal);
      transform: translateY(-4px);
      box-shadow: 0 0 40px -10px var(--neon-green-glow);
    }
    .card:hover::before { opacity: 1; }

    /* 标签系统 */
    .badge { 
      display: inline-flex;
      padding: 6px 16px; 
      border-radius: 2px; 
      font-size: 11px; 
      font-weight: 600;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }
    .badge-strong { 
      background: rgba(248, 81, 73, 0.15); 
      color: #f85149; 
      border: 1px solid rgba(248, 81, 73, 0.3);
    }
    .badge-worth { 
      background: rgba(210, 153, 34, 0.15); 
      color: #d29922; 
      border: 1px solid rgba(210, 153, 34, 0.3);
    }
    .badge-speculative { 
      background: rgba(139, 148, 158, 0.1); 
      color: #8b949e; 
      border: 1px solid rgba(139, 148, 158, 0.2);
    }

    /* 指标卡片 */
    .metric { 
      background: var(--bg-surface); 
      border: 1px solid var(--border-faint); 
      border-radius: 4px;
      position: relative;
      overflow: hidden;
    }
    .metric::after {
      content: '';
      position: absolute;
      bottom: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--neon-green), transparent);
      opacity: 0.5;
    }

    /* 图表标签 */
    .diagram-label { 
      font-size: 10px; 
      color: var(--text-muted); 
      text-transform: uppercase; 
      letter-spacing: 2px; 
      margin-bottom: 16px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .diagram-label::after {
      content: '';
      flex: 1;
      height: 1px;
      background: linear-gradient(90deg, var(--border-faint), transparent);
    }

    /* 代码块 */
    .code-block { 
      background: var(--bg-surface); 
      border: 1px solid var(--border-faint); 
      border-radius: 4px; 
      padding: 16px 20px; 
      font-family: 'JetBrains Mono', monospace; 
      font-size: 12px; 
      color: var(--text-secondary); 
      overflow-x: auto;
      line-height: 1.8;
    }
    .code-block:hover {
      border-color: var(--border-normal);
      background: var(--bg-elevated);
    }

    /* Mermaid 覆盖 */
    .mermaid { background: transparent !important; padding: 10px; }
    .mermaid .node rect, .mermaid .node circle, .mermaid .node polygon { 
      fill: var(--bg-surface) !important; 
      stroke: var(--neon-green) !important;
      stroke-width: 2px;
    }
    .mermaid .edgePath .path { stroke: var(--neon-green-dim) !important; stroke-width: 2px; }
    .mermaid .edgeLabel { 
      background: var(--bg-elevated) !important; 
      color: var(--text-secondary) !important;
      font-size: 11px;
      padding: 4px 8px;
      border-radius: 3px;
      border: 1px solid var(--border-faint);
    }
    .mermaid .cluster rect { 
      fill: rgba(0, 255, 157, 0.03) !important; 
      stroke: var(--border-normal) !important;
    }
    .mermaid .label { color: var(--text-primary) !important; font-family: 'Space Grotesk', sans-serif; }
    .mermaid .marker { fill: var(--neon-green) !important; }

    /* 滚动条 */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: var(--bg-void); }
    ::-webkit-scrollbar-thumb { background: var(--border-normal); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--neon-green-dim); }

    /* 代码高亮 */
    code {
      font-family: 'JetBrains Mono', monospace;
      background: rgba(0, 255, 157, 0.1);
      color: var(--neon-green);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <div class="relative z-10 min-h-screen p-6 md:p-12 max-w-7xl mx-auto">
    <main class="space-y-8">
      <header>...</header>
      <section id="candidates" class="space-y-8">...</section>
      <section id="top-recommendation">...</section>
    </main>
  </div>
  
  <script>
    // 渲染 Mermaid 图表
    async function renderMermaid() {
      try {
        await mermaid.init(undefined, '.mermaid');
      } catch (e) {
        console.error('Mermaid init failed:', e);
        try {
          await mermaid.run({ querySelector: '.mermaid' });
        } catch (e2) {
          console.error('Mermaid run failed:', e2);
        }
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', renderMermaid);
    } else {
      renderMermaid();
    }
  </script>
</body>
</html>
```

## 报告头部

项目名称、日期、简洁图例：实线框 = 模块，虚线 = seam，红色箭头 = 泄漏，深色粗框 = 深模块。无介绍段落，直接进入候选方案。

## 候选方案卡片

图表承载主要信息。文字简洁，使用术语表中的词汇。

每个候选方案一个 `<article>`：

- **标题** — 简短，命名重构方向（如"合并订单处理管道"）
- **标签行** — 推荐强度（`强烈推荐` = 红色，`值得探索` = 黄色，`待定` = 灰色）
- **涉及文件** — 等宽字体列表，`font-mono text-sm`
- **改造前/改造后图** — 核心内容。两列并排。见下方模式
- **问题分析** — 一句话。痛点是什么
- **解决方案** — 一句话。改变什么
- **收益** — 要点列表，≤6 字。如"测试命中单一接口"、"定价逻辑不再泄漏"、"删除 4 个浅包装"
- **ADR 告知**（如适用）— 黄色背景框中一行

无段落解释。如果图表需要一段文字才能理解，重绘图表。

## 图表模式

根据候选方案选择合适的模式，混合使用。

### Mermaid 流程图（依赖/调用流的主要工具）

使用 Mermaid `flowchart` 或 `graph` 表达"X 调用 Y 调用 Z，看看这个混乱"。包裹在 Tailwind 样式卡片中。使用 classDef 将泄漏边标红，深模块标深色。序列图适合表达"改造前：6 次往返；改造后：1 次"。

```html
<div class="bg-[#111820] border border-[rgba(0,255,157,0.08)] rounded p-5">
  <pre class="mermaid">
    flowchart LR
      A[订单处理器] --> B[订单校验器]
      B --> C[订单仓库]
      C -.泄漏.-> D[定价客户端]
      classDef leak stroke:#f85149,stroke-width:2px;
      class C,D leak
  </pre>
</div>
```

### 手写方框箭头（Mermaid 布局不理想时）

模块用 `<div>` 加边框和标签。箭头用内联 SVG `<line>` 或 `<path>` 元素。适用于"改造后"图需要一个粗边框深模块，内部调用变灰的情况。

### 横截面图（适合分层浅模块）

堆叠水平条带（`h-12 border-l-4`）展示调用穿过的层级。改造前：6 个薄层各做一点事。改造后：1 个厚条带标记合并后的职责。

### 质量图（适合"接口与实现一样宽"）

每个模块两个矩形——一个表示接口面积，一个表示实现。改造前：接口矩形几乎和实现一样高（浅模块）。改造后：接口矩形短，实现矩形高（深模块）。

### 调用图坍缩

改造前：函数调用树渲染为嵌套方框。改造后：同一棵树坍缩为一个方框，内部调用变灰显示在其中。

## 样式指导

- 编辑风格，非企业仪表盘。大量留白。标题可用衬线字体（`font-serif`）
- 克制用色：一个主色（霓虹绿 `#00ff9d`）+ 红色泄漏 + 黄色警告
- 图表高度约 320px，确保改造前/改造后能舒适并排
- 模块标签用 `text-xs uppercase tracking-wider`，读起来像示意图而非 UI
- 仅使用 Tailwind CDN 和 Mermaid 脚本，报告保持静态

## 最终建议部分

一个较大的卡片。候选方案名称，一句话说明原因，锚点链接到对应卡片。

## 术语

使用中文，但保留架构术语的英文原词（module、interface、seam、adapter、leverage、locality），在中文语境中自然使用。

**必须使用：** 模块（module）、接口（interface）、实现（implementation）、深度（depth）、深模块（deep）、浅模块（shallow）、接缝（seam）、适配器（adapter）、杠杆（leverage）、局部性（locality）

**收益要点**用术语表命名收益：*"局部性：bug 集中在一个模块"*、*"杠杆：一个接口，N 个调用点"*、*"接口缩小；实现吸收包装"*。不要写*"更容易维护"*或*"更清晰的代码"*。

无 hedging，无铺垫，无"值得注意的是…"。如果一句话可以变成要点，变成要点。如果一个要点可以删除，删除它。
