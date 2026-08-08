import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AiExecutionContext } from './ai-runtime.js';

export const runStages = [
  'plan',
  'retrieve',
  'enrich',
  'assess',
  'followup',
  'compose',
  'quality_gate',
  'persist',
] as const;
export type RunStageName = typeof runStages[number];
export type RunStageStatus = 'running' | 'succeeded' | 'failed';
export const RUN_STAGE_POLICY_VERSION = 'discovery-pipeline-v1';

export interface RunStageKey {
  execution: AiExecutionContext;
  stage: RunStageName;
  inputDigest: string;
  policyVersion?: string | undefined;
  routeVersion?: string | undefined;
}

export interface StoredRunStage {
  id: string;
  key: RunStageKey;
  status: RunStageStatus;
  attempt: number;
  artifact: unknown;
  startedAt: Date;
  finishedAt?: Date | undefined;
  errorCode?: string | undefined;
}

export interface RunStageStore {
  findSucceeded(key: RunStageKey): Promise<StoredRunStage | null>;
  begin(key: RunStageKey, startedAt: Date): Promise<StoredRunStage>;
  succeed(stage: StoredRunStage, artifact: unknown, finishedAt: Date, byteLength: number): Promise<void>;
  fail(stage: StoredRunStage, errorCode: string, finishedAt: Date): Promise<void>;
}

export class RunStageArtifactTooLargeError extends Error {
  readonly code = 'RUN_STAGE_ARTIFACT_TOO_LARGE';

  constructor() {
    super('Run stage artifact exceeded the configured retention size');
    this.name = 'RunStageArtifactTooLargeError';
  }
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
};

export const digestRunStageInput = (input: unknown): string => (
  createHash('sha256').update(JSON.stringify(stableValue(input))).digest('hex')
);

const safeErrorCode = (error: unknown): string => {
  if (!error || typeof error !== 'object' || !('code' in error)) return 'RUN_STAGE_FAILED';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_:-]{1,100}$/u.test(code)
    ? code
    : 'RUN_STAGE_FAILED';
};

export class RunStageManager {
  constructor(
    private readonly store: RunStageStore,
    private readonly options: {
      now?: () => Date;
      maxArtifactBytes?: number;
      policyVersion?: string;
    } = {},
  ) {}

  async run<T>(input: {
    execution: AiExecutionContext;
    stage: RunStageName;
    value: unknown;
    policyVersion?: string | undefined;
    routeVersion?: string | undefined;
    execute: () => Promise<T>;
  }): Promise<T> {
    const key: RunStageKey = {
      execution: input.execution,
      stage: input.stage,
      inputDigest: digestRunStageInput(input.value),
      ...(input.policyVersion !== undefined || this.options.policyVersion !== undefined
        ? { policyVersion: input.policyVersion ?? this.options.policyVersion } : {}),
      ...(input.routeVersion !== undefined ? { routeVersion: input.routeVersion } : {}),
    };
    const completed = await this.store.findSucceeded(key);
    if (completed?.artifact !== null && completed?.artifact !== undefined) {
      return completed.artifact as T;
    }

    const now = this.options.now ?? (() => new Date());
    const stage = await this.store.begin(key, now());
    try {
      const result = await input.execute();
      const serialized = JSON.stringify(stableValue(result)) ?? 'null';
      const byteLength = Buffer.byteLength(serialized, 'utf8');
      const maxBytes = this.options.maxArtifactBytes ?? 2_000_000;
      if (byteLength <= maxBytes) {
        await this.store.succeed(stage, result, now(), byteLength);
      } else {
        await this.store.fail(stage, 'RUN_STAGE_ARTIFACT_TOO_LARGE', now());
      }
      return result;
    } catch (error) {
      await this.store.fail(stage, safeErrorCode(error), now()).catch(() => undefined);
      throw error;
    }
  }
}

type MemoryStage = StoredRunStage;

export class MemoryRunStageStore implements RunStageStore {
  private readonly stages = new Map<string, MemoryStage>();

  async findSucceeded(key: RunStageKey): Promise<StoredRunStage | null> {
    const stage = this.stages.get(this.key(key));
    return stage?.status === 'succeeded' ? { ...stage } : null;
  }

  async begin(key: RunStageKey, startedAt: Date): Promise<StoredRunStage> {
    const mapKey = this.key(key);
    const previous = this.stages.get(mapKey);
    const stage: MemoryStage = {
      id: previous?.id ?? randomUUID(), key: { ...key, execution: { ...key.execution } },
      status: 'running', attempt: (previous?.attempt ?? 0) + 1, artifact: null, startedAt,
    };
    this.stages.set(mapKey, stage);
    return { ...stage };
  }

  async succeed(stage: StoredRunStage, artifact: unknown, finishedAt: Date, _byteLength: number): Promise<void> {
    const current = this.stages.get(this.key(stage.key));
    if (
      !current || current.id !== stage.id || current.attempt !== stage.attempt
      || current.status !== 'running'
    ) return;
    this.stages.set(this.key(stage.key), { ...current, status: 'succeeded', artifact, finishedAt });
  }

  async fail(stage: StoredRunStage, errorCode: string, finishedAt: Date): Promise<void> {
    const current = this.stages.get(this.key(stage.key));
    if (
      !current || current.id !== stage.id || current.attempt !== stage.attempt
      || current.status !== 'running'
    ) return;
    this.stages.set(this.key(stage.key), { ...current, status: 'failed', errorCode, finishedAt });
  }

  records(): StoredRunStage[] { return [...this.stages.values()].map((stage) => ({ ...stage })); }

  private key(key: RunStageKey): string {
    return [key.execution.runKind, key.execution.runId, key.stage, key.inputDigest,
      key.policyVersion ?? '', key.routeVersion ?? ''].join('\u0000');
  }
}

export class PrismaRunStageStore implements RunStageStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findSucceeded(key: RunStageKey): Promise<StoredRunStage | null> {
    const stage = await this.prisma.runStage.findFirst({
      where: {
        runKind: key.execution.runKind, runId: key.execution.runId,
        userId: key.execution.userId, stage: key.stage, inputDigest: key.inputDigest,
        policyVersion: key.policyVersion ?? '', routeVersion: key.routeVersion ?? '', status: 'succeeded',
      },
      include: { artifact: true }, orderBy: { attempt: 'desc' },
    });
    return stage ? mapPrismaStage(stage) : null;
  }

  async begin(key: RunStageKey, startedAt: Date): Promise<StoredRunStage> {
    const stage = await this.prisma.runStage.upsert({
      where: {
        userId_runKind_runId_stage_inputDigest_policyVersion_routeVersion: {
          userId: key.execution.userId, runKind: key.execution.runKind,
          runId: key.execution.runId, stage: key.stage,
          inputDigest: key.inputDigest, policyVersion: key.policyVersion ?? '', routeVersion: key.routeVersion ?? '',
        },
      },
      create: {
        runKind: key.execution.runKind, runId: key.execution.runId, userId: key.execution.userId,
        stage: key.stage, inputDigest: key.inputDigest, policyVersion: key.policyVersion ?? '',
        routeVersion: key.routeVersion ?? '', status: 'running', attempt: 1, startedAt,
      },
      update: { status: 'running', attempt: { increment: 1 }, startedAt, finishedAt: null, errorCode: null },
    });
    return mapPrismaStage(stage);
  }

  async succeed(stage: StoredRunStage, artifact: unknown, finishedAt: Date, byteLength: number): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.runStage.updateMany({
        where: { id: stage.id, status: 'running', attempt: stage.attempt },
        data: { status: 'succeeded', finishedAt, errorCode: null },
      });
      if (claimed.count !== 1) return;
      await transaction.runArtifact.upsert({
        where: { stageId: stage.id },
        create: { stageId: stage.id, data: artifact as object, byteLength },
        update: { data: artifact as object, byteLength },
      });
    });
  }

  async fail(stage: StoredRunStage, errorCode: string, finishedAt: Date): Promise<void> {
    await this.prisma.runStage.updateMany({
      where: { id: stage.id, status: 'running', attempt: stage.attempt },
      data: { status: 'failed', finishedAt, errorCode },
    });
  }
}

function mapPrismaStage(stage: {
  id: string; runKind: string; runId: string; userId: string; stage: string;
  inputDigest: string; policyVersion: string; routeVersion: string; status: string;
  attempt: number; startedAt: Date; finishedAt: Date | null; errorCode: string | null;
  artifact?: { data: unknown } | null;
}): StoredRunStage {
  return {
    id: stage.id,
    key: {
      execution: { runKind: stage.runKind as AiExecutionContext['runKind'], runId: stage.runId, userId: stage.userId },
      stage: stage.stage as RunStageName, inputDigest: stage.inputDigest,
      ...(stage.policyVersion ? { policyVersion: stage.policyVersion } : {}),
      ...(stage.routeVersion ? { routeVersion: stage.routeVersion } : {}),
    },
    status: stage.status as RunStageStatus, attempt: stage.attempt,
    artifact: stage.artifact?.data ?? null, startedAt: stage.startedAt,
    ...(stage.finishedAt ? { finishedAt: stage.finishedAt } : {}),
    ...(stage.errorCode ? { errorCode: stage.errorCode } : {}),
  };
}
