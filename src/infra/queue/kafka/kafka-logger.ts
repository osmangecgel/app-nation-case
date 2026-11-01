import { Logger } from '@nestjs/common';
import type { KafkaJS } from '@confluentinc/kafka-javascript';

const KafkaLogEvent = {
  KAFKA_CLIENT_ERROR: 'KAFKA_CLIENT_ERROR',
  KAFKA_CLIENT_WARNING: 'KAFKA_CLIENT_WARNING',
  KAFKA_CLIENT_INFO: 'KAFKA_CLIENT_INFO',
} as const;

// The Kafka library's own log lines, written through the application logger
// like every other line: a fixed event code, the library's text as a field,
// and the request id the logger adds (LOG-02, LOG-03). The library filters by
// its logLevel before calling, so every call here is written.
export function kafkaLogger(logger = new Logger('Kafka')): KafkaJS.Logger {
  const adapter: KafkaJS.Logger = {
    error: (message, extra) => logger.error(KafkaLogEvent.KAFKA_CLIENT_ERROR, { detail: message, ...extra }),
    warn: (message, extra) => logger.warn(KafkaLogEvent.KAFKA_CLIENT_WARNING, { detail: message, ...extra }),
    info: (message, extra) => logger.log(KafkaLogEvent.KAFKA_CLIENT_INFO, { detail: message, ...extra }),
    debug: (message, extra) => logger.debug(KafkaLogEvent.KAFKA_CLIENT_INFO, { detail: message, ...extra }),
    namespace: () => adapter,
    setLogLevel: () => undefined,
  };
  return adapter;
}
