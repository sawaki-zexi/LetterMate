import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MonitorRuleInput, TrustStatus } from '@lettermate/contracts';
import {
  Bell, BellRing, BookOpenCheck, Check, ChevronRight, CircleUserRound, FileSearch,
  Inbox, LayoutList, LibraryBig, Menu, Pause, Plus, Radar, RefreshCw, Save, Settings, ShieldCheck,
  SlidersHorizontal, X,
} from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, NavLink, Route, Routes, useParams } from 'react-router-dom';
import { api } from './api.js';
import { EventCard } from './components/EventCard.js';
import { enableBrowserPush } from './push.js';

const navigation = [
  { to: '/', label: '事件流', icon: LayoutList },
  { to: '/monitor-rules', label: '监控规则', icon: Radar },
  { to: '/notifications', label: '通知', icon: Bell },
  { to: '/sources', label: '来源', icon: LibraryBig },
  { to: '/settings', label: '设置', icon: Settings },
];

function QueryState({ isLoading, error, retry }: { isLoading: boolean; error: Error | null; retry: () => void }) {
  if (isLoading) return <div className="state"><RefreshCw className="spin" />正在同步最新内容</div>;
  if (error) return <div className="state state--error"><FileSearch /><strong>无法载入数据</strong><span>{error.message}</span><button className="button button--secondary" onClick={retry}><RefreshCw size={16} />重试</button></div>;
  return null;
}

function FeedPage() {
  const query = useQuery({ queryKey: ['events'], queryFn: api.events });
  const [status, setStatus] = useState<TrustStatus | 'all'>('all');
  const events = (query.data ?? []).filter((event) => status === 'all' || event.status === status);
  return (
    <Page title="事件流" description="按证据状态追踪你关注的最新事件" action={<button className="icon-button" title="刷新" onClick={() => query.refetch()}><RefreshCw size={18} /></button>}>
      <div className="segmented" aria-label="事件状态筛选">
        {([['all', '全部'], ['confirmed', '已确认'], ['pending', '待核实'], ['rejected', '已驳回']] as const).map(([value, label]) =>
          <button key={value} aria-pressed={status === value} onClick={() => setStatus(value)}>{label}</button>)}
      </div>
      <QueryState isLoading={query.isLoading} error={query.error} retry={() => query.refetch()} />
      {!query.isLoading && !query.error && events.length === 0 && <div className="state"><Inbox />暂无符合筛选条件的事件</div>}
      <div className="event-list">{events.map((event) => <EventCard key={event.id} event={event} />)}</div>
    </Page>
  );
}

interface RuleFormData {
  name: string;
  keywords: string;
  synonyms: string;
  exclusions: string;
  priority: MonitorRuleInput['priority'];
  notifyImmediately: boolean;
}

function RulesPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['rules'], queryFn: api.rules });
  const [editing, setEditing] = useState(false);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<RuleFormData>({
    defaultValues: { priority: 'normal', notifyImmediately: false },
  });
  const create = useMutation({
    mutationFn: api.createRule,
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['rules'] }); reset(); setEditing(false); },
  });
  const submit = handleSubmit((value) => create.mutate({
    name: value.name,
    keywords: value.keywords.split(',').map((item) => item.trim()).filter(Boolean),
    synonyms: value.synonyms.split(',').map((item) => item.trim()).filter(Boolean),
    exclusions: value.exclusions.split(',').map((item) => item.trim()).filter(Boolean),
    scope: { mode: 'all' }, priority: value.priority,
    notifyImmediately: value.notifyImmediately, enabled: true,
  }));
  return (
    <Page title="监控规则" description="定义关键词、排除项与即时通知条件" action={<button className="button" onClick={() => setEditing(true)}><Plus size={17} />新建监控</button>}>
      {editing && <section className="editor" aria-label="新建监控规则">
        <div className="section-heading"><div><h2>新建监控</h2><p>逗号分隔多个关键词，保存后立即生效。</p></div><button className="icon-button" title="关闭" onClick={() => setEditing(false)}><X size={18} /></button></div>
        <form onSubmit={submit} className="form-grid">
          <label>规则名称<input {...register('name', { required: '请输入规则名称' })} placeholder="例如：AI Agent 进展" />{errors.name && <span className="field-error">{errors.name.message}</span>}</label>
          <label>关键词<input {...register('keywords', { required: '至少输入一个关键词' })} placeholder="AI Agent, Agentic AI" />{errors.keywords && <span className="field-error">{errors.keywords.message}</span>}</label>
          <label>同义词<input {...register('synonyms')} placeholder="智能体, 自主代理" /></label>
          <label>排除词<input {...register('exclusions')} placeholder="招聘, 课程广告" /></label>
          <label>优先级<select {...register('priority')}><option value="low">低</option><option value="normal">普通</option><option value="high">高</option></select></label>
          <label className="check-field"><input type="checkbox" {...register('notifyImmediately')} /><span>符合确认规则时发送即时通知</span></label>
          {create.error && <p className="field-error form-wide">{create.error.message}</p>}
          <div className="form-actions"><button type="button" className="button button--secondary" onClick={() => setEditing(false)}>取消</button><button className="button" disabled={create.isPending}><Save size={16} />保存</button></div>
        </form>
      </section>}
      <QueryState isLoading={query.isLoading} error={query.error} retry={() => query.refetch()} />
      <div className="table-list">
        {(query.data ?? []).map((rule) => <div className="table-row" key={rule.id}>
          <span className="leading-icon"><Radar size={18} /></span><div className="table-row__main"><strong>{rule.name}</strong><span>{rule.keywords.join(' · ')}</span></div>
          <span className={`priority priority--${rule.priority}`}>{rule.priority === 'high' ? '高优先级' : rule.priority === 'low' ? '低优先级' : '普通'}</span>
          <span className="meta">{rule.notifyImmediately ? <><BellRing size={15} />即时通知</> : <><Bell size={15} />仅站内</>}</span>
          <button className="icon-button" title="暂停"><Pause size={17} /></button>
        </div>)}
        {!query.isLoading && !query.error && query.data?.length === 0 && <div className="state"><Radar />尚未创建监控规则</div>}
      </div>
    </Page>
  );
}

function EventDetailPage() {
  const { id = '' } = useParams();
  const query = useQuery({ queryKey: ['event', id], queryFn: () => api.event(id) });
  return <Page title="事件证据" description="核对状态判定和原始来源">
    <QueryState isLoading={query.isLoading} error={query.error} retry={() => query.refetch()} />
    {query.data && <>
      <div className="detail-header"><Link className="back-link" to="/"><ChevronRight size={15} />返回事件流</Link><h2>{query.data.event.title}</h2><p>{query.data.event.summary ?? '摘要暂不可用'}</p><div className="decision"><ShieldCheck size={20} /><div><strong>{query.data.event.statusReason}</strong><span>系统可信规则判定，AI 不参与最终状态决策</span></div></div></div>
      <section className="evidence"><div className="section-heading"><div><h2>证据链</h2><p>{query.data.evidence.length} 条可复核原始记录</p></div></div>
        {query.data.evidence.map((item) => <a className="evidence-row" href={item.sourceUrl} target="_blank" rel="noreferrer noopener" key={item.id}>
          <span className={`source-level source-level--${item.trustLevel}`}>{item.trustLevel === 'primary' ? '一级' : '二级'}</span><div><strong>{item.sourceName}</strong><span>{item.title}</span></div><ChevronRight size={18} />
        </a>)}
      </section>
    </>}
  </Page>;
}

function NotificationsPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['notifications'], queryFn: api.notifications });
  const read = useMutation({ mutationFn: api.readNotification, onSuccess: async () => client.invalidateQueries({ queryKey: ['notifications'] }) });
  return <Page title="通知中心" description="已确认事件、证据更新与更正记录">
    <QueryState isLoading={query.isLoading} error={query.error} retry={() => query.refetch()} />
    <div className="table-list">{(query.data ?? []).map((item) => <div className={`table-row ${item.status === 'unread' ? 'table-row--unread' : ''}`} key={item.id}>
      <span className="leading-icon"><BellRing size={18} /></span><div className="table-row__main"><strong>{item.title}</strong><span>{item.type === 'confirmed' ? '事件已确认' : '证据有更新'} · {new Date(item.createdAt).toLocaleString('zh-CN')}</span></div>
      {item.status === 'unread' ? <button className="button button--secondary" onClick={() => read.mutate(item.id)}><Check size={15} />标为已读</button> : <span className="meta"><Check size={15} />已读</span>}
    </div>)}</div>
  </Page>;
}

function SourcesPage() {
  const query = useQuery({ queryKey: ['sources'], queryFn: api.sources });
  return <Page title="来源说明" description="可信等级、合规状态与最近采集结果">
    <QueryState isLoading={query.isLoading} error={query.error} retry={() => query.refetch()} />
    <div className="table-list">{(query.data ?? []).map((source) => <div className="table-row" key={source.id}>
      <span className="leading-icon"><BookOpenCheck size={18} /></span><div className="table-row__main"><strong>{source.name}</strong><span>{source.type.toUpperCase()} · {source.trustLevel === 'primary' ? '一级来源' : '二级来源'}</span></div>
      <span className={`compliance compliance--${source.complianceStatus}`}>{source.complianceStatus === 'allowed' ? '允许采集' : source.complianceStatus === 'blocked' ? '已阻断' : '待审核'}</span>
      <span className="source-message">{source.failureReason ?? (source.lastSuccessAt ? `最近成功 ${new Date(source.lastSuccessAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '暂无运行记录')}</span>
    </div>)}</div>
  </Page>;
}

function SettingsPage() {
  const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  const [pushStatus, setPushStatus] = useState<'idle' | 'enabling' | 'enabled' | 'error'>('idle');
  const [pushMessage, setPushMessage] = useState(
    vapidPublicKey ? '授权后接收已确认高优先级事件' : '未配置 VAPID 公钥，站内通知仍可用',
  );
  const togglePush = async () => {
    if (!vapidPublicKey || pushStatus === 'enabled') return;
    setPushStatus('enabling');
    try {
      await enableBrowserPush(vapidPublicKey);
      setPushStatus('enabled');
      setPushMessage('浏览器 Push 已启用');
    } catch (error) {
      setPushStatus('error');
      setPushMessage(error instanceof Error ? error.message : '浏览器 Push 启用失败');
    }
  };
  return <Page title="个人设置" description="时区、免打扰和浏览器通知">
    <section className="settings-band"><div className="settings-copy"><CircleUserRound /><div><h2>个人资料</h2><p>user-a@example.local</p></div></div><label>时区<select defaultValue="Asia/Shanghai"><option>Asia/Shanghai</option><option>UTC</option></select></label></section>
    <section className="settings-band"><div className="settings-copy"><BellRing /><div><h2>浏览器 Push</h2><p>{'Notification' in window ? pushMessage : '当前浏览器不支持 Push，站内通知仍可用'}</p></div></div><button className={`toggle ${pushStatus === 'enabled' ? 'toggle--on' : ''}`} role="switch" aria-label="浏览器 Push" aria-checked={pushStatus === 'enabled'} disabled={!vapidPublicKey || !('Notification' in window) || pushStatus === 'enabling'} onClick={() => void togglePush()}><span /></button></section>
    <section className="settings-band"><div className="settings-copy"><SlidersHorizontal /><div><h2>免打扰</h2><p>在设定时间内延迟 Push，站内通知仍会立即创建</p></div></div><div className="time-range"><input aria-label="免打扰开始" type="time" defaultValue="23:00" /><span>至</span><input aria-label="免打扰结束" type="time" defaultValue="07:00" /></div></section>
  </Page>;
}

function Page({ title, description, action, children }: { title: string; description: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <main className="page"><header className="page-header"><div><h1>{title}</h1><p>{description}</p></div>{action}</header>{children}</main>;
}

function AppShell() {
  const [mobileMenu, setMobileMenu] = useState(false);
  return <div className="shell">
    <aside className={`sidebar ${mobileMenu ? 'sidebar--open' : ''}`}>
      <div className="brand"><span>LM</span><div><strong>LetterMate</strong><small>可信信息工作台</small></div></div>
      <nav>{navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} onClick={() => setMobileMenu(false)}><Icon size={19} />{label}</NavLink>)}</nav>
      <div className="sidebar-status"><span className="pulse" /><div><strong>采集服务正常</strong><small>3 个来源 · 刚刚同步</small></div></div>
    </aside>
    <div className="workspace"><header className="mobile-header"><button className="icon-button" title="菜单" onClick={() => setMobileMenu(!mobileMenu)}><Menu size={20} /></button><strong>LetterMate</strong><span className="live-dot" /></header>
      <Routes><Route path="/" element={<FeedPage />} /><Route path="/monitor-rules" element={<RulesPage />} /><Route path="/events/:id" element={<EventDetailPage />} /><Route path="/notifications" element={<NotificationsPage />} /><Route path="/sources" element={<SourcesPage />} /><Route path="/settings" element={<SettingsPage />} /></Routes>
    </div>
    <nav className="bottom-nav">{navigation.slice(0, 4).map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'}><Icon size={19} /><span>{label}</span></NavLink>)}</nav>
  </div>;
}

export default AppShell;
