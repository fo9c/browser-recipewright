<div align="center">

# browser-recipewright

### AI 写配方，浏览器照着做

**为 AI 打造的 RPA：重复的活交给配方，需要判断的地方交给 AI，每一步都看得见。**

[![CI](https://github.com/fo9c/browser-recipewright/actions/workflows/ci.yml/badge.svg)](https://github.com/fo9c/browser-recipewright/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node >= 18.17](https://img.shields.io/badge/node-%3E%3D18.17-339933?logo=node.js&logoColor=white)](package.json)

[English](README.en.md) · [快速开始](#-快速开始) · [Mac 上手指南](docs/getting-started.zh.md) · [Skill 说明](skills/browser-recipewright/SKILL.md) · [更新日志](CHANGELOG.md)

</div>

---

## 💡 它是什么

你对 AI 说：「打开这个网站，搜一个关键词，把真正相关的结果整理成表格。」

- **AI 先自己摸索一次页面**，把能固定下来的做法写成一份 JSON **配方**（比如「搜索并收集 30 条结果」）。
- **之后浏览器照着配方做**：用你电脑上的真实 Chrome，拟人化的鼠标键盘，**不再调用模型**。
- **需要判断的地方停下来问 AI**：配方里可以放一个**断点**，把数据交给 Agent（比如「这 30 条里哪些真正相关？」），AI 回答后浏览器接着跑。
- **每一步都有记录**：网站改版时，AI 读失败现场，**只修坏掉的那一步**。

它不是一条从头写死到尾的流程。配方是**可复用的固定片段**，由 Agent 在现场边看结果边决定下一步调用哪个；跑顺了的组合可以存成 flow。适合**个人自动化和数据分析**。

```
你的一句话
   │
   ▼
Agent（Claude Code 等）现场编排，负责判断
   │
   ├─▶ 片段 A：搜索并收集 30 条        配方，照着做，不调用模型
   ├─▶ ⏸ 断点：哪些真正相关？          数据交给 AI 判断，再接着跑
   ├─▶ 片段 B：逐条打开读详情          配方，照着做，不调用模型
   │
   ▼
表格 / CSV          每一步写进运行记录；网站改版时只修失败的那一步
```

## ✨ 亮点

| | 说明 |
|---|---|
| ⚡ **高效** | 重复执行不调用模型；同一个浏览器里连续跑多个片段，不用每次重开；多账号可同时开多个浏览器并行 |
| 🧭 **可行** | 配方是声明式 JSON，跑之前就能静态校验；登录、验证码交给人；失败时有现场档案，AI 只改一步 |
| 🧠 **AI 在中间** | `ask` 断点把数据交给 Agent 判断，执行器自己从不调用模型，也不需要 API Key |
| 👀 **看得见每一步** | 每次运行都写统一格式的事件流，任何只读可视化插件都能读它回放 |

## 🚀 快速开始

```bash
git clone https://github.com/fo9c/browser-recipewright.git
cd browser-recipewright
npm install          # 会自动编译
npm link             # 之后就能直接用 browser-recipewright 命令

browser-recipewright doctor      # 环境检查：Node、Chrome、数据目录
browser-recipewright selfcheck   # 自检：在自带的本地测试页上跑一遍所有核心浏览器操作
browser-recipewright demo        # 离线演示：本地生成的信息流，搜索并读帖子
```

需要电脑上装有 Google Chrome 和 Node.js 18.17 以上。第一次用请看 **[Mac 上手指南](docs/getting-started.zh.md)**（安装 → 自检 → 演示 → 写自己的配方）。

### 让 AI 来用（以 Claude Code 为例）

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/browser-recipewright" ~/.claude/skills/browser-recipewright
```

然后直接用自然语言说你想在某个网站上做什么。其他能运行命令行的 Agent，把 [`SKILL.md`](skills/browser-recipewright/SKILL.md) 放进系统提示或规则文件即可。

## 🧩 核心能力

### 1. 配方：可复用的固定片段

- 21 个动作（打开、点击、输入、选择、滚动、批量提取、下载、断言……）加上 `if` / `forEach` / `while` / `group` / `recipe` 五种组合步骤。
- `validate` 不开浏览器就能检查引用、循环上限、站点域名、脚本白名单；错误必须修，警告可以跑。
- 配方可以写 `startOn`：浏览器已经在对的页面时就地开始，所以 Agent 能在同一个浏览器里一段接一段地调用。

### 2. 断点：把判断交给 AI

```json
{ "id": "pick-relevant", "action": "ask",
  "question": "这些帖子里哪些真正在讲 {{inputs.topic}}？",
  "data": "{{vars.posts}}", "answer": { "type": "pick", "max": 10 },
  "default": [], "saveAs": "relevant" }
```

运行到这里会停下（退出码 `4`），浏览器留在原页面。Agent 看完数据后执行
`browser-recipewright answer <运行目录> --value "[0,3]"`，同一次运行从这一步接着往下跑。
答案类型有 `text` `number` `boolean` `choice` `pick` `json`；无人值守时（批量、自检）用 `default`。
`pending` 列出所有在等回答的运行。

### 3. flow 与任务记录：从现场操作长出配方

- `recipe` 步骤在同一个浏览器、同一份运行记录里调用另一个配方；由 `recipe` 调用和 `ask` 断点组成的配方就是 **flow**。
- 新情况 AI 用 `act` 一步一步现场操作，输入同样走拟人化的鼠标键盘。
- `task start` 之后，每次 `act`、`run`、`answer` 和 AI 记下的判断都写进同一份记录；`task draft` 把它整理成**配方或 flow 草稿**（固定值可用 `--param` 变成输入）。

### 4. 真实浏览器，拟人化输入

- 用你电脑上的 Google Chrome，干净的启动参数，通过 [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) 走 CDP 连接，页面脚本在隔离环境运行。
- 鼠标沿轨迹移动、按下前重新瞄准；逐字输入节奏有快有慢；焦点被抢走会放回原处；窗口被遮挡或最小化也照常运行。
- 遇到登录或验证码会暂停，把窗口交给你，处理完自动继续。AI 不会尝试绕过验证码。

### 5. 隔离的浏览器和账号

- 每个账号一个独立的 Chrome 用户目录（`<站点>/<账号>`），**和你自己平时用的 Chrome 完全分开**；登录一次，长期有效。
- 不写 `-p` 时所有命令按同一条规则选 profile（有配方就用 `<站点>/default`），选中的会打印出来。
- `login`：打开这个 profile 让你手动登录一次（推荐的默认方式）。
- `import-login`（**可选**）：把你自己 Chrome 里某个网站的 cookie 一次性复制进隔离 profile。只读取、不接管你的 Chrome；失败就改用 `login`。

### 6. 多账号批量

- 账号清单 × 配方 × 每个账号的参数，带间隔、跳过登录失效的账号、断点续跑。
- `"parallel": N` 同时开多个浏览器，每个用自己的 profile。
- 结束时把所有账号的结果合并成一张表：`merged.json` / `merged.csv`。
- `"remindAfter": N`：某个账号今天跑满 N 次时**只提醒、不拦截**，由你决定要不要停。

### 7. 记录与修复

- 每步一条记录：命中了哪个定位器、耗时、URL、错误码。失败时自动打包现场档案（截图、页面快照、上次成功时的记录、下一步该跑的命令）。
- `heal` 输出现场档案 → AI 写一个只针对失败步骤 id 的补丁 → `patch` 显示改动对比 → `run --resume` 从失败处续跑验证。

## ✅ 自检：确认这台电脑能正确操作浏览器

`browser-recipewright selfcheck` 在本机启动一个自带的测试网页（不联网、不需要账号），用内置配方 `selfcheck/basic` 逐项检查，每项一行通过 / 失败：

| 类别 | 检查项 |
|---|---|
| 导航 | 打开页面、点击链接跳转、浏览器返回 |
| 表单与键盘 | 逐字输入、下拉选择、勾选、按回车 |
| 鼠标 | 沿轨迹移动后点击、悬停显示提示 |
| 等待 | 1.5 秒后才出现的内容 |
| 滚动与提取 | 滚动分批加载的列表并提取全部 40 条 |
| 断点 | `ask` 步骤停下交给 Agent（自检时用默认答案） |
| 拟人化 | 输入都是可信事件、点击前有鼠标轨迹、按键节奏有快有慢、`navigator.webdriver` 未暴露 |

单元测试和端到端测试（真实 Chrome + 本地测试页）在每次提交时由 CI 运行。

## ⚖️ 和其他方式比

| | 每步都问大模型的浏览器 Agent | 传统 RPA（录制回放） | 手写 Playwright 脚本 | **browser-recipewright** |
|---|---|---|---|---|
| 谁来写流程 | 不写，每次现场推理 | 人录制 / 拖拽 | 程序员写代码 | **AI 写配方片段，人可审阅** |
| 需要判断时 | 模型现场判断 | 只能写规则 | 只能写规则 | **断点交给 AI，其余照配方** |
| 重复执行的模型成本 | 每一步都要调用 | 无 | 无 | **只有断点处由 Agent 判断** |
| 流程能否静态检查 | 没有固定流程 | 多为私有格式 | 任意代码，需审查 | **声明式 JSON + Schema 校验** |
| 网站改版后 | 现场重新推理 | 人工重录 | 人工改代码 | **现场档案 + 只修失败那一步** |

## 📖 命令一览

所有命令在 stdout 输出 JSON（方便 AI 解析），进度信息在 stderr。完整参数见 `browser-recipewright <命令> --help`。

| 用途 | 命令 |
|---|---|
| 环境与自检 | `doctor` · `selfcheck` · `demo` · `demo-server` |
| 浏览器与账号 | `launch` · `close` · `sessions` · `login` · `import-login`（可选）· `accounts` |
| 现场探索 | `snapshot`（页面大纲 + 稳定的 `[ref=…]` + 现成定位器）· `act`（试运行一步）· `screenshot` |
| 配方 | `validate` · `run` · `list` · `show` · `save` · `schema` |
| 断点 | `answer` · `pending` |
| 任务记录 | `task start / note / show / list / end / draft` |
| 批量 | `batch`（`--parallel`、`--resume`、`--dry-run`） |
| 记录与修复 | `runs` · `inspect` · `events` · `check-run` · `heal` · `patch` |

退出码：`0` 成功 · `1` 配方或步骤问题（AI 可修）· `2` 输入或配方无效 · `3` 环境问题（登录、验证码、浏览器，交给人）· `4` 停在断点，等 Agent 回答。

## 👀 运行数据与可视化

每次运行都会在 `runs/<id>/` 写下统一格式的数据：`events.jsonl` 事件流（步骤、循环进度、提取的数据、页面跳转、鼠标轨迹、断点、人工接管……）、`run.json`、`output.json`。

可视化界面**不捆绑**在执行器里，而是单独下载的只读插件，读这些文件即可：`events --follow` 可以边跑边读，`check-run` 校验数据是否符合格式。完整的可视化插件还在做；仓库里有一个零依赖的[终端时间线示例](examples/viewer-plugin-minimal)。格式见 [入门版](docs/viewer-plugins.zh.md) 和 [规范](docs/run-data-format.md)。

## 📚 文档

- [Mac 上手指南](docs/getting-started.zh.md)
- [配方格式参考（动作、定位器、条件、断点、flow、错误码）](skills/browser-recipewright/references/template-format.md)
- [多账号批量](skills/browser-recipewright/references/batch.md)
- [Skill 说明（给 AI 看的）](skills/browser-recipewright/SKILL.md)
- [架构说明](docs/architecture.md) · [运行数据格式](docs/run-data-format.md)
- [负责任使用说明](docs/responsible-use.md) · [参与贡献](CONTRIBUTING.md) · [维护手册](docs/MAINTAINING.md)
- Python 小工具：[`python/`](python/README.md)

<details>
<summary><b>目录结构</b></summary>

```
src/            TypeScript 内核：browser（启动/连接）、locator、human（拟人化输入）、engine（执行器）、
                ask（断点）、flow（片段编排）、task（任务记录）、validate、records / events（运行记录）、
                heal（补丁）、batch（批量）、import-login、cli
templates/      内置配方：selfcheck/basic（自检）、demo/local-feed（离线演示），只针对本地页面
demo-site/      本地测试页：自检页 + 离线演示站（生成的假数据）
skills/         Skill 分发形态（SKILL.md + references）
schema/         配方和运行事件的 JSON Schema
scripts/        白名单页面脚本 + manifest（sha256 + 域名限制）
examples/       批量示例、补丁示例、最小可视化插件
python/         Python 小工具（调用 CLI、读运行记录、导出 CSV）
tests/          单元测试 + 端到端测试（真实 Chrome + 本地测试页）
```

</details>

## 🗺️ 路线图

- [x] 声明式配方、静态校验、拟人化执行器、运行记录与现场档案
- [x] 按步骤补丁 + 续跑、多账号批量、Skill 分发
- [x] 断点（`ask`）、片段编排、flow、任务记录 → 配方草稿
- [x] 统一的默认 profile、多浏览器并行批量、结果合并表、用量提醒、可选的登录导入
- [ ] 单独下载的可视化插件：实时展示网页、事件流和数据流，可回放
- [ ] 发布到 npm，`npx browser-recipewright` 一键体验

## 🤝 参与

欢迎提 Issue 和 PR，请先看 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 边界

只用于你有权使用的账号和数据，遵守网站条款和访问频率。不破解验证码、不收集密码、不做群发。详见[负责任使用说明](docs/responsible-use.md)。

## 许可证

Apache-2.0。依赖 patchright / Playwright（Apache-2.0）。本项目为独立实现，不包含任何闭源 RPA 产品的代码。
