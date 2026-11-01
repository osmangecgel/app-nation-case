// A short, never-empty description of a thrown value for log fields.
// Connection errors to `localhost` are AggregateErrors (IPv6 and IPv4 both
// failed) with an empty message; the useful part is the code, e.g. ECONNREFUSED.
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  return [code, error.message].filter(Boolean).join(': ') || error.name;
}
