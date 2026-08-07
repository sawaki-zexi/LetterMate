import { z } from 'zod';
import { ConnectorError, type ConnectorResult, type SourceConnector, type SourceQueryPlan } from './types.js';

const repositorySchema = z.object({
  node_id: z.string().min(1), full_name: z.string().regex(/^[^/]+\/[^/]+$/), html_url: z.url(),
  description: z.string().optional().nullable(), pushed_at: z.string().optional().nullable(),
  stargazers_count: z.number().int().nonnegative().optional().default(0),
  owner: z.object({ login: z.string().min(1) }),
});
const searchSchema = z.object({ items: z.array(repositorySchema).max(100) });
const releaseSchema = z.object({
  node_id: z.string().min(1), html_url: z.url(), name: z.string().optional().nullable(),
  tag_name: z.string().optional().nullable(), body: z.string().optional().nullable(),
  published_at: z.string().optional().nullable(), draft: z.boolean().optional().default(false),
  prerelease: z.boolean().optional().default(false), author: z.object({ login: z.string().min(1) }).optional().nullable(),
});
const releasesSchema = z.array(releaseSchema).max(100);

export interface GitHubConnectorConfig { token?: string | undefined; repositoryBudget?: number; releasesPerRepository?: number }
const iso = (value: string | null | undefined): string | null => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export class GitHubConnector implements SourceConnector {
  readonly id = 'github'; readonly label = 'GitHub'; readonly sourceType = 'code' as const;
  private readonly repositoryBudget: number; private readonly releasesPerRepository: number;
  constructor(private readonly config: GitHubConnectorConfig, private readonly fetcher: typeof fetch = fetch) {
    this.repositoryBudget = config.repositoryBudget ?? 3;
    this.releasesPerRepository = config.releasesPerRepository ?? 3;
    if (!Number.isInteger(this.repositoryBudget) || this.repositoryBudget < 1) throw new Error('repositoryBudget must be positive');
    if (!Number.isInteger(this.releasesPerRepository) || this.releasesPerRepository < 1) throw new Error('releasesPerRepository must be positive');
  }
  isEnabled(): boolean { return true; }
  supports(plan: SourceQueryPlan): boolean { return plan.sourceTypes.includes('code'); }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const searchUrl = new URL('https://api.github.com/search/repositories');
    searchUrl.searchParams.set('q', `${plan.queries[0] ?? plan.keyword} pushed:>=${plan.windowStart.slice(0, 10)}`);
    searchUrl.searchParams.set('sort', 'updated'); searchUrl.searchParams.set('order', 'desc');
    searchUrl.searchParams.set('per_page', String(Math.min(this.repositoryBudget, 100)));
    const repositories = this.parse(searchSchema, await this.request(searchUrl, signal)).items.slice(0, this.repositoryBudget);
    // Repository search identifies projects to inspect. The repository landing page
    // is not itself a substantive update, so only release records become candidates.
    const candidates: ConnectorResult['candidates'] = [];
    let requestCount = 1;
    for (const repo of repositories) {
      if (candidates.length >= plan.maxCandidates) break;
      const releaseUrl = new URL(`https://api.github.com/repos/${repo.full_name.split('/').map(encodeURIComponent).join('/')}/releases`);
      releaseUrl.searchParams.set('per_page', String(Math.min(this.releasesPerRepository, 100)));
      const releases = this.parse(releasesSchema, await this.request(releaseUrl, signal)); requestCount += 1;
      for (const release of releases) {
        if (release.draft || candidates.length >= plan.maxCandidates) continue;
        candidates.push({
          connectorId: this.id, sourceType: this.sourceType, platform: 'GitHub', externalId: release.node_id,
          url: release.html_url, title: release.name?.trim() || release.tag_name?.trim() || repo.full_name,
          content: release.body?.trim() || null, excerpt: null, authorName: null,
          authorHandle: release.author?.login ?? repo.owner.login, publishedAt: iso(release.published_at), language: null,
          engagement: {}, proof: { kind: 'api_record', connectorId: this.id, externalId: release.node_id },
        });
      }
    }
    return { candidates: candidates.slice(0, plan.maxCandidates), requestCount };
  }

  private async request(url: URL, signal: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
    const token = this.config.token?.trim(); if (token) headers.authorization = `Bearer ${token}`;
    let response: Response;
    try { response = await this.fetcher(url.toString(), { headers, signal }); } catch { throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'GitHub is temporarily unavailable', true); }
    if (!response.ok) {
      if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) throw new ConnectorError('CONNECTOR_RATE_LIMITED', 'GitHub rate limit reached', true);
      if (response.status === 401 || response.status === 403) throw new ConnectorError('CONNECTOR_AUTH_FAILED', 'GitHub credentials are unavailable', false);
      throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'GitHub is temporarily unavailable', response.status >= 500);
    }
    try { return await response.json(); } catch { throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'GitHub returned an invalid response', false); }
  }

  private parse<T>(schema: z.ZodType<T>, payload: unknown): T {
    const parsed = schema.safeParse(payload);
    if (parsed.success) return parsed.data;
    throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'GitHub returned an invalid response', false);
  }
}
