import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

// @saidic/server: what a business's own server does with Saidic, in Node. The identity
// secret and the API key are read here and never leave the server: neither may reach a
// web page or an app.

const MOST_SECONDS = 3600;
const FACTS_MOST = 20;
const FACT_KEY = /^[A-Za-z0-9_]{1,40}$/;
const FACT_LONGEST = 200;
const FACTS_LONGEST = 2000;
const E164 = /^\+[1-9]\d{6,14}$/;

export class SaidicServerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;

  constructor(code: string, message: string, status = 0, requestId: string | null = null) {
    super(message);
    this.name = 'SaidicServerError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export interface MintOptions {
  // The identity secret and its key id, from the dashboard's Settings, Developers,
  // Identity.
  secret: string;
  keyId?: string;
  // The business's number on Saidic.
  businessId: number | string;
  // The customer's id in your own system: the same person on every device.
  customerId: string | number;
  email?: string;
  name?: string;
  // In E.164 (+2348031234567), so a contact step that asks a number is satisfied.
  phone?: string;
  // Facts the assistant may know about this customer: at most twenty fields, keys of
  // letters, digits and underscores up to 40 characters, values up to 200 characters,
  // 2,000 in all. Facts, never instructions.
  facts?: Record<string, string>;
  // Where the token is accepted: the widget and the API alike where none is given.
  scope?: 'customer' | 'widget' | 'api';
  // How long it lasts: an hour at most, an hour by default.
  ttlSeconds?: number;
}

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const checkFacts = (facts: Record<string, string>): void => {
  const entries = Object.entries(facts);
  if (entries.length > FACTS_MOST) {
    throw new SaidicServerError('invalid_request', `facts: at most ${FACTS_MOST} fields.`);
  }
  let all = 0;
  for (const [key, value] of entries) {
    if (!FACT_KEY.test(key)) {
      throw new SaidicServerError(
        'invalid_request',
        `facts: "${key}" is not a key (letters, digits and underscores, up to 40).`
      );
    }
    if (typeof value !== 'string' || value.length > FACT_LONGEST) {
      throw new SaidicServerError(
        'invalid_request',
        `facts: "${key}" must be text of at most ${FACT_LONGEST} characters.`
      );
    }
    all += key.length + value.length;
  }
  if (all > FACTS_LONGEST) {
    throw new SaidicServerError(
      'invalid_request',
      `facts: at most ${FACTS_LONGEST} characters in all.`
    );
  }
};

// THE TOKEN for a signed-in customer (sections 51.4 and 52.3): an HS256 JWT signed with
// the business's identity secret, for the widget (data-identity, saidicIdentify) and for
// an app (the SDK's token). What Saidic would refuse is refused here first.
export const mintToken = (options: MintOptions): string => {
  const ttl = options.ttlSeconds ?? MOST_SECONDS;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MOST_SECONDS) {
    throw new SaidicServerError('invalid_request', 'ttlSeconds: a whole number up to 3600.');
  }
  if (!options.secret) throw new SaidicServerError('invalid_request', 'secret is required.');
  const sub = String(options.customerId ?? '').trim();
  if (!sub || sub.length > 128) {
    throw new SaidicServerError('invalid_request', 'customerId: up to 128 characters.');
  }
  if (options.phone !== undefined && !E164.test(options.phone)) {
    throw new SaidicServerError('invalid_request', 'phone: in E.164, such as +2348031234567.');
  }
  if (options.facts) checkFacts(options.facts);
  const now = Math.floor(Date.now() / 1000);
  const header: Record<string, string> = { alg: 'HS256', typ: 'JWT' };
  if (options.keyId) header.kid = options.keyId;
  const claims: Record<string, unknown> = {
    aud: String(options.businessId),
    sub,
    iat: now,
    exp: now + ttl,
    jti: randomUUID(),
  };
  if (options.email) claims.email = options.email;
  if (options.name) claims.name = options.name;
  if (options.phone) claims.phone = options.phone;
  if (options.facts && Object.keys(options.facts).length) claims.facts = options.facts;
  if (options.scope) claims.scope = options.scope;
  const body = `${base64url(header)}.${base64url(claims)}`;
  const signature = createHmac('sha256', options.secret).update(body).digest('base64url');
  return `${body}.${signature}`;
};

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

const headerOf = (headers: HeaderBag, name: string): string => {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === wanted)
      return Array.isArray(value) ? String(value[0]) : String(value ?? '');
  }
  return '';
};

// A WEBHOOK's signature (Saidic-Signature: t=<seconds>,v1=<hex>[,v1=...]): true when one
// of the signatures is this body's, made with one of the secrets given (during a
// rotation both the new and the old one are good), at a time within the tolerance.
// The body as it came, before any parsing.
export const verifyWebhook = (
  headers: HeaderBag,
  rawBody: string | Buffer,
  secrets: string | string[],
  options: { toleranceSeconds?: number; now?: number } = {}
): boolean => {
  const header = headerOf(headers, 'saidic-signature');
  let stamp: number | null = null;
  const given: string[] = [];
  for (const part of header.split(',')) {
    const [name, value = ''] = part.trim().split('=', 2);
    if (name === 't' && /^\d+$/.test(value)) stamp = Number(value);
    else if (name === 'v1' && /^[0-9a-f]+$/.test(value)) given.push(value);
  }
  const now = options.now ?? Date.now() / 1000;
  if (stamp === null || Math.abs(now - stamp) > (options.toleranceSeconds ?? 300)) return false;
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  return (Array.isArray(secrets) ? secrets : [secrets]).some(secret => {
    const expected = Buffer.from(
      createHmac('sha256', secret).update(`${stamp}.${body}`).digest('hex'),
      'utf8'
    );
    return given.some(one => {
      const theirs = Buffer.from(one, 'utf8');
      return theirs.length === expected.length && timingSafeEqual(theirs, expected);
    });
  });
};

export interface CustomerFields {
  email?: string;
  phone?: string;
  name?: string;
  facts?: Record<string, string>;
}

export interface Customer extends CustomerFields {
  external_id: string;
  first_seen_at?: string;
  last_seen_at?: string;
}

// THE SERVER'S CLIENT, with the business's API key (Authorization: Bearer; never in an
// address): the customers your server knows of.
export class SaidicServer {
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: { key: string; baseUrl?: string; fetch?: typeof fetch }) {
    if (!options.key) throw new SaidicServerError('invalid_request', 'key is required.');
    this.base = (options.baseUrl ?? 'https://api.saidic.com').replace(/\/+$/, '');
    this.fetcher = (options.fetch ?? globalThis.fetch).bind(globalThis);
  }

  readonly customers = {
    // Made or brought up to date by your id for them.
    // A refusal of the fields comes as a rejection, as the server's would.
    upsert: async (externalId: string, fields: CustomerFields): Promise<Customer> => {
      if (fields.facts) checkFacts(fields.facts);
      return this.request<Customer>('PUT', `/customers/${encodeURIComponent(externalId)}`, fields);
    },
    get: (externalId: string): Promise<Customer> =>
      this.request<Customer>('GET', `/customers/${encodeURIComponent(externalId)}`),
  };

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(`${this.base}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.options.key}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: { error?: Record<string, unknown> } | null = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (response.ok) return parsed as T;
    const said = parsed?.error ?? {};
    throw new SaidicServerError(
      typeof said.code === 'string' ? said.code : `http_${response.status}`,
      typeof said.message === 'string' ? said.message : response.statusText,
      response.status,
      typeof said.request_id === 'string' ? said.request_id : response.headers.get('X-Request-Id')
    );
  }
}
