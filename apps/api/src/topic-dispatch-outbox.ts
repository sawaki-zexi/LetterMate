import {
  type DiscoveryJobData,
  type DiscoveryTrigger,
} from '@lettermate/contracts';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TopicQueue } from './topic-queue.js';

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_POLL_MS = 1_000;
const MAX_BATCH_SIZE = 25;

export interface TopicDispatchRecord {
  id: string;
  data: DiscoveryJobData;
  attemptCount: number;
}

export interface TopicDispatchOutbox {
  register(
    data: DiscoveryJobData,
    transaction?: Prisma.TransactionClient,
  ): Promise<string>;
  claim(limit: number, now: Date, leaseMs: number): Promise<TopicDispatchRecord[]>;
  acknowledge(id: string): Promise<void>;
  retry(id: string, availableAt: Date, errorCode: string): Promise<void>;
  cancelTopic(topicId: string, transaction?: Prisma.TransactionClient): Promise<void>;
  close(): Promise<void>;
}

export class NoopTopicDispatchOutbox implements TopicDispatchOutbox {
  async register(_data: DiscoveryJobData, _transaction?: Prisma.TransactionClient): Promise<string> {
    return 'noop';
  }

  async claim(_limit: number, _now: Date, _leaseMs: number): Promise<TopicDispatchRecord[]> {
    return [];
  }

  async acknowledge(_id: string): Promise<void> {}
  async retry(_id: string, _availableAt: Date, _errorCode: string): Promise<void> {}
  async cancelTopic(_topicId: string, _transaction?: Prisma.TransactionClient): Promise<void> {}
  async close(): Promise<void> {}
}

function dispatchData(row: {
  id: string;
  topicId: string;
  userId: string;
  trigger: DiscoveryTrigger;
  attemptCount: number;
}): TopicDispatchRecord {
  return {
    id: row.id,
    attemptCount: row.attemptCount,
    data: { topicId: row.topicId, userId: row.userId, trigger: row.trigger },
  };
}

export class PrismaTopicDispatchOutbox implements TopicDispatchOutbox {
  constructor(private readonly prisma: PrismaClient) {}

  async register(
    data: DiscoveryJobData,
    transaction?: Prisma.TransactionClient,
  ): Promise<string> {
    const client = transaction ?? this.prisma;
    const row = await client.topicDispatchOutbox.create({
      data: {
        topicId: data.topicId,
        userId: data.userId,
        trigger: data.trigger,
      },
      select: { id: true },
    });
    return row.id;
  }

  async claim(limit: number, now: Date, leaseMs: number): Promise<TopicDispatchRecord[]> {
    const boundedLimit = Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(limit)));
    return this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{
        id: string;
        topicId: string;
        userId: string;
        trigger: DiscoveryTrigger;
        attemptCount: number;
      }>>(Prisma.sql`
        SELECT o."id", o."topicId", o."userId", o."trigger", o."attemptCount"
        FROM "TopicDispatchOutbox" o
        JOIN "Topic" t ON t."id" = o."topicId"
        WHERE o."dispatchedAt" IS NULL
          AND o."availableAt" <= ${now}
          AND (o."claimUntil" IS NULL OR o."claimUntil" <= ${now})
          AND t."userId" = o."userId"
          AND t."deletedAt" IS NULL
          AND t."pausedAt" IS NULL
        ORDER BY o."createdAt" ASC, o."id" ASC
        FOR UPDATE OF o SKIP LOCKED
        LIMIT ${boundedLimit}
      `);
      if (rows.length === 0) return [];
      const claimUntil = new Date(now.getTime() + leaseMs);
      await transaction.topicDispatchOutbox.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, dispatchedAt: null },
        data: { claimUntil, attemptCount: { increment: 1 } },
      });
      return rows.map((row) => dispatchData({
        ...row,
        attemptCount: row.attemptCount + 1,
      }));
    });
  }

  async acknowledge(id: string): Promise<void> {
    await this.prisma.topicDispatchOutbox.updateMany({
      where: { id, dispatchedAt: null },
      data: { dispatchedAt: new Date(), claimUntil: null, lastErrorCode: null },
    });
  }

  async retry(id: string, availableAt: Date, errorCode: string): Promise<void> {
    await this.prisma.topicDispatchOutbox.updateMany({
      where: { id, dispatchedAt: null },
      data: { availableAt, claimUntil: null, lastErrorCode: errorCode },
    });
  }

  async cancelTopic(topicId: string, transaction?: Prisma.TransactionClient): Promise<void> {
    const client = transaction ?? this.prisma;
    await client.topicDispatchOutbox.updateMany({
      where: { topicId, dispatchedAt: null },
      data: { dispatchedAt: new Date(), claimUntil: null, lastErrorCode: 'TOPIC_CANCELLED' },
    });
  }

  async close(): Promise<void> {}
}

export class MemoryTopicDispatchOutbox implements TopicDispatchOutbox {
  private readonly rows = new Map<string, {
    id: string;
    data: DiscoveryJobData;
    createdAt: Date;
    availableAt: Date;
    claimUntil: Date | null;
    attemptCount: number;
    dispatchedAt: Date | null;
    lastErrorCode: string | null;
  }>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly isTopicDispatchable: (topicId: string) => boolean = () => true,
  ) {}

  async register(data: DiscoveryJobData): Promise<string> {
    const id = `dispatch-${this.rows.size + 1}`;
    const now = this.now();
    this.rows.set(id, {
      id,
      data: structuredClone(data),
      createdAt: now,
      availableAt: now,
      claimUntil: null,
      attemptCount: 0,
      dispatchedAt: null,
      lastErrorCode: null,
    });
    return id;
  }

  async claim(limit: number, now: Date, leaseMs: number): Promise<TopicDispatchRecord[]> {
    const boundedLimit = Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(limit)));
    const claimUntil = new Date(now.getTime() + leaseMs);
    return [...this.rows.values()]
      .filter((row) => (
        row.dispatchedAt === null
        && this.isTopicDispatchable(row.data.topicId)
        && row.availableAt <= now
        && (row.claimUntil === null || row.claimUntil <= now)
      ))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
      .slice(0, boundedLimit)
      .map((row) => {
        row.claimUntil = claimUntil;
        row.attemptCount += 1;
        return {
          id: row.id,
          data: structuredClone(row.data),
          attemptCount: row.attemptCount,
        };
      });
  }

  async acknowledge(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row || row.dispatchedAt !== null) return;
    row.dispatchedAt = this.now();
    row.claimUntil = null;
    row.lastErrorCode = null;
  }

  async retry(id: string, availableAt: Date, errorCode: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row || row.dispatchedAt !== null) return;
    row.availableAt = availableAt;
    row.claimUntil = null;
    row.lastErrorCode = errorCode;
  }

  async cancelTopic(topicId: string): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.data.topicId !== topicId || row.dispatchedAt !== null) continue;
      row.dispatchedAt = this.now();
      row.claimUntil = null;
      row.lastErrorCode = 'TOPIC_CANCELLED';
    }
  }

  snapshot(): ReadonlyArray<Readonly<{
    id: string;
    data: DiscoveryJobData;
    attemptCount: number;
    dispatchedAt: Date | null;
    lastErrorCode: string | null;
  }>> {
    return [...this.rows.values()].map((row) => ({
      id: row.id,
      data: structuredClone(row.data),
      attemptCount: row.attemptCount,
      dispatchedAt: row.dispatchedAt,
      lastErrorCode: row.lastErrorCode,
    }));
  }

  async close(): Promise<void> {}
}

export interface TopicDispatchRelayOptions {
  now?: () => Date;
  pollMs?: number;
  leaseMs?: number;
  logger?: Pick<Console, 'warn' | 'error'>;
}

export class TopicDispatchRelay {
  private readonly now: () => Date;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly logger: Pick<Console, 'warn' | 'error'>;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly outbox: TopicDispatchOutbox,
    private readonly queue: TopicQueue,
    options: TopicDispatchRelayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.logger = options.logger ?? console;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => { void this.kick(); }, this.pollMs);
    this.timer.unref?.();
  }

  async kick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.flush().finally(() => { this.running = null; });
    return this.running;
  }

  private async flush(): Promise<void> {
    let records: TopicDispatchRecord[];
    try {
      records = await this.outbox.claim(MAX_BATCH_SIZE, this.now(), this.leaseMs);
    } catch (error) {
      this.logger.warn(`topic dispatch claim failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return;
    }
    for (const record of records) {
      try {
        await this.queue.enqueue(record.data, record.id);
        await this.outbox.acknowledge(record.id);
      } catch {
        const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, record.attemptCount - 1));
        try {
          await this.outbox.retry(
            record.id,
            new Date(this.now().getTime() + delayMs),
            'TOPIC_QUEUE_UNAVAILABLE',
          );
        } catch (retryError) {
          this.logger.error(`topic dispatch retry failed: ${retryError instanceof Error ? retryError.message : 'unknown error'}`);
        }
      }
    }
  }

  async close(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.running) await this.running;
    await this.outbox.close();
  }
}
