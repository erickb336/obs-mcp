// Consent through the SDK multi-round-trip path (T7 design, 7.0): the tool returns inputRequired with one form
// elicitation, and only a random, single-use consent id rides in requestState. Reading A stays in this process's
// memory under that id. The id dies after 120 s (P15) or at its first use (rule 5), so a forged, late or repeated
// answer stops nothing.
import { randomBytes } from 'node:crypto';
import { CLIENT_CAPABILITIES_META_KEY, inputRequired, inputResponse, type McpServer, type ServerContext } from '@modelcontextprotocol/server';

const KEY = 'confirm';

export class Consents<T> {
  private ids = new Map<string, { value: T; timer: NodeJS.Timeout }>();

  /** onExpire gets the value of an id that nobody used in time. */
  constructor(private lifeMs: number, private onExpire: (value: T) => void = () => {}) {}

  /** Keeps value under a new random id of 128 bits, and gives the prompt that carries the id. */
  ask(message: string, value: T) {
    const id = randomBytes(16).toString('hex');
    const timer = setTimeout(() => {
      this.ids.delete(id);
      this.onExpire(value);
    }, this.lifeMs);
    timer.unref?.();
    this.ids.set(id, { value, timer });
    return inputRequired({ inputRequests: { [KEY]: inputRequired.elicit({ message, requestedSchema: { type: 'object', properties: {} } }) }, requestState: id });
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

/** The answer that a call carries: none (a first call), or the action and the consent id of a retried call. */
export function answerOf(ctx: ServerContext): { action: 'none' } | { action: 'accept' | 'decline' | 'cancel'; id?: string } {
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
