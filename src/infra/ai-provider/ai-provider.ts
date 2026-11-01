// The worker depends on AI providers only through this interface, in our own
// terms (job type, text), never a vendor's (messages, roles, choices). A real
// provider is a new adapter that maps its request, response and error codes to
// these types; nothing else changes.

export type AiRequest = {
  jobType: string;
  // Normalised input: results are shared by content, so the provider must see
  // the same text for every job that shares the result.
  input: string;
  modelVersion: string;
};

export type AiResult = {
  text: string;
};

export interface AiProvider {
  // Matches job_providers.adapter.
  readonly adapter: string;
  // Must stop and reject when the signal aborts (timeout, lost lease, shutdown).
  generate(request: AiRequest, signal: AbortSignal): Promise<AiResult>;
}

// Worth retrying: timeouts, rate limits, the provider's own outages.
export class TransientAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

// Retrying cannot help: the provider rejected this input.
export class PermanentAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
