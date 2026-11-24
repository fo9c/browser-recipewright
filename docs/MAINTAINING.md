# 维护手册 / Maintainer guide

给维护者看的：怎么发版、怎么处理 Issue 和 PR、怎么保持仓库健康。

## 分支与提交

- `main` 永远可用：CI 全绿才合并。
- 一次改动拆成多个小提交，每个提交一句话说清楚（`fix:` / `feat:` / `docs:` / `ci:` / `chore:`）。
- 改动走 PR，即使是维护者自己的改动，方便留下记录和跑 CI。

## 发版流程

版本号遵循语义化版本。0.x 阶段：新功能或配方格式不兼容变更升 minor（0.2.0），修复升 patch（0.1.3）。

1. 确认 `main` 上 CI 是绿的。
2. 把 `CHANGELOG.md` 里 `[Unreleased]` 的内容移到新版本标题下，写上日期，更新底部对比链接。
3. 同步改 `package.json` 的 `version`（Python 小工具有变化时也改 `python/pyproject.toml`）。
4. 提交：`chore(release): v0.1.3`，合并到 `main`。
5. 打标签并推送：
   ```bash
   git tag -a v0.1.3 -m "v0.1.3" && git push origin v0.1.3
   ```
6. 在 GitHub → Releases → Draft a new release，选这个标签，正文贴 CHANGELOG 对应段落，配一张截图或动图。
7. （发布到 npm 之后）`npm publish`。

## Issue 处理

| 标签 | 含义 |
|---|---|
| `triage` | 新 Issue，还没看（模板自动加） |
| `bug` | 工具本身的问题 |
| `selfcheck` | `selfcheck` 在某台机器上没通过 |
| `enhancement` | 功能建议 |
| `good first issue` | 适合新人：文档、自检页小改进、小修复 |
| `help wanted` | 欢迎社区来做 |
| `needs-info` | 等报告人补充信息，14 天没回复就关闭 |
| `wontfix` / `out-of-scope` | 不做，例如违反[负责任使用说明](responsible-use.md)的需求 |

建议节奏：每周看一次新 Issue，48 小时内给第一条回复（哪怕只是"收到，会看"）。回复快是让新项目显得可靠的最有效方式。

自检没通过的 Issue：先让报告人贴 `selfcheck` 的完整输出和 `heal <运行目录>`，按失败的检查项定位到执行器的问题。仓库不收真实网站的配方，这类 PR 礼貌关闭并说明原因。

## PR 审查清单

- CI 绿：构建、单元、端到端、配方校验。
- 行为变化有测试，有 CHANGELOG 条目。
- 不包含针对真实网站的配方、没有隐私数据。
- 不接受：绕过验证码、自动填密码、刷量、"无法检测"之类的功能或宣传。

## 依赖更新

Dependabot 每周提 npm 更新、每月提 GitHub Actions 更新。patchright 升级要特别留意：合并前在本机跑一遍 `npm test` 和 `browser-recipewright doctor`，再跑一次 `browser-recipewright selfcheck`（带窗口）。

## 安全报告

按 [SECURITY.md](../SECURITY.md)：通过 GitHub 私密报告接收，7 天内回复，修复后发 patch 版本并在 Release 里致谢。
