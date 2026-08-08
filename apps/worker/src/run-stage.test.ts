import { describe, expect, it, vi } from 'vitest';
import { MemoryRunStageStore, RunStageManager, digestRunStageInput } from './run-stage.js';

const execution = { runId: 'run-1', userId: 'user-1', runKind: 'topic' as const };

describe('RunStageManager', () => {
  it('reuses a completed artifact when input and policy versions match', async () => {
    const store = new MemoryRunStageStore();
    const manager = new RunStageManager(store, {
      now: () => new Date('2026-08-09T00:00:00.000Z'),
    });
    const execute = vi.fn().mockResolvedValue({ candidates: ['one'] });
    const input = {
      execution, stage: 'retrieve' as const, value: { query: 'AI agent', limit: 3 },
      policyVersion: 'policy-1', routeVersion: 'route-1', execute,
    };

    await expect(manager.run(input)).resolves.toEqual({ candidates: ['one'] });
    await expect(manager.run(input)).resolves.toEqual({ candidates: ['one'] });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.records()).toEqual([expect.objectContaining({
      status: 'succeeded', attempt: 1, artifact: { candidates: ['one'] },
      key: expect.objectContaining({ inputDigest: digestRunStageInput(input.value) }),
    })]);
  });

  it('reruns after a failure and records a safe error code', async () => {
    const store = new MemoryRunStageStore();
    const manager = new RunStageManager(store);
    const execute = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('private response body'), { code: 'AI_UPSTREAM_UNAVAILABLE' }))
      .mockResolvedValueOnce({ ok: true });
    const input = {
      execution, stage: 'assess' as const, value: { ids: ['candidate-1'] }, execute,
    };

    await expect(manager.run(input)).rejects.toMatchObject({ code: 'AI_UPSTREAM_UNAVAILABLE' });
    await expect(manager.run(input)).resolves.toEqual({ ok: true });

    expect(store.records()[0]).toMatchObject({ status: 'succeeded', attempt: 2 });
    expect(JSON.stringify(store.records())).not.toContain('private response body');
  });

  it('does not retain oversized artifacts while returning the valid result', async () => {
    const store = new MemoryRunStageStore();
    const manager = new RunStageManager(store, { maxArtifactBytes: 10 });
    const result = { text: 'this is larger than ten bytes' };

    await expect(manager.run({
      execution, stage: 'compose', value: { id: 'x' }, execute: async () => result,
    })).resolves.toEqual(result);
    expect(store.records()[0]).toMatchObject({ status: 'failed', errorCode: 'RUN_STAGE_ARTIFACT_TOO_LARGE' });
  });

  it('changes the digest when array order changes but ignores object key order', () => {
    expect(digestRunStageInput({ b: 2, a: 1 })).toBe(digestRunStageInput({ a: 1, b: 2 }));
    expect(digestRunStageInput({ ids: ['one', 'two'] })).not.toBe(digestRunStageInput({ ids: ['two', 'one'] }));
  });

  it('does not let an older concurrent attempt overwrite the newer artifact', async () => {
    const store = new MemoryRunStageStore();
    const manager = new RunStageManager(store);
    let resolveOlder!: (value: { value: string }) => void;
    let resolveNewer!: (value: { value: string }) => void;
    const olderResult = new Promise<{ value: string }>((resolve) => { resolveOlder = resolve; });
    const newerResult = new Promise<{ value: string }>((resolve) => { resolveNewer = resolve; });
    const input = {
      execution,
      stage: 'retrieve' as const,
      value: { query: 'same input' },
    };

    const older = manager.run({ ...input, execute: () => olderResult });
    await vi.waitFor(() => expect(store.records()[0]?.attempt).toBe(1));
    const newer = manager.run({ ...input, execute: () => newerResult });
    await vi.waitFor(() => expect(store.records()[0]?.attempt).toBe(2));

    resolveNewer({ value: 'newer' });
    await expect(newer).resolves.toEqual({ value: 'newer' });
    resolveOlder({ value: 'older' });
    await expect(older).resolves.toEqual({ value: 'older' });

    expect(store.records()[0]).toMatchObject({
      attempt: 2,
      status: 'succeeded',
      artifact: { value: 'newer' },
    });
  });
});
