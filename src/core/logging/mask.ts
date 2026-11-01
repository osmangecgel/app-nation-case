import { MASK_CENSOR, SENSITIVE_WORD_PAIRS, SENSITIVE_WORDS } from './logging.constants.ts';

const WORD_SEPARATOR = /[_\-.\s]+|(?<=[a-z0-9])(?=[A-Z])/;

function isSensitiveKey(key: string): boolean {
  const words = new Set(key.split(WORD_SEPARATOR).map((word) => word.toLowerCase()));
  if ([...words].some((word) => SENSITIVE_WORDS.has(word))) {
    return true;
  }
  return SENSITIVE_WORD_PAIRS.some(([first, second]) => words.has(first) && words.has(second));
}

function maskValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, seen));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, isSensitiveKey(key) ? MASK_CENSOR : maskValue(item, seen)]),
  );
}

// Returns a copy with sensitive fields replaced (LOG-07). The input is not changed.
export function maskSensitive<T>(value: T): T {
  // The copy has the same shape as the input, only some leaf values differ.
  return maskValue(value, new WeakSet()) as T;
}
