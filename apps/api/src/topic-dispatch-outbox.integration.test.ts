import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PrismaTopicDispatchOutbox } from './topic-dispatch-outbox.js';
import { PrismaTopicStore } from './topic-store.js';

const databaseIt = process.env.RUN_DATABASE_TESTS === '1' ? it : it.skip;

describe('Topic dispatch outbox PostgreSQL integration', () => {
  databaseIt('commits dispatch intent atomically and supports lease retry/ack', async () => {
    const prisma = new PrismaClient();
    const suffix = randomUUID();
    const userId = `topic-outbox-owner-${suffix}`;
    const dispatch = new PrismaTopicDispatchOutbox(prisma);
    try {
      await prisma.user.create({
        data: {
          id: userId,
          email: `${userId}@example.test`,
          passwordHash: 'test-password-hash',
        },
      });
      const store = new PrismaTopicStore(prisma);
      const topic = await store.createTopic(userId, 'AI Agent', 'ai agent');
      const persistedIntents = await prisma.topicDispatchOutbox.findMany({ where: { topicId: topic.id } });
      expect(persistedIntents).toHaveLength(1);
      const id = persistedIntents[0]!.id;
      const now = new Date();
      const claimed = await dispatch.claim(10, now, 30_000);
      expect(claimed).toEqual([expect.objectContaining({ id, attemptCount: 1 })]);

      const unavailableAt = new Date(now.getTime() + 60_000);
      await dispatch.retry(id, unavailableAt, 'TOPIC_QUEUE_UNAVAILABLE');
      expect(await dispatch.claim(10, new Date(now.getTime() + 30_000), 30_000)).toEqual([]);
      expect(await dispatch.claim(10, unavailableAt, 30_000)).toEqual([
        expect.objectContaining({ id, attemptCount: 2 }),
      ]);
      await dispatch.acknowledge(id);
      expect(await dispatch.claim(10, new Date('2026-08-19T10:02:00.000Z'), 30_000)).toEqual([]);
    } finally {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      await prisma.$disconnect();
    }
  });

  databaseIt('does not claim paused or deleted topics and rolls back intent with the transaction', async () => {
    const prisma = new PrismaClient();
    const suffix = randomUUID();
    const userId = `topic-outbox-state-${suffix}`;
    const dispatch = new PrismaTopicDispatchOutbox(prisma);
    try {
      await prisma.user.create({
        data: {
          id: userId,
          email: `${userId}@example.test`,
          passwordHash: 'test-password-hash',
        },
      });
      const paused = await prisma.topic.create({
        data: { userId, keyword: 'Paused', normalizedKeyword: 'paused', runStatus: 'queued', pausedAt: new Date() },
      });
      await dispatch.register({ topicId: paused.id, userId, trigger: 'manual' });
      expect(await dispatch.claim(10, new Date(), 30_000)).toEqual([]);

      const deleted = await prisma.topic.create({
        data: { userId, keyword: 'Deleted', normalizedKeyword: 'deleted', runStatus: 'queued' },
      });
      await dispatch.register({ topicId: deleted.id, userId, trigger: 'manual' });
      await prisma.topic.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
      expect(await dispatch.claim(10, new Date(), 30_000)).toEqual([]);

      const rollbackTopicId = randomUUID();
      await expect(prisma.$transaction(async (transaction) => {
        await transaction.topic.create({
          data: { id: rollbackTopicId, userId, keyword: 'Rollback', normalizedKeyword: 'rollback', runStatus: 'queued' },
        });
        await dispatch.register({ topicId: rollbackTopicId, userId, trigger: 'initial' }, transaction);
        throw new Error('rollback test');
      })).rejects.toThrow('rollback test');
      expect(await prisma.topic.findUnique({ where: { id: rollbackTopicId } })).toBeNull();
      expect(await prisma.topicDispatchOutbox.findMany({ where: { topicId: rollbackTopicId } })).toEqual([]);
    } finally {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      await prisma.$disconnect();
    }
  });
});
