import { Test, type TestingModule } from '@nestjs/testing';
import { type QueueMessage, QueuePublisher } from '#infra/queue/queue.ts';
import { JobConfigService } from '#modules/job-config/job-config.service.ts';
import { JobOutboxRelayModule } from '#modules/job-outbox/job-outbox-relay.module.ts';
import { JobOutboxRelayService } from '#modules/job-outbox/job-outbox-relay.service.ts';
import { JobsService } from '#modules/jobs/jobs.service.ts';
import { UsersService } from '#modules/users/users.service.ts';
import { AppModule } from '../src/app.module.ts';
import { testPrisma } from './support/test-prisma.ts';

describe('Outbox relay', () => {
  let moduleRef: TestingModule;
  let relay: JobOutboxRelayService;
  // Stands in for Kafka: records what was published, or fails when told to.
  const published: QueueMessage[] = [];
  let kafkaDown = false;
  let keySequence = 0;

  beforeAll(async () => {
    // Not initialised, so the relay's own timer stays off and the test calls it
    // directly; the job configuration is loaded by hand instead.
    moduleRef = await Test.createTestingModule({ imports: [AppModule, JobOutboxRelayModule] })
      .overrideProvider(QueuePublisher)
      .useValue({
        publish: (messages: QueueMessage[]) => {
          if (kafkaDown) {
            return Promise.reject(new Error('Broker transport failure'));
          }
          published.push(...messages);
          return Promise.resolve();
        },
      })
      .compile();
    relay = moduleRef.get(JobOutboxRelayService);
    await moduleRef.get(JobConfigService).refresh();
  });

  beforeEach(async () => {
    published.length = 0;
    kafkaDown = false;
    await moduleRef.get(UsersService).grantCredits('user-1', 100);
  });

  afterAll(async () => {
    await moduleRef.close();
    await testPrisma.$disconnect();
  });

  async function createJob(input = 'bir'): Promise<string> {
    keySequence += 1;
    const { jobId } = await moduleRef
      .get(JobsService)
      .create({ userId: 'user-1', idempotencyKey: `relay-${keySequence}`, type: 'translate', input });
    return jobId;
  }

  const unsent = () => testPrisma.jobOutboxMessage.count({ where: { sent_at: null } });

  it('publishes a new job with its content key and request id, then marks it sent', async () => {
    const jobId = await createJob();
    const row = await testPrisma.jobOutboxMessage.findFirstOrThrow({ where: { job_id: jobId } });

    expect(await relay.relayPending()).toBe(1);

    expect(published).toEqual([
      {
        topic: 'jobs.process',
        key: row.message_key,
        value: JSON.stringify({ job_id: jobId }),
        headers: { request_id: row.request_id },
      },
    ]);
    expect(await unsent()).toBe(0);
  });

  it('holds back a retry until its time has come', async () => {
    const jobId = await createJob();
    await testPrisma.$executeRaw`
      UPDATE job_outbox_messages SET not_before = now() + interval '1 minute' WHERE job_id = ${jobId}::uuid`;

    expect(await relay.relayPending()).toBe(0);
    expect(await unsent()).toBe(1);
  });

  it('keeps messages unsent when Kafka is down, and sends them once it is back', async () => {
    await createJob('bir');
    await createJob('iki');
    kafkaDown = true;

    await expect(relay.relayPending()).rejects.toThrow('Broker transport failure');
    expect(await unsent()).toBe(2);

    kafkaDown = false;
    expect(await relay.relayPending()).toBe(2);
    expect(await unsent()).toBe(0);
  });

  it('deletes every sent message past its retention, in as many batches as needed', async () => {
    const jobId = await createJob();
    // More than two cleanup batches of old messages, one recent and the job's unsent one.
    await testPrisma.$executeRaw`
      INSERT INTO job_outbox_messages (id, job_id, topic, message_key, request_id, sent_at)
      SELECT gen_random_uuid(), ${jobId}::uuid, 'jobs.process', 'key', 'request', now() - interval '2 hours'
        FROM generate_series(1, 2500)`;
    await testPrisma.$executeRaw`
      INSERT INTO job_outbox_messages (id, job_id, topic, message_key, request_id, sent_at)
      VALUES (gen_random_uuid(), ${jobId}::uuid, 'jobs.process', 'key', 'request', now() - interval '10 minutes')`;

    const deleted = await relay.deleteSent();

    expect(deleted).toBe(2500);
    expect(await testPrisma.jobOutboxMessage.count({ where: { sent_at: { not: null } } })).toBe(1);
    expect(await unsent()).toBe(1);
  });
});
