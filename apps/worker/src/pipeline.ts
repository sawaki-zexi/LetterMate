import type { Source, TrustStatus } from '@lettermate/contracts';
import { calculateTrust, canonicalizeUrl } from '@lettermate/domain';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export interface CollectedItem {
  source: Source;
  url: string;
  title: string;
  body: string;
  publishedAt: string;
}

export interface AiAnalysisProvider {
  analyze(item: CollectedItem): Promise<{ summary: string; suggestedStatus?: TrustStatus }>;
}

export interface ProcessedEvent {
  title: string;
  canonicalUrl: string;
  fingerprint: string;
  status: TrustStatus;
  statusReason: string;
  summary: string | null;
  summaryStatus: 'ready' | 'unavailable';
  publishedAt: string;
}

export class ProcessingPipeline {
  constructor(private readonly ai: AiAnalysisProvider) {}

  async process(item: CollectedItem): Promise<ProcessedEvent> {
    if (item.source.complianceStatus !== 'allowed' || !item.source.enabled) {
      throw new SourcePolicyError('SOURCE_NOT_ALLOWED', 'Source is not enabled and allowed');
    }

    const canonicalUrl = canonicalizeUrl(item.url);
    const fingerprint = createHash('sha256')
      .update(`${item.title.trim()}\n${item.body.trim()}`)
      .digest('hex');
    const decision = calculateTrust([
      {
        trustLevel: item.source.trustLevel,
        independenceGroup: item.source.independenceGroup ?? item.source.id,
        stance: 'supports',
      },
    ]);

    try {
      const analysis = await this.ai.analyze(item);
      return {
        title: item.title,
        canonicalUrl,
        fingerprint,
        status: decision.status,
        statusReason: decision.reason,
        summary: analysis.summary,
        summaryStatus: 'ready',
        publishedAt: item.publishedAt,
      };
    } catch {
      return {
        title: item.title,
        canonicalUrl,
        fingerprint,
        status: decision.status,
        statusReason: decision.reason,
        summary: null,
        summaryStatus: 'unavailable',
        publishedAt: item.publishedAt,
      };
    }
  }
}

export class SourcePolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SourcePolicyError';
  }
}

interface TransportResponse {
  finalUrl: string;
  status: number;
  body: string;
}

type SourceTransport = (url: string, options: { timeoutMs: number; maxBytes: number }) => Promise<TransportResponse>;

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;
  const [first = -1, second = -1] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first === 0
  );
}

export function assertSafeSourceUrl(input: string): URL {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new SourcePolicyError('SOURCE_PROTOCOL_BLOCKED', 'Only HTTP(S) sources are supported');
  }

  const hostname = url.hostname.toLocaleLowerCase().replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    (isIP(hostname) === 4 && isPrivateIpv4(hostname)) ||
    (isIP(hostname) === 6 && (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80')))
  ) {
    throw new SourcePolicyError('SOURCE_ADDRESS_BLOCKED', 'Private and local source addresses are blocked');
  }
  return url;
}

export class SafeSourceFetcher {
  constructor(private readonly transport: SourceTransport) {}

  async fetch(source: Source, inputUrl: string): Promise<TransportResponse> {
    if (source.complianceStatus !== 'allowed' || !source.enabled) {
      throw new SourcePolicyError('SOURCE_NOT_ALLOWED', 'Source is not enabled and allowed');
    }
    const input = assertSafeSourceUrl(inputUrl);
    this.assertConfiguredHost(source, input);
    const response = await this.transport(inputUrl, { timeoutMs: 10_000, maxBytes: 2_000_000 });
    const finalUrl = assertSafeSourceUrl(response.finalUrl);
    this.assertConfiguredHost(source, finalUrl);
    if (Buffer.byteLength(response.body, 'utf8') > 2_000_000) {
      throw new SourcePolicyError('SOURCE_TOO_LARGE', 'Source response exceeds configured size limit');
    }
    return response;
  }

  private assertConfiguredHost(source: Source, url: URL): void {
    if (source.baseUrl && new URL(source.baseUrl).hostname.toLocaleLowerCase() !== url.hostname.toLocaleLowerCase()) {
      throw new SourcePolicyError('SOURCE_HOST_BLOCKED', 'URL is outside the configured source host');
    }
  }
}

export function calculateRetryDelay(attempt: number, retryAfter?: string): number {
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1_000;
  }
  return Math.min(1_000 * 2 ** Math.max(0, attempt), 300_000);
}
