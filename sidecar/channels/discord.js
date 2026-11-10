/* sidecar/channels/discord.js — the Discord platform binding for the generic channel adapter (P3.2).

   The analogue of telegram.js: it supplies ONLY the wire translation (normalize) + the limit (2000) and hands the
   rest to the transport-agnostic adapter (owner/DM admission, one-per-chat inflight, resend, SSE status). Inbound
   messages arrive over the gateway (see discord.transport.js); each raw MESSAGE_CREATE payload is mapped here.

   normalize(rawMessage) -> { offset, message } | null
     - null                         : not a real message (no id) — skip, don't advance
     - { offset, message: null }    : a bot/self message or a non-text payload — advance, deliver nothing
     - { offset, message: {...} }   : a real user message, in the adapter's neutral InboundMessage shape */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./adapter.js'), require('./discord.transport.js'));
  } else {
    root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {};
    root.SK.channels.discord = factory(root.SK.channels.adapter, root.SK.channels.discordTransport);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (adapterMod, transportMod) {
  'use strict';
  const { makeChannelAdapter } = adapterMod;
  const { makeDiscordTransport } = transportMod;

  const MAX_MESSAGE_LENGTH = 2000;          // Discord's per-message content cap

  function normalize(m) {
    if (!m || m.id == null) return null;                       // not a message -> skip without advancing
    const offset = String(m.id);
    const author = m.author || {};
    if (author.bot) return { offset, message: null };          // never act on a bot/self message
    if (typeof m.content !== 'string' || !m.content) return { offset, message: null };   // non-text -> deliver nothing
    // In a server channel the text usually starts with "<@botId> ". Strip leading mentions of BOTS so the hub sees
    // "/allow" or the plain request; record bot mentions so the adapter's mention gate can see we were addressed.
    const botMentions = (Array.isArray(m.mentions) ? m.mentions : []).filter(u => u && u.bot);
    const botIds = new Set(botMentions.map(u => String(u.id)));
    let text = m.content;
    if (m.guild_id && botIds.size) {
      let prev;
      do { prev = text; text = text.replace(/^\s*<@!?(\d+)>\s*/, (all, id) => botIds.has(id) ? '' : all); } while (text !== prev);
      if (!text.trim()) return { offset, message: null };
    }
    return {
      offset,
      message: {
        chatId: String(m.channel_id),
        chatType: m.guild_id ? 'group' : 'dm',                 // a DM has no guild
        userId: String(author.id),
        userName: author.global_name || author.username || String(author.id),
        text,
        ...(botMentions.length ? { mentions: botMentions.map(u => String(u.username || '').toLowerCase()).filter(Boolean) } : {}),
        messageId: String(m.id)        // the adapter stamps ts from its injected clock
      }
    };
  }

  /* parseChannelIds(input) -> { ids, rejected }
     The operator-configured server channels (comma/space/newline separated string, or an array). Discord channel ids
     are snowflakes: all digits. Each entry is trimmed, duplicates are dropped (first wins, order kept), and anything
     that is not a 15-25 digit number lands in `rejected` rather than being silently kept. */
  function parseChannelIds(input) {
    const parts = Array.isArray(input) ? input : String(input == null ? '' : input).split(/[\s,;]+/);
    const ids = [], rejected = [], seen = new Set();
    for (const raw of parts) {
      const t = String(raw == null ? '' : raw).trim();
      if (!t) continue;
      if (!/^\d{15,25}$/.test(t)) { rejected.push(t); continue; }
      if (seen.has(t)) continue;
      seen.add(t); ids.push(t);
    }
    return { ids, rejected };
  }

  /* applyChannelAdmission(store, ids, prevIds) -> { admitted, revoked }
     Pre-admits the configured channels exactly as the owner's /allow would: the chat record gets admittedOn:'discord'
     (what hub.chatAdmitted reads) plus channel/chatId, which also makes the channel a known target for channel.send.
     A channel dropped from the config since last time (prevIds) has its admission withdrawn, but only if THIS
     platform granted it. Owner pairing is untouched: admission opens a room, it never makes anyone the owner. */
  function applyChannelAdmission(store, ids, prevIds) {
    const admitted = [], revoked = [];
    if (!store || typeof store.saveChatRecord !== 'function') return { admitted, revoked };
    const want = new Set(ids || []);
    for (const id of ids || []) {
      try { store.saveChatRecord(id, { channel: 'discord', chatId: id, admittedOn: 'discord' }); admitted.push(id); } catch (_) {}
    }
    for (const id of prevIds || []) {
      if (want.has(id)) continue;
      try {
        const r = typeof store.getChatRecord === 'function' ? store.getChatRecord(id) : null;
        if (r && r.admittedOn === 'discord') { store.saveChatRecord(id, { admittedOn: '' }); revoked.push(id); }
      } catch (_) {}
    }
    return { admitted, revoked };
  }

  function makeDiscordAdapter(opts) {
    const o = opts || {};
    const transport = o.transport || makeDiscordTransport({
      fetch: o.fetch, token: o.token, connectGateway: o.connectGateway, apiBase: o.apiBase, sleep: o.sleep
    });
    return makeChannelAdapter({
      transport,
      normalize,
      name: 'discord',
      maxMessageLength: MAX_MESSAGE_LENGTH,
      allowedChats: o.allowedChats,
      ownerUserId: o.ownerUserId,
      onOwnerClaim: o.onOwnerClaim,
      ownerAdmission: o.ownerAdmission,   // one-time pairing code (index.js channelOwnerAdmission)
      onInbound: o.onInbound,
      onCallback: o.onCallback,
      onStatus: o.onStatus,
      onMembership: o.onMembership,   // our own membership changed (blocked/kicked) — the hub stops retrying that chat
      onDelivery: o.onDelivery,       // per-send outcome (delivery health), separate from poll health
      clock: o.clock,
      sleep: o.sleep,
      dropPendingOnConnect: o.dropPendingOnConnect,   // gateway pushes only post-connect, but forward it for parity/tests
      startOffset: o.startOffset
    });
  }

  return { makeDiscordAdapter, normalize, parseChannelIds, applyChannelAdmission, MAX_MESSAGE_LENGTH };
});
