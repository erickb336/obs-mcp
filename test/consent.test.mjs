// T7 unit 5: consent through one form elicitation (inputRequired on the 2026 era, a server request on the 2025 era, F-T7-49), on an SDK test client in both protocol eras. A tool of this test stands in
// for obs_record_stop: it counts a "send" only after a valid, unused consent id. No OBS.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { asking, canAsk, Consents } from '../dist/consent.js';
import { TEXT } from '../dist/take.js';
import { accept, after, decline, pair } from './mcp-pair.mjs';

const R = { at: Date.now(), conn: 1, ev: 0, active: true, paused: false, duration: 2537000, bytes: 1, path: 'rec/2026-11-03 15-30-50.mov' };

function app(lifeMs) {
  const sends = [];
  const expired = [];
  const consents = new Consents(lifeMs, (v) => expired.push(v));
  const factory = () => {
    const server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
    const expiredReply = () => ({ content: [{ type: 'text', text: TEXT.X5(R) }] });
    server.registerTool('stop', { inputSchema: z.object({}) }, async (_a, ctx) => asking(ctx, async (a) => {
      if (!canAsk(server, ctx)) return { content: [{ type: 'text', text: TEXT.X1 }] };
      if (a.action === 'none') return consents.ask(TEXT.W3(R), R);
      if (a.action !== 'accept') {
        consents.drop(a.id);
        return { content: [{ type: 'text', text: TEXT.X4(R) }] };
      }
      const reading = consents.use(a.id);
      if (!reading) return { content: [{ type: 'text', text: TEXT.X17(R) }] };
      sends.push('StopRecord');
      return { content: [{ type: 'text', text: 'stopped' }] };
    }, expiredReply));
    server.registerTool('start', { inputSchema: z.object({}) }, async (_a, ctx) => ({ content: [{ type: 'text', text: canAsk(server, ctx) ? 'can ask' : TEXT.X2 }] }));
    return server;
  };
  return { factory, sends, expired };
}

for (const era of ['legacy', 'modern']) {
  describe(`T7 unit 5 on the ${era} era`, () => {
    test('accept: the prompt shows reading A, and one send follows', async () => {
      const a = app(5000);
      const p = await pair(a.factory, { era, elicit: accept });
      assert.equal((await p.call('stop')).text, 'stopped');
      assert.deepEqual(p.prompts, [TEXT.W3(R)]);
      assert.deepEqual(a.sends, ['StopRecord']);
      await p.close();
    });
    test('decline: X4, and nothing is sent', async () => {
      const a = app(5000);
      const p = await pair(a.factory, { era, elicit: decline });
      assert.equal((await p.call('stop')).text, 'You declined. I did not stop the recording. It still records (00:42:17).');
      assert.deepEqual(a.sends, []);
      await p.close();
    });
    test('a client with no elicitation: X1 for a stop and X2 for a start, and no prompt', async () => {
      const a = app(5000);
      const p = await pair(a.factory, { era });
      assert.equal((await p.call('stop')).text, TEXT.X1);
      assert.equal((await p.call('start')).text, TEXT.X2);
      assert.deepEqual([p.prompts, a.sends], [[], []]);
      await p.close();
    });
    test('a late answer, after the life of the id, stops nothing', async () => {
      const a = app(200);
      const p = await pair(a.factory, { era, elicit: after(400, accept) });
      const r = await p.call('stop');
      if (era === 'modern') assert.match(r.text, /^That confirm expired after 2 minutes, so I did not stop the recording\./);
      // On the 2025 era the server ends its own prompt at the end of the id's life, and the reply is X5 (F-T7-49).
      else assert.deepEqual([r.text, r.isError], [TEXT.X5(R), false]);
      assert.deepEqual(a.sends, []);
      assert.equal(a.expired.length, 1, 'the expiry is reported once, for the notice channel');
      await p.close();
    });
  });
}

test('T7 unit 5, F6: a reused consent id (the same answer sent twice) stops nothing the second time: X17', async () => {
  const a = app(5000);
  const p = await pair(a.factory, { era: 'modern', elicit: accept, manual: true });
  const first = (await p.client.callTool({ name: 'stop', arguments: {} }, { allowInputRequired: true }));
  assert.equal(first.resultType, 'input_required');
  assert.match(first.requestState, /^[0-9a-f]{32}$/, 'only a random 128-bit id rides in requestState');
  const again = { inputResponses: { confirm: { action: 'accept', content: {} } }, requestState: first.requestState };
  const one = await p.call('stop', {}, again);
  const two = await p.call('stop', {}, again);
  assert.deepEqual([one.text, two.text.slice(0, 41)], ['stopped', 'That confirm expired after 2 minutes, so ']);
  // A forged id stops nothing either.
  assert.match((await p.call('stop', {}, { ...again, requestState: 'f'.repeat(32) })).text, /^That confirm expired/);
  assert.deepEqual(a.sends, ['StopRecord']);
  await p.close();
});
