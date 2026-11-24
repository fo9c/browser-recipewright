# 负责任使用说明 / Responsible Use

browser-recipewright 是给**个人自动化和数据分析**用的工具：帮你把自己每天在浏览器里重复做的事交给 AI 和配方。

它**不是**用来"不被发现"、刷量、绕过风控的工具。我们不会以"无法检测"为卖点，也不接受这类功能的 PR。

## ✅ 适合的用法

- 自动整理你自己账号里能看到的信息：搜索结果、帖子和评论、职位、商品价格、订单记录。
- 定期把公开信息汇总成表格，做个人研究或数据分析。
- 替你完成重复的、你本来就有权限做的网页操作。
- 合规的多店铺 / 多品牌运营：每个账号都是你合法拥有、平台允许的。

## ❌ 不支持的用法

- 破解、绕过验证码或任何访问控制（工具遇到验证码会暂停并交给人）。
- 收集他人的密码、Cookie，或登录不属于你的账号。
- 群发、刷赞、刷评论、批量注册、协同虚假行为。
- 高频抓取、给网站造成负担，或违反网站服务条款和 robots 规则的采集。
- 收集、出售个人隐私数据，或违反所在地法律（例如个人信息保护相关法律）的用途。

## 内置的约束

- 配方必须写明 `site` 允许的域名，超出范围的访问会被拒绝。
- 批量运行支持间隔时间和每账号每日上限，默认就很保守。
- 登录失效、出现验证码时，单账号运行会暂停交给人，批量运行可配置为跳过或停止。
- 运行记录完整保存在本地，你随时能检查 AI 做了什么。

## 你的责任

使用本工具即表示你会自行确认：所用账号和数据你有权使用，行为符合网站条款与当地法律。项目按 Apache-2.0 许可"按原样"提供，作者不对滥用承担责任。

---

**English summary.** This is a tool for personal automation and data analysis on accounts and data you are entitled to use. It is not marketed as "undetectable" and will not accept features for captcha bypass, credential harvesting, spam, fake engagement, or aggressive scraping. Respect site terms, rate limits and local law.
