# 示例 / Examples

这里放的是**怎么用**的示例文件；可直接运行的配方在 [`templates/`](../templates/)。

| 文件 | 用途 | 用法 |
|---|---|---|
| [`batch.x.json`](batch.x.json) | 多账号批量：两个 X 账号各搜一个关键词，每次间隔 1–2 分钟，每账号每天最多 3 次，登录失效就跳过 | `browser-recipewright batch examples/batch.x.json` |
| [`accounts.csv`](accounts.csv) | 用表格写账号清单（`id, profile, 每账号参数…`），适合账号多的时候 | 见 [批量说明](../skills/browser-recipewright/references/batch.md) |
| [`patch.example.json`](patch.example.json) | 按步骤 id 打补丁：网站把帖子容器改名后，只替换 `collect-posts` 这一步的定位器 | `browser-recipewright patch x.com/search-read-posts examples/patch.example.json` 先看 diff，确认后加 `--write` |

## 内置配方 / Bundled recipes

| 配方 | 说明 | 需要登录 |
|---|---|---|
| [`demo/local-feed`](../templates/demo/local-feed.json) | 离线演示站上搜索并读帖子，用来检查安装、练习 snapshot / act / patch | 否 |
| [`x.com/search-read-posts`](../templates/x.com/search-read-posts.json) | X 关键词搜索 → 滚动找 N 条点赞 ≥ M 的帖子 → 读正文和评论（只读） | 是 |

```bash
browser-recipewright demo                                         # 离线演示，不需要账号
browser-recipewright run x.com/search-read-posts -i keyword="AI agent" -i count=5
```

想贡献新配方？请看 [配方贡献规则](../CONTRIBUTING.md#配方贡献规则)：只读优先、必须通过校验、必须真跑过。

---

Files here show *how to use* features (batch, account lists, patches). Runnable recipes live in [`templates/`](../templates/). New recipes are welcome, see [CONTRIBUTING](../CONTRIBUTING.md).
