use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use clap::{Parser, Subcommand, ValueEnum};
use futures::stream::{self, StreamExt};
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const SCHEMA_VERSION: &str = "x-search.session.v2";
const DEFAULT_GROK_API_URL: &str = "https://api.x.ai/v1";
const DEFAULT_GROK_MODEL: &str = "grok-4.20-fast";
const DEFAULT_TAVILY_API_URL: &str = "https://api.tavily.com";
const DEFAULT_CONTEXT7_API_URL: &str = "https://context7.com/api/v2";
const USER_AGENT_VALUE: &str = "x-search-rust/3.1";

#[derive(Parser, Debug)]
#[command(
    name = "x-search",
    version,
    about = "Realtime search: Grok primary, Tavily fallback, Context7 docs."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    Search {
        #[arg(required = true, num_args = 1..)]
        query: Vec<String>,
        #[arg(long, value_enum, default_value_t = PlanMode::Auto)]
        plan: PlanMode,
        #[arg(long = "max-results", alias = "max_results", default_value_t = 5)]
        max_results: usize,
        #[arg(long = "max-queries", alias = "max_queries", default_value_t = 3)]
        max_queries: usize,
        #[arg(long, short = 'm')]
        model: Option<String>,
        #[arg(long, value_enum, default_value_t = OutputFormat::Markdown)]
        format: OutputFormat,
    },
    Fetch {
        url: String,
        #[arg(long, value_enum, default_value_t = OutputFormat::Markdown)]
        format: OutputFormat,
    },
    Map {
        url: String,
        #[arg(long, short = 'd', default_value_t = 1)]
        depth: u32,
        #[arg(long, short = 'b', default_value_t = 20)]
        breadth: u32,
        #[arg(long, short = 'l', default_value_t = 50)]
        limit: u32,
        #[arg(long, value_enum, default_value_t = OutputFormat::Markdown)]
        format: OutputFormat,
    },
    Sources {
        session_id: String,
        #[arg(long, value_enum, default_value_t = OutputFormat::Markdown)]
        format: OutputFormat,
    },
    Config {
        #[arg(long, value_enum, default_value_t = OutputFormat::Markdown)]
        format: OutputFormat,
    },
    Model {
        name: Option<String>,
    },
    #[command(alias = "docs")]
    Doc,
}

#[derive(Clone, Debug, ValueEnum)]
enum PlanMode {
    Off,
    Auto,
    Force,
}

#[derive(Clone, Debug, ValueEnum, PartialEq, Eq)]
enum OutputFormat {
    Markdown,
    Json,
    Compact,
}

#[derive(Clone, Debug)]
struct App {
    skill_dir: PathBuf,
    config_file: PathBuf,
    cache_dir: PathBuf,
    client: reqwest::Client,
    grok: Grok,
    tavily: Tavily,
    context7: Context7,
}

#[derive(Clone, Debug)]
struct Grok {
    api_url: String,
    api_key: String,
    default_model: String,
}

#[derive(Clone, Debug)]
struct Tavily {
    api_url: String,
    api_key: String,
}

#[derive(Clone, Debug)]
struct Context7 {
    api_url: String,
    api_key: String,
}

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
struct UserConfig {
    model: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Source {
    title: String,
    url: String,
    #[serde(default)]
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_date: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ProviderStatus {
    name: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Context7Doc {
    title: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    src: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Context7Result {
    found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    library_title: Option<String>,
    #[serde(default)]
    docs: Vec<Context7Doc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SearchSession {
    schema_version: String,
    session_id: String,
    query: String,
    queries: Vec<String>,
    provider: String,
    provider_status: Vec<ProviderStatus>,
    answer: String,
    sources: Vec<Source>,
    context7: Option<Context7Result>,
    checked_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct TavilySearchResponse {
    #[serde(default)]
    results: Vec<TavilyResult>,
}

#[derive(Debug, Deserialize)]
struct TavilyResult {
    title: Option<String>,
    url: Option<String>,
    content: Option<String>,
    snippet: Option<String>,
    score: Option<f64>,
    published_date: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TavilyExtractResponse {
    #[serde(default)]
    results: Vec<TavilyExtractResult>,
}

#[derive(Debug, Deserialize)]
struct TavilyExtractResult {
    raw_content: Option<String>,
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Context7SearchResponse {
    #[serde(default)]
    results: Vec<Context7Library>,
}

#[derive(Debug, Deserialize)]
struct Context7Library {
    id: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Context7CtxResponse {
    #[serde(default, rename = "codeSnippets")]
    code_snippets: Vec<Value>,
    #[serde(default, rename = "infoSnippets")]
    info_snippets: Vec<Value>,
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("err: {err:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let skill_dir = find_skill_dir()?;
    load_env_files(&skill_dir)?;
    let app = App::new(skill_dir)?;
    let cli = Cli::parse();

    match cli.command.unwrap_or(Command::Doc) {
        Command::Search {
            query,
            plan,
            max_results,
            max_queries,
            model,
            format,
        } => {
            let query = sanitize(&query.join(" "));
            if query.is_empty() {
                return Err(anyhow!("query is required"));
            }
            let session = app
                .search(&query, plan, max_results, max_queries, model)
                .await?;
            app.cache_session(&session)?;
            print_search(&session, format);
        }
        Command::Fetch { url, format } => {
            let result = app.fetch_page(&url).await?;
            print_fetch(&url, result, format);
        }
        Command::Map {
            url,
            depth,
            breadth,
            limit,
            format,
        } => {
            let pages = app.map_site(&url, depth, breadth, limit).await?;
            print_map(&url, depth, breadth, limit, &pages, format);
        }
        Command::Sources { session_id, format } => {
            let session = app.read_session(&session_id)?;
            print_sources(&session, format);
        }
        Command::Config { format } => {
            let report = app.config_report().await;
            print_config(report, format);
        }
        Command::Model { name } => {
            app.model_cmd(name)?;
        }
        Command::Doc => {
            print_doc();
        }
    }

    Ok(())
}

impl App {
    fn new(skill_dir: PathBuf) -> Result<Self> {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let config_file = home.join(".config").join("x-search").join("config.json");
        let cache_dir = skill_dir.join(".cache");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .user_agent(USER_AGENT_VALUE)
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .context("failed to build HTTP client")?;

        Ok(Self {
            skill_dir,
            config_file,
            cache_dir,
            client,
            grok: Grok {
                api_url: env_var("GROK_API_URL", DEFAULT_GROK_API_URL)
                    .trim_end_matches('/')
                    .to_string(),
                api_key: env::var("GROK_API_KEY").unwrap_or_default(),
                default_model: env_var("GROK_MODEL", DEFAULT_GROK_MODEL),
            },
            tavily: Tavily {
                api_url: env_var("TAVILY_API_URL", DEFAULT_TAVILY_API_URL)
                    .trim_end_matches('/')
                    .to_string(),
                api_key: env::var("TAVILY_API_KEY").unwrap_or_default(),
            },
            context7: Context7 {
                api_url: env_var("CONTEXT7_API_URL", DEFAULT_CONTEXT7_API_URL)
                    .trim_end_matches('/')
                    .to_string(),
                api_key: env::var("CONTEXT7_API_KEY").unwrap_or_default(),
            },
        })
    }

    async fn search(
        &self,
        query: &str,
        plan: PlanMode,
        max_results: usize,
        max_queries: usize,
        model_override: Option<String>,
    ) -> Result<SearchSession> {
        let config = self.load_config();
        let model = model_override
            .or(config.model)
            .unwrap_or_else(|| self.grok.default_model.clone());
        let mut statuses = Vec::new();
        let provider;
        let answer;
        let sources;
        let mut queries = vec![query.to_string()];
        let mut detected_library = None;

        match self.grok_search(query, &model).await {
            Ok(result) => {
                provider = "Grok".to_string();
                answer = strip_library_marker(&result.answer);
                detected_library = result.detected_library;
                sources = extract_sources_from_text(&answer);
                statuses.push(ProviderStatus {
                    name: "Grok".to_string(),
                    ok: true,
                    detail: Some("primary search succeeded".to_string()),
                });
            }
            Err(err) => {
                statuses.push(ProviderStatus {
                    name: "Grok".to_string(),
                    ok: false,
                    detail: Some(err.to_string()),
                });
                if self.tavily.api_key.is_empty() {
                    return Err(anyhow!(
                        "No search provider available. Configure GROK_API_KEY or TAVILY_API_KEY."
                    ));
                }

                provider = if self.grok.api_key.is_empty() {
                    "Tavily".to_string()
                } else {
                    "Tavily + Grok synthesis".to_string()
                };
                queries = if should_plan(query, &plan) {
                    self.plan_queries(query, max_queries, &model)
                        .await
                        .unwrap_or_else(|_| vec![query.to_string()])
                } else {
                    vec![query.to_string()]
                };

                let all_sources = self
                    .tavily_search_many(&queries, max_results.max(1))
                    .await
                    .context("Tavily search failed")?;
                sources = dedupe_sources(all_sources);
                statuses.push(ProviderStatus {
                    name: "Tavily".to_string(),
                    ok: true,
                    detail: Some(format!("{} unique source(s)", sources.len())),
                });

                answer = if self.grok.api_key.is_empty() {
                    fallback_answer_from_sources(&sources)
                } else {
                    match self
                        .synthesize_answer(query, &queries, &sources, &model)
                        .await
                    {
                        Ok(text) if !text.trim().is_empty() => text,
                        Ok(_) => fallback_answer_from_sources(&sources),
                        Err(err) => {
                            statuses.push(ProviderStatus {
                                name: "Grok synthesis".to_string(),
                                ok: false,
                                detail: Some(err.to_string()),
                            });
                            fallback_answer_from_sources(&sources)
                        }
                    }
                };
            }
        }

        let context7 = self
            .context7_enrich(query, detected_library.as_deref(), &model)
            .await;
        if let Some(result) = &context7 {
            statuses.push(ProviderStatus {
                name: "Context7".to_string(),
                ok: result.found,
                detail: result.error.clone().or_else(|| {
                    Some(
                        if result.found {
                            "docs found"
                        } else {
                            "no docs found"
                        }
                        .to_string(),
                    )
                }),
            });
        }

        Ok(SearchSession {
            schema_version: SCHEMA_VERSION.to_string(),
            session_id: format!("xsearch_{}", Utc::now().timestamp_millis()),
            query: query.to_string(),
            queries,
            provider,
            provider_status: statuses,
            answer: answer.trim().to_string(),
            sources,
            context7,
            checked_at: Utc::now(),
        })
    }

    async fn grok_chat(
        &self,
        messages: Vec<ChatMessage>,
        model: &str,
        timeout_secs: u64,
    ) -> Result<String> {
        if self.grok.api_key.is_empty() {
            return Err(anyhow!("GROK_API_KEY not set"));
        }
        let data = self
            .client
            .post(format!("{}/chat/completions", self.grok.api_url))
            .headers(bearer_headers(&self.grok.api_key)?)
            .timeout(Duration::from_secs(timeout_secs))
            .json(&json!({
                "model": model,
                "messages": messages,
                "stream": false
            }))
            .send()
            .await
            .context("Grok request failed")?
            .error_for_status()
            .context("Grok returned error status")?
            .json::<ChatResponse>()
            .await
            .context("Grok returned invalid JSON")?;

        Ok(data
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .unwrap_or_default())
    }

    async fn grok_search(&self, query: &str, model: &str) -> Result<GrokSearchResult> {
        let answer = self
            .grok_chat(
                vec![
                    ChatMessage {
                        role: "system".to_string(),
                        content: [
                            "You are a concise research assistant with web search.",
                            "Return Markdown in this exact shape:",
                            "## 结论",
                            "A direct answer in 1-3 short paragraphs.",
                            "## 关键要点",
                            "Bullets with source URLs inline when available.",
                            "## 不确定或缺口",
                            "Say what is not verified or missing.",
                            "If the user asks about a specific library/framework/tool, end with: LIBRARY: <name>.",
                            "If not, do not add LIBRARY.",
                        ]
                        .join("\n"),
                    },
                    ChatMessage {
                        role: "user".to_string(),
                        content: query.to_string(),
                    },
                ],
                model,
                120,
            )
            .await?;

        if answer.trim().is_empty() {
            return Err(anyhow!("empty Grok response"));
        }
        let detected_library = Regex::new(r"(?m)^LIBRARY:\s*(.+?)\s*$")
            .ok()
            .and_then(|re| re.captures(&answer))
            .and_then(|caps| caps.get(1).map(|m| m.as_str().trim().to_string()))
            .filter(|name| !name.eq_ignore_ascii_case("null"));
        Ok(GrokSearchResult {
            answer,
            detected_library,
        })
    }

    async fn plan_queries(
        &self,
        query: &str,
        max_queries: usize,
        model: &str,
    ) -> Result<Vec<String>> {
        if self.grok.api_key.is_empty() {
            return Ok(vec![query.to_string()]);
        }
        let text = self
            .grok_chat(
                vec![
                    ChatMessage {
                        role: "system".to_string(),
                        content: format!(
                            "Break the user research query into non-overlapping web search queries. Return JSON only: {{\"queries\":[\"...\"]}}. Max {} queries.",
                            max_queries
                        ),
                    },
                    ChatMessage {
                        role: "user".to_string(),
                        content: query.to_string(),
                    },
                ],
                model,
                45,
            )
            .await?;
        let parsed = extract_json_object(&text)
            .and_then(|v| v.get("queries").cloned())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        let queries: Vec<String> = parsed
            .into_iter()
            .filter_map(|v| v.as_str().map(sanitize))
            .filter(|s| !s.is_empty())
            .take(max_queries.max(1))
            .collect();
        Ok(if queries.is_empty() {
            vec![query.to_string()]
        } else {
            queries
        })
    }

    async fn tavily_search_many(
        &self,
        queries: &[String],
        max_results: usize,
    ) -> Result<Vec<Source>> {
        if self.tavily.api_key.is_empty() {
            return Err(anyhow!("TAVILY_API_KEY not set"));
        }
        let client = self.client.clone();
        let api_url = self.tavily.api_url.clone();
        let api_key = self.tavily.api_key.clone();
        let jobs = stream::iter(queries.iter().cloned().map(move |query| {
            let client = client.clone();
            let api_url = api_url.clone();
            let api_key = api_key.clone();
            async move {
                tavily_search_one(&client, &api_url, &api_key, &query, max_results)
                    .await
                    .map(|items| {
                        items
                            .into_iter()
                            .map(|mut item| {
                                item.query = Some(query.clone());
                                item
                            })
                            .collect::<Vec<_>>()
                    })
            }
        }))
        .buffer_unordered(3);

        let mut merged = Vec::new();
        let results: Vec<Result<Vec<Source>>> = jobs.collect().await;
        for result in results {
            merged.extend(result?);
        }
        Ok(merged)
    }

    async fn synthesize_answer(
        &self,
        original_query: &str,
        queries: &[String],
        sources: &[Source],
        model: &str,
    ) -> Result<String> {
        if self.grok.api_key.is_empty() {
            return Ok(String::new());
        }
        let source_context = sources
            .iter()
            .enumerate()
            .map(|(i, s)| {
                format!(
                    "[{}] {}\nURL: {}\nDate: {}\nSnippet: {}",
                    i + 1,
                    s.title,
                    s.url,
                    s.published_date.as_deref().unwrap_or("unknown"),
                    if s.content.is_empty() {
                        "(none)"
                    } else {
                        &s.content
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let prompt = [
            "Answer the user using only the provided sources.",
            "Use Markdown with exactly these sections:",
            "## 结论",
            "## 关键要点",
            "## 不确定或缺口",
            "Every factual bullet should cite source numbers like [1] or [2].",
            "If sources are insufficient, say so plainly.",
            "Prefer concrete dates for time-sensitive information.",
            "",
            &format!("User question: {original_query}"),
            &format!("Search queries used: {}", queries.join(" | ")),
            "",
            "Sources:",
            &source_context,
        ]
        .join("\n");
        self.grok_chat(
            vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: "You are a concise research assistant.".to_string(),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: prompt,
                },
            ],
            model,
            90,
        )
        .await
    }

    async fn detect_library(&self, query: &str, model: &str) -> Result<Option<String>> {
        if self.grok.api_key.is_empty() {
            return Ok(None);
        }
        let text = self
            .grok_chat(
                vec![
                    ChatMessage {
                        role: "system".to_string(),
                        content: "If the user asks about a specific library/framework/tool, reply with ONLY the name. Otherwise reply null.".to_string(),
                    },
                    ChatMessage {
                        role: "user".to_string(),
                        content: query.to_string(),
                    },
                ],
                model,
                30,
            )
            .await?;
        let name = text.trim();
        if name.is_empty() || name.eq_ignore_ascii_case("null") || name.eq_ignore_ascii_case("none")
        {
            Ok(None)
        } else {
            Ok(Some(name.to_string()))
        }
    }

    async fn context7_enrich(
        &self,
        query: &str,
        detected_library: Option<&str>,
        model: &str,
    ) -> Option<Context7Result> {
        let library_name = match detected_library {
            Some(name) if !name.trim().is_empty() => Some(name.trim().to_string()),
            _ => self.detect_library(query, model).await.ok().flatten(),
        }?;

        match self.context7_search_docs(query, &library_name).await {
            Ok(result) => Some(result),
            Err(err) => Some(Context7Result {
                found: false,
                library_title: Some(library_name),
                docs: Vec::new(),
                error: Some(err.to_string()),
            }),
        }
    }

    async fn context7_search_docs(
        &self,
        query: &str,
        library_name: &str,
    ) -> Result<Context7Result> {
        let mut req = self.client.get(format!(
            "{}/libs/search?libraryName={}&query={}&fast=true",
            self.context7.api_url,
            url_encode(library_name),
            url_encode(query)
        ));
        if !self.context7.api_key.is_empty() {
            req = req.bearer_auth(&self.context7.api_key);
        }
        let libs = req
            .timeout(Duration::from_secs(15))
            .send()
            .await?
            .error_for_status()?
            .json::<Context7SearchResponse>()
            .await?;
        let lib = match libs.results.into_iter().next() {
            Some(lib) => lib,
            None => {
                return Ok(Context7Result {
                    found: false,
                    library_title: Some(library_name.to_string()),
                    docs: Vec::new(),
                    error: None,
                });
            }
        };
        let lib_id = lib.id.clone().unwrap_or_default();
        if lib_id.is_empty() {
            return Ok(Context7Result {
                found: false,
                library_title: lib.title.or_else(|| Some(library_name.to_string())),
                docs: Vec::new(),
                error: Some("Context7 library id missing".to_string()),
            });
        }

        let mut docs_req = self.client.get(format!(
            "{}/ctx?query={}&libraryId={}&type=json",
            self.context7.api_url,
            url_encode(query),
            url_encode(&lib_id)
        ));
        if !self.context7.api_key.is_empty() {
            docs_req = docs_req.bearer_auth(&self.context7.api_key);
        }
        let data = docs_req
            .timeout(Duration::from_secs(15))
            .send()
            .await?
            .error_for_status()?
            .json::<Context7CtxResponse>()
            .await?;
        let mut docs = Vec::new();
        for item in data.code_snippets.into_iter().take(3) {
            docs.push(Context7Doc {
                title: get_string(&item, &["pageTitle", "codeTitle"])
                    .unwrap_or_else(|| "Code Example".to_string()),
                content: build_context7_code_content(&item),
                src: get_string(&item, &["codeId", "src"]),
            });
        }
        for item in data.info_snippets.into_iter().take(3) {
            docs.push(Context7Doc {
                title: get_string(&item, &["pageTitle", "infoTitle"])
                    .unwrap_or_else(|| "Info".to_string()),
                content: get_string(&item, &["content"]).unwrap_or_default(),
                src: get_string(&item, &["src"]),
            });
        }
        docs.truncate(5);
        Ok(Context7Result {
            found: !docs.is_empty(),
            library_title: lib.title.or_else(|| Some(library_name.to_string())),
            docs,
            error: None,
        })
    }

    async fn fetch_page(&self, url: &str) -> Result<FetchResult> {
        if !self.tavily.api_key.is_empty() {
            if let Ok(content) = self.tavily_extract(url).await {
                if !content.trim().is_empty() {
                    return Ok(FetchResult {
                        url: url.to_string(),
                        method: "Tavily extract".to_string(),
                        content,
                        checked_at: Utc::now(),
                    });
                }
            }
        }
        let text = self
            .client
            .get(url)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .context("fetch request failed")?
            .error_for_status()
            .context("fetch returned error status")?
            .text()
            .await
            .context("failed to read response text")?;
        Ok(FetchResult {
            url: url.to_string(),
            method: "direct HTTP fallback".to_string(),
            content: html_to_text(&text).chars().take(50_000).collect(),
            checked_at: Utc::now(),
        })
    }

    async fn tavily_extract(&self, url: &str) -> Result<String> {
        let data = self
            .client
            .post(format!("{}/extract", self.tavily.api_url))
            .headers(bearer_headers(&self.tavily.api_key)?)
            .timeout(Duration::from_secs(60))
            .json(&json!({
                "urls": [url],
                "extract_depth": "advanced",
                "format": "markdown"
            }))
            .send()
            .await?
            .error_for_status()?
            .json::<TavilyExtractResponse>()
            .await?;
        Ok(data
            .results
            .into_iter()
            .next()
            .map(|r| r.raw_content.or(r.content).unwrap_or_default())
            .unwrap_or_default()
            .trim()
            .to_string())
    }

    async fn map_site(
        &self,
        url: &str,
        depth: u32,
        breadth: u32,
        limit: u32,
    ) -> Result<Vec<Source>> {
        if self.tavily.api_key.is_empty() {
            return Err(anyhow!("TAVILY_API_KEY not set"));
        }
        let data = self
            .client
            .post(format!("{}/map", self.tavily.api_url))
            .headers(bearer_headers(&self.tavily.api_key)?)
            .timeout(Duration::from_secs(60))
            .json(&json!({
                "url": url,
                "max_depth": depth,
                "max_breadth": breadth,
                "limit": limit,
                "format": "markdown"
            }))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;

        let mut pages = Vec::new();
        if let Some(results) = data.get("results").and_then(|v| v.as_array()) {
            for item in results {
                let url =
                    get_string(item, &["url"]).or_else(|| item.as_str().map(ToString::to_string));
                if let Some(url) = url {
                    pages.push(Source {
                        title: get_string(item, &["title"]).unwrap_or_else(|| url.clone()),
                        url,
                        content: String::new(),
                        score: None,
                        query: None,
                        published_date: None,
                    });
                }
            }
        } else if let Some(links) = data.get("links").and_then(|v| v.as_array()) {
            for item in links {
                if let Some(url) = item.as_str() {
                    pages.push(Source {
                        title: url.to_string(),
                        url: url.to_string(),
                        content: String::new(),
                        score: None,
                        query: None,
                        published_date: None,
                    });
                }
            }
        }
        Ok(dedupe_sources(pages))
    }

    fn load_config(&self) -> UserConfig {
        fs::read_to_string(&self.config_file)
            .ok()
            .and_then(|text| serde_json::from_str::<UserConfig>(&text).ok())
            .unwrap_or_default()
    }

    fn save_config(&self, config: &UserConfig) -> Result<()> {
        if let Some(parent) = self.config_file.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&self.config_file, serde_json::to_string_pretty(config)?)?;
        Ok(())
    }

    fn model_cmd(&self, name: Option<String>) -> Result<()> {
        if let Some(name) = name {
            let mut config = self.load_config();
            config.model = Some(name.clone());
            self.save_config(&config)?;
            println!("model = {name}");
        } else {
            let config = self.load_config();
            println!(
                "{}",
                config
                    .model
                    .unwrap_or_else(|| self.grok.default_model.clone())
            );
        }
        Ok(())
    }

    fn cache_session(&self, session: &SearchSession) -> Result<()> {
        fs::create_dir_all(&self.cache_dir)?;
        let file = self.cache_dir.join(format!("{}.json", session.session_id));
        fs::write(file, serde_json::to_string_pretty(session)?)?;
        Ok(())
    }

    fn read_session(&self, session_id: &str) -> Result<SearchSession> {
        let file = self.cache_dir.join(format!("{session_id}.json"));
        let text = fs::read_to_string(&file)
            .with_context(|| format!("session not found: {session_id}"))?;
        serde_json::from_str(&text).context("invalid session cache")
    }

    async fn config_report(&self) -> ConfigReport {
        let model = self
            .load_config()
            .model
            .unwrap_or_else(|| self.grok.default_model.clone());
        let mut connectivity = Vec::new();

        if self.grok.api_key.is_empty() {
            connectivity.push(ProviderStatus {
                name: "Grok".to_string(),
                ok: false,
                detail: Some("skipped: GROK_API_KEY not set".to_string()),
            });
        } else {
            let ok = self
                .grok_chat(
                    vec![ChatMessage {
                        role: "user".to_string(),
                        content: "Hi".to_string(),
                    }],
                    &model,
                    20,
                )
                .await;
            connectivity.push(ProviderStatus {
                name: "Grok".to_string(),
                ok: ok.is_ok(),
                detail: ok
                    .err()
                    .map(|e| e.to_string())
                    .or_else(|| Some("ok".to_string())),
            });
        }

        if self.tavily.api_key.is_empty() {
            connectivity.push(ProviderStatus {
                name: "Tavily".to_string(),
                ok: false,
                detail: Some("skipped: TAVILY_API_KEY not set".to_string()),
            });
        } else {
            let ok = tavily_search_one(
                &self.client,
                &self.tavily.api_url,
                &self.tavily.api_key,
                "hello",
                1,
            )
            .await;
            connectivity.push(ProviderStatus {
                name: "Tavily".to_string(),
                ok: ok.is_ok(),
                detail: ok
                    .err()
                    .map(|e| e.to_string())
                    .or_else(|| Some("ok".to_string())),
            });
        }

        ConfigReport {
            grok_url: self.grok.api_url.clone(),
            grok_key_configured: !self.grok.api_key.is_empty(),
            model,
            tavily_url: self.tavily.api_url.clone(),
            tavily_key_configured: !self.tavily.api_key.is_empty(),
            context7_url: self.context7.api_url.clone(),
            context7_key_configured: !self.context7.api_key.is_empty(),
            skill_dir: self.skill_dir.display().to_string(),
            config_file: self.config_file.display().to_string(),
            cache_dir: self.cache_dir.display().to_string(),
            connectivity,
        }
    }
}

#[derive(Debug)]
struct GrokSearchResult {
    answer: String,
    detected_library: Option<String>,
}

#[derive(Debug, Serialize)]
struct FetchResult {
    url: String,
    method: String,
    content: String,
    checked_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
struct ConfigReport {
    grok_url: String,
    grok_key_configured: bool,
    model: String,
    tavily_url: String,
    tavily_key_configured: bool,
    context7_url: String,
    context7_key_configured: bool,
    skill_dir: String,
    config_file: String,
    cache_dir: String,
    connectivity: Vec<ProviderStatus>,
}

async fn tavily_search_one(
    client: &reqwest::Client,
    api_url: &str,
    api_key: &str,
    query: &str,
    max_results: usize,
) -> Result<Vec<Source>> {
    let data = client
        .post(format!("{}/search", api_url.trim_end_matches('/')))
        .headers(bearer_headers(api_key)?)
        .timeout(Duration::from_secs(60))
        .json(&json!({
            "query": query,
            "max_results": max_results,
            "search_depth": "advanced",
            "include_answer": false,
            "include_raw_content": false,
            "topic": "general"
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<TavilySearchResponse>()
        .await?;
    Ok(data
        .results
        .into_iter()
        .filter_map(|item| {
            let url = item.url?;
            Some(Source {
                title: item.title.unwrap_or_else(|| "Untitled".to_string()),
                url,
                content: item
                    .content
                    .or(item.snippet)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                score: item.score,
                query: None,
                published_date: item.published_date,
            })
        })
        .collect())
}

fn print_search(session: &SearchSession, format: OutputFormat) {
    match format {
        OutputFormat::Json => println!("{}", serde_json::to_string_pretty(session).unwrap()),
        OutputFormat::Compact => {
            println!(
                "{} | {} | {} source(s) | {}",
                session.session_id,
                session.provider,
                session.sources.len(),
                first_non_heading_line(&session.answer)
            );
        }
        OutputFormat::Markdown => {
            println!("# x-search\n");
            println!("- 查询: {}", session.query);
            println!("- checked_at: {}", session.checked_at.to_rfc3339());
            println!("- provider: {}", session.provider);
            println!("- session_id: {}", session.session_id);
            println!("- results: {}\n", session.sources.len());

            println!("## Provider 状态\n");
            for status in &session.provider_status {
                println!(
                    "- {}: {}{}",
                    status.name,
                    if status.ok { "✅" } else { "❌" },
                    status
                        .detail
                        .as_deref()
                        .map(|d| format!(" — {d}"))
                        .unwrap_or_default()
                );
            }
            println!();

            if session.answer.trim().is_empty() {
                println!("## 结论\n\n未生成结论；请查看来源。\n");
            } else {
                println!("{}\n", session.answer.trim());
            }

            if let Some(ctx) = &session.context7 {
                if ctx.found {
                    println!(
                        "## 📚 库文档参考 ({})\n",
                        ctx.library_title.as_deref().unwrap_or("Context7")
                    );
                    for (i, doc) in ctx.docs.iter().enumerate() {
                        println!("{}. **{}**", i + 1, doc.title);
                        let content = normalize_ws(&doc.content);
                        if !content.is_empty() {
                            println!("   {}", truncate_chars(&content, 300));
                        }
                        if let Some(src) = &doc.src {
                            println!("   来源: `{src}`");
                        }
                        println!();
                    }
                }
            }

            println!("## 来源\n");
            print_source_table(&session.sources);
        }
    }
}

fn print_fetch(url: &str, result: FetchResult, format: OutputFormat) {
    match format {
        OutputFormat::Json => println!("{}", serde_json::to_string_pretty(&result).unwrap()),
        OutputFormat::Compact => println!(
            "{} | {} chars | {}",
            result.method,
            result.content.chars().count(),
            url
        ),
        OutputFormat::Markdown => {
            println!("# x-search fetch\n");
            println!("- URL: {url}");
            println!("- method: {}", result.method);
            println!("- checked_at: {}", result.checked_at.to_rfc3339());
            println!("- chars: {}\n", result.content.chars().count());
            println!("## 正文\n");
            println!("{}", result.content);
        }
    }
}

fn print_map(
    url: &str,
    depth: u32,
    breadth: u32,
    limit: u32,
    pages: &[Source],
    format: OutputFormat,
) {
    match format {
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "url": url,
                "depth": depth,
                "breadth": breadth,
                "limit": limit,
                "count": pages.len(),
                "pages": pages,
                "checked_at": Utc::now()
            }))
            .unwrap()
        ),
        OutputFormat::Compact => println!("{url} | {} page(s)", pages.len()),
        OutputFormat::Markdown => {
            println!("# Site Map\n");
            println!("- URL: {url}");
            println!("- depth: {depth}");
            println!("- breadth: {breadth}");
            println!("- limit: {limit}");
            println!("- pages: {}\n", pages.len());
            print_source_table(pages);
        }
    }
}

fn print_sources(session: &SearchSession, format: OutputFormat) {
    match format {
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&session.sources).unwrap()
        ),
        OutputFormat::Compact => println!("{} source(s)", session.sources.len()),
        OutputFormat::Markdown => {
            println!("# Sources for {}\n", session.session_id);
            println!("- Query: {}", session.query);
            println!("- Provider: {}", session.provider);
            println!("- checked_at: {}\n", session.checked_at.to_rfc3339());
            print_source_table(&session.sources);
        }
    }
}

fn print_config(report: ConfigReport, format: OutputFormat) {
    match format {
        OutputFormat::Json => println!("{}", serde_json::to_string_pretty(&report).unwrap()),
        OutputFormat::Compact => println!(
            "Grok: {} | Tavily: {} | model: {}",
            if report.grok_key_configured {
                "configured"
            } else {
                "missing"
            },
            if report.tavily_key_configured {
                "configured"
            } else {
                "missing"
            },
            report.model
        ),
        OutputFormat::Markdown => {
            println!("# X-Search Config\n");
            println!("## Grok\n");
            println!("- URL: {}", report.grok_url);
            println!(
                "- Key: {}",
                if report.grok_key_configured {
                    "✅ configured"
                } else {
                    "❌ not set"
                }
            );
            println!("- Model: {}\n", report.model);
            println!("## Tavily\n");
            println!("- URL: {}", report.tavily_url);
            println!(
                "- Key: {}\n",
                if report.tavily_key_configured {
                    "✅ configured"
                } else {
                    "❌ not set"
                }
            );
            println!("## Context7\n");
            println!("- URL: {}", report.context7_url);
            println!(
                "- Key: {}\n",
                if report.context7_key_configured {
                    "✅ configured"
                } else {
                    "ℹ️ optional"
                }
            );
            println!("## Paths\n");
            println!("- skill_dir: {}", report.skill_dir);
            println!("- config_file: {}", report.config_file);
            println!("- cache_dir: {}\n", report.cache_dir);
            println!("## Connectivity\n");
            for status in report.connectivity {
                println!(
                    "- {}: {}{}",
                    status.name,
                    if status.ok { "✅" } else { "❌" },
                    status.detail.map(|d| format!(" — {d}")).unwrap_or_default()
                );
            }
        }
    }
}

fn print_source_table(sources: &[Source]) {
    if sources.is_empty() {
        println!("未找到来源");
        return;
    }
    println!("| 编号 | 标题 | 日期 | 链接 |");
    println!("|---|---|---|---|");
    for (i, source) in sources.iter().enumerate() {
        println!(
            "| [{}] | {} | {} | {} |",
            i + 1,
            escape_md_cell(&source.title),
            source.published_date.as_deref().unwrap_or("-"),
            source.url
        );
    }
}

fn print_doc() {
    println!(
        r#"x-search

Commands:
  search <query> [--plan off|auto|force] [--max-results N] [--max-queries N] [--model MODEL] [--format markdown|json|compact]
  fetch <url> [--format markdown|json|compact]
  map <url> [--depth N] [--breadth N] [--limit N] [--format markdown|json|compact]
  sources <session_id> [--format markdown|json|compact]
  config [--format markdown|json|compact]
  model [name]
  doc

Examples:
  x-search search "Next.js 15 cache changes"
  x-search search "React 19 和 Vue 3.5 对比" --plan force --format json
  x-search fetch "https://example.com/page"
"#
    );
}

fn find_skill_dir() -> Result<PathBuf> {
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    let cwd = env::current_dir().context("failed to get current dir")?;
    let mut candidates = Vec::new();
    candidates.push(cwd.clone());
    candidates.push(cwd.join("x-search"));
    if let Some(dir) = exe_dir {
        candidates.push(dir.clone());
        candidates.push(dir.join("..").join(".."));
        candidates.push(dir.join("..").join("..").join(".."));
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".agents").join("skills").join("x-search"));
    }
    for candidate in candidates {
        let candidate = candidate.canonicalize().unwrap_or(candidate);
        if candidate.join("SKILL.md").exists() && candidate.join("runtime.conf").exists() {
            return Ok(candidate);
        }
    }
    Ok(cwd)
}

fn load_env_files(skill_dir: &Path) -> Result<()> {
    let mut candidates = vec![skill_dir.join(".env"), skill_dir.join(".env.local")];
    if let Some(home) = dirs::home_dir() {
        candidates.push(
            home.join(".agents")
                .join("skills")
                .join("x-search")
                .join(".env"),
        );
    }
    for file in candidates {
        if file.exists() {
            load_env_file(&file)?;
            break;
        }
    }
    Ok(())
}

fn load_env_file(file: &Path) -> Result<()> {
    let text =
        fs::read_to_string(file).with_context(|| format!("failed to read {}", file.display()))?;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || env::var_os(key).is_some() {
            continue;
        }
        let value = strip_inline_comment(value.trim());
        env::set_var(key, unquote(value));
    }
    Ok(())
}

fn env_var(key: &str, default_value: &str) -> String {
    env::var(key).unwrap_or_else(|_| default_value.to_string())
}

fn bearer_headers(api_key: &str) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {api_key}")).context("invalid API key header")?,
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_VALUE));
    Ok(headers)
}

fn sanitize(text: impl AsRef<str>) -> String {
    text.as_ref()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn should_plan(query: &str, mode: &PlanMode) -> bool {
    match mode {
        PlanMode::Force => true,
        PlanMode::Off => false,
        PlanMode::Auto => {
            query.chars().count() > 36
                || Regex::new(r"(?i)\b(vs|compare|comparison|difference|tradeoff|error|issue|best practice|migration)\b")
                    .map(|re| re.is_match(query))
                    .unwrap_or(false)
                || query.chars().any(|c| "对比区别差异怎么解决报错原因迁移方案".contains(c))
        }
    }
}

fn dedupe_sources(results: Vec<Source>) -> Vec<Source> {
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    for mut item in results {
        item.url = item
            .url
            .trim()
            .trim_end_matches(['.', ',', ';', ')', ']', '）'])
            .to_string();
        if item.url.is_empty() || !seen.insert(item.url.clone()) {
            continue;
        }
        if item.title.trim().is_empty() {
            item.title = "Untitled".to_string();
        }
        merged.push(item);
    }
    merged
}

fn extract_sources_from_text(text: &str) -> Vec<Source> {
    let re = Regex::new(r#"https?://[^\s\]\)>）"]+"#).unwrap();
    let sources = re
        .find_iter(text)
        .map(|m| {
            let url = m
                .as_str()
                .trim_end_matches(['.', ',', ';', ':', ')', ']', '）'])
                .to_string();
            Source {
                title: domain_title(&url),
                url,
                content: String::new(),
                score: None,
                query: None,
                published_date: None,
            }
        })
        .collect::<Vec<_>>();
    dedupe_sources(sources)
}

fn strip_library_marker(text: &str) -> String {
    Regex::new(r"(?m)\n?^LIBRARY:\s*.+?\s*$")
        .map(|re| re.replace_all(text, "").to_string())
        .unwrap_or_else(|_| text.to_string())
        .trim()
        .to_string()
}

fn extract_json_object(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(&text[start..=end]).ok()
}

fn fallback_answer_from_sources(sources: &[Source]) -> String {
    if sources.is_empty() {
        return "## 结论\n\n未找到足够来源。\n\n## 关键要点\n\n- 暂无。\n\n## 不确定或缺口\n\n- 没有可用来源。".to_string();
    }
    let mut lines = vec![
        "## 结论".to_string(),
        String::new(),
        "已找到相关来源，但当前没有可用模型生成综合结论。".to_string(),
        String::new(),
        "## 关键要点".to_string(),
        String::new(),
    ];
    for (i, source) in sources.iter().take(5).enumerate() {
        let snippet = if source.content.is_empty() {
            source.title.clone()
        } else {
            truncate_chars(&normalize_ws(&source.content), 180)
        };
        lines.push(format!("- {} [{}]", snippet, i + 1));
    }
    lines.push(String::new());
    lines.push("## 不确定或缺口".to_string());
    lines.push(String::new());
    lines.push("- 未经过模型综合，只展示来源摘要。".to_string());
    lines.join("\n")
}

fn first_non_heading_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| truncate_chars(line, 160))
        .unwrap_or_else(|| "no answer".to_string())
}

fn html_to_text(html: &str) -> String {
    let no_script = Regex::new(r"(?is)<script[^>]*>.*?</script>")
        .unwrap()
        .replace_all(html, " ");
    let no_style = Regex::new(r"(?is)<style[^>]*>.*?</style>")
        .unwrap()
        .replace_all(&no_script, " ");
    let no_tags = Regex::new(r"(?is)<[^>]+>")
        .unwrap()
        .replace_all(&no_style, " ");
    normalize_ws(&html_unescape(&no_tags))
}

fn normalize_ws(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn html_unescape(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn escape_md_cell(text: &str) -> String {
    normalize_ws(text).replace('|', "\\|")
}

fn domain_title(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.domain().map(ToString::to_string))
        .unwrap_or_else(|| "source".to_string())
}

fn strip_inline_comment(value: &str) -> &str {
    let mut in_quote = false;
    let mut quote_char = '\0';
    for (idx, ch) in value.char_indices() {
        if (ch == '"' || ch == '\'') && (idx == 0 || !value[..idx].ends_with('\\')) {
            if in_quote && ch == quote_char {
                in_quote = false;
            } else if !in_quote {
                in_quote = true;
                quote_char = ch;
            }
        }
        if ch == '#' && !in_quote {
            return value[..idx].trim_end();
        }
    }
    value
}

fn unquote(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        value[1..value.len() - 1].to_string()
    } else {
        value.to_string()
    }
}

fn url_encode(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn get_string(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = value.get(*key).and_then(Value::as_str) {
            if !s.trim().is_empty() {
                return Some(s.trim().to_string());
            }
        }
    }
    None
}

fn build_context7_code_content(value: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(desc) = get_string(value, &["codeDescription"]) {
        parts.push(desc);
    }
    if let Some(code_list) = value.get("codeList").and_then(Value::as_array) {
        for item in code_list.iter().take(2) {
            if let Some(code) = get_string(item, &["code"]) {
                parts.push(code);
            }
        }
    }
    parts.join("\n")
}
