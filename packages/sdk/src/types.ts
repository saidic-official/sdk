// The public protocol's shapes (protocol v1; docs/architecture.md, section 10, The
// public API, the SDKs and identity): what the REST routes answer and what the socket
// sends. A field the SDK does not know is kept as it came; an event type it does not
// know is ignored, so the server may add both inside v1.
//
// ONE NAMING RULE: what the server sends keeps the server's names, as the protocol
// document writes them (has_more, next_cursor, conversation_id, created_at); what is the
// SDK's own (its methods, its options, SaidicError's fields) is camelCase.

// Who wrote a message: the customer, the business's assistant, or a person of the
// business's team who took the conversation over.
export type Author = 'customer' | 'assistant' | 'person';

export interface Message {
  id: number;
  // A later message has a greater seq; nothing is promised of gaps.
  seq: number;
  from: Author;
  text: string;
  created_at: string;
  // The first name of the person of the team, on a message of theirs.
  person_name?: string;
  // Answers the assistant offers to choose from, where it offers some.
  choices?: { id: string; label: string }[];
  // Present on the answer to a send: the server took the message.
  status?: 'accepted';
  // The knowledge items an assistant reply was written from, fixed when it was stored;
  // an empty list on every other message.
  based_on: BasedOn[];
}

// One knowledge item a reply was written from. Only its title goes out, never its text.
export interface BasedOn {
  id: string;
  kind: 'profile' | 'about' | 'note' | 'file' | 'qa' | 'pushed';
  // As it was when the reply was stored.
  title: string;
  // True once the item has been deleted.
  removed: boolean;
}

export interface Control {
  by: 'assistant' | 'person';
  person_name?: string;
}

export interface Conversation {
  id: number;
  status: 'open' | 'closed';
  created_at: string;
  language: string;
  control: Control;
  customer: { external_id: string };
}

// What the assistant is doing with the customer's last message.
export type Working =
  | 'searching'
  | 'writing'
  | 'checking'
  | 'replied'
  | 'failed'
  | 'stopped'
  | 'unreachable';

// The events a connection hands to its handlers, by name, each with what it carries.
// Every one names its conversation.
export interface Events {
  'message.created': { conversation_id: number; message: Message };
  'conversation.status': { conversation_id: number; status: Working };
  'handover.started': { conversation_id: number; person_name?: string };
  'handover.ended': { conversation_id: number };
  'agent.typing': { conversation_id: number; typing: boolean };
  'conversation.closed': { conversation_id: number };
  // A frame the server refused, or a conversation that is not this customer's.
  // A refused connection carries the server's one-word reason and the close code.
  error: {
    conversation_id?: number;
    code: string;
    message: string;
    reason?: string;
    close_code?: number;
  };
  // The connection's own state, for an indicator of the app's.
  'connection.state': { state: ConnectionState };
}

export type EventName = keyof Events;
export type Handler<E extends EventName> = (event: Events[E]) => void;

export type ConnectionState =
  // Opening, or opening again after it was lost.
  | 'connecting'
  | 'open'
  // Lost: it opens again by itself, later each time.
  | 'reconnecting'
  // Closed by the app, or refused for good (the token, too many sockets).
  | 'closed';

// What starting a conversation may carry.
export interface StartOptions {
  // A language tag ("en", "fr"); the business's language where none is given.
  language?: string;
  // Facts about this customer for the assistant: at most twenty fields, keys of
  // letters, digits and underscores, values strings up to 200 characters. Facts, never
  // instructions.
  context?: Record<string, string>;
  // The business's own knowledge sources the assistant may answer from, by id.
  knowledge?: number[];
  // A first message, sent with the start.
  text?: string;
}

// A page of the customer's conversations, as the server sends it: next_cursor asks for
// the next page, null at the end.
export interface ConversationPage {
  conversations: Conversation[];
  next_cursor: string | null;
}

// Messages after a seq or before one, as the server sends them.
export interface MessagePage {
  messages: Message[];
  has_more: boolean;
}

// A WebSocket class as the platform gives it (browsers, React Native, Node 22 and up),
// or one the app passes in (Node 18 and 20, with a package of its choice).
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type SocketClass = new (url: string, protocols?: string | string[]) => SocketLike;

export interface ClientOptions {
  // The customer's token, made by the business's server (an hour at most).
  token?: string;
  // Asked for a token when there is none, and again when one is refused as expired.
  // Return the token as text; the SDK keeps it in memory alone.
  getToken?: () => string | Promise<string>;
  // Where the API is: https://api.saidic.com by default.
  baseUrl?: string;
  // Node 18 and 20 have no WebSocket of their own: pass one.
  WebSocket?: SocketClass;
  // The platform's fetch, by default.
  fetch?: typeof fetch;
}
