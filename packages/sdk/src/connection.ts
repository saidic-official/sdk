import { SaidicError } from './errors.js';
import type { Tokens } from './rest.js';
import type {
  ConnectionState,
  Control,
  EventName,
  Events,
  Handler,
  Message,
  SocketClass,
  SocketLike,
} from './types.js';

const PING_EVERY_MS = 30000;
const FIRST_RETRY_MS = 1000;
const LONGEST_RETRY_MS = 30000;
const MOST_SUBSCRIBED = 20;
// How many message ids are remembered per conversation to drop a second copy.
const IDS_REMEMBERED = 500;

// THE APP SOCKET'S REFUSALS (protocol v1, 51.6 as amended): the server accepts, then
// closes with a code in the 4000s and a one-word reason. 4401 the token refused (the
// verifier's reason), 4403 plan_limit (the business's plan does not allow the API, as
// REST's 403 plan_limit), 4404 the API not open to the business, 4429 too_many_uses. Every
// one is final but 4401 expired, which asks the app for a token once; a 4xxx this version
// does not know is final too. Any other close, and a failed handshake, is the network:
// it opens again, later each time.
const TOKEN_REFUSED = 4401;
const FINAL_CODES: Record<number, string> = {
  4401: 'unauthorized',
  4403: 'plan_limit',
  4404: 'not_open',
  4429: 'too_many_uses',
};
// Before the next page of a catch-up: the server answers one a second at most.
const NEXT_PAGE_MS = 1000;
const OPEN = 1;

const KNOWN: EventName[] = [
  'conversation.status',
  'handover.started',
  'handover.ended',
  'agent.typing',
  'conversation.closed',
  'error',
];

type Followed = { lastSeq: number | null; seen: Set<number>; control: Control | null };

// THE APP SOCKET (protocol v1, section 51.6): the customer's conversations in real time.
// On every open it subscribes again with the last seq it holds of each, and the server
// catches it up with what was stored meanwhile; the handlers see each message once, in
// the order of its seq. A ping every thirty seconds; a pong that names a later seq than
// the one held asks to be caught up. Lost, it opens again by itself, later each time;
// refused for its token, it asks the app for a new one, once.
export class Connection {
  private socket: SocketLike | null = null;
  private readonly followed = new Map<number, Followed>();
  private readonly handlers = new Map<EventName, Set<(event: never) => void>>();
  private ping: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryIn = FIRST_RETRY_MS;
  private readonly pages = new Set<ReturnType<typeof setTimeout>>();
  private refreshed = false;
  private closedByApp = false;
  private current: ConnectionState = 'connecting';

  constructor(
    private readonly base: string,
    private readonly tokens: Tokens,
    private readonly Socket: SocketClass,
    // Told when the socket opens: the client's queue then flushes.
    private readonly onOpen: () => void,
    // Told when it is closed for good, by the app or by a refusal.
    private readonly onEnd: () => void = () => {}
  ) {
    void this.open();
    const platform = globalThis as { addEventListener?: (name: string, fn: () => void) => void };
    platform.addEventListener?.('online', this.backOnline);
  }

  get state(): ConnectionState {
    return this.current;
  }

  // Follow these conversations (up to twenty): caught up from the last seq this
  // connection holds of each, then their events.
  subscribe(ids: number[]): void {
    const added = ids.filter(id => !this.followed.has(id));
    if (this.followed.size + added.length > MOST_SUBSCRIBED) {
      throw new SaidicError(
        'invalid_request',
        `A connection follows at most ${MOST_SUBSCRIBED} conversations.`
      );
    }
    added.forEach(id => this.followed.set(id, { lastSeq: null, seen: new Set(), control: null }));
    if (added.length) this.sendSubscribe(added);
  }

  unsubscribe(ids: number[]): void {
    const gone = ids.filter(id => this.followed.delete(id));
    if (gone.length) this.send({ type: 'unsubscribe', ids: gone });
  }

  // A handler for an event; the function answered takes it off again.
  on<E extends EventName>(name: E, handler: Handler<E>): () => void {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(handler as (event: never) => void);
    return () => {
      set?.delete(handler as (event: never) => void);
    };
  }

  close(): void {
    this.closedByApp = true;
    this.stopTimers();
    const platform = globalThis as {
      removeEventListener?: (name: string, fn: () => void) => void;
    };
    platform.removeEventListener?.('online', this.backOnline);
    this.socket?.close(1000);
    this.socket = null;
    this.setState('closed');
    this.onEnd();
  }

  private async open(): Promise<void> {
    if (this.closedByApp) return;
    let token: string;
    try {
      token = await this.tokens.current();
    } catch (error) {
      this.giveUp('unauthorized', error instanceof Error ? error.message : String(error));
      return;
    }
    if (this.closedByApp) return;
    const url = `${this.base.replace(/^http/, 'ws')}/v1/ws`;
    // The token goes in the subprotocol: a browser can set no header on a socket, and
    // an address is written in logs.
    const socket = new this.Socket(url, ['saidic.v1', `saidic.token.${token}`]);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.retryIn = FIRST_RETRY_MS;
      this.refreshed = false;
      this.setState('open');
      this.sendSubscribe([...this.followed.keys()]);
      this.ping = setInterval(() => this.send({ type: 'ping' }), PING_EVERY_MS);
      this.onOpen();
    };
    socket.onmessage = event => {
      if (this.socket === socket) this.receive(event.data);
    };
    socket.onerror = () => {
      // The close that follows says what to do.
    };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopTimers();
      if (this.closedByApp) return;
      if (event.code === TOKEN_REFUSED) {
        if (event.reason === 'expired' && this.tokens.refreshable && !this.refreshed) {
          // An hour is over: one new token from the app, and at once again.
          this.refreshed = true;
          this.tokens.forget();
          this.setState('connecting');
          void this.tokens.fresh().then(
            () => this.open(),
            error =>
              this.giveUp('unauthorized', error instanceof Error ? error.message : String(error))
          );
          return;
        }
      }
      if (event.code >= 4000 && event.code < 5000) {
        const reason = event.reason || 'refused';
        this.giveUp(
          FINAL_CODES[event.code] ?? 'refused',
          `The connection was refused: ${reason}.`,
          {
            reason,
            close_code: event.code,
          }
        );
        return;
      }
      this.again();
    };
  }

  private again(): void {
    this.setState('reconnecting');
    const wait = this.retryIn * (0.8 + Math.random() * 0.4);
    this.retryIn = Math.min(this.retryIn * 2, LONGEST_RETRY_MS);
    this.retry = setTimeout(() => void this.open(), wait);
  }

  // The platform says the network is back: no waiting for the timer.
  private readonly backOnline = () => {
    if (this.current !== 'reconnecting') return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    void this.open();
  };

  // Final: closed, said to the handlers, and nothing left listening.
  private giveUp(
    code: string,
    message: string,
    more: { reason?: string; close_code?: number } = {}
  ): void {
    this.stopTimers();
    const platform = globalThis as {
      removeEventListener?: (name: string, fn: () => void) => void;
    };
    platform.removeEventListener?.('online', this.backOnline);
    this.setState('closed');
    this.emit('error', { code, message, ...more });
    this.onEnd();
  }

  private receive(data: unknown): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    const type = frame.type;
    const id = Number(frame.conversation_id);
    if (type === 'caught_up') {
      const messages = Array.isArray(frame.messages) ? (frame.messages as Message[]) : [];
      [...messages].sort((a, b) => a.seq - b.seq).forEach(message => this.deliver(id, message));
      if (frame.control) this.controlIs(id, frame.control as Control);
      // More was stored than one answer holds: ask for the rest.
      if (frame.has_more === true) {
        const page = setTimeout(
          () => {
            this.pages.delete(page);
            this.sendSubscribe([id]);
          },
          NEXT_PAGE_MS + Math.random() * 500
        );
        this.pages.add(page);
      }
      return;
    }
    if (type === 'message.created') {
      this.deliver(id, frame.message as Message);
      return;
    }
    if (type === 'pong') {
      const latest = (frame.latest ?? {}) as Record<string, number>;
      const behind = Object.entries(latest)
        .map(([key, seq]) => [Number(key), Number(seq)] as const)
        .filter(([key, seq]) => {
          const held = this.followed.get(key);
          return held && seq > (held.lastSeq ?? 0);
        })
        .map(([key]) => key);
      if (behind.length) this.sendSubscribe(behind);
      return;
    }
    if (typeof type === 'string' && (KNOWN as string[]).includes(type)) {
      const { type: _type, ...event } = frame;
      void _type;
      if (type === 'handover.started')
        this.noteControl(id, { by: 'person', person_name: frame.person_name as string });
      if (type === 'handover.ended') this.noteControl(id, { by: 'assistant' });
      this.emit(type as EventName, event as never);
    }
    // Anything else is a type this version does not know: ignored, as the protocol asks.
  }

  // A message to the handlers once, never one older than what they already saw.
  private deliver(conversationId: number, message: Message | undefined): void {
    const held = this.followed.get(conversationId);
    if (!held || !message || typeof message.id !== 'number') return;
    if (held.seen.has(message.id)) return;
    if (held.lastSeq !== null && message.seq <= held.lastSeq) return;
    held.seen.add(message.id);
    if (held.seen.size > IDS_REMEMBERED)
      held.seen.delete(held.seen.values().next().value as number);
    held.lastSeq = message.seq;
    this.emit('message.created', { conversation_id: conversationId, message });
  }

  // The control state a catch-up gives: an event where it changed while away.
  private controlIs(conversationId: number, control: Control): void {
    const held = this.followed.get(conversationId);
    if (!held) return;
    const before = held.control;
    held.control = control;
    if (!before || before.by === control.by) return;
    if (control.by === 'person') {
      this.emit('handover.started', {
        conversation_id: conversationId,
        person_name: control.person_name,
      });
    } else {
      this.emit('handover.ended', { conversation_id: conversationId });
    }
  }

  private noteControl(conversationId: number, control: Control): void {
    const held = this.followed.get(conversationId);
    if (held) held.control = control;
  }

  private sendSubscribe(ids: number[]): void {
    if (!ids.length) return;
    this.send({
      type: 'subscribe',
      conversations: ids.map(id => ({ id, after_seq: this.followed.get(id)?.lastSeq ?? null })),
    });
  }

  private send(frame: Record<string, unknown>): void {
    if (this.socket && this.socket.readyState === OPEN) this.socket.send(JSON.stringify(frame));
  }

  private emit<E extends EventName>(name: E, event: Events[E]): void {
    this.handlers.get(name)?.forEach(handler => {
      try {
        (handler as Handler<E>)(event);
      } catch (error) {
        // A handler's own fault never stops the others or the connection; it is said
        // where the app's developer will see it (thrown again, it would end a Node
        // process).
        console.error('Saidic: an event handler threw.', error);
      }
    });
  }

  private setState(state: ConnectionState): void {
    if (state === this.current) return;
    this.current = state;
    this.emit('connection.state', { state });
  }

  private stopTimers(): void {
    if (this.ping) clearInterval(this.ping);
    if (this.retry) clearTimeout(this.retry);
    this.pages.forEach(page => clearTimeout(page));
    this.pages.clear();
    this.ping = null;
    this.retry = null;
  }
}
