import { contentHash, countChars, normalizeInput, requestHash } from './job-content.ts';

const KEY = {
  jobTypeCode: 'summary',
  promptVersion: 'v1',
  providerCode: 'fake-text',
  modelVersion: 'fake-v1',
  normalizedInput: 'merhaba',
};

describe('normalizeInput', () => {
  it('trims, lowercases and collapses whitespace', () => {
    expect(normalizeInput('  Merhaba \n\t  DÜNYA  ')).toBe('merhaba dünya');
  });

  it('gives composed and decomposed characters the same form', () => {
    expect(normalizeInput('ş')).toBe(normalizeInput('ş'));
  });

  it('lowercases without the server locale', () => {
    expect(normalizeInput('İ')).toBe('i̇');
  });
});

describe('countChars', () => {
  it('counts an emoji as one character', () => {
    expect(countChars('a😀')).toBe(2);
  });
});

describe('contentHash', () => {
  it('is a 32-byte sha256', () => {
    expect(contentHash(KEY)).toHaveLength(32);
  });

  it('is the same for the same key', () => {
    expect(contentHash(KEY).equals(contentHash({ ...KEY }))).toBe(true);
  });

  it.each([
    ['job type', { jobTypeCode: 'translate' }],
    ['prompt version', { promptVersion: 'v2' }],
    ['provider', { providerCode: 'other-provider' }],
    ['model version', { modelVersion: 'fake-v2' }],
    ['input', { normalizedInput: 'selam' }],
  ])('changes with the %s', (_part, change) => {
    expect(contentHash({ ...KEY, ...change }).equals(contentHash(KEY))).toBe(false);
  });
});

describe('requestHash', () => {
  it('tells raw inputs apart even when they normalise to the same text', () => {
    expect(requestHash('summary', 'Merhaba').equals(requestHash('summary', 'merhaba'))).toBe(false);
  });
});
