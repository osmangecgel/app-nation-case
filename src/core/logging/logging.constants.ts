// LOG-07: a field is masked when its name contains one of these words, at any
// depth and in any case. Names are split into words on _ - . and camelCase, so
// new_password, refreshToken and x-api-key are all caught. Masking a harmless
// field by mistake is acceptable; writing a secret to the logs is not.
export const SENSITIVE_WORDS = new Set([
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'otp',
  'authorization',
  'cookie',
  'cvv',
  // A job's text and its result are the user's content; they never reach the
  // logs, even with LOG_HTTP_BODIES on.
  'input',
  'result',
]);
// Words that are only sensitive together, e.g. api + key, card + number.
export const SENSITIVE_WORD_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['api', 'key'],
  ['private', 'key'],
  ['access', 'key'],
  ['card', 'number'],
  ['national', 'id'],
];
export const MASK_CENSOR = '[MASKED]';

// LOG-06
export const HTTP_LOG_CONTEXT = 'HTTP';
// Messages of the request lines, printed as [HTTP][REQUEST_RECEIVED] (LOG-03).
export const HttpLogEvent = {
  REQUEST_RECEIVED: 'REQUEST_RECEIVED',
  RESPONSE_SENT: 'RESPONSE_SENT',
  REQUEST_ABORTED: 'REQUEST_ABORTED',
} as const;
export const HTTP_LOG_EXCLUDED_PATHS = new Set(['/health']);
export const MAX_LOGGED_BODY_BYTES = 10 * 1024;
export const MULTIPART_CONTENT_TYPE = 'multipart/form-data';
