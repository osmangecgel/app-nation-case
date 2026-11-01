import { Logger } from '@nestjs/common';
import { kafkaLogger } from './kafka-logger.ts';

describe('kafkaLogger', () => {
  it("writes the library's lines as event codes, with its text as a field", () => {
    const logger = new Logger('Kafka');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const adapter = kafkaLogger(logger);

    adapter.warn('Broker transport failure', { fac: 'FAIL' });
    adapter.namespace('consumer').error('Connection refused');

    expect(warn).toHaveBeenCalledWith('KAFKA_CLIENT_WARNING', { detail: 'Broker transport failure', fac: 'FAIL' });
    expect(error).toHaveBeenCalledWith('KAFKA_CLIENT_ERROR', { detail: 'Connection refused' });
  });
});
