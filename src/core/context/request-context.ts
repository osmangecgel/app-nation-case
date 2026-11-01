import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { generateRequestId } from './request-id.ts';

export type LoggableBody = object | string | number | boolean | null;

type RequestContextStore = {
  requestId: string;
  // Set while a worker processes a job, so every line it logs names the job.
  jobId?: string;
  responseBody?: LoggableBody;
};

// Carries per-request values (request id, job id, response body for LOG-06)
// through async calls without passing them as arguments. The worker runs each
// job in its own context, with the request id of the request that created it,
// so one search finds a job's whole way from the API through the worker.
@Injectable()
export class RequestContext {
  private readonly storage = new AsyncLocalStorage<RequestContextStore>();
  // Every log line carries a request id (LOG-02). Lines that belong to no
  // request or job (startup, shutdown, the broker client) carry this one, made
  // once per process, so a process's own lines can be found together.
  private readonly processRequestId = generateRequestId();

  run<T>(store: RequestContextStore, callback: () => T): T {
    return this.storage.run(store, callback);
  }

  // Event listeners (e.g. response 'close') may fire outside the request's
  // async context; binding keeps the request id available to them.
  bind<T extends (...args: never[]) => void>(callback: T): T {
    return AsyncLocalStorage.bind(callback);
  }

  logFields(): Record<string, string> {
    const store = this.storage.getStore();
    if (!store) {
      return { requestId: this.processRequestId };
    }
    return store.jobId ? { requestId: store.requestId, jobId: store.jobId } : { requestId: store.requestId };
  }

  requestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }

  setResponseBody(body: LoggableBody): void {
    const store = this.storage.getStore();
    if (store) {
      store.responseBody = body;
    }
  }

  responseBody(): LoggableBody | undefined {
    return this.storage.getStore()?.responseBody;
  }
}
