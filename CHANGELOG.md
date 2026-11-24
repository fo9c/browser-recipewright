# Changelog

本项目所有值得注意的变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
0.x 阶段模板格式（`schema/template.v0.json`）仍可能有不兼容变更，每次都会在这里写明。

All notable changes are listed here (Keep a Changelog format, SemVer). While on 0.x the template format may still change; breaking changes are always called out.

## [Unreleased]

### Added
- `browser-recipewright selfcheck`：在自带的本地测试页上用内置配方 `selfcheck/basic` 跑一遍所有核心浏览器操作（输入、选择、勾选、点击、按键、等待、悬停、滚动提取、跳转、返回），并检查输入是否可信、拟人。每项一行通过 / 失败。

### Changed
- 不再内置任何真实网站的配方；`templates/` 只保留针对本地测试页的 `selfcheck/basic` 和 `demo/local-feed`。示例、文档和 Skill 里的站点一律改用 example.com 或本地演示站。
- 离线演示站改用中性的 test id（`post`、`post-text`、`author`、`account-menu` 等）。
- Python `flatten_posts` 不再写死域名，新增 `base` 参数。

### Fixed
- `back` 返回到浏览器缓存（back/forward cache）里的页面时不再白等 30 秒超时。
- 用户在运行中动了浏览器窗口也不会出错（#1）：
  - 窗口最小化、被遮挡或切到后台标签页时，Chrome 保持全速运行（加入防后台节流的启动参数）。
  - 鼠标移动到目标后、按下前重新测量点击点；目标位置变了就重新瞄准，最多 3 次。
  - 输入文字前确认焦点在目标输入框，每次按键前焦点被抢走会放回原处。

### Added
- **运行数据标准 v1**（`recipewright.run/1`）：每次运行都会写 `events.jsonl` 事件流（步骤开始/结束/重试、循环进度、提取的数据、页面跳转、鼠标轨迹、人工接管等），`run.json` 带 `format` 版本号，`runs/_latest.json` 指向最新一次运行。可视化界面改为单独下载的只读插件，读这些文件即可，执行器不捆绑任何界面。见 [docs/run-data-format.md](docs/run-data-format.md)、[入门版](docs/viewer-plugins.zh.md)。
  Run data format v1: every run writes an `events.jsonl` stream for read-only viewer plugins; nothing is bundled.
- 新命令：`events [runDir] [-f]`（输出/跟随事件流）、`check-run [runDir]`（校验运行数据）、`schema --run-events`（事件 JSON Schema，`schema/run-events.v1.json`）。
- 示例插件 [examples/viewer-plugin-minimal](examples/viewer-plugin-minimal)：零依赖，终端里显示运行时间线。
- 端到端测试：点击中途目标被移走、输入中途焦点被抢走；运行数据格式校验（共 27 个测试）。
- 仓库维护文件：CHANGELOG、CONTRIBUTING、SECURITY、负责任使用说明、Issue / PR 模板、Dependabot。
- CI：Node 20 / 22 矩阵、内置模板静态校验、手动触发。

## [0.1.2] - 2026-11-23

### Changed
- 项目改名为 **browser-recipewright**（原 browser-rpa）：npm 包、CLI 命令、Skill、Python 包、环境变量 `BROWSER_RECIPEWRIGHT_*` 全部改名。
  旧的数据目录 `~/.browser-rpa` 和 `BROWSER_RPA_*` 环境变量仍然有效。

### Fixed
- `login` 会把模板输入（默认值 + `-i`）填进 `loginUrl` / `checkUrl` / `loginCheck`；不再停在 about:blank。
- `--resume`：第 1 步之前就写检查点；没有 `state.json` 的运行会带着原输入从第 1 步重来。
- `--resume`：`forEach` 每处理完一项就写检查点，已读过的帖子不会重读。
- `launch` / `snapshot` / `screenshot --url`：页面一直加载不完时给出警告并继续，而不是失败。

### Added
- `screenshot` 命令和 `act --screenshot`。
- 3 个新的端到端测试（共 22 个）。

## [0.1.1] - 2026-11-23

### Added
- 任意步骤可用 `appendTo` 把结果追加到列表变量（数组会展开，可选 `dedupeBy` 去重）。
- `forEach.flatten` 合并每轮的数组；新增过滤器 `flatten`、`compact`。

### Changed
- `act collect` 输出条数、样例、空字段和统计，而不是截断的记录。
- 续跑日志写明从哪一步继续：`resuming at top-level step N/M "id"`。
- 校验器：`appendTo` 的变量视为已声明；`saveAs` 与 `appendTo` 同名报错。

## [0.1.0] - 2026-11-22

首个版本。

- 模板格式 v0：20 个原子动作 + `if` / `forEach` / `while` / `group`，zod schema + JSON Schema 导出。
- 静态校验：引用、循环上限、站点域名、脚本白名单、定位器警告。
- 执行器：patchright 经 CDP 连接自启动的系统 Chrome，干净启动参数，每账号独立 Profile，隔离环境页面脚本，拟人化可信输入，多候选定位器并记录命中。
- 运行记录（run.json、steps.jsonl、state.json、output.json）和失败现场档案。
- 登录 / 验证码交给人处理；按步骤 id 打补丁（带 diff、版本号 +1）；`--resume` 续跑。
- 多账号批量：间隔、每日上限、跳过登录失效账号、续跑。
- 内置模板 `demo/local-feed` + 离线演示站。
- Skill、中文 README + Mac 上手指南、Python 小工具、单元 + 端到端测试、CI。

[Unreleased]: https://github.com/fo9c/browser-recipewright/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/fo9c/browser-recipewright/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/fo9c/browser-recipewright/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/fo9c/browser-recipewright/releases/tag/v0.1.0
