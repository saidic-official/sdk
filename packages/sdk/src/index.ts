import { Connection } from './connection.js';
import { SaidicError } from './errors.js';
import { SendQueue } from './queue.js';
import { Rest, Tokens, newKey } from './rest.js';
import type {
  ClientOptions,
  Conversation,
  Message,
  Page,
  SocketClass,
  StartOptions,
} from './types.js';

export { SaidicError } from './errors.js';
export { Connection } from './connection.js';
export type * from './types.js';

const segment = (id: number): string => {
  if (!Number.isInteger(id) || id <= 0) {
    throw new SaidicError('invalid_request', `Not a conversation id: ${String(id)}.`);
  }
  return String(id);
};

// THE CLIENT of one signed-in customer: their conversations with the business's
// assistant, and a person of the team where one takes over. It holds the customer's
// token in memory alone, never a key: keys stay on the business's server.
export class SaidicClient {
  private readonly tokens: Tokens;
  private readonly rest: Rest;
  private readonly queue: SendQueue;
  private readonly connections = new Set<Connection>();

  constructor(private readonly options: ClientOptions) {
    if (!options.token && !options.getToken) {
      throw new SaidicError('invalid_request', 'Give a token or a getToken.');
    }
    if ('key' in (options as Record<string, unknown>)) {
      // A key in a browser or an app can be read by anyone who has it.
      throw new SaidicError(
        'invalid_request',
        'An API key is for your server alone: give the SDK a customer token.'
      );
    }
    this.tokens = new Tokens(options);
    this.rest = new Rest(options, this.tokens);
    this.queue = new SendQueue((conversationId, text, key) =>
      this.rest.request<Message>({
        method: 'POST',
        path: `/conversations/${segment(conversationId)}/messages`,
        body: { text },
        idempotencyKey: key,
      })
    );
  }

  readonly conversations = {
    // A new conversation of this customer's (with a first message, where one is given).
    start: (options: StartOptions = {}): Promise<Conversation> =>
      this.rest.request<Conversation>({
        method: 'POST',
        path: '/conversations',
        body: options,
        idempotencyKey: newKey(),
      }),
    get: (id: number): Promise<Conversation> =>
      this.rest.request<Conversation>({ method: 'GET', path: `/conversations/${segment(id)}` }),
    // This customer's conversations, newest first, a page at a time.
    list: async (cursor?: string | null): Promise<Page<Conversation>> => {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const page = await this.rest.request<{
        conversations: Conversation[];
        next_cursor: string | null;
      }>({ method: 'GET', path: `/conversations${query}` });
      return { items: page.conversations ?? [], next: page.next_cursor ?? null };
    },
    close: (id: number): Promise<Conversation> =>
      this.rest.request<Conversation>({
        method: 'POST',
        path: `/conversations/${segment(id)}/close`,
      }),
    // The customer asks for a person: the business's team is told.
    requestPerson: async (id: number): Promise<void> => {
      await this.rest.request<unknown>({
        method: 'POST',
        path: `/conversations/${segment(id)}/request_person`,
      });
    },
  };

  readonly messages = {
    // A message of the customer's. While the network is down it waits, in order, and
    // goes when it is back; its idempotency key makes every try one message.
    send: (
      conversationId: number,
      text: string,
      options: { idempotencyKey?: string } = {}
    ): Promise<Message> => {
      segment(conversationId);
      return this.queue.add(conversationId, text, options.idempotencyKey ?? newKey());
    },
    // The messages after a seq (oldest first), or before one (the history, newest
    // first): a page, and whether there is more.
    list: async (
      conversationId: number,
      page: { after?: number; before?: number; limit?: number } = {}
    ): Promise<{ messages: Message[]; hasMore: boolean }> => {
      const query = new URLSearchParams();
      if (page.after !== undefined) query.set('after', String(page.after));
      if (page.before !== undefined) query.set('before', String(page.before));
      if (page.limit !== undefined) query.set('limit', String(page.limit));
      const asked = query.toString();
      const found = await this.rest.request<{ messages: Message[]; has_more: boolean }>({
        method: 'GET',
        path: `/conversations/${segment(conversationId)}/messages${asked ? `?${asked}` : ''}`,
      });
      return { messages: found.messages ?? [], hasMore: found.has_more === true };
    },
  };

  // The messages sent while offline that wait to go.
  get waiting(): number {
    return this.queue.size;
  }

  // The real-time connection: subscribe to conversations and listen for their events.
  connect(): Connection {
    const Socket = this.options.WebSocket ?? (globalThis as { WebSocket?: SocketClass }).WebSocket;
    if (!Socket) {
      throw new SaidicError(
        'invalid_request',
        'No WebSocket on this platform (Node before 22): pass one as the WebSocket option.'
      );
    }
    const connection = new Connection(this.rest.base, this.tokens, Socket, () => {
      void this.queue.flush();
    });
    this.connections.add(connection);
    return connection;
  }

  // Everything closed: the connections, and the messages still waiting are refused.
  close(): void {
    this.connections.forEach(connection => connection.close());
    this.connections.clear();
    this.queue.drop(new SaidicError('closed', 'The client was closed.'));
  }
}

export const Saidic = {
  create: (options: ClientOptions): SaidicClient => new SaidicClient(options),
};

export default Saidic;
