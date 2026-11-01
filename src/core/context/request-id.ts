import { randomBytes } from 'node:crypto';

// W3C Trace Context: version-traceid-parentid-flags, lower-case hex.
const TRACEPARENT_PATTERN = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;
const INVALID_TRACE_ID = '0'.repeat(32);
const REQUEST_ID_BYTES = 16;

// The request id is a W3C trace id: a caller that sends traceparent finds its
// own trace id in our logs and responses.
export function requestIdFromTraceparent(header: string | undefined): string | undefined {
  const traceId = header?.match(TRACEPARENT_PATTERN)?.[1];
  return traceId === INVALID_TRACE_ID ? undefined : traceId;
}

export function generateRequestId(): string {
  return randomBytes(REQUEST_ID_BYTES).toString('hex');
}
