import type {
  Event,
  EventEvidence,
  MonitorRule,
  MonitorRuleInput,
  Notification,
  Source,
} from '@lettermate/contracts';
import { randomUUID } from 'node:crypto';

interface OwnedNotification extends Notification {
  userId: string;
}

export interface OwnedPushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
}

const now = '2026-07-24T08:00:00.000Z';

export class InMemoryStore {
  private readonly rules: MonitorRule[] = [];
  private readonly pushSubscriptions: OwnedPushSubscription[] = [];
  private readonly notifications: OwnedNotification[] = [
    {
      id: 'notification-a', userId: 'user-a', eventId: 'event-confirmed', type: 'confirmed',
      status: 'unread', title: 'OpenAI 发布 Agent Studio', createdAt: now, readAt: null,
    },
    {
      id: 'notification-b', userId: 'user-b', eventId: 'event-confirmed', type: 'confirmed',
      status: 'unread', title: 'Private notification', createdAt: now, readAt: null,
    },
  ];

  readonly events: Event[] = [
    {
      id: 'event-confirmed',
      title: 'OpenAI 发布 Agent Studio 开发工具',
      subject: 'OpenAI Agent Studio',
      action: '发布',
      summary: 'OpenAI 发布面向开发者的 Agent Studio，并公开了产品说明与技术文档。',
      summaryStatus: 'ready',
      status: 'confirmed',
      statusReason: '一级来源与独立二级来源交叉佐证',
      firstPublishedAt: '2026-07-24T06:30:00.000Z',
      lastDiscoveredAt: '2026-07-24T07:05:00.000Z',
      updatedAt: '2026-07-24T07:10:00.000Z',
      sourceCount: 2,
      matchedRuleIds: [],
    },
    {
      id: 'event-pending', title: '新型推理模型传闻', subject: '推理模型', action: '可能发布',
      summary: null, summaryStatus: 'unavailable', status: 'pending', statusReason: '仅有单一二级来源',
      firstPublishedAt: '2026-07-24T05:20:00.000Z', lastDiscoveredAt: now, updatedAt: now,
      sourceCount: 1, matchedRuleIds: [],
    },
    {
      id: 'event-rejected', title: '已被官方否认的收购消息', subject: '技术公司收购', action: '否认',
      summary: '事件主体已发布澄清声明。', summaryStatus: 'ready', status: 'rejected',
      statusReason: '一级来源提供明确反证', firstPublishedAt: '2026-07-23T12:00:00.000Z',
      lastDiscoveredAt: now, updatedAt: now, sourceCount: 2, matchedRuleIds: [],
    },
  ];

  readonly evidence: EventEvidence[] = [
    {
      id: 'evidence-1', eventId: 'event-confirmed', sourceId: 'openai', sourceName: 'OpenAI 官方博客',
      sourceUrl: 'https://openai.com/news/agent-studio', title: 'Introducing Agent Studio',
      publishedAt: '2026-07-24T06:30:00.000Z', trustLevel: 'primary', independenceGroup: 'openai', stance: 'supports',
    },
    {
      id: 'evidence-2', eventId: 'event-confirmed', sourceId: 'reuters', sourceName: 'Reuters',
      sourceUrl: 'https://reuters.com/technology/agent-studio', title: 'OpenAI launches new agent tooling',
      publishedAt: '2026-07-24T07:00:00.000Z', trustLevel: 'secondary', independenceGroup: 'reuters', stance: 'supports',
    },
  ];

  readonly sources: Source[] = [
    { id: 'openai', name: 'OpenAI 官方博客', type: 'rss', baseUrl: 'https://openai.com/news/rss.xml', trustLevel: 'primary', complianceStatus: 'allowed', independenceGroup: 'openai', enabled: true, lastSuccessAt: now, failureReason: null },
    { id: 'reuters', name: 'Reuters Technology', type: 'rss', baseUrl: 'https://reuters.com/technology', trustLevel: 'secondary', complianceStatus: 'allowed', independenceGroup: 'reuters', enabled: true, lastSuccessAt: now, failureReason: null },
    { id: 'restricted', name: '受限网页来源', type: 'web', baseUrl: 'https://example.com', trustLevel: 'secondary', complianceStatus: 'blocked', independenceGroup: 'restricted', enabled: false, lastSuccessAt: null, failureReason: 'robots.txt 不允许采集配置路径' },
  ];

  listRules(userId: string): MonitorRule[] {
    return this.rules.filter((rule) => rule.userId === userId);
  }

  findRule(userId: string, id: string): MonitorRule | undefined {
    return this.rules.find((rule) => rule.userId === userId && rule.id === id);
  }

  createRule(userId: string, input: MonitorRuleInput): MonitorRule {
    const timestamp = new Date().toISOString();
    const rule: MonitorRule = { ...input, id: randomUUID(), userId, createdAt: timestamp, updatedAt: timestamp };
    this.rules.push(rule);
    return rule;
  }

  updateRule(userId: string, id: string, input: Partial<Pick<MonitorRule, 'enabled'>>): MonitorRule | undefined {
    const rule = this.findRule(userId, id);
    if (!rule) return undefined;
    if (input.enabled !== undefined) rule.enabled = input.enabled;
    rule.updatedAt = new Date().toISOString();
    return rule;
  }

  deleteRule(userId: string, id: string): boolean {
    const index = this.rules.findIndex((rule) => rule.userId === userId && rule.id === id);
    if (index < 0) return false;
    this.rules.splice(index, 1);
    return true;
  }

  listNotifications(userId: string): Notification[] {
    return this.notifications.filter((item) => item.userId === userId).map(({ userId: _userId, ...item }) => item);
  }

  readNotification(userId: string, id: string): Notification | undefined {
    const notification = this.notifications.find((item) => item.userId === userId && item.id === id);
    if (!notification) return undefined;
    notification.status = 'read';
    notification.readAt = new Date().toISOString();
    const { userId: _userId, ...publicNotification } = notification;
    return publicNotification;
  }

  addPushSubscription(userId: string, input: Pick<OwnedPushSubscription, 'endpoint' | 'keys'>): OwnedPushSubscription {
    const existing = this.pushSubscriptions.find((item) => item.userId === userId && item.endpoint === input.endpoint);
    if (existing) return existing;
    const subscription = { id: randomUUID(), userId, ...input, createdAt: new Date().toISOString() };
    this.pushSubscriptions.push(subscription);
    return subscription;
  }

  deletePushSubscription(userId: string, id: string): boolean {
    const index = this.pushSubscriptions.findIndex((item) => item.userId === userId && item.id === id);
    if (index < 0) return false;
    this.pushSubscriptions.splice(index, 1);
    return true;
  }

  deletePersonalData(userId: string): void {
    for (const collection of [this.rules, this.notifications, this.pushSubscriptions]) {
      for (let index = collection.length - 1; index >= 0; index -= 1) {
        if (collection[index]?.userId === userId) collection.splice(index, 1);
      }
    }
  }
}
