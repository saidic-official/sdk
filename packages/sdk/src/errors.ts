// One error for everything the API refuses, with the server's fixed word for why
// (protocol v1: invalid_request, unauthorized, forbidden, not_found, conflict,
// rate_limited, plan_limit, conversation_closed, unavailable), and the request id to
// quote to support.
export class SaidicError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  // Seconds to wait before asking again, on rate_limited.
  readonly retryAfter: number | null;
  // What the server said of each field, on invalid_request.
  readonly fields: Record<string, string>;

  constructor(
    code: string,
    message: string,
    details: {
      status?: number;
      requestId?: string | null;
      retryAfter?: number | null;
      fields?: Record<string, string>;
    } = {}
  ) {
    super(message);
    this.name = 'SaidicError';
    this.code = code;
    this.status = details.status ?? 0;
    this.requestId = details.requestId ?? null;
    this.retryAfter = details.retryAfter ?? null;
    this.fields = details.fields ?? {};
  }
}

// The network could not be reached: the request may be tried again.
export const OFFLINE = 'offline';
