# 参与贡献 / Contributing

谢谢你愿意帮忙！这个项目欢迎两类贡献：

1. **报告问题**：安装失败、`selfcheck` 没通过、文档看不懂、执行器行为不对。请用 [Issue 模板](https://github.com/fo9c/browser-recipewright/issues/new/choose)，附上 `browser-recipewright doctor` 和 `browser-recipewright selfcheck` 的输出；运行失败时附上 `heal <运行目录>` 的输出（记得先删掉账号名、Cookie 等隐私信息）。
2. **改代码**：修 bug、加动作、改执行器、改进本地自检页。大的改动请先开 Issue 讨论，避免白做。

**本仓库不收针对真实网站的配方。** 仓库里只放引擎和针对本地测试页的配方（`selfcheck/basic`、`demo/local-feed`）。真实网站的配方由你的 AI 在你本机生成、保存在你自己的 `~/.browser-recipewright/templates/`。

English: issues and code are welcome. Use the issue templates and include `doctor` and `selfcheck` output. This repo does not accept recipes for real websites; it only bundles recipes for its own local test pages.

## 开发环境

```bash
git clone https://github.com/fo9c/browser-recipewright.git
cd browser-recipewright
npm install            # 会自动编译 TypeScript 到 dist/
npm test               # 单元测试 + 端到端测试（需要本机装有 Google Chrome）
npm run test:unit      # 只跑单元测试，不需要浏览器
npm run validate:templates   # 静态校验所有内置配方
```

需要 Node.js ≥ 18.17（CI 用 20 和 22）。端到端测试用的是仓库自带的离线演示站 `demo-site/`，不会访问外网。

## 提交 Pull Request

- 从 `main` 新建分支，一个 PR 只做一件事。
- 提交信息用一句话说清楚改了什么，例如 `fix(locator): retry when candidate is detached`、`docs: ...`。
- 改了行为请加测试，并在 `CHANGELOG.md` 的 `[Unreleased]` 下加一行。
- CI（构建 + 单元 + 端到端 + 配方校验）必须是绿的。
- 新增或改动浏览器动作时，请在 `demo-site/selfcheck.html` 和 `templates/selfcheck/basic.json` 里加上对应的检查。

## 写配方时的原则（给自己本机用的配方同样适用）

- **只读优先**：默认只做浏览、搜索、读取。
- **必须通过校验**：`browser-recipewright validate <配方>` 没有错误；`site` 字段写明允许的域名。
- **不碰验证码和登录**：不绕过验证码、不自动填密码、不自动注册；遇到登录或验证码交给人。
- **有节制**：设置合理的数量上限和等待时间，不要高频抓取。
- **遵守网站条款**：明确禁止自动化访问的网站不要用。

## 行为准则

参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.md)。
