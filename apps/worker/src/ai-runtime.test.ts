import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  AiBudgetExceededError,
  AiRuntimePolicyChangedError,
  createAiRuntimePolicy,
  MemoryAiUsageLedger,
  PrismaAiUsageLedger,
  usdToMicros,
} from './ai-runtime.js';

const policy = () => createAiRuntimePolicy({
  defaultModel: 'default/model',
  fastModel: 'fast/model',
  qualityModel: 'quality/model',
  localizationModel: 'localization/model',
  fallbackModels: ['fallback/model'],
  providerOrder: ['Provider A'],
  allowProviderFallbacks: true,
  reservedCostUsdPerCall: 0.25,
  budget: {
    maxCalls: 2,
    maxInputTokens: 1_000,
    maxOutputTokens: 500,
    maxCostUsd: 0.5,
  },
});

describe('AI runtime policy', () => {
  it('routes tasks to explicit model classes with stable versions', () => {
    const first = policy();
    const second = policy();

    expect(first.version).toBe(second.version);
    expect(first.route('topic_expansion')).toMatchObject({
      model: 'fast/model', fallbackModels: ['fallback/model'],
      providerOrder: ['Provider A'], allowProviderFallbacks: true,
    });
    expect(first.route('candidate_assessment').model).toBe('quality/model');
    expect(first.route('digest_brief').model).toBe('quality/model');
    expect(first.route('creator_localization').model).toBe('localization/model');
    expect(first.route('item_chinese_repair').reservedCostMicros).toBe(250_000);
  });

  it('changes the policy version when a route or budget changes', () => {
    const initial = policy();
    const changed = createAiRuntimePolicy({
      defaultModel: 'default/model',
      fastModel: 'different/model',
      reservedCostUsdPerCall: 0.25,
      budget: {
        maxCalls: 2,
        maxInputTokens: 1_000,
        maxOutputTokens: 500,
        maxCostUsd: 0.5,
      },
    });

    expect(changed.version).not.toBe(initial.version);
  });
});

describe('MemoryAiUsageLedger', () => {
  it('reserves a conservative run budget and records actual usage', async () => {
    const runtime = policy();
    const ledger = new MemoryAiUsageLedger();
    const execution = { runId: 'run-1', userId: 'user-1', runKind: 'topic' as const };
    const reservation = await ledger.reserve({
      execution,
      task: 'topic_expansion',
      policyVersion: runtime.version,
      route: runtime.route('topic_expansion'),
      budget: runtime.budget,
      estimatedInputTokens: 100,
      reservedOutputTokens: 200,
      startedAt: new Date('2026-08-08T00:00:00.000Z'),
    });
    await ledger.complete(reservation, {
      actualModel: 'fast/model-v2', provider: 'Provider A',
      inputTokens: 60, outputTokens: 40, cachedTokens: 10, costMicros: usdToMicros(0.01),
    }, new Date('2026-08-08T00:00:01.000Z'));

    expect(ledger.records()).toEqual([expect.objectContaining({
      id: reservation.id,
      status: 'succeeded',
      actualModel: 'fast/model-v2',
      inputTokens: 60,
      outputTokens: 40,
      costMicros: 10_000,
    })]);
  });

  it('fails closed before an over-budget call is sent', async () => {
    const runtime = policy();
    const ledger = new MemoryAiUsageLedger();
    const input = {
      execution: { runId: 'run-2', userId: 'user-1', runKind: 'trend' as const },
      task: 'trend_classification' as const,
      policyVersion: runtime.version,
      route: runtime.route('trend_classification'),
      budget: runtime.budget,
      estimatedInputTokens: 400,
      reservedOutputTokens: 200,
      startedAt: new Date('2026-08-08T00:00:00.000Z'),
    };

    await ledger.reserve(input);
    await ledger.reserve(input);
    await expect(ledger.reserve(input)).rejects.toBeInstanceOf(AiBudgetExceededError);
  });

  it('rejects mixing runtime policies inside one run', async () => {
    const initial = policy();
    const changed = createAiRuntimePolicy({
      defaultModel: 'other/model',
      reservedCostUsdPerCall: 0.1,
      budget: { maxCalls: 2, maxInputTokens: 1_000, maxOutputTokens: 500, maxCostUsd: 1 },
    });
    const ledger = new MemoryAiUsageLedger();
    const execution = { runId: 'run-3', userId: 'user-1', runKind: 'creator' as const };
    await ledger.reserve({
      execution, task: 'creator_localization', policyVersion: initial.version,
      route: initial.route('creator_localization'), budget: initial.budget,
      estimatedInputTokens: 10, reservedOutputTokens: 10, startedAt: new Date(),
    });

    await expect(ledger.reserve({
      execution, task: 'creator_localization', policyVersion: changed.version,
      route: changed.route('creator_localization'), budget: changed.budget,
      estimatedInputTokens: 10, reservedOutputTokens: 10, startedAt: new Date(),
    })).rejects.toBeInstanceOf(AiRuntimePolicyChangedError);
  });

  it('charges actual cost above the reservation before allowing another call', async () => {
    const runtime = policy();
    const ledger = new MemoryAiUsageLedger();
    const input = {
      execution: { runId: 'run-actual-cost', userId: 'user-1', runKind: 'topic' as const },
      task: 'topic_expansion' as const,
      policyVersion: runtime.version,
      route: runtime.route('topic_expansion'),
      budget: runtime.budget,
      estimatedInputTokens: 10,
      reservedOutputTokens: 10,
      startedAt: new Date('2026-08-08T00:00:00.000Z'),
    };
    const reservation = await ledger.reserve(input);
    await ledger.complete(
      reservation,
      { costMicros: usdToMicros(0.4) },
      new Date('2026-08-08T00:00:01.000Z'),
    );

    await expect(ledger.reserve(input)).rejects.toBeInstanceOf(AiBudgetExceededError);
  });
});

describe('PrismaAiUsageLedger', () => {
  it('settles excess actual cost once when completion is retried', async () => {
    const transaction = {
      aiUsage: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({
            status: 'reserved',
            runKind: 'topic',
            runId: 'run-actual-cost',
            reservedCostMicros: 250_000,
          })
          .mockResolvedValueOnce({
            status: 'succeeded',
            runKind: 'topic',
            runId: 'run-actual-cost',
            reservedCostMicros: 250_000,
          }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      aiRunBudget: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) => (
        callback(transaction)
      )),
    } as unknown as PrismaClient;
    const ledger = new PrismaAiUsageLedger(prisma);
    const reservation = { id: 'usage-1' };
    const finishedAt = new Date('2026-08-08T00:00:01.000Z');

    await ledger.complete(reservation, { costMicros: 400_000 }, finishedAt);
    await ledger.complete(reservation, { costMicros: 400_000 }, finishedAt);

    expect(transaction.aiUsage.updateMany).toHaveBeenCalledOnce();
    expect(transaction.aiRunBudget.updateMany).toHaveBeenCalledOnce();
    expect(transaction.aiRunBudget.updateMany).toHaveBeenCalledWith({
      where: { runKind: 'topic', runId: 'run-actual-cost' },
      data: { reservedCostMicros: { increment: 150_000 } },
    });
  });
});
