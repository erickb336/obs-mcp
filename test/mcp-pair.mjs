// An MCP client and a server factory joined in this process, through serveStdio over an in-memory transport.
// era: 'legacy' (2025 opening) or 'modern' (2026-07-28). elicit: the client's answer to each prompt, or null for a
// client that declares no elicitation.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

export async function pair(factory, { era = 'legacy', elicit = null, name = 'obs-mcp-test', manual = false } = {}) {
  const [c, s] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(factory, { transport: s, onerror: () => {} });
  const options = { capabilities: elicit ? { elicitation: { form: {} } } : {}, ...(manual ? { inputRequired: { autoFulfill: false } } : {}) };
  if (era === 'modern') options.versionNegotiation = { mode: { pin: '2026-07-28' } };
  const client = new Client({ name, version: '0.0.0' }, options);
  const prompts = [];
  const logs = [];
  if (elicit) client.setRequestHandler('elicitation/create', async (req) => (prompts.push(req.params.message), elicit(req.params.message, prompts.length)));
  client.setNotificationHandler?.('notifications/message', (n) => logs.push(n.params));
  await client.connect(c);
  const call = async (tool, args = {}, extra = {}, opts) => {
    const r = await client.callTool({ name: tool, arguments: args, ...extra }, opts);
    return { text: r.content?.map((x) => x.text).join('\n') ?? '', isError: !!r.isError, raw: r };
  };
  return { client, call, prompts, logs, close: async () => (await client.close(), await handle.close?.()) };
}

/** An answer that accepts, declines or waits first. */
export const accept = async () => ({ action: 'accept', content: {} });
export const decline = async () => ({ action: 'decline' });
export const after = (ms, answer) => async (...a) => (await new Promise((r) => setTimeout(r, ms)), answer(...a));
