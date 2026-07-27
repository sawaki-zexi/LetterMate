import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

const fieldNames = (modelName: string) => (
  Prisma.dmmf.datamodel.models.find((model) => model.name === modelName)?.fields.map((field) => field.name) ?? []
);

describe('multi-source Prisma schema', () => {
  it('stores topic scheduling state and source-aware discovery items', () => {
    expect(fieldNames('Topic')).toEqual(expect.arrayContaining([
      'nextRunAt', 'scheduleIntervalHours', 'productiveRunStreak', 'emptyRunStreak', 'runs',
    ]));
    expect(fieldNames('DiscoveryItem')).toEqual(expect.arrayContaining([
      'sourceType', 'platform', 'authorName', 'authorHandle', 'externalId', 'provenanceKind',
    ]));
  });

  it('defines durable discovery run lifecycle fields', () => {
    expect(Prisma.dmmf.datamodel.models.map((model) => model.name)).toContain('DiscoveryRun');
    expect(fieldNames('DiscoveryRun')).toEqual(expect.arrayContaining([
      'topicId', 'trigger', 'status', 'startedAt', 'finishedAt', 'connectorSummary',
      'candidateCount', 'acceptedCount', 'newItemCount', 'error',
    ]));
  });
});
