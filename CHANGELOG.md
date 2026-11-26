# Changelog

本项目所有值得注意的变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
0.x 阶段模板格式（`schema/template.v0.json`）仍可能有不兼容变更，每次都会在这里写明。

All notable changes are listed here (Keep a Changelog format, SemVer). While on 0.x the template format may still change; breaking changes are always called out.

## [Unreleased]

### Added
- **可选：从自己的 Chrome 导入登录** `import-login <站点|配方>`：把你平时用的 Chrome 里这个网站的 cookie 一次性复制进隔离 profile（默认 `<站点>/default`），之后照常用隔离 profile 跑。只读取你的 Chrome（复制一份临时副本让 Chrome 自己解密，用完删除），只取这个网站的域名（`--domain` 可加登录域名），`--from` 选 Chrome 用户，`--list` 列出。失败时（Chrome 开着锁住文件、Mac 钥匙串被拒、Windows 应用绑定加密、该用户没登录）报 `IMPORT_FAILED` / `IMPORT_EMPTY`（退出码 3）并提示改用 `login`。默认仍推荐手动 `login`。
- **断点（`ask` 步骤）**：配方可以在中途停下，把问题和数据交给调用它的 Agent 判断（例如"这 30 条帖子里哪些真正相关"），浏览器停在原页面。`run` 以退出码 `4` 结束并打印问题；Agent 用 `browser-recipewright answer <runDir> --value ...` 回答后，同一次运行从这一步接着跑（循环、`if`、`group` 内部也行），记录写在同一个运行目录里。执行器自己从不调用模型。答案格式：`text` `number` `boolean` `choice` `pick`（从列表里挑编号）`json`。
- `browser-recipewright pending`：列出所有停在断点、等待回答的运行。
- `run --on-ask pause|default|fail`；`batch` 和 `selfcheck` 无人值守，断点使用步骤的 `default`（`batch.json` 可设 `"onAsk": "fail"`）。
- **片段编排**：配方可以写 `startOn`（`when` + 可选 `goto`），浏览器已经在对的页面时就地开始，所以 Agent 能在同一个浏览器里连续调用多个配方，边看结果边决定下一步；不在对的页面时打开 `goto` 或报 `START_PAGE_MISMATCH`。
- **flow**：新增 `recipe` 步骤，在同一个浏览器、同一份运行记录里调用另一个配方（片段）；flow 就是由 `recipe` 调用和 `ask` 断点组成的配方（`"kind": "flow"`）。`validate` 会检查被调用的配方是否存在、有效、输入齐全、没有循环调用。
- **任务记录**：`task start/note/show/list/end`。任务进行中，每次 `act`、`run`、`answer` 和 Agent 记下的判断都写进同一份 `journal.jsonl`；`--gap` 让片段之间有随机停顿。`task draft` 把这些记录整理成配方或 flow 草稿（act → 步骤，配方运行 → `recipe` 调用，判断 → `ask` 断点，`--param` 把固定值变成输入）。
- 运行数据格式 v1 新增（向后兼容）：`recipe.enter` 事件；任务记录 `tasks/<name>/journal.jsonl`。
- 运行数据格式 v1 新增（向后兼容）：`ask.start`、`ask.answered`、`run.pause`、`run.resume` 事件，步骤状态 `paused`，运行状态 `paused`，以及暂停期间的 `ask.json`。
- **多浏览器并行批量**：`batch.json` 的 `"parallel": N`（或 `batch --parallel N`，1–8）同时开多个浏览器，每个用自己的隔离 profile；同一个 profile 不会同时跑两个任务；启动之间仍按 `spacingMs` 错开，输入照样拟人。默认仍是 1（逐个跑）。
- **用量提醒（按 站点+账号）**：`batch.json` 的 `"remindAfter": N`：某个 profile 今天已跑满 N 次时只打印提醒、写进汇总的 `reminders`，照常运行，由人决定要不要停。每次 `run`、`batch`、`answer` 的运行都按 profile 记在 `usage/<站点>__<账号>.json`；`accounts` 命令显示每个 profile 今天的次数和条数。
- **多账号结果合并表**：批量结束时写 `merged.json` / `merged.csv`，所有账号的结果一张表，每条一行，前面带 `_job`、`_account`、`_profile` 列。
- **弹窗策略**：配方 `defaults.dialogs` 可设为 `accept`（或 `{ "action": "accept", "promptText": "..." }` 回答 prompt），`run` / `act` 可用 `--dialogs accept|dismiss` 覆盖；默认仍是关闭（dismiss）。每个弹窗都会记录成新的 `dialog` 事件（向后兼容）。
- `browser-recipewright selfcheck`：在自带的本地测试页上用内置配方 `selfcheck/basic` 跑一遍所有核心浏览器操作（输入、选择、勾选、点击、按键、等待、悬停、滚动提取、跳转、返回），并检查输入是否可信、拟人。每项一行通过 / 失败。

### Changed
- README（中英文）重写：按“配方片段 + Agent 现场编排 + 断点”讲清楚现在的功能，命令按用途分组，补上退出码 4，可视化说明为单独的插件，路线图更新。
- **默认 profile 统一一条规则**：没写 `-p` 时，所有命令都一样：有配方 → `<配方站点>/default`；`launch --url` → `<网址域名>/default`；否则用当前唯一在运行的浏览器；同时有多个在运行 → 报 `PROFILE_AMBIGUOUS`（退出码 2）让你用 `-p` 指定；都没有 → `<网址域名>/default` 或 `default/default`。选中的 profile 会打印出来。以前 `run` 用 `<站点>/default` 而 `snapshot`/`act` 用 `default/default`，`run --keep-open` 之后再 `snapshot` 会悄悄开一个空浏览器。
- `dailyCapPerAccount` 不再跳过任务，改为和 `remindAfter` 一样只提醒；计数从按账号 id 改为按 站点+账号（profile）。旧的按 id 计数文件不再读取。
- `waitFor` 的目标匹配到多个元素时视为“已出现”，不再报 `LOCATOR_AMBIGUOUS`（等一个列表出现时很常见）。
- `snapshot` 的 ref id 改为按元素本身（角色、名字、testid 等）生成的短哈希，同一个元素在多次快照之间 id 不变；页面上方新增内容不会让后面的 ref 全部错位。外观相同的元素依次加 `-2`、`-3`。
- 内部错误类 `RpaError` 改名为 `RecipeError`；Python 包的 `BrowserRpaError` 改名为 `RecipewrightError`（旧名保留为别名）。
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
