import { z } from 'zod';
import { ConnectorError, type ConnectorResult, type SourceConnector, type SourceQueryPlan } from './types.js';

const itemSchema = z.object({
  bvid: z.string().regex(/^BV[0-9A-Za-z]+$/), title: z.string().min(1), description: z.string(),
  author: z.string().optional().nullable(), mid: z.union([z.string(), z.number()]).optional().nullable(),
  pubdate: z.number().nonnegative().optional().default(0), play: z.number().nonnegative().optional().default(0),
  video_review: z.number().nonnegative().optional().default(0),
});
const responseSchema = z.object({ code: z.number().int(), data: z.object({ result: z.array(itemSchema).max(100) }).optional().nullable() });
export interface BilibiliConnectorConfig { timeoutMs?: number; queryBudget?: number }
const clean = (value: string): string => value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

export class BilibiliConnector implements SourceConnector {
  readonly id = 'bilibili'; readonly label = 'Bilibili'; readonly sourceType = 'video' as const;
  private readonly timeoutMs: number; private readonly queryBudget: number; private enabled = true;
  constructor(config: BilibiliConnectorConfig, private readonly fetcher: typeof fetch = fetch) {
    this.timeoutMs = config.timeoutMs ?? 5_000; this.queryBudget = config.queryBudget ?? 2;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1) throw new Error('timeoutMs must be positive');
    if (!Number.isInteger(this.queryBudget) || this.queryBudget < 1) throw new Error('queryBudget must be positive');
  }
  isEnabled(): boolean { return this.enabled; }
  supports(plan: SourceQueryPlan): boolean { return plan.sourceTypes.includes('video'); }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const candidates = new Map<string, ConnectorResult['candidates'][number]>(); let requestCount = 0;
    for (const query of plan.queries.slice(0, this.queryBudget)) {
      const url = new URL('https://api.bilibili.com/x/web-interface/search/type');
      url.searchParams.set('search_type', 'video'); url.searchParams.set('keyword', query); url.searchParams.set('page', '1');
      const payload = await this.request(url, signal); requestCount += 1;
      const parsed = responseSchema.safeParse(payload);
      if (!parsed.success) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Bilibili returned an invalid response', false);
      if (parsed.data.code === -412) { this.enabled = false; throw new ConnectorError('CONNECTOR_ACCESS_RESTRICTED', 'Bilibili public search is unavailable', false); }
      if (parsed.data.code !== 0 || parsed.data.data === null || parsed.data.data === undefined) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Bilibili returned an invalid response', false);
      for (const item of parsed.data.data.result) {
        const description = clean(item.description); if (!description || candidates.has(item.bvid)) continue;
        candidates.set(item.bvid, {
          connectorId: this.id, sourceType: this.sourceType, platform: 'Bilibili', externalId: item.bvid,
          url: `https://www.bilibili.com/video/${item.bvid}`, title: clean(item.title), content: description,
          excerpt: null, authorName: item.author?.trim() || null, authorHandle: item.mid === null || item.mid === undefined ? null : String(item.mid),
          publishedAt: item.pubdate > 0 ? new Date(item.pubdate * 1_000).toISOString() : null, language: 'zh',
          engagement: { views: item.play, comments: item.video_review },
          proof: { kind: 'api_record', connectorId: this.id, externalId: item.bvid },
        });
      }
    }
    return { candidates: [...candidates.values()].slice(0, plan.maxCandidates), requestCount };
  }

  private async request(url: URL, parentSignal: AbortSignal): Promise<unknown> {
    const controller = new AbortController(); const abort = () => controller.abort();
    parentSignal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new ConnectorError('CONNECTOR_TIMEOUT', 'Bilibili search timed out', true));
      }, this.timeoutMs); });
      const response = await Promise.race([this.fetcher(url.toString(), {
        headers: { accept: 'application/json', 'user-agent': 'LetterMate/0.1' }, signal: controller.signal,
      }), timeout]);
      if (response.status === 412) { this.enabled = false; throw new ConnectorError('CONNECTOR_ACCESS_RESTRICTED', 'Bilibili public search is unavailable', false); }
      if (response.status === 429) throw new ConnectorError('CONNECTOR_RATE_LIMITED', 'Bilibili rate limit reached', true);
      if (!response.ok) throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Bilibili is temporarily unavailable', response.status >= 500);
      try { return await response.json(); } catch { throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Bilibili returned an invalid response', false); }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (parentSignal.aborted) throw new ConnectorError('CONNECTOR_ABORTED', 'Bilibili search was aborted', true);
      throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Bilibili is temporarily unavailable', true);
    } finally {
      if (timer !== undefined) clearTimeout(timer); parentSignal.removeEventListener('abort', abort);
    }
  }
}
