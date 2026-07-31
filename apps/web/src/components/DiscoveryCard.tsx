import type { FeedItem, SourceType } from '@lettermate/contracts';
import {
  Clock3,
  Code2,
  ExternalLink,
  FileText,
  Flame,
  Globe2,
  MessageCircle,
  Rss,
  Sparkles,
  Users,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { discoveryKindLabels } from '../discovery-display.js';

const sourceTypeMeta: Record<SourceType, { label: string; icon: LucideIcon }> = {
  web: { label: '网页', icon: Globe2 },
  feed: { label: '订阅', icon: Rss },
  social: { label: '社交', icon: MessageCircle },
  video: { label: '视频', icon: Video },
  community: { label: '社区', icon: Users },
  code: { label: '代码', icon: Code2 },
  paper: { label: '论文', icon: FileText },
};

export function DiscoveryCard({
  item,
  detailHref,
  headingLevel = 2,
  topicKeyword,
}: {
  item: FeedItem;
  detailHref?: string;
  headingLevel?: 2 | 3;
  topicKeyword?: string;
}) {
  const Heading = `h${headingLevel}` as const;
  const ClassificationIcon = item.kind === 'hot' ? Flame : Sparkles;
  const classification = discoveryKindLabels[item.kind];
  const discoveryContext = item.origin === 'trend'
    ? '来自全网趋势'
    : topicKeyword
      ? `来自「${topicKeyword}」`
      : '来自关注主题';
  const source = sourceTypeMeta[item.sourceType];
  const SourceIcon = source.icon;
  const author = [item.authorName, item.authorHandle ? `@${item.authorHandle}` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <article className="discovery-card">
      <div className="discovery-card__topline">
        <span className={`classification classification--${item.kind}`}>
          <ClassificationIcon size={15} />{classification}
        </span>
        <div className="discovery-card__meta">
          <span
            className="origin-label"
            title={item.origin === 'topic' ? topicKeyword : undefined}
            aria-label={discoveryContext}
          >
            {discoveryContext}
          </span>
          <span><SourceIcon size={14} />{item.platform}</span>
          <span>{source.label}</span>
          <span className="meta"><Clock3 size={14} />{new Date(item.publishedAt ?? item.discoveredAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>
      {author && <div className="source-author">{author}</div>}
      <Heading>{detailHref ? <Link to={detailHref}>{item.title}</Link> : item.title}</Heading>
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
