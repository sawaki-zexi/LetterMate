import type { DiscoveryItem } from '@lettermate/contracts';
import { Clock3, ExternalLink, Flame, Sparkles } from 'lucide-react';

export function DiscoveryCard({ item }: { item: DiscoveryItem }) {
  const ClassificationIcon = item.kind === 'hot' ? Flame : Sparkles;
  const classification = item.kind === 'hot' ? '热点' : '优质';
  return (
    <article className="discovery-card">
      <div className="discovery-card__topline">
        <span className={`classification classification--${item.kind}`}>
          <ClassificationIcon size={15} />{classification}
        </span>
        <span className="meta"><Clock3 size={14} />{new Date(item.publishedAt ?? item.discoveredAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <h2>{item.title}</h2>
      <p>{item.summary}</p>
      <p className="discovery-card__reason"><strong>推荐理由</strong>{item.reason}</p>
      <div className="discovery-card__footer">
        <div className="source-links">
          {item.sourceUrls.map((url) => (
            <a key={url} className="text-link" href={url} target="_blank" rel="noreferrer noopener">
              <ExternalLink size={15} />查看原文
            </a>
          ))}
        </div>
      </div>
    </article>
  );
}
