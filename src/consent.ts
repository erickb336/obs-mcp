// Consent through one form elicitation (T7 design, 7.0): on the 2026 era the tool returns inputRequired, and only a
// random, single-use consent id rides in requestState; on the 2025 era the server sends the prompt itself (asking). Reading A stays in this process's
// memory under that id. The id dies after 120 s (P15) or at its first use (rule 5), so a forged, late or repeated
// answer stops nothing.
import { randomBytes } from 'node:crypto';
import { CLIENT_CAPABILITIES_META_KEY, inputRequired, inputResponse, type McpServer, type ServerContext } from '@modelcontextprotocol/server';

const KEY = 'confirm';
const SCHEMA = { type: 'object' as const, properties: {} };

/** A confirm prompt of a tool: its text, its consent id, and the end of the id's life (after onExpire ran). */
export type Prompt = { prompt: string; id: string; expired: Promise<void>; lifeMs: number };
const isPrompt = (v: unknown): v is Prompt => !!v && typeof v === 'object' && typeof (v as Prompt).prompt === 'string' && (v as Prompt).expired instanceof Promise;

export class Consents<T> {
  private ids = new Map<string, { value: T; timer: NodeJS.Timeout }>();

  /** onExpire gets the value of an id that nobody used in time. */
  constructor(readonly lifeMs: number, private onExpire: (value: T) => void | Promise<void> = () => {}) {}

  /** Keeps value under a new random id of 128 bits, and gives the prompt that carries the id. */
  ask(message: string, value: T): Prompt {
    const id = randomBytes(16).toString('hex');
    let end!: () => void;
    const expired = new Promise<void>((r) => (end = r));
    const timer = setTimeout(async () => {
      this.ids.delete(id);
      try {
        await this.onExpire(value);
      } finally {
        end();
      }
    }, this.lifeMs);
    timer.unref?.();
    this.ids.set(id, { value, timer });
    return { prompt: message, id, expired, lifeMs: this.lifeMs };
  }
  /** Takes the value of an id and deletes it: a second use, or a use after 120 s, gives undefined. */
  use(id: string | undefined): T | undefined {
    const e = id === undefined ? undefined : this.ids.get(id);
    if (!e) return undefined;
    clearTimeout(e.timer);
    this.ids.delete(id!);
    return e.value;
  }

  /** Drops an id without using it, for a declined prompt. */
  drop(id: string | undefined) {
    this.use(id);
  }
}

export type Answer = { action: 'none' } | { action: 'accept' | 'decline' | 'cancel'; id?: string };

/** The answer that a call carries: none (a first call), or the action and the consent id of a retried call. */
export function answerOf(ctx: ServerContext): Answer {
  const r = inputResponse(ctx.mcpReq.inputResponses, KEY);
  const state = ctx.mcpReq.requestState();
  if (r.kind !== 'elicit') return typeof state === 'string' ? { action: 'cancel', id: state } : { action: 'none' };
  return { action: r.action, id: typeof state === 'string' ? state : undefined };
}

/**
 * Whether the client declared form elicitation: in the request envelope on the 2026 era, at initialize on a 2025-era
 * connection. A bare elicitation object counts as form, as the SDK shim counts it. Nothing else counts (R41).
 */
export function canAsk(server: McpServer, ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps = (envelope ? envelope[CLIENT_CAPABILITIES_META_KEY] : server.server.getClientCapabilities()) as { elicitation?: { form?: object; url?: object } } | undefined;
  const e = caps?.elicitation;
  return !!e && (!!e.form || !e.url);
}

/**
 * Runs a tool that can ask for consent. run gets the answer, and gives the reply or a prompt.
 * - 2026 era: the prompt goes back as inputRequired with one form elicitation, and the client calls again with the answer.
 * - 2025 era: the wire has no such round, so the server sends the prompt to the client itself and waits until the
 *   consent id expires (P15). Then end('expired') gives the reply, and the prompt goes (F-T7-49). After 8 prompts in
 *   one call, as the SDK's own loop, end('rounds') gives the reply.
 */
export async function asking<R>(ctx: ServerContext, run: (a: Answer) => Promise<R | Prompt>, end: (why: 'expired' | 'rounds') => R): Promise<R | ReturnType<typeof inputRequired>> {
  let res = await run(answerOf(ctx));
  if (!isPrompt(res)) return res;
  if (ctx.mcpReq.envelope) return inputRequired({ inputRequests: { [KEY]: inputRequired.elicit({ message: res.prompt, requestedSchema: SCHEMA }) }, requestState: res.id });
  for (let round = 1; isPrompt(res); round++) {
    const p = res;
    if (round > 8) return end('rounds');
    const stop = new AbortController();
    // The request's own limit is a little longer than the consent life, so that the consent life decides, and a
    // request that nobody answers (a client that closed) still ends.
    // A bare elicitation capability counts as form, as canAsk counts it (R41), so the request goes out with no form check.
    const answer = ctx.mcpReq.send({ method: 'elicitation/create', params: { mode: 'form', message: p.prompt, requestedSchema: SCHEMA } }, { signal: stop.signal, timeout: p.lifeMs + 5000 }).then(
      (r) => ({ action: (r as { action?: string }).action === 'accept' ? 'accept' : (r as { action?: string }).action === 'decline' ? 'decline' : 'cancel', id: p.id }) as Answer,
      () => ({ action: 'cancel', id: p.id }) as Answer,
    );
    const a = await Promise.race([answer, p.expired.then(() => undefined)]);
    if (!a) {
      stop.abort();
      return end('expired');
    }
    res = await run(a);
  }
  return res;
}
