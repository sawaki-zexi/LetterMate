# Agent 质量评估

LetterMate 使用确定性的版本化 golden fixtures 评估最终发现输出。评估不访问外部服务，也不调用 AI；它检查经过 Agent 管线后的结果是否仍满足产品质量边界。

## 评估指标

| 指标 | 默认门槛 | 业务含义 |
| --- | --- | --- |
| `expectedRecall` | `1.0` | golden case 中应出现的内容全部命中 |
| `forbiddenHitRate` | `0` | 已知越界内容不得命中，例如相邻版本 |
| `sourceCoverage` | `1.0` | 每条结果都有有效 HTTP(S) 原始链接 |
| `chineseCoverage` | `1.0` | 标题、摘要和推荐理由均完成中文化 |
| `duplicateRate` | `0` | 规范化主链接没有重复 |

运行：

```powershell
npm run evaluate:quality
```

命令输出机器可读 JSON；任一 case 未达到门槛时进程以非零状态退出，可以直接作为 CI quality gate。

仓库当前 case 是用于验证评估机制和业务边界的回归 fixtures，不是线上模型效果基准。简历或项目说明中应描述为“建立了可扩展的离线评估与 CI 门禁”，不能把这两个 case 宣称为生产数据集或真实召回率。

## 扩展数据集

新增 case 时需要同时提供：

- 稳定的 `caseId`；
- 经过人工确认的 `expectedUrls`；
- 已知不应出现的 `forbiddenUrls`，特别是版本边界、重复和无正文来源；
- Agent 最终输出的候选快照。

评估接口位于 `packages/domain/src/evaluation.ts`。CLI 只是一个 Adapter；测试、CI 或未来的离线数据集运行器应复用同一个接口。真实线上样本需要先脱敏和人工标注，不能把用户关键词、私有 URL 或供应商原始响应提交到仓库。

## 运行阶段遥测

Topic 与 Trend Worker 还会输出 `agent.stage.completed` 结构化事件。阶段包括 `plan`、`collect`、`classify`、`retrieve`、`quality_gate` 和 `persist`，只记录运行 ID、耗时和聚合数量。

阶段遥测不包含关键词、用户 ID、来源 URL、正文或 AI 原始响应；遥测失败也不会改变发现任务结果。目标环境可以按阶段耗时、输入输出收敛率和失败数量建立看板与告警。
