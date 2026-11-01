import { csvField, toJobCsvLine } from './job-csv.ts';

describe('csvField', () => {
  it.each([
    ['plain text', 'summary', 'summary'],
    ['a number', 3, '3'],
    ['null as empty', null, ''],
    ['a comma', 'a,b', '"a,b"'],
    ['a quote', 'say "hi"', '"say ""hi"""'],
    ['a new line', 'a\nb', '"a\nb"'],
    ['a formula', '=SUM(A1)', "'=SUM(A1)"],
  ])('writes %s', (_case, value, expected) => {
    expect(csvField(value)).toBe(expected);
  });
});

describe('toJobCsvLine', () => {
  it('writes the columns in header order', () => {
    const line = toJobCsvLine({
      jobId: 'job-1',
      type: 'summary',
      status: 'failed',
      cost: 3,
      errorCode: 'provider_rejected',
      createdAt: '2026-10-30T10:00:00.000Z',
      finishedAt: null,
    });

    // RFC 4180: every record ends with CRLF.
    expect(line).toBe('job-1,summary,failed,3,provider_rejected,2026-10-30T10:00:00.000Z,\r\n');
  });
});
