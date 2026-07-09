# x-search

实时搜索 skill。Grok 主力 → Tavily 兜底 → Context7 按需补充库文档。

## 依赖

- Windows：无需安装 Rust，仓库已内置 `bin/x-search.exe`
- macOS / Linux：从 GitHub Releases 下载对应平台压缩包，无需安装 Rust
- 开发/重新编译：Rust 1.75+
- API Key：Grok 和/或 Tavily（至少一个）

## 安装

```bash
cp -r x-search ~/.agents/skills/x-search
cd ~/.agents/skills/x-search
cp .env.example .env   # 填入你的 API Key
```

## 快速开始

```bash
bin/x-search.exe config                       # 检查配置
bin/x-search.exe search "xxx"                 # 搜索
bin/x-search.exe search "xxx" --format json
bin/x-search.exe doc                          # 查看全部命令
```

开发时也可以直接：

```bash
cargo run -- search "xxx"
```

重新编译并更新内置 exe：

```bash
cargo build --release
cp target/release/x-search.exe bin/x-search.exe
```

详细说明见 `SKILL.md`。

## 多平台发布

仓库已配置 GitHub Actions：

- push / pull request：自动构建 Windows、Linux、macOS x64、macOS arm64
- tag：自动创建 GitHub Release 并上传多平台压缩包

发布新版本：

```bash
git tag x-search-v3.1.0
git push origin x-search-v3.1.0
```

Release 产物：

```text
x-search-windows-x86_64.zip
x-search-linux-x86_64.tar.gz
x-search-macos-x86_64.tar.gz
x-search-macos-aarch64.tar.gz
```
