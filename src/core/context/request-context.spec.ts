import { RequestContext } from './request-context.ts';

const REQUEST_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

describe('RequestContext', () => {
  const context = new RequestContext();

  it('exposes the request id and response body inside a request', () => {
    context.run({ requestId: REQUEST_ID }, () => {
      context.setResponseBody({ id: 'p-1' });

      expect(context.requestId()).toBe(REQUEST_ID);
      expect(context.logFields()).toEqual({ requestId: REQUEST_ID });
      expect(context.responseBody()).toEqual({ id: 'p-1' });
    });
  });

  it('adds the job id to log fields while a job is processed', () => {
    context.run({ requestId: REQUEST_ID, jobId: 'job-1' }, () => {
      expect(context.logFields()).toEqual({ requestId: REQUEST_ID, jobId: 'job-1' });
    });
  });

  it('has no request outside one, and ignores writes there', () => {
    context.setResponseBody({ id: 'p-1' });

    expect(context.requestId()).toBeUndefined();
    expect(context.responseBody()).toBeUndefined();
  });

  it("logs lines outside any request or job (startup, shutdown) with the process's own id", () => {
    const fields = context.logFields();

    expect(fields).toEqual({ requestId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(context.logFields()).toEqual(fields);
    expect(new RequestContext().logFields()).not.toEqual(fields);
  });

  it('keeps the request id in callbacks bound inside the request', () => {
    const callback = context.run({ requestId: REQUEST_ID }, () => context.bind(() => context.requestId()));

    expect(callback()).toBe(REQUEST_ID);
  });
});
