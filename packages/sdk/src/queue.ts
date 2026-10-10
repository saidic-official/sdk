import { SaidicError, passing } from './errors.js';
import type { Message } from './types.js';

type Waiting = {
  conversationId: number;
  text: string;
  key: string;
  resolve: (message: Message) => void;
  reject: (error: unknown) => void;
};

const FIRST_WAIT_MS = 2000;
const LONGEST_WAIT_MS = 30000;

// THE OFFLINE QUEUE (protocol v1's rules for an SDK): a message sent while the network
// is down, or while the server or its gateway says "not now" (502, 503, 504, 520 to 524,
// 'unavailable'), waits here, in the order it was sent, and goes when it is back, with
// the idempotency key it was given at the first try, so a message the server took
// before the answer was lost is never stored twice. A refusal (a closed conversation,
// a message too long) ends that message alone; the rest go on in order.
export class SendQueue {
  private readonly waiting: Waiting[] = [];
  private flushing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wait = FIRST_WAIT_MS;

  constructor(
    private readonly sendOnce: (
      conversationId: number,
      text: string,
      key: string
    ) => Promise<Message>
  ) {}

  // The number of messages waiting, for an app that shows it.
  get size(): number {
    return this.waiting.length;
  }

  add(conversationId: number, text: string, key: string): Promise<Message> {
    return new Promise<Message>((resolve, reject) => {
      this.waiting.push({ conversationId, text, key, resolve, reject });
      void this.flush();
    });
  }

  // Try what waits, in order. Called on every add, when the connection opens, when the
  // platform says the network is back, and by the queue's own timer.
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    this.clearTimer();
    try {
      while (this.waiting.length) {
        const next = this.waiting[0];
        try {
          const message = await this.sendOnce(next.conversationId, next.text, next.key);
          this.waiting.shift();
          this.wait = FIRST_WAIT_MS;
          next.resolve(message);
        } catch (error) {
          if (passing(error)) {
            this.later(this.wait);
            this.wait = Math.min(this.wait * 2, LONGEST_WAIT_MS);
            return;
          }
          if (error instanceof SaidicError && error.code === 'rate_limited') {
            this.later(((error.retryAfter ?? 2) + Math.random()) * 1000);
            return;
          }
          this.waiting.shift();
          next.reject(error);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  // The app closed the client: what waits is refused, with the reason.
  drop(reason: SaidicError): void {
    this.clearTimer();
    this.waiting.splice(0).forEach(one => one.reject(reason));
  }

  private later(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => void this.flush(), ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
