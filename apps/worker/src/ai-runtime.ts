import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

export const aiTasks = [
  'topic_expansion',
  'trend_classification',
  'evidence_gap_detection',
  'candidate_assessment',
  'item_composition',
  'item_chinese_repair',
  'creator_localization',
  'interest_tagging',
] as const;

export type AiTask = typeof aiTasks[number];
export type AiRunKind = 'topic' | 'trend' | 'creator';

export interface AiExecutionContext {
  runId: string;
  userId: string;
  runKind: AiRunKind;
}

export interface AiModelRoute {
  task: AiTask;
  version: string;
  model: string;
  fallbackModels: string[];
  providerOrder: string[];
  allowProviderFallbacks: boolean;
  reservedCostMicros: number;
}

export interface AiRunBudgetLimits {
  version: string;
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicros: number;
}

export interface AiRuntimePolicy {
  version: string;
  budget: AiRunBudgetLimits;
  route(task: AiTask): AiModelRoute;
}

export interface AiRuntimePolicyInput {
  defaultModel: string;
  fastModel?: string | undefined;
  qualityModel?: string | undefined;
  localizationModel?: string | undefined;
  fallbackModels?: readonly string[] | undefined;
  providerOrder?: readonly string[] | undefined;
  allowProviderFallbacks?: boolean | undefined;
  reservedCostUsdPerCall: number;
  budget: {
    maxCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxCostUsd: number;
  };
}

export interface AiUsageReservationInput {
  execution: AiExecutionContext;
  task: AiTask;
  policyVersion: string;
  route: AiModelRoute;
  budget: AiRunBudgetLimits;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  startedAt: Date;
}

export interface AiUsageReservation {
  id: string;
}

export interface AiCallUsage {
  actualModel?: string | undefined;
  provider?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  cachedTokens?: number | undefined;
  costMicros?: number | undefined;
}

export interface AiUsageLedger {
  reserve(input: AiUsageReservationInput): Promise<AiUsageReservation>;
  complete(reservation: AiUsageReservation, usage: AiCallUsage, finishedAt: Date): Promise<void>;
  fail(reservation: AiUsageReservation, errorCode: string, finishedAt: Date): Promise<void>;
}

export class AiBudgetExceededError extends Error {
  readonly code = 'AI_BUDGET_EXCEEDED';

  constructor(message = 'AI run budget was exhausted') {
    super(message);
    this.name = 'AiBudgetExceededError';
  }
}

export class AiRuntimePolicyChangedError extends Error {
  readonly code = 'AI_RUNTIME_POLICY_CHANGED';

  constructor() {
    super('AI runtime policy changed during an active run');
    this.name = 'AiRuntimePolicyChangedError';
  }
}

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be positive`);
  return value;
};

const nonNegativeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must not be negative`);
  return value;
};

export const usdToMicros = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('USD value must not be negative');
  const micros = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(micros)) throw new RangeError('USD value is too large');
  return micros;
};

const unique = (values: readonly string[]): string[] => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

const version = (prefix: string, input: unknown): string => {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
  return `${prefix}-${digest}`;
};

export function createAiRuntimePolicy(input: AiRuntimePolicyInput): AiRuntimePolicy {
  const defaultModel = input.defaultModel.trim();
  if (!defaultModel) throw new TypeError('defaultModel must not be empty');
  const fastModel = input.fastModel?.trim() || defaultModel;
  const qualityModel = input.qualityModel?.trim() || defaultModel;
  const localizationModel = input.localizationModel?.trim() || defaultModel;
  const fallbackModels = unique(input.fallbackModels ?? []).filter((model) => model !== defaultModel);
  const providerOrder = unique(input.providerOrder ?? []);
  const reservedCostMicros = usdToMicros(input.reservedCostUsdPerCall);
  const budgetShape = {
    maxCalls: positiveInteger(input.budget.maxCalls, 'maxCalls'),
    maxInputTokens: positiveInteger(input.budget.maxInputTokens, 'maxInputTokens'),
    maxOutputTokens: positiveInteger(input.budget.maxOutputTokens, 'maxOutputTokens'),
    maxCostMicros: positiveInteger(usdToMicros(input.budget.maxCostUsd), 'maxCostMicros'),
  };
  const routeModels: Record<AiTask, string> = {
    topic_expansion: fastModel,
    trend_classification: fastModel,
    evidence_gap_detection: qualityModel,
    candidate_assessment: qualityModel,
    item_composition: qualityModel,
    item_chinese_repair: localizationModel,
    creator_localization: localizationModel,
    interest_tagging: fastModel,
  };
  const routeInput = aiTasks.map((task) => ({
    task,
    model: routeModels[task],
    fallbackModels: fallbackModels.filter((model) => model !== routeModels[task]),
    providerOrder,
    allowProviderFallbacks: input.allowProviderFallbacks ?? false,
    reservedCostMicros,
  }));
  const policyVersion = version('ai-policy', { routeInput, budgetShape });
  const routes = new Map<AiTask, AiModelRoute>(routeInput.map((route) => [route.task, {
    ...route,
    version: version('model-route', route),
  }]));
  const budget: AiRunBudgetLimits = {
    ...budgetShape,
    version: version('run-budget', budgetShape),
  };
  return {
    version: policyVersion,
    budget,
    route(task) {
      const route = routes.get(task);
      if (!route) throw new Error(`Missing model route for ${task}`);
      return { ...route, fallbackModels: [...route.fallbackModels], providerOrder: [...route.providerOrder] };
    },
  };
}

interface MemoryBudgetState {
  userId: string;
  policyVersion: string;
  budget: AiRunBudgetLimits;
  reservedCalls: number;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  reservedCostMicros: number;
}

export interface MemoryAiUsageRecord extends AiUsageReservationInput, AiCallUsage {
  id: string;
  status: 'reserved' | 'succeeded' | 'failed';
  errorCode?: string | undefined;
  finishedAt?: Date | undefined;
}

const assertReservationFits = (
  state: MemoryBudgetState,
  input: Pick<AiUsageReservationInput, 'estimatedInputTokens' | 'reservedOutputTokens' | 'route'>,
): void => {
  const nextCalls = state.reservedCalls + 1;
  const nextInput = state.reservedInputTokens + input.estimatedInputTokens;
  const nextOutput = state.reservedOutputTokens + input.reservedOutputTokens;
  const nextCost = state.reservedCostMicros + input.route.reservedCostMicros;
  if (
    nextCalls > state.budget.maxCalls
    || nextInput > state.budget.maxInputTokens
    || nextOutput > state.budget.maxOutputTokens
    || nextCost > state.budget.maxCostMicros
  ) {
    throw new AiBudgetExceededError();
  }
};

export class MemoryAiUsageLedger implements AiUsageLedger {
  private readonly budgets = new Map<string, MemoryBudgetState>();
  private readonly usage = new Map<string, MemoryAiUsageRecord>();

  async reserve(input: AiUsageReservationInput): Promise<AiUsageReservation> {
    nonNegativeInteger(input.estimatedInputTokens, 'estimatedInputTokens');
    nonNegativeInteger(input.reservedOutputTokens, 'reservedOutputTokens');
    const key = `${input.execution.runKind}\u0000${input.execution.runId}`;
    let state = this.budgets.get(key);
    if (!state) {
      state = {
        userId: input.execution.userId,
        policyVersion: input.policyVersion,
        budget: { ...input.budget },
        reservedCalls: 0,
        reservedInputTokens: 0,
        reservedOutputTokens: 0,
        reservedCostMicros: 0,
      };
      this.budgets.set(key, state);
    }
    if (state.userId !== input.execution.userId || state.policyVersion !== input.policyVersion) {
      throw new AiRuntimePolicyChangedError();
    }
    assertReservationFits(state, input);
    state.reservedCalls += 1;
    state.reservedInputTokens += input.estimatedInputTokens;
    state.reservedOutputTokens += input.reservedOutputTokens;
    state.reservedCostMicros += input.route.reservedCostMicros;
    const id = randomUUID();
    this.usage.set(id, { ...input, id, status: 'reserved' });
    return { id };
  }

  async complete(reservation: AiUsageReservation, usage: AiCallUsage, finishedAt: Date): Promise<void> {
    const current = this.usage.get(reservation.id);
    if (!current || current.status !== 'reserved') return;
    if (usage.costMicros !== undefined) {
      const actualCostMicros = nonNegativeInteger(usage.costMicros, 'costMicros');
      const excessCostMicros = actualCostMicros - current.route.reservedCostMicros;
      if (excessCostMicros > 0) {
        const key = `${current.execution.runKind}\u0000${current.execution.runId}`;
        const budget = this.budgets.get(key);
        if (budget) budget.reservedCostMicros += excessCostMicros;
      }
    }
    this.usage.set(reservation.id, { ...current, ...usage, status: 'succeeded', finishedAt });
  }

  async fail(reservation: AiUsageReservation, errorCode: string, finishedAt: Date): Promise<void> {
    const current = this.usage.get(reservation.id);
    if (!current || current.status !== 'reserved') return;
    this.usage.set(reservation.id, { ...current, status: 'failed', errorCode, finishedAt });
  }

  records(): MemoryAiUsageRecord[] {
    return [...this.usage.values()].map((record) => ({
      ...record,
      execution: { ...record.execution },
      route: {
        ...record.route,
        fallbackModels: [...record.route.fallbackModels],
        providerOrder: [...record.route.providerOrder],
      },
      budget: { ...record.budget },
    }));
  }
}

export class PrismaAiUsageLedger implements AiUsageLedger {
  constructor(private readonly prisma: PrismaClient) {}

  async reserve(input: AiUsageReservationInput): Promise<AiUsageReservation> {
    const estimatedInputTokens = nonNegativeInteger(
      input.estimatedInputTokens,
      'estimatedInputTokens',
    );
    const reservedOutputTokens = nonNegativeInteger(
      input.reservedOutputTokens,
      'reservedOutputTokens',
    );
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.aiRunBudget.upsert({
        where: {
          runKind_runId: {
            runKind: input.execution.runKind,
            runId: input.execution.runId,
          },
        },
        create: {
          runKind: input.execution.runKind,
          runId: input.execution.runId,
          userId: input.execution.userId,
          policyVersion: input.policyVersion,
          budgetVersion: input.budget.version,
          maxCalls: input.budget.maxCalls,
          maxInputTokens: input.budget.maxInputTokens,
          maxOutputTokens: input.budget.maxOutputTokens,
          maxCostMicros: input.budget.maxCostMicros,
        },
        update: {},
      });
      if (
        current.userId !== input.execution.userId
        || current.policyVersion !== input.policyVersion
      ) {
        throw new AiRuntimePolicyChangedError();
      }
      const remainingInput = current.maxInputTokens - estimatedInputTokens;
      const remainingOutput = current.maxOutputTokens - reservedOutputTokens;
      const remainingCost = current.maxCostMicros - input.route.reservedCostMicros;
      if (remainingInput < 0 || remainingOutput < 0 || remainingCost < 0) {
        throw new AiBudgetExceededError();
      }
      const reserved = await transaction.aiRunBudget.updateMany({
        where: {
          runKind: input.execution.runKind,
          runId: input.execution.runId,
          policyVersion: input.policyVersion,
          reservedCalls: { lt: current.maxCalls },
          reservedInputTokens: { lte: remainingInput },
          reservedOutputTokens: { lte: remainingOutput },
          reservedCostMicros: { lte: remainingCost },
        },
        data: {
          reservedCalls: { increment: 1 },
          reservedInputTokens: { increment: estimatedInputTokens },
          reservedOutputTokens: { increment: reservedOutputTokens },
          reservedCostMicros: { increment: input.route.reservedCostMicros },
        },
      });
      if (reserved.count !== 1) throw new AiBudgetExceededError();
      const usage = await transaction.aiUsage.create({
        data: {
          runKind: input.execution.runKind,
          runId: input.execution.runId,
          userId: input.execution.userId,
          task: input.task,
          status: 'reserved',
          routeVersion: input.route.version,
          requestedModel: input.route.model,
          estimatedInputTokens,
          reservedOutputTokens,
          reservedCostMicros: input.route.reservedCostMicros,
          startedAt: input.startedAt,
        },
        select: { id: true },
      });
      return usage;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async complete(reservation: AiUsageReservation, usage: AiCallUsage, finishedAt: Date): Promise<void> {
    const data: Prisma.AiUsageUpdateManyMutationInput = {
      status: 'succeeded',
      finishedAt,
      ...(usage.actualModel !== undefined ? { actualModel: usage.actualModel } : {}),
      ...(usage.provider !== undefined ? { provider: usage.provider } : {}),
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(usage.cachedTokens !== undefined ? { cachedTokens: usage.cachedTokens } : {}),
      ...(usage.costMicros !== undefined ? { costMicros: usage.costMicros } : {}),
    };
    await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.aiUsage.findUnique({
        where: { id: reservation.id },
        select: {
          status: true,
          runKind: true,
          runId: true,
          reservedCostMicros: true,
        },
      });
      if (!current || current.status !== 'reserved') return;
      const completed = await transaction.aiUsage.updateMany({
        where: { id: reservation.id, status: 'reserved' },
        data,
      });
      if (completed.count !== 1 || usage.costMicros === undefined) return;
      const actualCostMicros = nonNegativeInteger(usage.costMicros, 'costMicros');
      const excessCostMicros = actualCostMicros - current.reservedCostMicros;
      if (excessCostMicros <= 0) return;
      await transaction.aiRunBudget.updateMany({
        where: { runKind: current.runKind, runId: current.runId },
        data: { reservedCostMicros: { increment: excessCostMicros } },
      });
    });
  }

  async fail(reservation: AiUsageReservation, errorCode: string, finishedAt: Date): Promise<void> {
    await this.prisma.aiUsage.updateMany({
      where: { id: reservation.id, status: 'reserved' },
      data: { status: 'failed', errorCode, finishedAt },
    });
  }
}
