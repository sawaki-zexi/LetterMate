import {
  digestVerificationJobDataSchema,
  digestVerificationQueueName,
  type DigestVerificationJobData,
} from '@lettermate/contracts';
import type { PrismaClient } from '@prisma/client';
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { EmailGateway } from './digest-email.js';
import { renderDigestVerificationEmail } from './digest-email.js';

export interface DigestVerificationDeliveryRepository {
  succeed(verificationId: string, messageId: string): Promise<void>;
}

export class PrismaDigestVerificationDeliveryRepository
implements DigestVerificationDeliveryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async succeed(verificationId: string, messageId: string): Promise<void> {
    const result = await this.prisma.digestEmailVerification.updateMany({
      where: { id: verificationId, providerMessageId: null },
      data: { providerMessageId: messageId },
    });
    if (result.count !== 1) {
      const existing = await this.prisma.digestEmailVerification.findUnique({
        where: { id: verificationId },
        select: { providerMessageId: true },
      });
      if (existing?.providerMessageId !== messageId) {
        throw new Error('Digest verification message ownership could not be persisted');
      }
    }
  }
}

export class DigestVerificationDeliveryService {
  constructor(
    private readonly gateway: EmailGateway,
    private readonly repository?: DigestVerificationDeliveryRepository,
  ) {}

  async run(data: DigestVerificationJobData): Promise<void> {
    const parsed = digestVerificationJobDataSchema.parse(data);
    const result = await this.gateway.send(renderDigestVerificationEmail(parsed), {
      idempotencyKey: `digest-verification:${parsed.verificationId}`,
    });
    await this.repository?.succeed(parsed.verificationId, result.messageId);
  }
}

export const createDigestVerificationJobHandler = (
  service: Pick<DigestVerificationDeliveryService, 'run'>,
) => async (job: Job<DigestVerificationJobData>): Promise<void> => {
  await service.run(digestVerificationJobDataSchema.parse(job.data));
};

export function createDigestVerificationWorker(
  connection: ConnectionOptions,
  service: Pick<DigestVerificationDeliveryService, 'run'>,
): Worker<DigestVerificationJobData> {
  return new Worker<DigestVerificationJobData>(
    digestVerificationQueueName,
    createDigestVerificationJobHandler(service),
    { connection },
  );
}
