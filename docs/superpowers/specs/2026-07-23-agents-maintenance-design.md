# AGENTS.md Maintenance Design / AGENTS.md 维护设计

**Date / 日期:** 2026-07-23  
**Status / 状态:** Approved design / 已确认设计  
**Scope / 范围:** Repository-root `AGENTS.md` only / 仅仓库根目录 `AGENTS.md`

## Purpose / 目的

Create a concise bilingual operating guide for coding agents working in LetterMate. The guide
must translate the repository's active requirements and implementation plan into executable
working rules without presenting planned capabilities as implemented.

为参与 LetterMate 开发的编码代理提供简洁的双语操作指南。该指南应把仓库中的有效需求和实施
计划转化为可执行的工作规则，同时不得把规划中的能力描述为已经实现。

## Selected Approach / 选定方案

Use a constraint-first guide. It will be more prescriptive than a directory index, but lighter
than a mandatory task or commit template. This matches an early-stage project whose product and
security boundaries are already defined while much of the end-to-end implementation remains open.

采用“约束优先型”指南。它比单纯的目录索引更具约束力，但不引入强制任务模板或提交模板。
这种方式适合当前阶段：产品与安全边界已经明确，而端到端实现仍有大量工作尚未完成。

## Content Model / 内容模型

The root guide will contain these sections:

1. Project mission and an explicit current-state warning.
2. Source-of-truth precedence among the active PRD, active V3 plan, README, architecture and
   technology documents, and historical plans.
3. Repository map and ownership boundaries.
4. Product and architecture invariants derived from the V2 PRD.
5. Development workflow, focused verification commands, and full quality gates.
6. Security, privacy, idempotency, and observability requirements.
7. Documentation synchronization rules and a maintenance checklist.

根指南将包含以下内容：

1. 项目使命，以及对当前实现状态的明确提示。
2. 有效 PRD、V3 实施计划、README、架构与技术选型文档、历史计划之间的事实来源优先级。
3. 仓库目录和职责边界。
4. 从 V2 PRD 提炼的产品与架构不变量。
5. 开发流程、聚焦验证命令和完整质量门禁。
6. 安全、隐私、幂等性和可观测性要求。
7. 文档同步规则与维护检查清单。

## Maintenance Rules / 维护规则

- Describe implemented behavior from code and tests; describe future behavior as planned work.
- Keep stable principles in `AGENTS.md`; keep detailed task sequences in the active implementation
  plan to avoid duplication and drift.
- Update `AGENTS.md` when authoritative document paths, supported runtimes, quality commands,
  repository boundaries, or non-negotiable architecture constraints change.
- Update the README when user-visible status or setup changes, the PRD when product requirements
  change, the active plan when implementation sequencing changes, and ADRs when an architectural
  decision changes or supersedes an earlier decision.
- Do not silently reconcile contradictions. Record the conflict and update the authoritative source
  before encoding the result in `AGENTS.md`.

- 已实现行为以代码和测试为准；未来行为必须明确标记为规划工作。
- `AGENTS.md` 只保存稳定原则；详细任务顺序保留在有效实施计划中，以免重复和漂移。
- 当权威文档路径、支持的运行时、质量命令、目录职责或不可妥协的架构约束发生变化时，更新
  `AGENTS.md`。
- 用户可见状态或安装方式变化时更新 README；产品需求变化时更新 PRD；实施顺序变化时更新
  有效计划；架构决策变化或取代旧决策时更新 ADR。
- 不得静默消解文档冲突。应先记录冲突并更新权威事实来源，再把结论写入 `AGENTS.md`。

## Verification / 验证

The document will be checked against current file paths, `pyproject.toml`, README status, the V2
PRD boundaries, and the V3 plan. A placeholder and contradiction scan will confirm that it contains
no unresolved markers, nonexistent required commands, or claims that unfinished features exist.

文档将与当前路径、`pyproject.toml`、README 状态、V2 PRD 边界和 V3 计划交叉检查。占位符与
矛盾检查将确保其中没有未解决标记、不存在的必需命令，或把未完成功能写成已完成的表述。

## Non-Goals / 非目标

- Rewriting the PRD or implementation plan.
- Defining a new product architecture.
- Adding nested `AGENTS.md` files before directory-specific rules are needed.
- Changing application code, dependencies, or runtime behavior.

- 重写 PRD 或实施计划。
- 定义新的产品架构。
- 在出现目录专属规则需求之前添加嵌套的 `AGENTS.md`。
- 修改应用代码、依赖或运行时行为。
