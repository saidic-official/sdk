import { OFFLINE, SaidicError } from './errors.js';
import type { ClientOptions } from './types.js';

export const DEFAULT_BASE = 'https://api.saidic.com';

// A key for one message, kept with it through every try: the server answers a second
// request under the same key with the first one's answer, so a retry never doubles a
// message.
export const newKey = (): string => {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  let key = '';
  for (let i = 0; i < 32; i++) key += Math.floor(Math.random() * 16).toString(16);
  return key;
};

// The customer's token: in memory alone, asked of the app where there is none, and
// asked again once when the server refuses it.
export class Tokens {
  private token: string | null;
  private asking: Promise<string> | null = null;

  constructor(private readonly options: ClientOptions) {
    this.token = options.token ?? null;
  }

  async current(): Promise<string> {
    if (this.token) return this.token;
    return this.fresh();
  }

  // A new token from the app, one asking at a time however many requests wait for it.
  async fresh(): Promise<string> {
    if (!this.options.getToken) {
      throw new SaidicError('unauthorized', 'The token was refused and no getToken was given.');
    }
    if (!this.asking) {
      this.asking = Promise.resolve(this.options.getToken())
        .then(token => {
          this.token = token;
          return token;
        })
        .finally(() => {
          this.asking = null;
        });
    }
    return this.asking;
  }

  forget(): void {
    this.token = null;
  }

  // A new token in place of the one a refused request used. Where another request has
  // already put a new one in its place, that one is answered: requests refused together
  // ask the app once (Reviewer 2's LOW).
  async renewFrom(used: string): Promise<string> {
    if (this.token && this.token !== used) return this.token;
    if (this.asking) return this.asking;
    this.token = null;
    return this.fresh();
  }

  // Whether a refused token can be replaced: the app gave a getToken.
  get refreshable(): boolean {
    return Boolean(this.options.getToken);
  }
}

type Ask = {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: unknown;
  idempotencyKey?: string;
};

// The REST half of the protocol: every request with the token in the Authorization
// header (never in the address), its answer read, its refusal made a SaidicError.
export class Rest {
  readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(
    options: ClientOptions,
    private readonly tokens: Tokens
  ) {
    this.base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    const given = options.fetch ?? globalThis.fetch;
    if (!given) throw new SaidicError('invalid_request', 'No fetch on this platform: pass one.');
    this.fetcher = given.bind(globalThis);
  }

  async request<T>(ask: Ask): Promise<T> {
    const used = await this.tokens.current();
    let response = await this.once(ask, used);
    if (response.status === 401 && this.tokens.refreshable) {
      // Refused, most often for being expired: one new token, one more try.
      response = await this.once(ask, await this.tokens.renewFrom(used));
    }
    return this.read<T>(response);
  }

  private async once(ask: Ask, token: string): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (ask.body !== undefined) headers['Content-Type'] = 'application/json';
    if (ask.idempotencyKey) headers['Idempotency-Key'] = ask.idempotencyKey;
    try {
      return await this.fetcher(`${this.base}/v1${ask.path}`, {
        method: ask.method,
        headers,
        body: ask.body === undefined ? undefined : JSON.stringify(ask.body),
      });
    } catch (cause) {
      const error = new SaidicError(OFFLINE, 'The API could not be reached.');
      (error as { cause?: unknown }).cause = cause;
      throw error;
    }
  }

  private async read<T>(response: Response): Promise<T> {
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (response.ok) return body as T;
    const said = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
    const header = Number(response.headers.get('Retry-After'));
    throw new SaidicError(
      typeof said.code === 'string' ? said.code : `http_${response.status}`,
      typeof said.message === 'string' ? said.message : response.statusText || 'Refused.',
      {
        status: response.status,
        requestId:
          (typeof said.request_id === 'string' ? said.request_id : null) ??
          response.headers.get('X-Request-Id'),
        retryAfter:
          typeof said.retry_after === 'number'
            ? said.retry_after
            : Number.isFinite(header) && header > 0
              ? header
              : null,
        fields:
          said.fields && typeof said.fields === 'object'
            ? (said.fields as Record<string, string>)
            : {},
      }
    );
  }
}
