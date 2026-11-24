# Mac 上手指南（约 10 分钟）

这份指南假设你没用过 Playwright / patchright 也没关系。每一步都写了"应该看到什么"。


> **从 browser-rpa 升级过来？** 项目已改名为 browser-recipewright，命令也变成 `browser-recipewright`。旧的数据文件夹 `~/.browser-rpa`（里面有登录状态、运行记录、模板）会被自动继续使用；想换成新名字，关掉所有浏览器窗口后运行 `mv ~/.browser-rpa ~/.browser-recipewright` 即可。旧命令要先 `npm unlink -g browser-rpa`，再在新目录里 `npm link`。

## 1. 准备

需要两样东西：

- **Google Chrome**（平时用的那个就行，装在"应用程序"里）。
- **Node.js 18 或更新版本**。在"终端"里输入 `node -v`，如果提示找不到命令，或版本低于 18：
  ```bash
  brew install node        # 没有 Homebrew 的话，去 https://nodejs.org 下载安装包也可以
  ```

> browser-recipewright 不会下载额外的浏览器，它直接使用你电脑上的 Chrome，但会为每个账号建一个**独立的 Chrome 资料夹**（在 `~/.browser-recipewright/profiles/` 里），不会动你平时用的 Chrome 的书签、密码和登录状态。

## 2. 安装

```bash
cd ~                       # 放哪都行
git clone https://github.com/fo9c/browser-recipewright.git
cd browser-recipewright
npm install                # 安装依赖并自动编译（第一次约 1 分钟）
npm link                   # 注册 browser-recipewright 命令
```

如果 `npm link` 报权限错误，可以先不用它，把下面所有的 `browser-recipewright` 换成 `node bin/browser-recipewright.js`（在 browser-recipewright 目录里执行）。

## 3. 自检

先检查环境：

```bash
browser-recipewright doctor
```

应该看到一串 ✅，其中 `navigator.webdriver: false` 表示浏览器没有暴露"自动化"标记。如果 Chrome 显示 ❌，确认 Chrome 装在 `/Applications/Google Chrome.app`，或者设置路径：
`export BROWSER_RECIPEWRIGHT_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`。

再检查浏览器操作是否都正常：

```bash
browser-recipewright selfcheck
```

会弹出一个 Chrome 窗口，打开项目自带的**本地测试页**（不联网、不需要账号），然后自动完成：输入文字、下拉选择、勾选、点击、按回车、等待延迟出现的内容、悬停、滚动加载列表并提取 40 条、点链接跳转再返回。最后检查页面看到的输入是不是"像人"：都是可信事件、鼠标有移动轨迹、打字有快有慢、`navigator.webdriver` 没有暴露。

终端里每项一行 ✅ / ❌，全部通过会显示 **自检通过**。失败的话会写出错误码和记录目录，把目录发给 Claude 就能看到哪一步出了问题。加 `--headless` 可以不弹窗口。

## 4. 离线演示（不用联网、不碰真实账号）

```bash
browser-recipewright demo
```

会发生什么：

1. 弹出一个 Chrome 窗口，打开本地的演示站（一个无限滚动的信息流，内容是随机生成的）。
2. 第一次会提示"未登录"，终端里出现 **🙋 需要人工处理**。在窗口里点 **Log in** 按钮——程序会自己检测到并继续。这就是"人工接管"（以后在真实网站上遇到登录或验证码也是这个流程）。
3. 它会搜索、边滚动边收集 5 条点赞 ≥100 的帖子，逐条打开读正文和评论。
4. 结束后终端输出一段 JSON，`output` 是结果文件路径，`runDir` 是这次运行的全部记录。

看一下记录：

```bash
browser-recipewright runs                       # 最近的运行
browser-recipewright inspect <runDir>           # 每一步：状态、命中第几个定位器、耗时
open <runDir>                          # 在 Finder 里打开：run.json / steps.jsonl / output.json
```

## 5. 在你自己的网站上用

项目本身只带针对本地测试页的配方。要在你常用的网站上自动化，让 AI 来写配方（见下一节）：它会先用 `snapshot` / `act` 探索页面，再写成配方、校验、试跑，最后保存到你本机的配方库（`~/.browser-recipewright/templates/`）。

需要登录的网站，先登录一次（登录状态保存在这个账号专用的 Chrome 资料夹里）：

```bash
browser-recipewright login <你的配方id>            # 或者：login 网站域名
```

在弹出的窗口里正常登录，成功后程序会自动检测到并关闭窗口。同一网站多个账号用 `-p 网站/账号名` 区分，例如 `-p example.com/work`。

运行时窗口会显示出来，你可以看着它操作（请不要同时在这个窗口里点来点去）。过程中如果出现验证码，终端会提示你手动处理，处理完自动继续。

## 6. 让 Claude Code 来用

```bash
mkdir -p ~/.claude/skills
ln -s ~/browser-recipewright/skills/browser-recipewright ~/.claude/skills/browser-recipewright
```

然后在 Claude Code 里说，例如：

- "用 browser-recipewright 打开 <网址>，搜索 <关键词>，把前 20 条结果的标题和链接整理成表格。"
- "帮我写一个配方：打开 <网址> 的某个列表页，收集最近 20 条内容。"（它会先 snapshot 探索，再写配方、校验、试跑）
- "上次运行失败了，帮我看看怎么回事"（它会读现场档案，只修失败的那一步）

## 7. 如果失败了

终端会显示失败的步骤和错误码，例如 `✗ failed at collect-posts: LOCATOR_NOT_FOUND`。

- 错误码是 `LOGIN_REQUIRED` / `CHALLENGE_DETECTED`：是环境问题（没登录、验证码），重新 `login` 后用
  `browser-recipewright run <配方id> --resume <runDir>` 从失败处继续。
- 其他错误码：通常是网站改版导致定位器失效。运行 `browser-recipewright heal <runDir>` 看现场档案，或者直接让 Claude 处理。
- Chrome 起不来：可能这个账号的窗口还开着，`browser-recipewright close --all` 后重试。

把 `<runDir>` 整个文件夹发给我（或者 Claude），就能看到每一步发生了什么。

## 数据都放在哪

```
~/.browser-recipewright/
├── profiles/<站点>/<账号>/   每个账号独立的 Chrome 资料夹（含登录状态，别分享给别人）
├── runs/<运行 id>/          每次运行的记录
├── batches/<批次 id>/       批量任务记录
├── templates/              你保存或修复过的模板
└── sessions/               正在运行的浏览器信息
```

想换位置：`export BROWSER_RECIPEWRIGHT_HOME=/某个/目录`。
