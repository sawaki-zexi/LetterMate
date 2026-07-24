import type { Event } from '@lettermate/contracts';
import { ArrowRight, Ban, CheckCircle2, CircleHelp, Clock3, Link2 } from 'lucide-react';
import { Link } from 'react-router-dom';

const statusMeta = {
  confirmed: { label: '已确认', icon: CheckCircle2 },
  pending: { label: '待核实', icon: CircleHelp },
  rejected: { label: '已驳回', icon: Ban },
} as const;

export function EventCard({ event }: { event: Event }) {
  const meta = statusMeta[event.status];
  const StatusIcon = meta.icon;
  return (
    <article className="event-card">
      <div className="event-card__topline">
        <span className={`status status--${event.status}`}><StatusIcon size={15} />{meta.label}</span>
        <span className="meta"><Clock3 size={14} />{new Date(event.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <h2>{event.title}</h2>
      <p className={event.summary ? '' : 'muted'}>{event.summary ?? '摘要暂不可用'}</p>
      <div className="event-card__footer">
        <span className="meta"><Link2 size={14} />{event.sourceCount} 个独立来源</span>
        <Link className="text-link" to={`/events/${event.id}`}>查看证据<ArrowRight size={15} /></Link>
      </div>
    </article>
  );
}
