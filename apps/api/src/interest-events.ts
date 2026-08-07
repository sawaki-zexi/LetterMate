import {
  creatorInterestEventPayloadSchema,
  feedbackInterestEventPayloadSchema,
  interestEventSchema,
  topicInterestEventPayloadSchema,
  type InterestEvent,
  type InterestEventType,
} from '@lettermate/contracts';
import type { InterestEvent as PrismaInterestEvent, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

type EventPayloadByType = {
  topic_state: Extract<InterestEvent, { eventType: 'topic_state' }>['payload'];
  creator_state: Extract<InterestEvent, { eventType: 'creator_state' }>['payload'];
  feedback_state: Extract<InterestEvent, { eventType: 'feedback_state' }>['payload'];
};

export type InterestEventDraft<T extends InterestEventType = InterestEventType> = {
  userId: string;
  eventType: T;
  sourceRef: string;
  payload: EventPayloadByType[T];
  occurredAt: Date;
};

const payloadSchemas = {
  topic_state: topicInterestEventPayloadSchema,
  creator_state: creatorInterestEventPayloadSchema,
  feedback_state: feedbackInterestEventPayloadSchema,
} as const;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const parsePayload = <T extends InterestEventType>(
  eventType: T,
  payload: EventPayloadByType[T],
): EventPayloadByType[T] => payloadSchemas[eventType].parse(payload) as EventPayloadByType[T];

export async function appendInterestEvent<T extends InterestEventType>(
  transaction: Prisma.TransactionClient,
  draft: InterestEventDraft<T>,
): Promise<boolean> {
  const payload = parsePayload(draft.eventType, draft.payload);
  const current = await transaction.interestEvent.findFirst({
    where: {
      userId: draft.userId,
      eventType: draft.eventType,
      sourceRef: draft.sourceRef,
      activeKey: draft.sourceRef,
    },
    select: { id: true, payload: true },
  });
  if (current && canonicalJson(current.payload) === canonicalJson(payload)) return false;

  if (current) {
    await transaction.interestEvent.update({
      where: { id: current.id },
      data: { activeKey: null, supersededAt: draft.occurredAt },
    });
  }
  await transaction.interestEvent.create({
    data: {
      userId: draft.userId,
      eventType: draft.eventType,
      sourceRef: draft.sourceRef,
      activeKey: draft.sourceRef,
      payload: payload as Prisma.InputJsonValue,
      occurredAt: draft.occurredAt,
    },
  });
  return true;
}

export function mapInterestEvent(event: PrismaInterestEvent): InterestEvent {
  return interestEventSchema.parse({
    id: event.id,
    userId: event.userId,
    eventType: event.eventType,
    sourceRef: event.sourceRef,
    payload: event.payload,
    occurredAt: event.occurredAt.toISOString(),
    recordedAt: event.recordedAt.toISOString(),
    supersededAt: event.supersededAt?.toISOString() ?? null,
  });
}

export function appendMemoryInterestEvent<T extends InterestEventType>(
  events: InterestEvent[],
  draft: InterestEventDraft<T>,
): boolean {
  const payload = parsePayload(draft.eventType, draft.payload);
  const current = events.find((event) => (
    event.userId === draft.userId
    && event.eventType === draft.eventType
    && event.sourceRef === draft.sourceRef
    && event.supersededAt === null
  ));
  if (current && canonicalJson(current.payload) === canonicalJson(payload)) return false;
  if (current) current.supersededAt = draft.occurredAt.toISOString();
  events.push(interestEventSchema.parse({
    id: randomUUID(),
    userId: draft.userId,
    eventType: draft.eventType,
    sourceRef: draft.sourceRef,
    payload,
    occurredAt: draft.occurredAt.toISOString(),
    recordedAt: draft.occurredAt.toISOString(),
    supersededAt: null,
  }));
  return true;
}
