# LetterMate 邮件投递与邮箱授权方案研究

**日期：** 2026-08-12
**范围：** 用户填写收件邮箱、邮箱确认、LetterMate 每日简报投递，以及 Gmail / Microsoft 账号授权代发
**结论：** LetterMate 应采用市面上常见的 SaaS 模式：由 LetterMate 统一接入事务邮件服务，用户只填写并验证收件邮箱，然后开启每日简报。用户不需要提供邮箱密码，也不需要授权 LetterMate 读取或代表其邮箱发信。Gmail OAuth 和 Microsoft Graph `Mail.Send` 解决的是“以用户身份发信”，权限更大、实施和审核成本更高，不适合作为个人简报投递的默认路径。

## 1. 先区分两种完全不同的“授权”

### 1.1 授权 LetterMate 给我发邮件

这是每日简报需要的能力。典型流程是：

1. 用户在 LetterMate 填写收件邮箱。
2. LetterMate 使用自己的发件域名发送确认邮件。
3. 用户点击一次性确认链接，证明能控制该邮箱，并明确同意接收简报。
4. LetterMate 此后从自己的地址，例如 `digest@updates.lettermate.example`，向该邮箱发送每日简报。
5. 用户可以在产品设置或邮件中的退订链接随时关闭。

这类确认通常称为 double opt-in（双重确认）：先提交地址，再通过发到该地址的链接完成确认。Mailchimp 官方说明的流程正是“提交表单 -> 收到确认邮件 -> 点击链接验证邮箱 -> 成为已订阅联系人”：[Mailchimp, About Double Opt-in](https://mailchimp.com/help/about-double-opt-in/)。

这里授权的是“接收 LetterMate 邮件”，不是把邮箱账号权限交给 LetterMate。

### 1.2 授权 LetterMate 代表我发邮件

这是另一类能力。用户会被跳转到 Google 或 Microsoft 的授权页面，同意 LetterMate 使用其邮箱身份发信。LetterMate 需要长期安全保存可刷新凭据，并处理撤销、失效、组织管理员策略和供应商审核。

Google 将 `https://www.googleapis.com/auth/gmail.send` 描述为“Send email on your behalf”，即代表用户发送邮件，并把它列为 sensitive scope：[Google, Choose Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)。Microsoft Graph 的 delegated `Mail.Send` 同样表示“Send mail as a user”：[Microsoft Graph permissions reference, Mail.Send](https://learn.microsoft.com/en-us/graph/permissions-reference#mail-send)。

每日简报没有“必须出现在用户发件箱、必须使用用户本人地址作为发件人”的需求，因此不应索取这类权限。

## 2. 方案 A：LetterMate 使用事务邮件服务统一发信

这是 Web SaaS、账户通知、日报和产品更新最常见的技术形态。

### 2.1 服务如何工作

LetterMate 运营方只需配置一次邮件服务商账户和自己的域名。以 Resend 为代表：

- 发件方必须添加并验证自己拥有的域名；验证后可以使用该域名下的地址发信：[Resend, Verified Domains](https://resend.com/docs/dashboard/domains/introduction)。
- 后端通过 API Key 调用发送接口，提供 `from`、`to`、`subject` 和 HTML / 文本正文；API Key 放在服务端，不给浏览器：[Resend, Send Email](https://resend.com/docs/api-reference/emails/send-email)。
- API 支持 `Idempotency-Key`，相同键在 24 小时内重复请求不会再次发送，适合队列重试：[Resend, Idempotency Keys](https://resend.com/docs/dashboard/emails/idempotency-keys)。
- Webhook 可报告 delivered、bounced、complained、delivery delayed 和 failed 等事件，应用可据此停止向永久退信或投诉地址继续发送：[Resend, Webhook Event Types](https://resend.com/docs/dashboard/webhooks/event-types)。

Resend 只是一个代表。Postmark、SendGrid、Amazon SES 等事务邮件平台的产品角色相同：LetterMate 持有一个系统级服务凭据，用户只提供收件地址。

### 2.2 用户看到的体验

前端可以做成：

1. 输入“接收简报的邮箱”。
2. 点击“发送验证邮件”。
3. 页面显示“等待验证”，允许限频重发。
4. 用户在邮箱中点击“确认接收 LetterMate 每日简报”。
5. 返回 LetterMate 后显示“已验证”，用户设置发送时间并开启日报。
6. 提供“发送测试邮件”“更换邮箱”“停止接收”。

这里不应出现“SMTP”“API Key”“授权码”等基础设施术语。普通用户只需要理解“验证收件邮箱”。

### 2.3 LetterMate 仍需做的一次性系统配置

“用户填完邮箱即可使用”不等于系统不需要发件服务。LetterMate 必须先有一个能发出第一封验证邮件的服务商账户和已验证发件域名。这个配置由部署者完成一次，不由每个用户完成。

发件域名还应配置 SPF / DKIM，并逐步配置 DMARC。Resend 的官方文档说明域名验证通过时已通过 SPF 与 DKIM，并建议在此基础上配置 DMARC：[Resend, Implementing DMARC](https://resend.com/docs/dashboard/domains/dmarc)。Google 的发件人指南也要求发件域使用 SPF 或 DKIM、TLS；大批量发件还要求 SPF、DKIM、DMARC，并要求订阅类邮件支持清晰退订，大批量场景支持一键退订：[Google, Email sender guidelines](https://support.google.com/a/answer/81126)。

### 2.4 对 LetterMate 的适配度

当前代码已经具备合适的边界：Worker 通过 `EmailGateway` 投递，生产实现目前是 `SmtpEmailGateway`；Digest 调度、冻结快照、重试和确定性幂等标识也已经存在。最小演进路径是新增供应商 HTTP API 适配器，例如 `ResendEmailGateway`，而不是改变整个简报管线。

供应商 API 的直接价值包括：

- 真正的供应商幂等键比普通 SMTP 的确定性 `Message-ID` 更适合安全重试。
- 可用 Webhook 更新 delivered / bounced / complained 状态。
- 域名、信誉和退信处理集中在系统级配置中。
- 用户不需要理解不同邮箱厂商的授权流程。

## 3. 方案 B：Google Gmail OAuth 后代表用户发信

### 3.1 工作方式

LetterMate 注册 Google OAuth 应用，引导用户进入 Google 的授权页，请求 `gmail.send`。授权完成后，后端用授权码换取 access token；为了在用户不在线时每天自动发信，还需要 offline access 和 refresh token。Google 的 Web Server OAuth 文档说明该流程包含用户同意、授权码交换、access token / refresh token，并指出 offline access 可让应用在没有用户交互时刷新访问令牌：[Google, OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)。

发送时，应用构造符合 MIME 的邮件，将其编码为 base64URL，调用 `messages.send` 或 `drafts.send`：[Google, Create and send email messages](https://developers.google.com/workspace/gmail/api/guides/sending)。

### 3.2 成本和风险

- `gmail.send` 是敏感权限。公开应用可能需要 Google 验证，包含域名、OAuth consent screen、隐私政策、权限用途说明和演示材料：[Google, Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)。
- 必须加密保存 refresh token，限制内部访问，支持用户撤销，并正确处理 token 失效。
- Google Workspace 管理员可能限制敏感权限；个人用户也可能因“代表你发邮件”的提示而拒绝授权。
- 发信受 Gmail 账户限额、反滥用、账号状态和组织策略影响。
- 每位用户的账号连接都是独立故障点，会显著增加支持成本。

### 3.3 何时才值得用

只有当核心需求是“邮件必须从用户自己的 Gmail 地址发给第三方，并保存在用户的已发送邮件中”时才合理，例如销售外联、客服回复、CRM 或个人助理代发。

LetterMate 的每日简报是系统发给用户本人，不需要这一能力。因此 Gmail OAuth 不应作为启用简报的步骤，也不应作为解决“填邮箱后收到日报”的方案。

## 4. 方案 C：Microsoft OAuth + Graph `Mail.Send`

### 4.1 工作方式

LetterMate 注册 Microsoft Entra 应用，请求 delegated `Mail.Send`，获得用户授权后调用：

```text
POST /me/sendMail
```

Microsoft 官方说明 delegated `Mail.Send` 适用于工作/学校账户和个人 Microsoft 账户；发送成功返回 `202 Accepted`，但这仅表示请求已被接受，不代表投递已经完成，并且投递仍受 Exchange Online 限制和节流影响：[Microsoft, user: sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0)。

为了后台定时发送，需要 OAuth authorization code flow，并请求 `offline_access` 以取得 refresh token。Microsoft 官方说明 refresh token 是长期凭据，可在 access token 到期后继续获取新 token：[Microsoft identity platform, OAuth 2.0 authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)。

### 4.2 权限边界

应只考虑 delegated `Mail.Send`，即以当前已授权用户身份发信。Microsoft 还提供 application `Mail.Send`，允许在没有登录用户时“以组织内任意用户身份”发信，需要管理员同意，权限和风险远超 LetterMate 需求：[Microsoft Graph permissions reference, Mail.Send](https://learn.microsoft.com/en-us/graph/permissions-reference#mail-send)。

与 Gmail 相同，这条路线适合“使用用户本人 Outlook / Microsoft 365 邮箱向第三方发信”，不适合仅向用户投递 LetterMate 日报。

## 5. 邮箱验证和订阅确认的推荐机制

### 5.1 数据状态

建议把收件地址与登录地址分开建模，即使默认值相同：

- `recipientEmail`：规范化后的收件地址。
- `recipientStatus`：`unverified | verified | suppressed`。
- `recipientVerifiedAt`：完成确认的时间。
- `digestEnabled`：用户是否开启每日简报。
- `unsubscribeTokenVersion` 或等价撤销机制。
- `suppressionReason`：永久退信、投诉或用户退订的安全枚举，不保存供应商原始响应。

`DigestRun` 应冻结 `recipientEmail` 快照。这样用户更换邮箱后，已经入队的运行不会在重试时悄悄换收件人。

### 5.2 验证令牌

推荐使用高熵、一次性、短期令牌：

- 数据库只保存令牌哈希，不保存明文。
- 令牌绑定 `userId + normalizedEmail + purpose`。
- 设置明确过期时间，例如 30 分钟到 24 小时。
- 成功使用后立即失效；重新申请时废弃旧令牌。
- 验证请求和重发按用户、地址和 IP 限频。
- API 响应避免暴露某邮箱是否已被其他账号使用。

用户修改 `recipientEmail` 时必须立即把新地址设回 `unverified`，暂停简报；不能沿用旧地址的验证状态。

### 5.3 开启和退订规则

- 未验证地址不能开启正式日报。
- 验证邮件只用于确认地址，不携带日报内容。
- 邮件正文和设置页都提供明确的停止接收入口。
- 用户退订后立即停止调度；再次开启需显式操作。
- 永久退信或投诉进入 suppression，不能由普通任务重试自动恢复。
- “测试邮件”只能发到当前已验证地址，并限频。

对 LetterMate 这种用户登录后主动开启的个人日报，可以默认以登录邮箱预填，但如果当前注册流程没有验证邮箱所有权，仍应完成一次邮件确认。若未来登录本身已通过可信邮件 magic link 或第三方已验证邮箱完成，可评估复用该验证事实，但“已验证身份邮箱”和“同意接收每日简报”仍应是可独立撤销的产品状态。

## 6. 方案对比

| 方案 | 用户授予什么 | 发件人 | 是否适合 LetterMate 日报 | 主要代价 |
| --- | --- | --- | --- | --- |
| LetterMate + 事务邮件服务 | 同意接收，并验证地址 | LetterMate 域名 | **最适合** | 系统一次性配置服务商、域名和 Webhook |
| Gmail OAuth `gmail.send` | 代表用户发信 | 用户 Gmail 地址 | 不适合默认路径 | 敏感权限审核、refresh token、账户限额和逐用户故障 |
| Microsoft delegated `Mail.Send` | 代表用户发信 | 用户 Outlook / M365 地址 | 不适合默认路径 | OAuth 凭据、租户策略、节流和逐用户故障 |
| 用户填写 SMTP / 邮箱授权码 | 用户把邮箱凭据交给 LetterMate | 用户邮箱地址 | **不推荐** | 高风险凭据存储、厂商差异、配置困难、支持成本高 |

## 7. LetterMate 推荐产品方案

### 7.1 推荐的 MVP

1. 部署者为 LetterMate 配置一个事务邮件服务和专用发件子域，例如 `updates.lettermate.example`。
2. 在现有 `EmailGateway` 后新增供应商 HTTP API 适配器，保留 SMTP 作为兼容或开发路径。
3. 前端增加收件邮箱、验证状态、重发验证、发送测试邮件和停止接收。
4. 新增验证令牌、收件地址状态和投递 suppression 数据；`DigestRun` 冻结收件地址。
5. 只有 `verified && enabled` 的偏好进入调度。
6. 使用现有 DigestRun ID 或稳定运行键作为供应商幂等键。
7. 接收供应商签名 Webhook，处理 delivered、bounced、complained、delayed 和 failed；校验签名后再更新状态。
8. 邮件提供产品内退订入口；生产域配置 SPF、DKIM、DMARC 和 TLS。

用户体验最终应是：

```text
填写邮箱 -> 收到 LetterMate 验证邮件 -> 点击确认 -> 选择每天发送时间 -> 开始接收
```

用户不需要知道 SMTP，也不需要给 LetterMate Gmail / Outlook 发信权限。

### 7.2 不推荐的默认方案

- 不让用户填写 SMTP host、端口、用户名或授权码。
- 不保存用户邮箱密码或应用专用密码。
- 不以 `gmail.send` / `Mail.Send` 作为接收日报的前提。
- 不在浏览器持有服务商 API Key、OAuth refresh token 或邮件授权头。
- 不允许未验证的新地址直接开启日报。

### 7.3 可选的未来高级集成

若未来 LetterMate 增加“把研究结果从我的邮箱转发给团队”“以我本人身份发送 briefing”等明确需求，可以单独设计“连接 Gmail / 连接 Microsoft 365”功能。该功能应与日报收件设置分离，采用最小权限、服务端加密令牌、清晰授权说明、撤销入口和独立安全评审。

## 8. 对当前文档约束的影响

现有要求规定邮件凭据只在服务端，Web 只调用 LetterMate API；推荐方案完全保持这一边界。实施时需要更新 `docs/requirements.md` 和 `docs/design.md`，明确：

- 收件邮箱允许由用户配置，但必须完成确认。
- “用户邮箱确认”不等于“用户邮箱代发授权”。
- 系统发件凭据仍由服务端统一管理。
- 供应商 HTTP API 可作为生产 `EmailGateway`，SMTP 保留兼容路径。
- 正式投递、测试邮件、退订、退信和投诉的状态转换与所有权规则。

## 9. 官方资料

- [Resend: Verified Domains](https://resend.com/docs/dashboard/domains/introduction)
- [Resend: Send Email API](https://resend.com/docs/api-reference/emails/send-email)
- [Resend: Idempotency Keys](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [Resend: Webhook Event Types](https://resend.com/docs/dashboard/webhooks/event-types)
- [Resend: Implementing DMARC](https://resend.com/docs/dashboard/domains/dmarc)
- [Google: Create and send email messages](https://developers.google.com/workspace/gmail/api/guides/sending)
- [Google: Choose Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google: OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google: Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [Google: Email sender guidelines](https://support.google.com/a/answer/81126)
- [Microsoft: user: sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0)
- [Microsoft Graph permissions reference: Mail.Send](https://learn.microsoft.com/en-us/graph/permissions-reference#mail-send)
- [Microsoft identity platform: OAuth 2.0 authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Mailchimp: About Double Opt-in](https://mailchimp.com/help/about-double-opt-in/)

## 10. Ticket 06：Resend Webhook 契约核对

本节基于 2026-08-12 可访问的 Resend 官方文档、Resend 官方 SDK 所使用的 Svix 实现，以及 Svix / Standard Webhooks 官方资料。结论用于固定 Ticket 06 的接收契约；不要根据 Dashboard 截图、博客示例或推测新增字段。

### 10.1 原始请求体和签名契约

Resend 要求使用**未经 JSON 解析或重新序列化的原始请求体**验签。任何空格、字段顺序或编码变化都会改变签名。NestJS 应在启动时启用 `rawBody: true`，Webhook Controller 从 `request.rawBody` 取 Buffer 或其 UTF-8 原文；不能把全局 `express.json()` 已解析的对象再次 `JSON.stringify` 后验签。[Resend, Verify Webhooks Requests](https://resend.com/docs/webhooks/verify-webhooks-requests)；[Svix, How to Verify Webhooks](https://docs.svix.com/receiving/verifying-payloads/how)

每个请求必须携带三个头：

| HTTP 头 | 含义 | Ticket 06 用法 |
| --- | --- | --- |
| `svix-id` | Webhook 消息唯一 ID；同一消息重试/重发时保持不变 | 验签输入，同时作为数据库幂等键 |
| `svix-timestamp` | 本次投递尝试的 Unix 秒时间戳 | 验签输入，并用于拒绝过旧或未来请求 |
| `svix-signature` | 空格分隔的版本化 Base64 签名列表，例如 `v1,... v1,...` | 至少一个受支持的 `v1` 签名匹配才通过 |

Resend 的签名 secret 从 Webhook 详情页或 Webhook API 获取，示例格式是 `whsec_<base64>`。`whsec_` 是格式前缀；实际 HMAC key 是前缀后内容经 Base64 解码后的字节。secret 是服务端秘密，不得进入客户端或日志。[Resend, Verify Webhooks Requests](https://resend.com/docs/webhooks/verify-webhooks-requests)；[Svix, Manual Verification](https://docs.svix.com/receiving/verifying-payloads/how-manual)

手工算法为：

```text
signedContent = svix-id + "." + svix-timestamp + "." + rawBody
expected = Base64(HMAC-SHA256(base64Decode(secretWithoutWhsecPrefix), signedContent))
wireSignature = "v1," + expected
```

比较必须使用恒定时间比较，并允许 `svix-signature` 中存在多个签名，以支持密钥轮换。实现上优先使用 Resend SDK 的 `resend.webhooks.verify(...)` 或官方 `svix` 包，而不是自行维护密码学代码。

Svix 当前 JavaScript 包把验签委托给 Standard Webhooks 实现，该实现将允许时间偏差固定为前后各 **5 分钟**；超过 5 分钟会分别报 `Message timestamp too old` 或 `Message timestamp too new`：[Svix JavaScript Webhook wrapper](https://github.com/svix/svix-webhooks/blob/main/javascript/src/webhook.ts)；[Standard Webhooks JavaScript implementation](https://github.com/standard-webhooks/standard-webhooks/blob/main/libraries/javascript/src/index.ts)。Ticket 06 应使用官方库的默认窗口，不要在业务层另放宽窗口。需要注意，5 分钟只降低截获请求的重放风险，并不能替代 `svix-id` 幂等存储。

签名或时间戳验证失败返回 `400`，不解析、更不改变任何邮件状态。secret 未配置属于服务启动/就绪配置错误，不应让路由在“跳过验签”模式运行。

### 10.2 Resend 邮件事件公共结构

四类事件的 JSON 顶层结构一致：

```json
{
  "type": "email.bounced",
  "created_at": "2026-11-22T23:41:12.126Z",
  "data": {}
}
```

- 顶层 `type` 是事件类型。
- 顶层 `created_at` 是 Webhook 事件创建时间。
- `data.created_at` 是原邮件创建时间，两者含义不同。
- JSON 顶层**没有 Webhook event ID**；事件去重必须使用 HTTP 头 `svix-id`。
- `data.email_id` 是 Resend 对该封邮件的唯一 ID，应与发送 API 返回并保存到 LetterMate 的 provider message ID 对应。
- `data.message_id` 是邮件的 RFC `Message-ID` header 值，例如 `<111-222-333@email.example.com>`，不能替代 `email_id` 作为 Resend API 资源 ID。

四类事件共同记录的 `data` 字段如下：

| 字段 | 官方类型 | 含义 |
| --- | --- | --- |
| `broadcast_id` | `string` | Broadcast ID（如适用） |
| `created_at` | `string` | 原邮件创建时间，ISO 8601 |
| `email_id` | `string` | Resend 邮件唯一 ID |
| `message_id` | `string` | RFC `Message-ID` header 值 |
| `from` | `string` | 发件地址，可能含 display name |
| `to` | `string[]` | 受该事件影响的收件地址数组 |
| `subject` | `string` | 主题 |
| `template_id` | `string` | Template ID（如适用） |
| `tags` | `Record<string, string>` | 发送时附带的标签对象 |

Resend 页面没有给这些字段标注 JSON Schema 意义上的 `required`。示例中 `broadcast_id`、`template_id` 存在，但文字明确写了 “if applicable”；Ticket 06 的解析器至少应把这两项视为可选/可空缺。为了供应商向前兼容，不要对 `data` 使用拒绝未知字段的严格对象；只校验和读取业务需要的字段，并忽略未知字段。相关官方事件页：[bounced](https://resend.com/docs/webhooks/emails/bounced)、[complained](https://resend.com/docs/webhooks/emails/complained)、[delivery delayed](https://resend.com/docs/webhooks/emails/delivery-delayed)、[failed](https://resend.com/docs/webhooks/emails/failed)。

### 10.3 `email.bounced`

`email.bounced` 表示收件服务器拒收邮件。除公共字段外，`data.bounce` 的官方字段为：

| 字段 | 官方类型 | 含义 |
| --- | --- | --- |
| `diagnosticCode` | `string[]` | 收件服务器 SMTP 诊断响应数组 |
| `message` | `string` | 收件服务器或抑制系统返回的详细信息 |
| `subType` | `string` | 退信子类型；事件页示例包括 `Suppressed`、`MessageRejected` |
| `type` | `string` | 退信类型 |

Resend **没有文档化 `bounce.outcome` 字段**，Ticket 06 不应把 `outcome` 加入必需契约，也不能依赖它决定 suppression。

官方资料目前存在术语差异：Webhook 事件页对 `bounce.type` 举例为 `Permanent`、`Temporary`，而 Resend 的退信分类页列出的正式类别是 `Permanent`、`Transient`、`Undetermined`，子类型还包括 `General`、`NoEmail`、`MailboxFull`、`MessageTooLarge`、`ContentRejected`、`AttachmentRejected`、`Undetermined`。[Resend, email.bounced](https://resend.com/docs/webhooks/emails/bounced)；[Resend, Email Bounces](https://resend.com/docs/dashboard/emails/email-bounces)

因此推荐契约是把 `bounce.type` 和 `bounce.subType` 保留为受长度限制的非空字符串，并保存受控映射结果，而不是在接收层用封闭 enum 拒绝未知值。业务处理只在明确的永久/硬退信或 Resend suppression 事件下把地址设为 `suppressed`；`Transient`、`Temporary`、`Undetermined` 或未知值只能记录安全状态并等待后续终态，不能永久停用用户邮箱。

另一个需要防止的误解是：`email.bounced` 事件总览文字称其为“permanently rejected”，但同页 `bounce.type` 又允许非永久示例。代码应以结构化 `bounce.type` / suppression 信号执行保守决策，不要仅凭事件名永久抑制。

### 10.4 `email.complained`

`email.complained` 表示邮件已经投递，但收件人将其标记为垃圾邮件。该事件只有公共邮件字段，没有额外的 `complaint`、`reason` 或 `outcome` 对象：[Resend, email.complained](https://resend.com/docs/webhooks/emails/complained)。

对 LetterMate，这应是明确的永久 suppression 信号：匹配 `data.email_id` 对应的已冻结收件地址，将地址状态设为 `suppressed`、原因设为受控的 `complaint`，并关闭后续摘要投递。不要把供应商原始 subject、地址、完整 payload 或未知反馈内容写入日志。

Resend 还提供 `suppression.added`：`data` 包含 `id`、`email`、`origin`（`bounce | complaint | manual`）、`source_id`（触发 suppression 的邮件 ID，手动时为 `null`）和 `created_at`。如果 Ticket 06 订阅该事件，它是同步供应商 suppression 状态的更直接信号，但必须继续通过内部邮件记录或安全地址键确认用户归属，不能仅按 Webhook 提供的裸邮箱跨用户更新。[Resend, suppression.added](https://resend.com/docs/webhooks/suppressions/added)

### 10.5 `email.delivery_delayed`

`email.delivery_delayed` 表示由于邮箱已满或收件服务器临时问题，邮件暂时无法投递。它只有公共邮件字段，官方 payload **没有** `delay`、`reason`、`outcome` 或 `retry_after` 字段：[Resend, email.delivery_delayed](https://resend.com/docs/webhooks/emails/delivery-delayed)。

Ticket 06 只能把它记录为临时投递状态和观测事件；不能据此 suppression，不能自行重新调用 Send Email API，也不能把 DigestRun 标成新的发送失败。邮件已经由 Resend 接管，供应商会继续处理其邮件投递生命周期；LetterMate 等待后续 `email.delivered`、`email.bounced` 或其他终态事件。

### 10.6 `email.failed` 和 `email.suppressed`

`email.failed` 表示邮件因错误未能发送，除公共字段外包含：

```json
{
  "failed": {
    "reason": "reached_daily_quota"
  }
}
```

`data.failed.reason` 是字符串，官方示例值为 `reached_daily_quota`；文档没有给出封闭枚举，也没有说明所有 reason 的永久/可重试分类。[Resend, email.failed](https://resend.com/docs/webhooks/emails/failed)

因此接收层应保留开放字符串并映射为有限的内部安全错误码。不能把未知 reason 自动归类为永久收件人错误。`email.failed` 主要用于修正“API 已接受但异步发送阶段失败”的投递状态和告警；是否触发新的业务重试必须由明确的内部映射决定，并继续使用原 DigestRun 幂等键。

建议 Ticket 06 同时考虑 `email.suppressed`。其公共字段之外，当前示例包含：

```json
{
  "suppressed": {
    "message": "...",
    "type": "OnAccountSuppressionList"
  }
}
```

该页正文参数表目前未完整列出 `suppressed` 对象，但示例已给出；因此它适合作为供应商侧已拒绝发送的状态信号，但 `suppressed.type` 同样应按开放字符串解析。[Resend, email.suppressed](https://resend.com/docs/webhooks/emails/suppressed)

### 10.7 Replay、幂等和事务顺序

Resend 对非成功 Webhook 使用指数退避，官方当前调度为：立即、5 秒、5 分钟、30 分钟、2 小时、5 小时、10 小时、再 10 小时；失败或成功的消息都可以在 Dashboard 手动 Replay。[Resend, Retries and Replays](https://resend.com/docs/webhooks/retries-and-replays)

Svix 明确保证同一 Webhook 被重发时 `svix-id` 保持不变。Resend 官方 Webhook Ingester 也以 `svix_id` 做幂等存储并安全忽略重复投递：[Svix, Manual Verification](https://docs.svix.com/receiving/verifying-payloads/how-manual)；[Resend, Webhook Ingester](https://resend.com/docs/webhooks/ingester)。

Ticket 06 推荐处理顺序：

1. 读取 raw body 和三个 `svix-*` 头。
2. 使用官方库完成签名和 5 分钟时间窗口验证。
3. 验签成功后解析并校验支持的 `type` 与所需字段。
4. 在同一个短数据库事务中，以 `svix-id` 唯一约束插入 Webhook inbox 记录，并执行或登记对应状态转换。
5. 若唯一约束冲突，视为已处理重复，返回 `2xx`，不重复产生状态变化或任务。
6. 事务提交后快速返回 `2xx`；非 `2xx` 会触发 Resend 重试。

只把 `svix-id` 放进短期 5 分钟缓存不足以覆盖 Resend 超过一天的自动重试和以后人工 Replay。LetterMate 应在 PostgreSQL 中持久化唯一 ID，保留期至少覆盖业务审计和供应商可 Replay 的实际周期；如果后续做数据清理，不能在仍可能 Replay 时删除唯一性记录。

状态更新还需要第二层业务幂等：以 `data.email_id` 关联 `DigestRun.providerMessageId`，并让状态转换单调。例如相同 `email.complained` 无论收到多少次都只得到同一个 suppression 结果；较晚到达的 `email.delivery_delayed` 不能把已经 `delivered`、`bounced` 或 `complained` 的终态倒退回临时状态。

不要使用 `data.message_id`、`data.to[0]` 或 payload 哈希替代 `svix-id` 做事件幂等。一次邮件会产生多个不同生命周期事件，它们共享 `email_id` / `message_id`，但每个事件有不同的 `svix-id`；反过来，同一 Webhook 消息的自动重试和人工 Replay 应由 `svix-id` 去重。
