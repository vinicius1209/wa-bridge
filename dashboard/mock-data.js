/**
 * Dados de exemplo do modo mock do painel (?mock=1, ?mock=empty, ?mock=error,
 * ?mock=pairing, ?mock=close). Só entra em cena com o parâmetro na URL, e nada aqui é
 * dado real: nomes e números são fictícios.
 */
(function () {
  'use strict';

  var NOW = Date.now();
  var MIN = 60000;
  var HOUR = 3600000;
  var DAY = 86400000;
  var qs = new URLSearchParams(location.search);

  var seed = 7;
  function rnd() {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  }
  function pick(list) { return list[Math.floor(rnd() * list.length)]; }

  /** QR falso, só para exercitar a tela de pareamento (não pareia nada). */
  function fakeQrDataUrl(variant) {
    var size = 29;
    var rects = '';
    var s = 11 + variant;
    function r() { s = (s * 9301 + 49297) % 233280; return s / 233280; }
    function finder(x, y) {
      rects += '<rect x="' + x + '" y="' + y + '" width="7" height="7" fill="#000"/>' +
        '<rect x="' + (x + 1) + '" y="' + (y + 1) + '" width="5" height="5" fill="#fff"/>' +
        '<rect x="' + (x + 2) + '" y="' + (y + 2) + '" width="3" height="3" fill="#000"/>';
    }
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var inFinder = (x < 8 && y < 8) || (x > size - 9 && y < 8) || (x < 8 && y > size - 9);
        if (!inFinder && r() > 0.52) rects += '<rect x="' + x + '" y="' + y + '" width="1" height="1" fill="#000"/>';
      }
    }
    finder(0, 0); finder(size - 7, 0); finder(0, size - 7);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges">' +
      '<rect width="' + size + '" height="' + size + '" fill="#fff"/>' + rects + '</svg>';
    return 'data:image/svg+xml;base64,' + btoa(svg);
  }

  var ME = { jid: '5551999990000@s.whatsapp.net', name: 'Você' };
  var AGENTS = ['claude-code', 'codex', 'opencode'];
  var TOOLS = [
    ['wa_read_messages', 0.30, 320], ['wa_search', 0.16, 45], ['wa_list_chats', 0.14, 90],
    ['wa_media', 0.08, 4800], ['wa_resolve_contact', 0.08, 80], ['wa_send_text', 0.07, 2200],
    ['wa_group_participants', 0.05, 140], ['wa_mark_read', 0.04, 70], ['wa_session_status', 0.04, 9],
    ['wa_react', 0.02, 60], ['wa_usage', 0.02, 40]
  ];
  var CHATS = [
    { jid: '5551988887777@s.whatsapp.net', name: 'Ana' },
    { jid: '5551977776666@s.whatsapp.net', name: 'Rogério Alves' },
    { jid: '5551966665555@s.whatsapp.net', name: 'Paulo Mendes' },
    { jid: '120363000000000001@g.us', name: 'Padel de segunda' },
    { jid: '120363000000000002@g.us', name: 'Libreta · professores' },
    { jid: '5551955554444@s.whatsapp.net', name: 'Mãe' }
  ];

  // ------------------------------------------------------------- métricas

  function bucketMs(windowMs) {
    if (windowMs <= 2 * HOUR) return 5 * MIN;
    if (windowMs <= 2 * DAY) return HOUR;
    return DAY;
  }

  function summaryFor(windowMs, empty) {
    seed = 7;
    var size = bucketMs(windowMs);
    var start = Math.floor((NOW - windowMs) / size) * size;
    var timeline = [];
    var scale = windowMs <= HOUR ? 0.15 : windowMs <= DAY ? 1 : 7;
    for (var ts = start; ts <= NOW; ts += size) {
      var hour = new Date(ts).getHours();
      var awake = windowMs > DAY || (hour >= 8 && hour <= 23);
      var calls = empty || !awake ? 0 : Math.round((20 + rnd() * 70) * scale);
      var errors = calls && rnd() > 0.7 ? Math.max(1, Math.round(calls * 0.03)) : 0;
      var sends = calls && rnd() > 0.35 ? Math.max(1, Math.round((rnd() * 6) * Math.max(scale / 3, 0.3))) : 0;
      timeline.push({ bucketTs: ts, calls: calls, errors: errors, sends: sends });
    }
    var sum = function (k) { return timeline.reduce(function (a, b) { return a + b[k]; }, 0); };
    var totals = {
      calls: sum('calls'), errors: sum('errors'), sends: sum('sends'),
      cancels: empty ? 0 : 2, blocked: empty ? 0 : 1, mediaProcessed: empty ? 0 : Math.round(sum('calls') * 0.03),
      messagesRead: empty ? 0 : Math.round(sum('calls') * 0.3)
    };
    var previousTotals = {
      calls: Math.round(totals.calls * 0.88), errors: totals.errors + 2, sends: totals.sends + 3,
      cancels: 1, blocked: 0, mediaProcessed: totals.mediaProcessed, messagesRead: totals.messagesRead
    };
    var shares = [0.62, 0.31, 0.07];
    var seen = [NOW - 40 * 1000, NOW - 3 * HOUR, NOW - 2 * DAY];
    var byAgent = empty ? [] : AGENTS.map(function (agent, i) {
      var calls = Math.round(totals.calls * shares[i]);
      return {
        agent: agent, calls: calls, errors: Math.round(totals.errors * shares[i]),
        sends: Math.round(totals.sends * shares[i]), p50Ms: 60 + i * 40, p95Ms: 320 + i * 500,
        lastCallAt: windowMs < 2 * DAY && i === 2 ? null : seen[i]
      };
    }).filter(function (a) { return a.calls > 0; });
    var byTool = empty ? [] : TOOLS.map(function (t, i) {
      var calls = Math.round(totals.calls * t[1]);
      return { tool: t[0], calls: calls, errors: i === 3 ? Math.round(totals.errors * 0.6) : (i === 5 ? Math.round(totals.errors * 0.4) : 0), p95Ms: t[2] };
    });
    return {
      windowMs: windowMs, generatedAt: NOW, totals: totals, previousTotals: previousTotals,
      byAgent: byAgent, byTool: byTool, timeline: timeline, session: sessions.open
    };
  }

  var calls = [];
  (function () {
    seed = 3;
    var errors = [
      ['error', 'MEDIA_EXPIRED: mídia antiga demais, o WhatsApp já descartou o arquivo', 'wa_media'],
      ['denied', 'rascunho exige acknowledge NEVER_CONTACTED', 'wa_send_text'],
      ['error', 'AMBIGUOUS_CONTACT: "ana" casou com 2 contatos', 'wa_send_text']
    ];
    for (var i = 0; i < 100; i++) {
      var tool = pick(TOOLS);
      var e = i % 9 === 2 ? errors[(i / 9 | 0) % errors.length] : null;
      calls.push({
        ts: NOW - i * 97 * 1000,
        traceId: 'c' + (100000 + i * 7919).toString(16) + '-' + (i * 2654435761 >>> 0).toString(16) + '-4e0e',
        agent: i % 5 === 0 ? 'codex' : 'claude-code',
        tool: e ? e[2] : tool[0],
        durationMs: Math.round(tool[2] * (0.4 + rnd())),
        status: e ? e[0] : 'ok',
        error: e ? e[1] : null
      });
    }
  })();

  var audit = [];
  (function () {
    var defs = [
      ['send.completed', 'ok', CHATS[0].jid, {}],
      ['draft.created', 'ok', CHATS[3].jid, {}],
      ['media.materialized', 'ok', CHATS[1].jid, {}],
      ['send.blocked', 'denied', 'status@broadcast', { reason: 'status@broadcast está na blocklist padrão' }],
      ['send.cancelled', 'ok', CHATS[3].jid, { stage: 'typing' }],
      ['send.cancelled', 'ok', CHATS[0].jid, { stage: 'draft' }],
      ['alias.set', 'ok', CHATS[5].jid, { alias: 'mãe' }],
      ['send.failed', 'error', CHATS[2].jid, { reason: 'timeout aguardando ack do WhatsApp' }],
      ['session.paired', 'ok', null, {}]
    ];
    for (var i = 0; i < 50; i++) {
      var d = defs[i % defs.length];
      audit.push({ ts: NOW - i * 23 * MIN, traceId: 't' + i, agent: i % 4 === 0 ? 'codex' : 'claude-code', action: d[0], chatJid: d[2], outcome: d[1], detail: d[3] });
    }
  })();

  var sessions = {
    open: { state: 'open', me: ME, qrDataUrl: null, since: NOW - (3 * HOUR + 12 * MIN), lastError: null },
    pairing: { state: 'pairing', me: null, qrDataUrl: fakeQrDataUrl(0), since: NOW - 30000, lastError: null },
    connecting: { state: 'connecting', me: null, qrDataUrl: null, since: NOW - 5000, lastError: null },
    close: { state: 'close', me: null, qrDataUrl: null, since: NOW - 20 * MIN, lastError: 'sessão deslogada: é preciso parear de novo' }
  };

  // ------------------------------------------------------------------ gate

  var drafts = [
    {
      id: '7a1c2e9b0d4f3a21', chatJid: CHATS[0].jid, name: 'Ana', maskedNumber: '+55 51 ****-7777',
      bubbles: ['Vou chegar tarde hoje, por volta das 21h.', 'Guarda janta?'], mediaPath: null, warnings: [], mentions: 0,
      agent: 'claude-code', createdAt: NOW - 78000, expiresAt: NOW + 222000
    },
    {
      id: '3f9e8d7c6b5a4021', chatJid: CHATS[3].jid, name: 'Padel de segunda', maskedNumber: 'grupo',
      bubbles: ['@5551977776666 o placar de segunda já está no app, confere?'], mediaPath: null,
      warnings: ['GROUP_CHAT'], mentions: 1, agent: 'codex', createdAt: NOW - 259000, expiresAt: NOW + 41000
    }
  ];
  var sends = [
    { sendId: 'snd_mock_1', chatJid: CHATS[3].jid, name: 'Padel de segunda', stage: 'typing', bubblesTotal: 3, bubblesSent: 1, agent: 'claude-code', startedAt: NOW - 8000 }
  ];

  function gate(empty) {
    var elapsed = Date.now() - NOW;
    var live = sends.map(function (s) {
      var sent = Math.min(s.bubblesTotal - 1, s.bubblesSent + Math.floor(elapsed / 9000));
      return Object.assign({}, s, { bubblesSent: sent });
    });
    return {
      sendsLastHour: empty ? 0 : 3, sendsPerHour: 10, quietHours: { active: false, window: '23:00-07:00' },
      draftTtlMs: 300000,
      drafts: empty ? [] : drafts.filter(function (d) { return d.expiresAt > Date.now(); }),
      sends: empty ? [] : live
    };
  }

  // ---------------------------------------------------------------- status

  function status(empty) {
    return {
      version: '0.1.0', pid: 48861, node: 'v24.18.0', startedAt: NOW - 3 * HOUR, service: 'launchd (local.wa-bridge)',
      schemaVersion: 2, dbBytes: empty ? 98304 : 3456789,
      media: { bytes: empty ? 0 : 134217728, files: empty ? 0 : 412, measuredAt: NOW },
      retention: { messagesDays: 365, mediaDays: 30, metricsDays: 30, last: { at: NOW - 2 * HOUR, result: { messages: 0, mediaFiles: 12, calls: 380, drafts: 4 } } },
      historyDays: 7, mediaQueue: { running: 0, queued: 0, max: 10 }, eventStreams: 1,
      whisperModel: { name: 'ggml-large-v3-turbo.bin', present: true }, stateDirMode: '700'
    };
  }

  // ----------------------------------------------------------------- busca

  var corpus = [
    { chat: CHATS[3], sender: 'Paulo', when: NOW - 40 * MIN, source: 'text', text: 'Fechou, quadra 3 às 19h então, quem leva bola?' },
    { chat: CHATS[1], sender: null, when: NOW - DAY, source: 'transcript', text: 'o pix da inscrição do americano de segunda cai direto na minha chave, depois te mando o print' },
    { chat: CHATS[4], sender: 'Martín', when: NOW - 3 * DAY, source: 'text', text: 'Consegue colocar a aula experimental como pacote? Os alunos pedem toda semana' },
    { chat: CHATS[0], sender: null, when: NOW - 4 * HOUR, source: 'text', text: 'Não esquece de pagar o pix do condomínio hoje' },
    { chat: CHATS[2], sender: null, when: NOW - 2 * DAY, source: 'transcript', text: 'toda vez que eu fecho o app ele desloga, aí tenho que pedir o código de novo' },
    { chat: CHATS[5], sender: null, when: NOW - 5 * HOUR, source: 'text', text: 'Domingo vai ter churrasco aqui, avisa a Ana' }
  ];

  function normalize(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

  function searchHits(q) {
    var terms = normalize(q).split(/\s+/).map(function (t) { return t.replace(/\*$/, ''); }).filter(Boolean);
    return corpus.filter(function (m) {
      var n = normalize(m.text);
      return terms.every(function (t) { return n.indexOf(t) !== -1; });
    }).map(function (m) {
      var n = normalize(m.text);
      var snippet = '';
      var pos = 0;
      terms.map(function (t) { return [n.indexOf(t), t.length]; }).sort(function (a, b) { return a[0] - b[0]; }).forEach(function (hit) {
        if (hit[0] < pos) return;
        snippet += m.text.slice(pos, hit[0]) + '«' + m.text.slice(hit[0], hit[0] + hit[1]) + '»';
        pos = hit[0] + hit[1];
      });
      snippet += m.text.slice(pos);
      return {
        message: { id: 'm' + m.when, chatJid: m.chat.jid, senderName: m.sender, fromMe: false, ts: m.when, type: m.source === 'transcript' ? 'audio' : 'text', text: m.text },
        chatName: m.chat.name, source: m.source, snippet: snippet
      };
    });
  }

  // ------------------------------------------------------------- roteador

  function fetchMock(path, method, body, variant, state) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (variant === 'error' && path.indexOf('/health') !== 0) {
          reject(new TypeError('daemon indisponível (mock)'));
          return;
        }
        var empty = variant === 'empty';
        var sessionVariant = (variant === 'pairing' || variant === 'close' || variant === 'connecting') ? variant : 'open';
        if (path.indexOf('/health') === 0) {
          resolve({ ok: true, version: '0.1.0', session: { state: sessions[sessionVariant].state, since: NOW }, account: { label: qs.get('label'), description: null, color: qs.get('color'), tokenPath: '~/.wa-bridge/token' } });
        } else if (path.indexOf('/metrics/summary') === 0) {
          resolve(summaryFor(state.windowMs, empty));
        } else if (path.indexOf('/metrics/calls') === 0) {
          resolve({ calls: empty ? [] : calls.slice(0, state.callsLimit) });
        } else if (path.indexOf('/metrics/audit') === 0) {
          resolve({ events: empty ? [] : audit.slice(0, state.auditLimit) });
        } else if (path.indexOf('/session/pair') === 0) {
          resolve({ started: true });
        } else if (path.indexOf('/session') === 0) {
          var s = sessions[sessionVariant];
          if (sessionVariant === 'pairing') s.qrDataUrl = fakeQrDataUrl(Math.floor(Date.now() / 20000));
          resolve(s);
        } else if (path.indexOf('/gate/drafts/') === 0 && method === 'POST') {
          var id = decodeURIComponent(path.split('/')[3]);
          var before = drafts.length;
          drafts = drafts.filter(function (d) { return d.id !== id; });
          resolve({ discarded: drafts.length < before });
        } else if (path.indexOf('/gate') === 0) {
          resolve(gate(empty));
        } else if (path.indexOf('/send/cancel') === 0) {
          sends = sends.filter(function (x) { return x.sendId !== (body && body.sendId); });
          resolve({ cancelled: true, stage: 'typing' });
        } else if (path.indexOf('/status') === 0) {
          resolve(status(empty));
        } else if (path.indexOf('/search') === 0) {
          var q = new URLSearchParams(path.split('?')[1] || '').get('q') || '';
          resolve({ hits: empty ? [] : searchHits(q) });
        } else {
          reject(new Error('rota mock desconhecida: ' + path));
        }
      }, 120);
    });
  }

  // ------------------------------------------------------------ feed fake

  var incoming = [
    { chat: CHATS[2], sender: null, type: 'text', text: 'Saiu do app de novo, mesma coisa de ontem' },
    { chat: CHATS[3], sender: 'Allan', type: 'text', text: 'Alguém tem bola sobrando?' },
    { chat: CHATS[1], sender: null, type: 'image', text: '[Imagem] pódio do americano', caption: 'pódio do americano' },
    { chat: CHATS[0], sender: null, type: 'audio', text: '[Áudio enviado]' },
    { chat: CHATS[4], sender: 'Martín', type: 'text', text: 'Amanhã cancelo a turma das 7h, choveu demais' }
  ];
  var nextIncoming = 0;

  function toEvent(m, ts) {
    return {
      chatName: m.chat.name,
      message: { id: 'live' + ts, chatJid: m.chat.jid, senderName: m.sender, fromMe: false, ts: ts, type: m.type, text: m.text, caption: m.caption || null, hasMedia: m.type !== 'text' }
    };
  }

  /** Simula o stream /events: 3 mensagens recentes na hora e uma nova a cada 7s. */
  function startFeed(cb) {
    [3, 2, 1].forEach(function (i) { cb(toEvent(incoming[i], Date.now() - i * 4 * MIN)); });
    return setInterval(function () {
      cb(toEvent(incoming[nextIncoming++ % incoming.length], Date.now()));
    }, 7000);
  }

  window.WA_MOCK = { fetch: fetchMock, startFeed: startFeed };
})();
