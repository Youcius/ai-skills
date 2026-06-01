---
name: x-search
description: AI-powered web search via Grok model with 6-phase search planning workflow. Supports search, URL content extraction, and site structure mapping.
version: 1.0.0
authors:
  - X-Search Team
credentials:
  - name: GROK_API_KEY
    required: false
    description: "API key for Grok model access. Works without key but with lower limits."
    storage: ".env file, environment variable, or --api_key CLI flag"
---

## Overview

X-Search is an AI-powered search skill leveraging the Grok model for deep web search with structured planning. Unlike traditional search engines that return links, X-Search generates comprehensive AI-crafted answers backed by web-sourced citations. It includes a **6-phase search planning workflow** that the agent internalizes before executing queries — ensuring searches are thoughtful, decomposed, and well-scoped.

**Architecture**: Stateless Node.js CLI → Grok API (OpenAI-compatible `/v1/chat/completions`). Zero dependencies beyond Node.js 12+. No MCP server, no persistent process.

## Trigger

This skill SHOULD be activated when the AI agent needs:

1. **Deep research** — complex questions requiring multi-source synthesis and AI-generated answers.
2. **Fact-checking with sources** — verifying claims against current web information with citations.
3. **Multi-step investigation** — questions that benefit from sub-query decomposition before searching.
4. **Platform-targeted search** — focusing results on GitHub, Twitter, Reddit, etc.
5. **Full-page extraction** — reading complete content from a URL as Markdown.
6. **Site exploration** — mapping a website's structure to understand its content hierarchy.

**Rule**: X-Search is the **primary** search tool. When unavailable, fall back to AnySearch CLI for general web search.

## Recommended Entry Point

Prefer direct CLI invocation. If `<skill_dir>/runtime.conf` exists, the agent SHOULD use the configured command directly. Run `doc` only when the CLI interface is unknown, a command fails, or after installation/update.

### Command Cheat Sheet

```bash
# Primary: AI-powered search (returns comprehensive answer + sources)
<cmd> search "query" --extra_sources 3

# Platform-targeted search
<cmd> search "query" --platform GitHub

# URL content extraction (returns Markdown, max 50K chars)
<cmd> fetch "https://example.com/page"

# Site structure mapping
<cmd> map "https://docs.example.com" --depth 2 --breadth 15

# Retrieve cached sources from a previous search
<cmd> sources <session_id>

# Configuration & connectivity test
<cmd> config

# Model management
<cmd> model                    # list available models
<cmd> model grok-4.20-fast     # switch model

# Full documentation (offline)
<cmd> doc
```

## CLI Runtime

| Runtime | Command |
|---------|---------|
| Node.js | `node <skill_dir>/scripts/x_search_cli.js <command> [options]` |

Priority: Node.js (zero-dependency, fastest startup on this platform).

---

## 6-Phase Search Planning Workflow

> **Core principle**: The agent MUST internalize this workflow before executing searches. This replaces the MCP's stateful planning tools. The agent thinks through these phases mentally, then executes via CLI. No tool calls for planning — pure cognition.

### Phase 1: Intent Analysis

**Goal**: Distill the user's question into a single core question. Classify the query type.

| Query Type | Description | Example |
|------------|-------------|---------|
| `factual` | Single answer expected | "Who is the CEO of xAI?" |
| `comparative` | Compare 2+ entities | "React vs Vue performance 2025" |
| `exploratory` | Broad topic exploration | "Current state of quantum computing" |
| `analytical` | Requires reasoning across sources | "Why did the SpaceXAI merger happen?" |

**Checklist**:
- [ ] Core question distilled to one sentence
- [ ] Query type identified
- [ ] Time sensitivity assessed: `realtime` | `recent` | `historical` | `irrelevant`
- [ ] Any flawed premises flagged and corrected
- [ ] Ambiguous terms resolved

### Phase 2: Complexity Assessment

**Goal**: Determine how many sub-queries and tool calls are needed.

| Level | When to Use | Typical Calls |
|-------|-------------|---------------|
| **Level 1 — Simple** | Straightforward factual query, single source sufficient | 1 `search` |
| **Level 2 — Moderate** | Query needs decomposition, 2-4 sub-aspects | 2-4 `search` + maybe 1 `fetch` |
| **Level 3 — Complex** | Multi-source synthesis, site exploration needed | 3-6 `search` + `fetch` + `map` |

**Checklist**:
- [ ] Complexity level assessed with justification
- [ ] Estimated sub-queries: N
- [ ] Estimated total tool calls: N

### Phase 3: Sub-Query Decomposition

**Goal**: Break the core question into mutually-exclusive sub-queries. Each sub-query MUST have a clear boundary — no overlap.

For each sub-query, define:
- `id`: Unique identifier (e.g., `sq1`, `sq2`)
- `goal`: What this sub-query aims to answer
- `expected_output`: What success looks like (concrete, verifiable)
- `boundary`: What this sub-query explicitly excludes (prevents overlap)

**Example**: "How does Rust compare to Go for backend services?"
```
sq1: "Rust backend performance benchmarks 2025" → excludes developer experience
sq2: "Go backend performance benchmarks 2025"   → excludes developer experience
sq3: "Rust vs Go developer productivity surveys" → excludes performance metrics
```

**Checklist**:
- [ ] Each sub-query has unique ID, goal, expected output, boundary
- [ ] Mutual exclusion verified — no two sub-queries answer the same thing
- [ ] Dependencies noted (e.g., sq2 depends on sq1 findings)

### Phase 4: Search Term Design

**Goal**: Convert sub-queries into precise, high-signal search terms (max 8 words each).

| Approach | When to Use |
|----------|-------------|
| `broad_first` | Start with wide terms, narrow in later rounds |
| `narrow_first` | Start with specific terms, expand if insufficient |
| `targeted` | One-shot precise query, no follow-up rounds |

For each search term, specify:
- `term`: The exact query string (≤8 words)
- `purpose`: Which sub-query it serves (e.g., `sq1`)
- `round`: 1 = broad exploration, 2+ = targeted follow-up

**Checklist**:
- [ ] Approach declared (`broad_first` | `narrow_first` | `targeted`)
- [ ] Fallback plan if primary searches insufficient
- [ ] Each term mapped to a sub-query purpose

### Phase 5: Tool Mapping

**Goal**: Assign each sub-query to the optimal execution tool.

| Tool | Best For |
|------|----------|
| `search` | Knowledge synthesis, factual questions, comparisons |
| `fetch` | Reading a specific known URL in full |
| `map` | Exploring an entire site's structure |

**Checklist**:
- [ ] Each sub-query mapped to exactly one tool
- [ ] Mapping justified (why this tool for this sub-query?)
- [ ] Tool-specific parameters prepared (platform, depth, etc.)

### Phase 6: Execution Orchestration

**Goal**: Define execution order — which sub-queries run in parallel, which must be sequential.

Format: `parallel_groups` = semicolon-separated groups, comma-separated IDs within a group.

**Example**: `sq1,sq2;sq3` means sq1 and sq2 run in parallel first, sq3 runs after both complete.

**Checklist**:
- [ ] Parallel groups defined (use `;` to separate groups, `,` within groups)
- [ ] Sequential dependencies identified
- [ ] Estimated total rounds: N

---

### Planning Example: End-to-End

**User**: "How has AI regulation evolved in the EU vs US in 2025?"

```
Phase 1 — Intent: comparative, recent, core question = "Key differences in EU vs US AI regulation 2025"

Phase 2 — Complexity: Level 2 (moderate), 3 sub-queries, 3 tool calls

Phase 3 — Sub-queries:
  sq1: "EU AI Act implementation timeline 2025" → boundary: excludes US
  sq2: "US federal AI regulation 2025 executive orders" → boundary: excludes EU
  sq3: "EU vs US AI regulation comparison analysis" → depends on sq1,sq2 findings

Phase 4 — broad_first:
  Round 1: "EU AI Act 2025 status" (sq1), "US AI executive order 2025" (sq2)

Phase 5 — Tool mapping:
  sq1 → search, sq2 → search, sq3 → search

Phase 6 — Execution: sq1,sq2;sq3

Then execute:
  node x_search_cli.js search "EU AI Act implementation 2025"
  node x_search_cli.js search "US federal AI regulation 2025 executive orders"
  (wait for both, synthesize, then...)
  node x_search_cli.js search "EU vs US AI regulation differences 2025"
```

---

## search — Detailed Options

```
node <cmd> search "query" [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| query | string | required | Natural-language search query (positional) |
| --platform, -p | string | — | Target platform: GitHub, Twitter, Reddit, etc. |
| --model, -m | string | env default | Override model for this request only |
| --extra_sources, -e | int | 3 | Extra Tavily search results (0-10) |

**Output**: Markdown with AI-generated answer, source list, and session metadata (session_id, model, token count).

## fetch — Detailed Options

```
node <cmd> fetch <url>
```

Extracts full page content as Markdown. Uses Grok AI for intelligent extraction, falls back to direct HTTP fetch + HTML stripping.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| url | string | required | Target URL (positional) |

**Output**: Page content as Markdown (max 50K characters).

## map — Detailed Options

```
node <cmd> map <url> [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| url | string | required | Root URL to begin mapping |
| --depth, -d | int | 1 | Max crawl depth |
| --breadth, -b | int | 20 | Max links per page |
| --limit, -l | int | 50 | Max total pages |
| --instructions, -i | string | — | Natural-language filter |

**Output**: Markdown site map with page titles and URLs.

## API Key Management

### Key Source Priority

```
--model CLI flag  >  .config/x-search/config.json  >  .env file  >  environment variable  >  anonymous
```

Configure via `.env` file in the skill directory:

```
GROK_API_KEY=your_key_here
GROK_MODEL=grok-4.20-fast
```

### Scenarios

| Scenario | Behavior |
|----------|----------|
| **No key** | Proceed with anonymous access (lower limits). Inform the user that a key provides higher limits. |
| **Has key** | Key sent via `Authorization: Bearer <key>` header. |
| **Key exhausted** | API returns 4xx. Inform the user and suggest configuring a new key. |
| **Connection failed** | Fall back to AnySearch CLI for general web search. |

## Fallback & Error Handling

| Error | Action |
|-------|--------|
| `search` fails (network/timeout/4xx) | Inform user. Fall back to AnySearch CLI `search` for general web queries. |
| `fetch` fails (Grok API error) | Try direct HTTP fetch as fallback. If that fails too, report. |
| `map` fails (timeout) | Reduce depth/breadth and retry. If still failing, suggest AnySearch `extract`. |
| All CLI commands fail | Report: Node.js not available or script corrupted. Fall back to AnySearch. |
| No API connectivity | Run `config` to diagnose. If API unreachable, use AnySearch exclusively. |

## Security

- The `doc` command is offline — no network requests.
- Search queries and API keys are sent to `GROK_API_URL` (configured in `.env`).
- API keys displayed in `config` output are masked (`ff41***260d`).
- Do not paste API keys in chat. Configure via `.env` instead.
