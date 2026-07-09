# x-search source

这里是 `x-search` 的 Rust 源码。

运行用 skill 包在：

```text
../../x-search/
```

重新构建 Windows 内置二进制：

```powershell
cargo build --release --manifest-path .\dev\x-search-src\Cargo.toml
Copy-Item .\dev\x-search-src\target\release\x-search.exe .\x-search\bin\x-search.exe -Force
```

`evals/` 是测试用例说明，不是运行依赖。
