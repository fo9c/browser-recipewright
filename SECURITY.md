# 安全策略 / Security Policy

## 支持的版本

项目处于 0.x 阶段，只有最新发布的版本会收到安全修复。

| 版本 | 是否支持 |
|---|---|
| 0.1.x（最新） | ✅ |
| 更早 | ❌ |

## 报告漏洞

**请不要在公开 Issue 里报告安全漏洞。**

请使用 GitHub 的私密报告：仓库页面 → **Security** → **Report a vulnerability**。
我们会在 7 天内回复，确认后尽快修复并在 CHANGELOG 和 Release 里致谢（除非你希望匿名）。

Please report vulnerabilities privately via **Security → Report a vulnerability** on GitHub, not in public issues. We aim to respond within 7 days.

## 我们关心的问题

- 配方（模板 JSON）能执行白名单之外的脚本，或绕过 `scripts/manifest.json` 的 sha256 / 域名限制。
- 配方能访问 `site` 字段之外的域名。
- 运行记录、现场档案或日志泄露 Cookie、密码、Token 等敏感信息。
- 浏览器 Profile 目录权限过宽，或被其他配方 / 账号读到。
- CLI 参数或配方内容导致本机命令注入、任意文件写入。

## 安全设计说明

- 配方是声明式 JSON，**不能**内嵌任意 JavaScript；页面脚本只能来自 `scripts/` 白名单，并校验 sha256。
- 工具本身不调用任何大模型、不需要 API Key、不上传数据；所有数据留在你的电脑上。
- 每个站点、每个账号使用独立的 Chrome Profile（默认在 `~/.browser-recipewright/profiles/`），不会读取你日常 Chrome 的登录信息。
- 登录和验证码始终交给人处理，工具不保存密码。

另见 [负责任使用说明](docs/responsible-use.md)。
