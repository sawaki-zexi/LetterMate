import {
  evaluateDiscoveryOutput,
  validateSourceCandidate,
  type DiscoveryEvaluationReport,
  type ValidatedSourceCandidate,
} from '@lettermate/domain';
import { pathToFileURL } from 'node:url';
import { buildKeywordPolicy } from './keyword-policy.js';
import { QualityPipeline, type QualityAiGateway } from './quality-pipeline.js';

interface QualityEvaluationSummary {
  passed: boolean;
  caseCount: number;
  failedCaseCount: number;
  reports: DiscoveryEvaluationReport[];
}

interface EvaluationFixture {
  caseId: string;
  keyword: string;
  candidates: ValidatedSourceCandidate[];
  fetchedText: ReadonlyMap<string, string>;
  expectedUrls: string[];
  forbiddenUrls?: string[];
}

const sourceCandidate = (
  id: string,
  url: string,
  title: string,
  publishedAt: string,
): ValidatedSourceCandidate => validateSourceCandidate({
  connectorId: 'quality-evaluation',
  sourceType: 'web',
  platform: 'Quality Evaluation Fixture',
  externalId: id,
  url,
  title,
  content: null,
  excerpt: null,
  authorName: 'Fixture Maintainer',
  authorHandle: null,
  publishedAt,
  language: 'en',
  engagement: {},
  proof: {
    kind: 'api_record',
    connectorId: 'quality-evaluation',
    externalId: id,
  },
});

const fixtures = (): EvaluationFixture[] => {
  const release = sourceCandidate(
    'gpt-5-7-release',
    'https://example.com/gpt-5-7-release',
    'GPT-5.7 release notes',
    '2026-08-08T08:00:00.000Z',
  );
  const guide = sourceCandidate(
    'gpt-5-7-guide',
    'https://example.com/gpt-5-7-guide',
    'GPT-5.7 engineering migration guide',
    '2026-08-08T09:00:00.000Z',
  );
  const adjacentVersion = sourceCandidate(
    'gpt-5-7-1-release',
    'https://example.com/gpt-5-7-1-release',
    'GPT-5.7.1 release notes',
    '2026-08-08T10:00:00.000Z',
  );
  const databaseRelease = sourceCandidate(
    'postgresql-19-release',
    'https://example.com/postgresql-19-release',
    'PostgreSQL 19 storage engine release',
    '2026-08-08T11:00:00.000Z',
  );
  return [
    {
      caseId: 'precise-version-boundary',
      keyword: 'GPT-5.7',
      candidates: [release, guide, adjacentVersion],
      fetchedText: new Map([
        [release.canonicalUrl, 'GPT-5.7 adds documented API behavior, migration details, measurements, and limitations.'],
        [guide.canonicalUrl, 'This GPT-5.7 guide provides reproducible migration steps, compatibility notes, and benchmark results.'],
        [adjacentVersion.canonicalUrl, 'GPT-5.7.1 fixes a separate patch release with its own compatibility notes and measurements.'],
      ]),
      expectedUrls: [release.canonicalUrl, guide.canonicalUrl],
      forbiddenUrls: [adjacentVersion.canonicalUrl],
    },
    {
      caseId: 'technology-trend-proof',
      keyword: 'PostgreSQL 19',
      candidates: [databaseRelease],
      fetchedText: new Map([
        [databaseRelease.canonicalUrl, 'PostgreSQL 19 introduces a storage engine with benchmarks, upgrade steps, and documented tradeoffs.'],
      ]),
      expectedUrls: [databaseRelease.canonicalUrl],
    },
  ];
};

const gateway: QualityAiGateway = {
  async evaluateCandidates({ candidates }) {
    return candidates.map(({ id }) => ({
      id,
      accepted: true,
      kind: 'quality' as const,
      reason: 'The fixture contains concrete and reproducible technical evidence.',
      claimSupport: 'supported' as const,
    }));
  },
  async composeItems({ candidates }) {
    return candidates.map(({ candidate, assessment }) => ({
      kind: assessment.kind ?? 'quality',
      title: `\u6280\u672f\u53d1\u5e03\uff1a${candidate.title ?? candidate.externalId ?? 'release'}`,
      summary: '\u6b63\u6587\u63d0\u4f9b\u4e86\u53ef\u590d\u73b0\u7684\u5de5\u7a0b\u7ec6\u8282\u3001\u8fc1\u79fb\u6b65\u9aa4\u548c\u660e\u786e\u9650\u5236\u3002',
      reason: '\u539f\u59cb\u94fe\u63a5\u53ef\u9a8c\u8bc1\uff0c\u4e14\u6b63\u6587\u76f4\u63a5\u652f\u6301\u6838\u5fc3\u6280\u672f\u4e8b\u5b9e\u3002',
      sourceUrls: [candidate.canonicalUrl],
      publishedAt: candidate.publishedAt,
      sourceType: candidate.sourceType,
      platform: candidate.platform,
      authorName: candidate.authorName,
      authorHandle: candidate.authorHandle,
      externalId: candidate.externalId,
      provenanceKind: candidate.proof.kind,
    }));
  },
};

const runFixture = async (fixture: EvaluationFixture): Promise<DiscoveryEvaluationReport> => {
  const pipeline = new QualityPipeline(
    {
      async fetchText(url: string) {
        const text = fixture.fetchedText.get(url);
        if (text === undefined) throw new Error(`Missing fixture body for ${url}`);
        return { finalUrl: url, title: null, contentType: 'text/html', text };
      },
    },
    gateway,
  );
  const items = await pipeline.run({
    keyword: fixture.keyword,
    matchPolicy: buildKeywordPolicy(fixture.keyword),
    candidates: fixture.candidates,
    historyUrls: [],
    windowStart: '2026-08-01T00:00:00.000Z',
    windowEnd: '2026-08-09T00:00:00.000Z',
  });
  return evaluateDiscoveryOutput({
    caseId: fixture.caseId,
    items,
    expectedUrls: fixture.expectedUrls,
    ...(fixture.forbiddenUrls ? { forbiddenUrls: fixture.forbiddenUrls } : {}),
  });
};

export async function runQualityEvaluation(): Promise<QualityEvaluationSummary> {
  const reports = await Promise.all(fixtures().map(runFixture));
  return {
    passed: reports.every((report) => report.passed),
    caseCount: reports.length,
    failedCaseCount: reports.filter((report) => !report.passed).length,
    reports,
  };
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  runQualityEvaluation()
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      if (!summary.passed) process.exitCode = 1;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
