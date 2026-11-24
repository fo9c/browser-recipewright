# 参与贡献 / Contributing

谢谢你愿意帮忙！这个项目欢迎三类贡献，按门槛从低到高：

1. **报告问题**：某个配方在某个网站上跑不通、文档看不懂、安装失败。请用 [Issue 模板](https://github.com/fo9c/browser-recipewright/issues/new/choose)，附上 `browser-recipewright doctor` 的输出；配方失败时附上 `heal <运行目录>` 的输出（记得先删掉账号名、Cookie 等隐私信息）。
2. **贡献配方**：把你写好、跑通过的配方（模板 JSON）提交到 `templates/<站点>/<名字>.json`。见下面的「配方贡献规则」。
3. **改代码**：修 bug、加动作、改执行器。大的改动请先开 Issue 讨论，避免白做。

English: issues, recipes and code are all welcome. Use the issue templates, include `doctor` output, and open an issue before large changes. Recipe rules below apply to everyone.

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
- 提交信息用一句话说清楚改了什么，例如 `fix(locator): retry when candidate is detached`、`docs: ...`、`recipe(github.com): ...`。
- 改了行为请加测试，并在 `CHANGELOG.md` 的 `[Unreleased]` 下加一行。
- CI（构建 + 单元 + 端到端 + 配方校验）必须是绿的。

## 配方贡献规则

配方是这个项目最有价值的部分，也最容易出问题。请遵守：

- **只读优先**：默认只做浏览、搜索、读取。会发帖、点赞、关注、私信、下单的配方不收。
- **必须通过校验**：`browser-recipewright validate <配方>` 没有错误；`site` 字段写明允许的域名。
- **必须真跑过**：PR 描述里写明你在哪天、用什么账号类型（不要写账号名）跑通了几次。
- **不碰验证码和登录**：配方里不能有绕过验证码、自动填密码、自动注册的步骤；遇到登录或验证码交给人。
- **有节制**：设置合理的数量上限和等待时间，不要写高频抓取。
- **不含隐私**：配方和示例里不能出现真实账号、Cookie、手机号、个人数据。
- **遵守网站条款**：明确禁止自动化访问的网站不收。

## 行为准则

参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.md)。
