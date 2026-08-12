# LetterMate 运行手册

**更新日期：** 2026-08-10

## 1. 边界

本手册面向单实例 API、单 Worker 的当前生产基线。所有诊断输出、日志聚合和告警标签都禁止包含用户 ID、邮箱、关键词、来源 URL、连接 URL、Token、密码、授权头或供应商原始响应。

`ops:doctor` 默认只读取并验证配置，不访问网络：

```powershell
npm run ops:doctor
```

显式 live 模式只探测 PostgreSQL 和 Redis，不访问 AI、搜索、社交或邮件供应商：

```powershell
npm run ops:doctor -- live
```

报告为 `warning` 时命令返回 0，表示服务仍可运行但存在开发身份、HTTP Origin 或可选能力未配置；`error` 返回非零。报告只包含安全错误码、能力 ID 和计数。

容器内运行：

```powershell
docker compose -f infra/compose.production.example.yaml run --rm api node --import tsx apps/api/dist/ops-doctor-cli.js live
```

## 2. 部署检查

1. 使用秘密存储提供 `SESSION_SECRET`、`CSRF_SECRET`、`EMAIL_UNSUBSCRIBE_SECRET`、数据库、Redis、AI、连接器和邮件提供商凭据；不要写入镜像或仓库。生产邮件推荐 `EMAIL_PROVIDER=resend`，并必须提供 `RESEND_WEBHOOK_SECRET`；SMTP 仅作为兼容路径。API 与 Worker 必须使用同一个退订密钥。
2. 设置 `NODE_ENV=production`、`ALLOW_DEV_IDENTITY=false`，并使用 HTTPS `WEB_ORIGIN`。生产配置不满足这三项时必须启动失败。
3. 运行 `docker compose -f infra/compose.production.example.yaml --profile monitoring config --quiet`，确认 Compose 有效且没有暴露 PostgreSQL/Redis 端口。
4. 创建并校验数据库备份，再运行 `npm run db:deploy` 或一次性 `migrate` 服务。禁止自动执行迁移回滚。
5. 部署收件验证和退订快照迁移时，历史未验证偏好会被保守暂停，历史排队/运行中且没有冻结地址或退订 ID 的任务会标记失败；用户验证地址后需显式重新启用。迁移不会改写已成功或已跳过的历史运行。
5. 运行配置模式和 live 模式 `ops:doctor`；数据库与 Redis 必须为 `ok`。
6. 启动 API/Worker/Web，确认 `/api/v1/health` 为 200，`/api/v1/health/ready` 为 200。
7. 对已配置供应商运行对应的显式 live smoke；Resend 还需把 Webhook 配置为公开 HTTPS `POST /api/v1/email-webhooks/resend`，确认 Svix 签名测试事件返回 200。未配置供应商不阻塞其他能力。
8. 检查 `api.started`、`worker.started`、队列快照和首次调度日志，再开放流量。

### 每日备份与恢复演练

生产任务通过直连 PostgreSQL 客户端运行，不挂载 Docker Socket：

```powershell
docker compose -f infra/compose.production.example.yaml --profile operations run --rm backup
$env:BACKUP_PATH='/backups/lettermate-YYYYMMDDTHHMMSSZ.dump'
docker compose -f infra/compose.production.example.yaml --profile operations run --rm restore-drill
```

- 每日由目标平台调度 `backup` 一次，并监控非零退出码；`backup` 与 `restore-drill` 都是一次性任务，容器内不实现睡眠循环。
- `.dump` 与同名 `.manifest.json` 必须作为一组复制到加密外部存储；复制后再次执行清单校验。
- 至少每月运行一次 `restore-drill`。默认自动删除隔离数据库，不得将目标改为主库或系统库。
- 外部存储凭据和加密密钥只存在于目标环境秘密存储，不写入 Compose、镜像、日志或仓库。

## 3. 指标采集与告警

本地开发时，API 和 Worker 继续运行在宿主机，可通过独立 profile 启动持久化指标采集：

```powershell
docker compose -f infra/compose.yaml --profile monitoring up -d prometheus
```

本地配置通过 `host.docker.internal` 抓取 `3000` 和 `9464` 端口，指标保留 15 天，Prometheus 默认只绑定 `127.0.0.1:9090`。启动前必须先运行 API 和 Worker；该 profile 不改变默认的 PostgreSQL、Redis 或应用启动方式。

采集满 24 小时后运行来源漏斗评估：

```powershell
npm run evaluate:source-quality -- http://127.0.0.1:9090 24
```

报告通过 Worker `up` 的分钟 range 判断窗口是否完整，再按来源汇总成功/失败、候选获取、拒绝原因和最终精选贡献。`insufficient_data` 表示观察覆盖不足、Worker 可用率不足或窗口内没有来源尝试；`review_required` 表示至少一个来源命中重复失败、成功但零候选、低精选率或单来源占比规则。评估只读取固定 connector ID、来源类型和有限结果标签，不查询用户、关键词、URL 或运行 ID。

仓库提供可选 `monitoring` profile，使用固定版本 Prometheus 加载仓库内的抓取与告警规则：

```powershell
docker compose -f infra/compose.production.example.yaml --profile monitoring config --quiet
docker compose -f infra/compose.production.example.yaml --profile monitoring up -d prometheus
```

默认只在 `127.0.0.1:9090` 暴露 Prometheus。启动后检查 `http://127.0.0.1:9090/targets` 和 `http://127.0.0.1:9090/alerts`。不要通过设置 `PROMETHEUS_BIND_ADDRESS=0.0.0.0` 直接公开管理界面；远程访问应由目标环境通过 VPN、端口转发或带认证的 HTTPS 入口提供。

使用镜像内的官方 `promtool` 校验配置和规则：

```powershell
docker run --rm --entrypoint /bin/promtool `
  -v "${PWD}\infra\monitoring\prometheus.yml:/etc/prometheus/prometheus.yml:ro" `
  -v "${PWD}\infra\monitoring\alerts.yml:/etc/prometheus/alerts.yml:ro" `
  prom/prometheus:v3.5.0 check config /etc/prometheus/prometheus.yml

docker run --rm --entrypoint /bin/promtool `
  -v "${PWD}\infra\monitoring\alerts.yml:/etc/prometheus/alerts.yml:ro" `
  prom/prometheus:v3.5.0 check rules /etc/prometheus/alerts.yml
```

Compose 示例不内置 Alertmanager，也不保存邮件、即时通信或值班系统凭据。目标环境必须把 Prometheus 告警接入自己的 Alertmanager 或托管通知渠道，并为通知失败配置独立监控。

阈值是单实例初始值，完成容量测试后再调整。Prometheus 负责指标规则；结构化 JSON 日志仍由目标环境聚合，用于 trace/run 级诊断和日志告警：

Prometheus 采集目标：

- API：`http://api:3000/metrics`
- Worker：`http://worker:9464/metrics`

主要指标：

- `lettermate_api_http_requests_total`
- `lettermate_api_feed_impression_batches_total`
- `lettermate_api_feed_impressions_total`
- `lettermate_api_http_request_duration_seconds`
- `lettermate_worker_queue_jobs`
- `lettermate_worker_job_events_total`
- `lettermate_worker_agent_stage_duration_seconds`
- `lettermate_worker_agent_stage_items_total`
- `lettermate_worker_source_attempts_total`
- `lettermate_worker_source_items_total`

| 严重度 | 条件 | 建议动作 |
| --- | --- | --- |
| Critical | Readiness 连续 2 分钟非 200 | 停止接流量，检查 PostgreSQL/Redis，运行 live doctor |
| Critical | `queue.worker.error` 或 `queue.metrics.failed` 连续出现 3 次 | 检查 Redis、网络和 Worker 重启状态 |
| High | 任一 `queue.snapshot.counts.failed > 0` 持续 10 分钟 | 按 queue 和安全错误码定位失败任务 |
| High | waiting 超过 100 且持续 10 分钟 | 检查 Worker 存活、外部限流和任务耗时 |
| Medium | 同一 connector/source 15 分钟内失败 5 次 | 检查供应商状态、配额和凭据，不停止其他来源 |
| Medium | 已成功调用的来源连续 24 小时没有候选 | 检查查询路由、供应商返回和时间窗口 |
| Medium | 单一来源 24 小时内至少 20 条候选但精选率低于 5% | 按 `outcome` 区分正文安全/HTTP/超时/MIME/大小、时间、关键词、事实支持和去重问题 |
| Medium | 单一来源占 24 小时最终精选的 90% 以上，且总精选不少于 10 条 | 检查其他来源是否失效或长期低产出，不按配额补低质量内容 |
| Medium | `agent.stage.completed` 耗时持续接近运行超时 | 检查对应 stage、模型延迟和候选规模 |
| Medium | Feed 曝光批次拒绝率超过 10% 持续 10 分钟 | 检查决策生命周期、客户端版本和 API 所有权校验错误 |

日志告警标签只允许 `service`、`event`、`queue`、`component`、`stage` 和安全 `code`。Prometheus 指标额外允许 method、路由模板、状态类别、result、state、kind，以及固定 connector ID、`source_type` 和有限 `outcome`。不得使用实际路径、用户字段、关键词、URL，或把 trace/run/job 标识用于长期高基数指标。

## 4. 密钥轮换

### AI、连接器和邮件提供商

1. 在供应商创建新凭据，保留旧凭据。
2. 更新秘密存储并重启使用该凭据的服务。X 同时被 API 身份解析和 Worker 使用，需要重启两者；其他发现和邮件凭据通常只需重启 Worker。
3. 运行配置 doctor、依赖 live doctor 和对应供应商 live smoke。
4. 观察至少一个调度周期，确认没有持续的认证、限流或投递错误。
5. 撤销旧凭据并记录轮换时间，不记录密钥值。

### Session 与 CSRF

当前单实例基线没有多密钥验证窗口。轮换 `SESSION_SECRET` 会使现有登录会话失效，轮换 `CSRF_SECRET` 会使现有 CSRF Token 失效。应在维护窗口更新、重启 API，并明确要求用户重新登录。横向扩展前必须先设计 key ring，不能用不一致密钥滚动发布。

### 邮件退订签名

`EMAIL_UNSUBSCRIBE_SECRET` 必须在 API 与 Worker 中同步。当前没有多密钥验证窗口；轮换会使历史邮件中的退订链接失效。只在密钥泄露或计划维护时轮换，同时重启 API 与 Worker，并通知用户仍可登录 LetterMate 关闭每日邮件。不要把它与供应商 API Key 一起常规轮换。

### PostgreSQL 与 Redis

先完成可恢复备份，再更新服务端凭据和 `DATABASE_URL`/`REDIS_URL`，重启 API 与 Worker 并运行 live doctor。数据库与 Redis 凭据必须同步更新，避免旧实例继续使用已撤销密码。

## 5. 配额检查

- 每次部署前记录已配置供应商的套餐、月/日配额、并发限制和重置时间，只记录数值，不记录凭据。
- 通过显式 live smoke 验证一次最小请求；禁止用批量发现任务测试凭据。
- 聚合 `AI_RATE_LIMITED`、`CONNECTOR_RATE_LIMITED`、`TREND_SOURCE_RATE_LIMITED` 和 `EMAIL_RATE_LIMITED`。持续限流时降低调度或并发，不绕过供应商限制。
- `AI_CREDIT_EXHAUSTED` 和 `CONNECTOR_CREDIT_EXHAUSTED` 分别表示 OpenRouter AI 网关与 Web Search 连接器余额或额度不足，均属于不可重试故障；补充额度后再手动刷新，不应通过增加队列重试次数处理。
- GitHub、YouTube、Reddit、X、搜索和邮件供应商的配额分别管理；一个来源耗尽不能阻塞其他来源。

## 6. 故障恢复

| 现象 | 检查 | 恢复 |
| --- | --- | --- |
| API 不就绪 | live doctor、PostgreSQL、Redis | 恢复依赖后确认 Readiness；不要仅重启循环 |
| 队列积压 | Worker 日志、waiting/active/failed、外部限流 | 恢复 Worker 或限流来源；保留 BullMQ 任务状态 |
| 单一来源失败 | component 与安全 code、供应商状态 | 禁用或修复该来源；其他来源继续运行 |
| 邮件失败 | digest queue、对应 Resend/SMTP live smoke | 修复后重试同一冻结快照；失败不能推进成功边界 |
| 邮件未调度 | 收件状态、`enabled`、冻结地址迁移 | 确认地址为 `verified` 并让用户显式启用；不得手工把未验证地址写成已验证 |
| 一键退订失败 | API/Worker 的 `EMAIL_UNSUBSCRIBE_SECRET`、邮件头与公开路由 | 确保两进程密钥一致并同时重启；不要通过手工恢复旧 Token 绕过轮换 |
| Resend Webhook 失败 | `RESEND_WEBHOOK_SECRET`、公开 HTTPS 路由、Svix 三个头、API 时间同步 | 修复秘密或反向代理原始请求体传递后重放供应商事件；禁止关闭签名验证或记录原始 payload |
| 地址被邮件服务停用 | `EmailDeliveryEvent` 的安全事件类型/结果、对应本地 provider message ID | 不手工恢复同一地址；让用户更换并验证地址。未知或冲突归属只调查消息 ID，不能按 payload 邮箱修改账户 |
| 测试邮件失败 | `digest-test-email` queue、安全状态码、Provider smoke | 修复后在限频窗口允许时重试；测试邮件不得用于推进日报成功边界 |
| 数据库损坏或误操作 | 备份清单、隔离恢复验证 | 停机、审批后恢复主库；禁止工具自动覆盖主库 |

应用回滚只回滚镜像，不自动回滚 Prisma migration。若旧镜像不兼容新 schema，继续使用新镜像修复或执行经过评审的前向迁移。
