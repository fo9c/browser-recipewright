<div align="center">

# browser-recipewright

**为 AI 打造的高效 RPA：AI 写配方，浏览器照着做。**

AI 探索一次网页，写下一份可复用的「配方」；之后真实 Chrome 照着配方拟人化执行，不再消耗模型调用。<br>
每一步都有记录，网站改版时只修坏掉的那一步。适合个人自动化和数据分析。

[![CI](https://github.com/fo9c/browser-recipewright/actions/workflows/ci.yml/badge.svg)](https://github.com/fo9c/browser-recipewright/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node >= 18.17](https://img.shields.io/badge/node-%3E%3D18.17-339933?logo=node.js&logoColor=white)](package.json)
[![Agent Skill](https://img.shields.io/badge/Agent%20Skill-Claude%20Code%20%7C%20Codex%20%7C%20Cursor-8A63D2)](skills/browser-recipewright/SKILL.md)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[English](README.en.md) · [快速体验](#快速体验) · [Mac 上手指南](docs/getting-started.zh.md) · [配方示例](examples/) · [更新日志](CHANGELOG.md)

</div>

<!-- TODO: 演示动图 docs/assets/demo.gif（AI 探索 → 生成配方 → 浏览器回放 + 实时可视化），录好后替换这一行 -->

## 一句话理解

> 你对 AI 说「打开这个网站，搜某个关键词，把前 20 条结果的标题和链接整理成表格」。
> AI 第一次自己摸索页面，把做法写成一份 JSON 配方；以后同样的事，浏览器直接照配方做，**快、稳、可复查**。

```
  ① 探索（AI 看页面、试点击）  →  ② 配方（声明式 JSON，可校验、可审阅）  →  ③ 回放（真实 Chrome，逐步记录）
                                              ▲                                        │ 网站改版
                                              └──── ④ 只修失败的那一步（补丁 + 续跑） ◀──┘
```

## 自检：确认浏览器能被正确操作

装好后跑一次 `browser-recipewright selfcheck`。它会在本机启动一个自带的测试网页（不联网、不需要账号），用内置配方 `selfcheck/basic` 逐项检查：

| 检查项 | 说明 |
|---|---|
| 打开页面、点击链接跳转、浏览器返回 | 导航 |
| 逐字输入、下拉选择、勾选、按回车 | 表单与键盘 |
| 鼠标沿轨迹移动后点击、悬停显示提示 | 鼠标 |
| 等待 1.5 秒后才出现的内容 | 等待 |
| 滚动分批加载的列表并提取全部 40 条 | 滚动与批量提取 |
| 页面看到的输入都是可信事件、按键节奏有快有慢、`navigator.webdriver` 未暴露 | 拟人化输入 |

每项一行通过 / 失败，失败时会给出错误码和运行记录目录。自动化测试（单元 + 端到端，真实 Chrome + 本地测试页）在每次提交时由 CI 运行。

## 和其他方式比

| | 每步都问大模型的浏览器 Agent | 传统 RPA（录制回放） | 手写 Playwright 脚本 | **browser-recipewright** |
|---|---|---|---|---|
| 谁来写流程 | 不写，每次现场推理 | 人录制 / 拖拽 | 程序员写代码 | **AI 写一次配方，人可审阅** |
| 重复执行的模型成本 | 每一步都要调用 | 无 | 无 | **无（回放不调用模型）** |
| 流程能否静态检查、安全分享 | 没有固定流程 | 多为私有格式 | 是任意代码，需审查 | **声明式 JSON + Schema 校验，脚本白名单** |
| 网站改版后 | 现场重新推理 | 人工重录 | 人工改代码 | **现场档案 + 只修失败那一步** |
| 每步可追溯 | 视实现而定 | 部分 | 自己加日志 | **每步一行记录，失败自动打包现场** |
| 需要的 API Key | 需要 | 不需要 | 不需要 | **工具本身不需要（用你已有的 Agent）** |

## 特点

- **一份模板，三种读者**：AI 写、人审、执行器跑。模板是声明式 JSON（20 个原子动作 + 4 个控制流），能在不开浏览器的情况下静态校验。
- **真浏览器、低特征**：用你电脑上的 Google Chrome，干净的启动参数（没有 `--enable-automation`），通过 [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) 走 CDP 连接；页面内脚本在隔离环境运行；鼠标和键盘是可信事件并带拟人化轨迹；每个站点每个账号一个独立的 Chrome Profile，登录一次长期有效。
- **每一步都有记录**：每步写一行运行记录（命中了哪个定位器、耗时、URL、错误码），失败时自动打包"现场档案"（截图 + 页面快照 + 上次成功时的记录 + 下一步该跑的命令）。
- **坏了只修那一步**：AI 读现场档案，写一个只针对失败步骤 id 的补丁，`patch` 显示改动对比，`--resume` 从失败处续跑验证。
- **登录和验证码交给人**：遇到未登录或验证码会暂停，把窗口交给你，处理完自动继续；AI 不会去改模板、也不会尝试绕过验证码。
- **多账号批量**：账号清单 × 模板 × 每账号参数，带间隔、每日上限、跳过登录失效账号、每账号独立记录、断点续跑。
- **不绑定 Agent**：主要以 Skill 形式分发（`skills/browser-recipewright/SKILL.md`），任何能运行命令行的 Agent 都能用。

> 第一次使用请看 **[Mac 上手指南](docs/getting-started.zh.md)**（10 分钟：安装 → 自检 → 离线演示 → 写自己的配方）。

## 快速体验

```bash
git clone https://github.com/fo9c/browser-recipewright.git
cd browser-recipewright
npm install          # 会自动编译
npm link             # 之后就能直接用 browser-recipewright 命令

browser-recipewright doctor      # 环境检查：Node、Chrome、navigator.webdriver
browser-recipewright selfcheck   # 自检：在本地测试页上跑一遍所有核心浏览器操作
browser-recipewright demo        # 离线演示：本地生成的无限滚动信息流，搜索并读帖子
```

要在你自己常用的网站上用，让 AI 用 `snapshot` / `act` 探索页面，再把做法保存成配方（见 [Skill 说明](skills/browser-recipewright/SKILL.md)）。

结果在命令输出的 `output` 路径里（`output.json`），完整记录在 `runDir`。

## 让 AI 使用（Claude Code 为例）

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/browser-recipewright" ~/.claude/skills/browser-recipewright
```

然后直接用自然语言告诉 Claude 你想在某个网站上做什么，例如"用 browser-recipewright 打开 <网址>，搜索 <关键词>，把前 20 条结果整理成表格"。
其他 Agent（Codex、Cursor、自研 Agent）把 `skills/browser-recipewright/SKILL.md` 的内容放进系统提示或规则文件即可。

## 工作方式

```
  AI 探索 (snapshot / act)  ─┐
  人工手写 / 改模板          ─┼─▶  模板 JSON ──validate──▶ run ──▶ 运行记录 runs/<id>/
  模板库 (list / save)      ─┘                                │
                                                              ▼ 失败
                                  patch（只改失败的那一步） ◀── heal（现场档案）
                                          └──── run --resume 验证 ────┘
```

## 命令一览

| 命令 | 作用 |
|---|---|
| `doctor` | 环境检查 |
| `selfcheck` | 在本地测试页上检查所有核心浏览器操作 |
| `demo` / `demo-server` | 离线演示 / 只启动演示站和自检页 |
| `login <模板或站点> [-p 账号]` | 打开该账号的浏览器让人登录一次 |
| `launch` / `close` / `sessions` | 启动、关闭、列出常驻浏览器 |
| `snapshot [--json] [--text]` | 页面大纲 + `[ref=rN]` + 每个 ref 的现成定位器 |
| `act <动作> --ref rN ...` | 试运行单个步骤（和模板步骤语义相同） |
| `validate <模板>` | 静态校验（错误必须修，警告可以跑） |
| `run <模板> -i k=v [-p 账号] [--resume 运行目录]` | 运行 / 从失败处续跑 |
| `list` / `show` / `save` / `schema` | 模板库 |
| `runs` / `inspect <运行目录>` | 查看运行记录 |
| `heal <运行目录>` | 输出失败现场档案 |
| `patch <模板> <补丁.json> [--write]` | 按步骤 id 打补丁，版本号 +1，旧版本进 `.history/` |
| `batch <batch.json>` / `batch --resume <目录>` | 多账号批量 / 续跑 |
| `accounts` | 本机账号 Profile、今日使用次数 |

所有命令在 stdout 输出 JSON（方便 AI 解析），进度信息在 stderr。退出码：`0` 成功、`1` 模板/步骤问题、`2` 输入或模板无效、`3` 环境问题（登录、验证码、浏览器）。

## 文档

- [Mac 上手指南](docs/getting-started.zh.md)
- [模板格式参考（动作、定位器、条件、运行记录、错误码）](skills/browser-recipewright/references/template-format.md)
- [多账号批量](skills/browser-recipewright/references/batch.md)
- [Skill 说明（给 AI 看的）](skills/browser-recipewright/SKILL.md)
- [架构说明](docs/architecture.md)
- [负责任使用说明](docs/responsible-use.md) · [参与贡献](CONTRIBUTING.md) · [维护手册](docs/MAINTAINING.md) · [更新日志](CHANGELOG.md)
- Python 小工具：[`python/`](python/README.md)

## 目录结构

```
src/            TypeScript 内核：browser（启动/连接）、locator、human（拟人化输入）、engine（执行器）、
                validate（静态校验）、records（运行记录）、heal（补丁）、batch（批量）、cli
templates/      内置配方（selfcheck/basic 自检、demo/local-feed 演示），只针对本地页面
scripts/        白名单页面脚本 + manifest（sha256 + 域名限制）
skills/         Skill 分发形态（SKILL.md + references）
schema/         模板 JSON Schema
demo-site/      本地测试页：自检页 + 离线演示站（生成的假数据）
python/         Python 小工具（调用 CLI、读运行记录、导出 CSV）
tests/          单元测试 + 端到端测试（真实 Chrome + 演示站）
```

## 路线图

- [x] 声明式配方格式 v0、静态校验、拟人化执行器、运行记录与现场档案
- [x] 按步骤补丁 + 续跑、多账号批量、Skill 分发
- [ ] 实时可视化面板：执行时同步展示网页、事件流和数据流，可回放
- [ ] 无障碍树（AX tree）优先的定位器，CSS / 文本兜底
- [ ] 发布到 npm，`npx browser-recipewright` 一键体验

## 参与

欢迎提 Issue 和 PR。请先看 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 边界

只用于你有权使用的账号和数据，遵守网站条款和频率限制。不做验证码破解、不收集密码、不做群发。多账号功能面向合规的多店铺/多品牌运营；平台禁止协同的虚假行为。详见[负责任使用说明](docs/responsible-use.md)。

## 许可证

Apache-2.0。依赖 patchright / Playwright（Apache-2.0）。本项目为独立实现（clean-room），不包含任何闭源 RPA 产品的代码。
