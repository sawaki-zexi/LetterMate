import type {
  FeedItem,
  FeedbackValue,
  FeedOriginDetail,
  SourceType,
} from '@lettermate/contracts';
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
  ThumbsDown,
  ThumbsUp,
  Users,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect, useRef } from 'react';
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

const recommendationLabels = {
  followed_topic: '关注关键词',
  followed_creator: '关注博主',
  related_interest: '符合兴趣',
  recent_hot: '近期热点',
  exploration: '拓展发现',
} as const;

function originLabel(origin: FeedOriginDetail): string {
  if (origin.origin === 'topic') return `「${origin.topicKeyword}」`;
  if (origin.origin === 'trend') return '全网趋势';
  const action = origin.contentType === 'repost'
    ? '转发'
    : origin.contentType === 'reply' ? '回复' : '';
  return `「${origin.creatorName}」${action}`;
}

export function DiscoveryCard({
  item,
  detailHref,
  headingLevel = 2,
  feedbackPending = false,
  onFeedback,
  onImpression,
}: {
  item: FeedItem;
  detailHref?: string;
  headingLevel?: 2 | 3;
  feedbackPending?: boolean;
  onFeedback?: (value: FeedbackValue | null) => void;
  onImpression?: () => void;
}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const impressionSent = useRef(false);

  useEffect(() => {
    if (!onImpression || impressionSent.current || typeof IntersectionObserver === 'undefined') return;
    const node = cardRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting || entry.intersectionRatio < 0.5) return;
      impressionSent.current = true;
      onImpression();
      observer.disconnect();
    }, { threshold: [0.5] });
    observer.observe(node);
    return () => observer.disconnect();
  }, [onImpression]);

  const Heading = `h${headingLevel}` as const;
  const ClassificationIcon = item.kind === 'hot' ? Flame : Sparkles;
  const classification = discoveryKindLabels[item.kind];
  const discoveryContext = `来自${item.origins.map(originLabel).join('、')}`;
  const hasInactiveTopic = item.origins.some((origin) => (
    origin.origin === 'topic' && !origin.topicKeywordActive
  ));
  const source = sourceTypeMeta[item.sourceType];
  const SourceIcon = source.icon;
  const author = [item.authorName, item.authorHandle ? `@${item.authorHandle}` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <article className="discovery-card" ref={cardRef}>
      <div className="discovery-card__topline">
        <span className={`classification classification--${item.kind}`}>
          <ClassificationIcon size={15} />{classification}
        </span>
        {item.recommendation && (
          <span className={`recommendation-context recommendation-context--${item.recommendation.lane}`}>
            {recommendationLabels[item.recommendation.reason]}
          </span>
        )}
        <div className="discovery-card__meta">
          <span
            className="origin-label"
            title={discoveryContext}
            aria-label={discoveryContext}
          >
            {discoveryContext}
          </span>
          {hasInactiveTopic && (
            <span className="keyword-state keyword-state--inactive">关键词已失效</span>
          )}
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
        {onFeedback && (
          <div className="feedback-actions" aria-label="内容反馈">
            <button
              className="feedback-button"
              type="button"
              aria-pressed={item.feedback === 'interested'}
              disabled={feedbackPending}
              onClick={() => onFeedback(item.feedback === 'interested' ? null : 'interested')}
            >
              <ThumbsUp size={15} />感兴趣
            </button>
            <button
              className="feedback-button"
              type="button"
              aria-pressed={item.feedback === 'less'}
              disabled={feedbackPending}
              onClick={() => onFeedback(item.feedback === 'less' ? null : 'less')}
            >
              <ThumbsDown size={15} />减少推荐
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
