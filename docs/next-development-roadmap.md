# LetterMate 开发路线图

**更新日期：** 2026-08-09

## 当前基线

已完成：

- 精确关键词监控、自动技术趋势和多来源质量管线；
- RSS/Atom、X、Bilibili 博主关注；Bilibili 已覆盖公开视频、公开动态、专栏和带原帖上下文的转发动态；
- 统一 Feed、显式反馈、兴趣记忆和个性化排序；
- 相邻兴趣探索及约 10% 上限；
- 每日邮件偏好、预览、调度、冻结快照、重试和运行状态；
- 生产 SMTP 适配器、未配置能力状态和显式 live smoke 入口。

## P0：生产身份（单实例基线已完成）

1. 已实现登录、登出、会话滑动续期和撤销。
2. 已使用 HttpOnly、生产 Secure、SameSite Cookie 承载服务端 Session。
3. 已为所有生产写操作增加 CSRF 防护。
4. 生产 Web 和业务接口不再接受固定 `x-user-id`；开发兼容由 `ALLOW_DEV_IDENTITY` 显式控制。
5. 已增加进程内登录限流、旧 scrypt 参数自动升级和跨用户回归测试；横向扩展 API 前需将限流状态迁移到 Redis。

完成条件：未认证请求不能访问用户资源；跨用户访问不泄露资源；浏览器不持有身份伪造头。

## P0：生产运行

1. 已实现统一结构化日志契约、API `x-trace-id`、错误响应 trace 复用，以及 Worker queue/job/run 事件。
2. 已实现分钟级队列快照、任务/来源安全失败事件，以及 API/Worker 低基数 Prometheus 指标和初始告警阈值；目标环境仍需接入 Prometheus、仪表盘和通知渠道。
3. 已实现 PostgreSQL custom-format 备份、SHA-256 清单、14 日/8 周/12 月分层保留、Docker-socket-free direct 运维容器和隔离恢复验证；目标环境仍需配置每日调度、加密外部副本和周期演练通知。
4. 已实现脱敏 `ops:doctor` 配置/依赖诊断和密钥轮换、配额检查、故障恢复手册；目标环境仍需执行真实轮换并记录供应商配额基线。
5. 已实现存活/就绪探针、依赖异常 503、API/Worker 优雅退出，以及 API/Worker/Web 容器和一次性迁移 Compose 基线；目标环境仍需完成 TLS、秘密存储、容量基线和部署演练。

完成条件：可以发现故障、定位运行、恢复数据库并轮换密钥，而不暴露凭据或用户邮箱。

## P1：平台扩展

按真实使用需求选择，不阻塞生产上线：

1. 已实现 Bilibili 动态、专栏和转发动态，并提供显式 live smoke；
2. YouTube Creator；
3. Bluesky Creator。

每个平台必须先实现结构化身份解析、稳定账号 ID、公开内容增量、失败隔离和 live smoke，再进入 Web 能力列表。

## 决策边界

当前 SMTP 通过确定性 `Message-ID` 尽力减少重试重复，但标准 SMTP 无法严格解决“已接受但确认丢失”。如果产品要求严格零重复，新增支持幂等键的供应商 HTTP API 适配器，并将 SMTP 保留为兼容模式。

## 完成定义

- 行为与 `requirements.md`、`design.md` 一致；
- 公共契约位于 `packages/contracts`，业务规则位于 `packages/domain`；
- 用户所有权、来源证明和凭据边界没有削弱；
- Prisma 变更包含迁移和 Client 生成；
- lint、typecheck、测试、构建和适用 E2E 全部通过；
- 文档、环境变量示例和运行说明同步更新。
