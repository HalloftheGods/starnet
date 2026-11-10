/* node test/channels.discord.test.js — the Discord channel binding (P3.2).
   Mirrors channels.telegram.test.js: the pure normalize() truth table; send() returns a normalized SendResult
   (ok / 4xx not-retryable / 429 retryable+retryAfter / network never-throws); and an end-to-end connect() that
   drains an INJECTED gateway through the real transport+normalize+generic adapter to onInbound. The live
   WebSocket gateway is injected (a fake here), so this is deterministic and touches no real network. */
'use strict';
const A = require('./_assert.js');
const { makeDiscordAdapter, normalize, parseChannelIds, applyChannelAdmission, MAX_MESSAGE_LENGTH } = require('../sidecar/channels/discord.js');
const { makeDiscordTransport } = require('../sidecar/channels/discord.transport.js');

const tick = () => new Promise(r => setTimeout(r, 0));

// a fake fetch: route() decides the response per url; records calls.
function fakeFetch(route) {
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, opts }); return route(url, opts); };
  f.calls = calls;
  return f;
}
function resp(status, body, headers) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; }, headers: { get: k => (headers || {})[k] } };
}

(async () => {
  A.eq(MAX_MESSAGE_LENGTH, 2000, 'Discord per-message cap is 2000');

  // ---- A. normalize() truth table (pure) ----
  {
    const dm = normalize({ id: '900', channel_id: '111', content: 'hi', author: { id: '5', username: 'andro', global_name: 'Andro' } });
    A.eq(dm, { offset: '900', message: { chatId: '111', chatType: 'dm', userId: '5', userName: 'Andro', text: 'hi', messageId: '900' } }, 'a DM -> normalized message (global_name preferred)');
    const guild = normalize({ id: '901', channel_id: '222', guild_id: '7', content: 'yo', author: { id: '6', username: 'bob' } });
    A.eq(guild.message.chatType, 'group', 'a guild message -> group');
    A.eq(guild.message.userName, 'bob', 'falls back to username when no global_name');
    A.eq(normalize({ id: '902', channel_id: '111', content: 'beep', author: { id: '9', username: 'botto', bot: true } }), { offset: '902', message: null }, 'a bot/self message -> message:null (advance, deliver nothing)');
    A.eq(normalize({ id: '903', channel_id: '111', author: { id: '5' } }), { offset: '903', message: null }, 'a non-text payload -> message:null');
    A.eq(normalize({ channel_id: '111', content: 'x' }), null, 'no id -> null (skipped)');
  }

  // ---- B. send(): ok / 4xx / 429 / network ----
  {
    const okF = fakeFetch(() => resp(200, { id: '42' }));
    const t1 = makeDiscordTransport({ fetch: okF, token: 'T' });
    A.eq(await t1.send('111', 'hello'), { ok: true, messageId: '42' }, 'a 200 -> ok with messageId');
    A.ok(okF.calls[0].url.indexOf('/channels/111/messages') !== -1, 'POSTs to the channel messages endpoint');
    A.ok(JSON.parse(okF.calls[0].opts.body).content === 'hello', 'sends the content');

    const t2 = makeDiscordTransport({ fetch: fakeFetch(() => resp(403, { message: 'Missing Access' })), token: 'T' });
    const r403 = await t2.send('111', 'x');
    A.eq(r403.ok, false, '403 -> not ok'); A.eq(r403.retryable, false, '403 is not retryable (bad token/permission)');

    const t3 = makeDiscordTransport({ fetch: fakeFetch(() => resp(429, {}, { 'retry-after': '2' })), token: 'T' });
    const r429 = await t3.send('111', 'x');
    A.eq(r429.retryable, true, '429 -> retryable'); A.eq(r429.retryAfter, 2, '429 carries retry-after');

    const t4 = makeDiscordTransport({ fetch: async () => { throw new Error('socket hang up'); }, token: 'T' });
    const rNet = await t4.send('111', 'x');
    A.eq(rNet.ok, false, 'a network error never throws -> SendResult'); A.eq(rNet.retryable, true, 'a network blip is retryable');
  }

  // ---- C. end-to-end: an injected gateway feeds a DM -> onInbound via the real pipeline ----
  {
    const inbox = [];
    // the fake gateway pushes one DM synchronously when the transport opens it (real WS would push post-identify).
    const connectGateway = ({ onMessage }) => {
      onMessage({ id: '950', channel_id: '777', content: 'ping', author: { id: '1', username: 'a' } });
      return { close() {} };
    };
    const okF = fakeFetch(() => resp(200, { id: '1' }));
    const transport = makeDiscordTransport({ fetch: okF, token: 'T', connectGateway, parkMs: 1, sleep: () => Promise.resolve() });
    // dropPending OFF so the first poll IS the delivery (the gateway doesn't replay history anyway).
    const a = makeDiscordAdapter({ transport, onInbound: m => inbox.push(m), clock: { now: () => 1234 }, dropPendingOnConnect: false });
    await a.connect();
    for (let i = 0; i < 20 && !inbox.length; i++) await tick();
    A.eq(inbox.length, 1, 'end-to-end: one inbound delivered');
    A.eq(inbox[0], { channel: 'discord', chatId: '777', chatType: 'dm', userId: '1', userName: 'a', text: 'ping', messageId: '950', ts: 1234 }, 'normalized InboundMessage via the real transport+normalize+adapter');
    await a.disconnect();
  }

  // ---- D. DM ownership: first Discord DM claims owner; preset owner survives restart/refuses strangers ----
  {
    const inbox = [], claims = [];
    const connectGateway = ({ onMessage }) => {
      onMessage({ id: '960', channel_id: 'a', content: 'first', author: { id: 'owner', username: 'o' } });
      onMessage({ id: '961', channel_id: 'b', content: 'takeover', author: { id: 'stranger', username: 's' } });
      onMessage({ id: '962', channel_id: 'a', content: 'again', author: { id: 'owner', username: 'o' } });
      return { close() {} };
    };
    const transport = makeDiscordTransport({ fetch: fakeFetch(() => resp(200, { id: '1' })), token: 'T', connectGateway, parkMs: 1, sleep: () => Promise.resolve() });
    const a = makeDiscordAdapter({
      transport, onInbound: m => inbox.push(m), onOwnerClaim: u => claims.push(u),
      clock: { now: () => 1 }, dropPendingOnConnect: false
    });
    await a.connect();
    for (let i = 0; i < 20 && inbox.length < 2; i++) await tick();
    A.eq(inbox.map(m => m.text), ['first', 'again'], 'first Discord DM claims owner; a different user is dropped');
    A.eq(claims, ['owner'], 'Discord owner claim callback fires once with the first userId');
    A.eq(a._internals.owner, 'owner', 'Discord adapter records the claimed owner');
    await a.disconnect();
  }
  {
    const inbox = [], claims = [];
    const connectGateway = ({ onMessage }) => {
      onMessage({ id: '970', channel_id: 'x', content: 'reclaim', author: { id: 'stranger', username: 's' } });
      onMessage({ id: '971', channel_id: 'y', content: 'owner-ok', author: { id: 'owner', username: 'o' } });
      return { close() {} };
    };
    const transport = makeDiscordTransport({ fetch: fakeFetch(() => resp(200, { id: '1' })), token: 'T', connectGateway, parkMs: 1, sleep: () => Promise.resolve() });
    const a = makeDiscordAdapter({
      transport, ownerUserId: 'owner', onInbound: m => inbox.push(m), onOwnerClaim: u => claims.push(u),
      clock: { now: () => 1 }, dropPendingOnConnect: false
    });
    await a.connect();
    for (let i = 0; i < 20 && inbox.length < 1; i++) await tick();
    A.eq(inbox.map(m => m.text), ['owner-ok'], 'preset Discord owner survives restart; first stranger DM cannot reclaim');
    A.eq(claims, [], 'preset owner does not emit a new claim');
    await a.disconnect();
  }

  // ---- E. pre-admitted channels: the adapter's allow-list read (what hub.chatAdmitted gives) opens ONLY listed server channels ----
  {
    const ID1 = '1430342161744003132';
    const recs = new Map([[ID1, { admittedOn: 'discord', channel: 'discord', chatId: ID1 }]]);
    const inbox = [];
    const connectGateway = ({ onMessage }) => {
      onMessage({ id: '980', channel_id: ID1, guild_id: 'G', content: 'in listed', author: { id: 'owner', username: 'o' } });
      onMessage({ id: '981', channel_id: '1430342161744009999', guild_id: 'G', content: 'in unlisted', author: { id: 'owner', username: 'o' } });
      return { close() {} };
    };
    const transport = makeDiscordTransport({ fetch: fakeFetch(() => resp(200, { id: '1' })), token: 'T', connectGateway, parkMs: 1, sleep: () => Promise.resolve() });
    const a = makeDiscordAdapter({
      transport, ownerUserId: 'owner', onInbound: m => inbox.push(m), clock: { now: () => 1 }, dropPendingOnConnect: false,
      allowedChats: (c) => { const r = recs.get(String(c)); return !!(r && r.admittedOn === 'discord'); }
    });
    await a.connect();
    for (let i = 0; i < 30 && !inbox.length; i++) await tick();
    A.eq(inbox.map(m => m.text), ['in listed'], 'a message in a pre-admitted channel is delivered; an unlisted server channel stays closed');
    await a.disconnect();
  }

  A.report('channels.discord.test');
})().catch(e => { console.error(e); process.exit(1); });

// ---- server-channel messages: leading bot mention stripped, mentions recorded ----
(function serverChannelMentions() {
  const bot = { id: '999', username: 'StarNet', bot: true };
  const r = normalize({ id: '1', channel_id: 'C1', guild_id: 'G1', author: { id: 'u1', username: 'cmdr' }, content: '<@999> /allow', mentions: [bot] });
  A.eq(r.message.text, '/allow', 'leading bot mention is stripped so /allow parses in a server channel');
  A.eq(r.message.chatType, 'group', 'a guild message is a group');
  A.ok(r.message.mentions.indexOf('starnet') !== -1, 'bot mention recorded for the mention gate');
  const r2 = normalize({ id: '2', channel_id: 'C1', guild_id: 'G1', author: { id: 'u1' }, content: '<@!999>  hello', mentions: [bot] });
  A.eq(r2.message.text, 'hello', 'nickname-form mention stripped too');
  const r3 = normalize({ id: '3', channel_id: 'C1', guild_id: 'G1', author: { id: 'u1' }, content: '<@555> hi', mentions: [{ id: '555', bot: false }] });
  A.eq(r3.message.text, '<@555> hi', 'a human mention is left alone');
  const r4 = normalize({ id: '4', channel_id: 'C1', guild_id: 'G1', author: { id: 'u1' }, content: '<@999>', mentions: [bot] });
  A.eq(r4.message, null, 'a bare mention with no text delivers nothing');
})();

// ---- configured server channels (CHANNEL IDS): parsing + pre-admission ----
(function channelIdConfig() {
  const ID1 = '1430342161744003132', ID2 = '1430342161744003133';
  A.eq(parseChannelIds(' ' + ID1 + ' ,' + ID2 + ' '), { ids: [ID1, ID2], rejected: [] }, 'ids are trimmed and split on commas');
  A.eq(parseChannelIds(ID1 + ',' + ID1 + ',' + ID2 + ',' + ID1), { ids: [ID1, ID2], rejected: [] }, 'duplicates are dropped, first order kept');
  A.eq(parseChannelIds(ID1 + ' ' + ID2).ids, [ID1, ID2], 'whitespace also separates');
  const bad = parseChannelIds(ID1 + ',general,#chat,12ab,<#' + ID2 + '>,123');
  A.eq(bad.ids, [ID1], 'only numeric snowflakes are kept');
  A.eq(bad.rejected, ['general', '#chat', '12ab', '<#' + ID2 + '>', '123'], 'non-numeric / too-short entries are reported, not silently kept');
  A.eq(parseChannelIds(''), { ids: [], rejected: [] }, 'empty -> none');
  A.eq(parseChannelIds(null), { ids: [], rejected: [] }, 'null -> none');
  A.eq(parseChannelIds([' ' + ID1, ID1, 'x']), { ids: [ID1], rejected: ['x'] }, 'an array is parsed the same way');

  const recs = new Map();
  const store = {
    getChatRecord: (c) => recs.get(String(c)),
    saveChatRecord: (c, patch) => { const m = Object.assign({}, recs.get(String(c)), patch); recs.set(String(c), m); return m; }
  };
  const r1 = applyChannelAdmission(store, [ID1, ID2], []);
  A.eq(r1.admitted, [ID1, ID2], 'every configured channel is admitted');
  A.eq([recs.get(ID1).admittedOn, recs.get(ID1).channel, recs.get(ID1).chatId], ['discord', 'discord', ID1], 'the record carries admittedOn + channel + chatId (admitted, and a known channel.send target)');
  recs.set('555', { admittedOn: 'discord', channel: 'discord', chatId: '555' });   // a channel the owner opened with /allow
  recs.set('666', { admittedOn: 'telegram', channel: 'telegram', chatId: '666' });
  const r2 = applyChannelAdmission(store, [ID1], [ID1, ID2, '555', '666']);
  A.eq(r2.revoked.sort(), ['555', ID2].sort(), 'a channel dropped from the config is withdrawn');
  A.eq(recs.get(ID2).admittedOn, '', 'withdrawn record is closed');
  A.eq(recs.get('666').admittedOn, 'telegram', 'another platform\'s admission is never touched');
  A.eq(applyChannelAdmission(null, [ID1], []), { admitted: [], revoked: [] }, 'no store -> no-op, no throw');

})();
