/* node test/channels.discord-media.test.js — Discord transport sendMedia: multipart upload, SendResult shapes. */
'use strict';
const A = require('./_assert.js');
const { makeDiscordTransport } = require('../sidecar/channels/discord.transport.js');

function resp(status, body, headers) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; }, headers: { get: k => (headers || {})[k] } };
}

(async () => {
  // success: multipart body, bot auth, no hand-set Content-Type, caption in payload_json
  {
    const calls = [];
    const t = makeDiscordTransport({ token: 'tok', fetch: async (url, opts) => { calls.push({ url, opts }); return resp(200, { id: '777' }); } });
    const r = await t.sendMedia('123', { buffer: Buffer.from([1, 2, 3, 4]), filename: 'a.png', mime: 'image/png', caption: 'hello' });
    A.eq(r, { ok: true, messageId: '777' }, 'upload ok -> messageId');
    A.eq(calls[0].url, 'https://discord.com/api/v10/channels/123/messages', 'posts to the channel messages endpoint');
    A.eq(calls[0].opts.headers, { Authorization: 'Bot tok' }, 'bot auth only, no Content-Type');
    const form = calls[0].opts.body;
    A.ok(form instanceof FormData, 'body is FormData');
    A.eq(JSON.parse(form.get('payload_json')).content, 'hello', 'caption rides payload_json');
    const file = form.get('files[0]');
    A.eq(file.name, 'a.png', 'filename kept');
    A.eq(file.size, 4, 'all bytes attached');
    A.eq(file.type, 'image/png', 'mime kept');
  }
  // empty buffer
  {
    const t = makeDiscordTransport({ token: 't', fetch: async () => resp(200, {}) });
    const r = await t.sendMedia('1', { buffer: Buffer.alloc(0) });
    A.eq(r.ok, false, 'no bytes -> not ok');
    A.eq(r.retryable, false, 'no bytes -> not retryable');
  }
  // too large
  {
    const t = makeDiscordTransport({ token: 't', fetch: async () => resp(200, {}) });
    const r = await t.sendMedia('1', { buffer: Buffer.alloc(26 * 1024 * 1024) });
    A.eq(r.ok, false, 'over 25MB refused');
    A.ok(/too large/.test(r.error), 'says too large');
  }
  // 403 not retryable, 429 retryable, 401 auth, network never throws
  {
    const mk = r => makeDiscordTransport({ token: 't', fetch: async () => r });
    const buf = Buffer.from([1]);
    const r403 = await mk(resp(403, {})).sendMedia('1', { buffer: buf });
    A.eq([r403.ok, r403.retryable], [false, false], '403 not retryable');
    const r429 = await mk(resp(429, {}, { 'retry-after': '2' })).sendMedia('1', { buffer: buf });
    A.eq([r429.retryable, r429.retryAfter], [true, 2], '429 retryable with retryAfter');
    const r401 = await mk(resp(401, {})).sendMedia('1', { buffer: buf });
    A.eq(r401.auth, true, '401 flags auth');
    const rn = await makeDiscordTransport({ token: 't', fetch: async () => { throw new Error('boom'); } }).sendMedia('1', { buffer: buf });
    A.eq([rn.ok, rn.retryable], [false, true], 'network error -> retryable, never throws');
  }
  A.report('channels.discord-media.test');
})().catch(e => { console.error(e); process.exit(1); });
