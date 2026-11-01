// Settles like `promise`, or rejects with the signal's reason as soon as it
// aborts, whether or not `promise` ever settles. For work that should honour
// a signal but might not (a third-party SDK): the caller stops waiting anyway.
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: Error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
