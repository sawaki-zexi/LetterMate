# LetterMate 运行手册

**更新日期：** 2026-08-09

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

1. 使用秘密存储提供 `SESSION_SECRET`、`CSRF_SECRET`、数据库、Redis、AI、连接器和 SMTP 凭据；不要写入镜像或仓库。
2. 设置 `NODE_ENV=production`、`ALLOW_DEV_IDENTITY=false`，并使用 HTTPS `WEB_ORIGIN`。生产配置不满足这三项时必须启动失败。
3. 运行 `docker compose -f infra/compose.production.example.yaml config`，确认没有暴露 PostgreSQL/Redis 端口。
4. 创建并校验数据库备份，再运行 `npm run db:deploy` 或一次性 `migrate` 服务。禁止自动执行迁移回滚。
5. 运行配置模式和 live 模式 `ops:doctor`；数据库与 Redis 必须为 `ok`。
6. 启动 API/Worker/Web，确认 `/api/v1/health` 为 200，`/api/v1/health/ready` 为 200。
7. 对已配置供应商运行对应的显式 live smoke；未配置供应商不阻塞其他能力。
8. 检查 `api.started`、`worker.started`、队列快照和首次调度日志，再开放流量。

### 每日备份与恢复演练

生产任务通过直连 PostgreSQL 客户端运行，不挂载 Docker Socket：

```powershell
docker compose -f infra/compose.production.example.yaml --profile operations run --rm backup
$env:BACKUP_PATH='/backups/lettermate-YYYYMMDDTHHMMSSZ.dump'
docker compose -f infra/compose.production.example.yaml --profile operations run --rm restore-drill
```

- 每日调度 `backup` 一次，并监控非零退出码。
- `.dump` 与同名 `.manifest.json` 必须作为一组复制到加密外部存储；复制后再次执行清单校验。
- 至少每月运行一次 `restore-drill`。默认自动删除隔离数据库，不得将目标改为主库或系统库。
- 外部存储凭据和加密密钥只存在于目标环境秘密存储，不写入 Compose、镜像、日志或仓库。

## 3. 告警基线

目标环境从结构化 JSON 日志聚合以下规则；阈值是单实例初始值，完成容量测试后再调整：

Prometheus 采集目标：

- API：`http://api:3000/metrics`
- Worker：`http://worker:9464/metrics`

主要指标：

- `lettermate_api_http_requests_total`
- `lettermate_api_http_request_duration_seconds`
- `lettermate_worker_queue_jobs`
- `lettermate_worker_job_events_total`
- `lettermate_worker_agent_stage_duration_seconds`
- `lettermate_worker_agent_stage_items_total`

| 严重度 | 条件 | 建议动作 |
| --- | --- | --- |
| Critical | Readiness 连续 2 分钟非 200 | 停止接流量，检查 PostgreSQL/Redis，运行 live doctor |
| Critical | `queue.worker.error` 或 `queue.metrics.failed` 连续出现 3 次 | 检查 Redis、网络和 Worker 重启状态 |
| High | 任一 `queue.snapshot.counts.failed > 0` 持续 10 分钟 | 按 queue 和安全错误码定位失败任务 |
| High | waiting 超过 100 且持续 10 分钟 | 检查 Worker 存活、外部限流和任务耗时 |
| Medium | 同一 connector/source 15 分钟内失败 5 次 | 检查供应商状态、配额和凭据，不停止其他来源 |
| Medium | `agent.stage.completed` 耗时持续接近运行超时 | 检查对应 stage、模型延迟和候选规模 |

日志告警标签只允许 `service`、`event`、`queue`、`component`、`stage` 和安全 `code`。Prometheus 指标额外允许 method、路由模板、状态类别、result、state 和 kind。不得使用实际路径、用户字段，或把 trace/run/job 标识用于长期高基数指标。

## 4. 密钥轮换

### AI、连接器和 SMTP

1. 在供应商创建新凭据，保留旧凭据。
2. 更新秘密存储并重启使用该凭据的服务。X 同时被 API 身份解析和 Worker 使用，需要重启两者；其他发现和邮件凭据通常只需重启 Worker。
3. 运行配置 doctor、依赖 live doctor 和对应供应商 live smoke。
4. 观察至少一个调度周期，确认没有持续的认证、限流或投递错误。
5. 撤销旧凭据并记录轮换时间，不记录密钥值。

### Session 与 CSRF

当前单实例基线没有多密钥验证窗口。轮换 `SESSION_SECRET` 会使现有登录会话失效，轮换 `CSRF_SECRET` 会使现有 CSRF Token 失效。应在维护窗口更新、重启 API，并明确要求用户重新登录。横向扩展前必须先设计 key ring，不能用不一致密钥滚动发布。

### PostgreSQL 与 Redis

先完成可恢复备份，再更新服务端凭据和 `DATABASE_URL`/`REDIS_URL`，重启 API 与 Worker 并运行 live doctor。数据库与 Redis 凭据必须同步更新，避免旧实例继续使用已撤销密码。

## 5. 配额检查

- 每次部署前记录已配置供应商的套餐、月/日配额、并发限制和重置时间，只记录数值，不记录凭据。
- 通过显式 live smoke 验证一次最小请求；禁止用批量发现任务测试凭据。
- 聚合 `AI_RATE_LIMITED`、`CONNECTOR_RATE_LIMITED`、`TREND_SOURCE_RATE_LIMITED` 和 `EMAIL_RATE_LIMITED`。持续限流时降低调度或并发，不绕过供应商限制。
- GitHub、YouTube、Reddit、X、搜索和邮件供应商的配额分别管理；一个来源耗尽不能阻塞其他来源。

## 6. 故障恢复

| 现象 | 检查 | 恢复 |
| --- | --- | --- |
| API 不就绪 | live doctor、PostgreSQL、Redis | 恢复依赖后确认 Readiness；不要仅重启循环 |
| 队列积压 | Worker 日志、waiting/active/failed、外部限流 | 恢复 Worker 或限流来源；保留 BullMQ 任务状态 |
| 单一来源失败 | component 与安全 code、供应商状态 | 禁用或修复该来源；其他来源继续运行 |
| 邮件失败 | digest queue、SMTP live smoke | 修复后重试同一冻结快照；失败不能推进成功边界 |
| 数据库损坏或误操作 | 备份清单、隔离恢复验证 | 停机、审批后恢复主库；禁止工具自动覆盖主库 |

应用回滚只回滚镜像，不自动回滚 Prisma migration。若旧镜像不兼容新 schema，继续使用新镜像修复或执行经过评审的前向迁移。
