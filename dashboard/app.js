/**
 * wa-bridge · painel. HTML+CSS+JS vanilla, sem build e sem CDN, SVG à mão.
 *
 * Modo mock: abra com ?mock=1 (dados completos), ?mock=empty, ?mock=error, ?mock=pairing
 * ou ?mock=close para exercitar cada estado sem o daemon. Identidade da instância no mock:
 * &label=Trabalho&color=%23F7B00D.
 *
 * Segurança: texto de mensagem é de terceiros. Tudo que vem do daemon entra na página
 * só por textContent (nunca innerHTML).
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'wa-bridge-token';
  // Servido pelo próprio daemon, o painel fala com a origem que o serviu: com mais de uma
  // instância (uma porta por número), cada painel enxerga só o seu daemon.
  var DEFAULT_BASE = /^https?:$/.test(location.protocol) ? location.origin : 'http://127.0.0.1:7788';
  // O daemon tira este agente das métricas: sem isso, o polling do painel era quase todo o "uso".
  var AGENT = 'dashboard';
  var REFRESH_MS = 10000;
  var QR_LIFETIME_MS = 20000;
  var FEED_MAX = 6;

  var qs = new URLSearchParams(location.search);
  var MOCK = qs.has('mock') ? (qs.get('mock') || '1') : null;

  var WINDOW_TEXT = {
    3600000: { range: 'última hora', bucket: 'a cada 5 min', vs: 'vs hora anterior' },
    86400000: { range: 'últimas 24h', bucket: 'por hora', vs: 'vs 24h anteriores' },
    604800000: { range: 'últimos 7 dias', bucket: 'por dia', vs: 'vs semana anterior' },
    2592000000: { range: 'últimos 30 dias', bucket: 'por dia', vs: 'vs 30 dias anteriores' }
  };

  var state = {
    windowMs: 86400000,
    paused: false,
    offline: false,
    inFlight: false,
    lastUpdated: null,
    nextRefreshAt: 0,
    callsLimit: 8,
    auditLimit: 8,
    expandedCalls: {},
    data: {},
    feed: [],
    lastQr: null,
    qrSeenAt: 0,
    eventsCtl: null,
    eventsRetry: null,
    mockFeed: null
  };

  // ---------------------------------------------------------------- utils

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function icon(id, cls) {
    var s = svgEl('svg', { class: 'ic' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' });
    s.appendChild(svgEl('use', { href: '#' + id }));
    return s;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function fmtInt(n) { return Number(n || 0).toLocaleString('pt-BR'); }

  function fmtMs(ms) {
    if (ms == null || isNaN(ms)) return '—';
    if (ms < 1000) return Math.round(ms) + 'ms';
    return (ms / 1000).toFixed(1).replace('.', ',') + 's';
  }

  function fmtBytes(b) {
    if (!b) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
    var v = b / Math.pow(1024, i);
    return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1).replace('.', ',')) + ' ' + units[i];
  }

  function pct(part, total) {
    if (!total) return '0%';
    var v = part / total * 100;
    return (v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1).replace('.', ',')) + '%';
  }

  function relTime(ts) {
    if (!ts) return '—';
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 10) return 'agora';
    if (s < 60) return 'há ' + s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return 'há ' + m + ' min';
    var h = Math.floor(m / 60);
    if (h < 24) return 'há ' + h + 'h';
    var d = Math.floor(h / 24);
    return 'há ' + d + (d === 1 ? ' dia' : ' dias');
  }

  function fmtClock(ts) {
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtDayTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function fmtUptime(since) {
    var m = Math.max(0, Math.floor((Date.now() - since) / 60000));
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    if (h < 48) return h + 'h' + String(m % 60).padStart(2, '0');
    return Math.floor(h / 24) + ' dias';
  }

  function mmss(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  /**
   * Mascara um JID como o daemon faz (`maskNumber`): DDI, DDD e os 4 últimos dígitos.
   * LID é identificador opaco e nunca vira telefone.
   */
  function maskPhone(jid) {
    if (!jid) return '';
    var parts = jid.split('@');
    var local = (parts[0] || '').split(':')[0];
    var domain = parts[1] || '';
    if (domain === 'g.us') return 'grupo';
    if (domain === 'broadcast' || domain === 'newsletter') return domain;
    if (domain !== 's.whatsapp.net' && domain !== 'c.us') return 'sem número';
    var digits = local.replace(/\D/g, '');
    if (digits.length <= 4) return '****' + digits;
    var area = digits.length >= 10 ? digits.slice(2, 4) : '';
    return ('+' + digits.slice(0, 2) + ' ' + area + ' ****-' + digits.slice(-4)).replace(/\s+/g, ' ');
  }

  function isGroup(jid) { return /@g\.us$/.test(jid || ''); }

  function chatLabel(jid, name) { return name || maskPhone(jid) || '—'; }

  function initials(name) {
    var clean = String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
    var parts = clean.split(/\s+/).filter(Boolean);
    if (!parts.length) return '#';
    return parts.slice(0, 2).map(function (p) { return p.charAt(0); }).join('').toUpperCase();
  }

  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 3200);
  }

  function copyText(text, okMsg) {
    var done = function () { toast(okMsg); };
    if (navigator.clipboard && window.isSecureContext !== false) {
      navigator.clipboard.writeText(text).then(done, function () { toast('Copie à mão: ' + text); });
    } else {
      toast('Copie à mão: ' + text);
    }
  }

  function setEmpty(panelId, isEmpty) {
    var p = $(panelId);
    if (p) p.classList.toggle('is-empty', !!isEmpty);
  }

  // ------------------------------------------------------------------ auth

  function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* storage indisponível */ } }
  function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignora */ } }

  function showAuthScreen(message) {
    stopEvents();
    $('auth-screen').classList.remove('hidden');
    $('app').classList.add('hidden');
    var err = $('auth-error');
    err.textContent = message || '';
    err.classList.toggle('hidden', !message);
    $('token-input').value = '';
    $('token-input').focus();
  }

  function showApp() {
    $('auth-screen').classList.add('hidden');
    $('app').classList.remove('hidden');
  }

  // ----------------------------------------------------------------- fetch

  /** Chama a API do daemon com o token. Erro HTTP vira exceção com `code` e `http`. */
  function apiFetch(path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET';
    if (MOCK) return window.WA_MOCK.fetch(path, method, opts.body, MOCK, state);
    var headers = { Authorization: 'Bearer ' + getToken(), 'X-WA-Agent': AGENT };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(DEFAULT_BASE + path, {
      method: method,
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      if (res.status === 401) {
        clearToken();
        var e = new Error('UNAUTHORIZED');
        e.code = 'UNAUTHORIZED';
        throw e;
      }
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
          err.code = (data && data.error && data.error.code) || 'HTTP_ERROR';
          err.http = true;
          throw err;
        }
        return data;
      });
    });
  }

  // ------------------------------------------------------------ identidade

  /*
   * Cada daemon serve um número só. A identidade (nome, cor, caminho do token) vem de
   * /health, que não pede token: assim até a tela de login diz de qual número ela é.
   */
  var identityLoaded = false;

  function loadIdentity() {
    var req = MOCK
      ? window.WA_MOCK.fetch('/health', 'GET', undefined, MOCK, state)
      : fetch(DEFAULT_BASE + '/health').then(function (res) { return res.ok ? res.json() : null; });
    return req.then(function (health) {
      if (!health) return;
      applyIdentity(health.account);
      identityLoaded = true;
    }).catch(function () { /* fora do ar: tenta de novo no próximo refresh */ });
  }

  function applyIdentity(account) {
    account = account || {};
    var label = account.label || null;
    var color = account.color || null;
    var root = document.documentElement;
    if (color) {
      root.style.setProperty('--account-color', color);
      root.style.setProperty('--account-ink', contrastText(color));
      root.setAttribute('data-account-color', '');
    } else {
      root.style.removeProperty('--account-color');
      root.style.removeProperty('--account-ink');
      root.removeAttribute('data-account-color');
    }
    ['brand-account', 'auth-account'].forEach(function (id) {
      var node = $(id);
      node.textContent = label || '';
      node.classList.toggle('hidden', !label);
    });
    document.title = label ? label + ' · wa-bridge' : 'wa-bridge · painel';
    if (account.tokenPath) $('auth-token-path').textContent = tildify(account.tokenPath);
    setFavicon(color || '#6fd3ff', label);
  }

  /** Favicon de bolinha na cor da conta com a inicial: distingue as abas lado a lado. */
  function setFavicon(color, label) {
    var initial = label ? label.trim().charAt(0).toUpperCase().replace(/[<>&"]/g, '') : '';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<circle cx="32" cy="32" r="30" fill="' + color + '"/>' +
      (initial
        ? '<text x="32" y="44" font-family="Helvetica,Arial,sans-serif" font-size="34" font-weight="700" ' +
          'text-anchor="middle" fill="' + contrastText(color) + '">' + initial + '</text>'
        : '') + '</svg>';
    $('favicon').href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  /** Texto escuro ou branco sobre a cor, pelo maior contraste (WCAG). */
  function contrastText(hex) {
    var rgb = [1, 3, 5].map(function (i) {
      var c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    var lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return (lum + 0.05) / 0.05 > 1.05 / (lum + 0.05) ? '#06222e' : '#ffffff';
  }

  function tildify(path) {
    return path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
  }

  // ---------------------------------------------------------------- refresh

  function refreshAll() {
    if (state.inFlight) return;
    state.inFlight = true;
    state.nextRefreshAt = Date.now() + REFRESH_MS;
    Promise.all([
      apiFetch('/metrics/summary?window=' + state.windowMs),
      apiFetch('/metrics/calls?limit=' + state.callsLimit),
      apiFetch('/metrics/audit?limit=' + state.auditLimit),
      apiFetch('/session'),
      apiFetch('/gate'),
      apiFetch('/status')
    ]).then(function (r) {
      setOffline(false);
      state.data = {
        summary: r[0] || {},
        calls: (r[1] && r[1].calls) || [],
        audit: (r[2] && r[2].events) || [],
        session: r[3] || {},
        gate: r[4] || { drafts: [], sends: [] },
        status: r[5] || {}
      };
      if (!identityLoaded) loadIdentity();
      renderAll();
      state.lastUpdated = Date.now();
      startEvents();
    }).catch(function (err) {
      if (err && err.code === 'UNAUTHORIZED') {
        showAuthScreen('Token inválido ou expirado. Cole o token atual.');
        return;
      }
      if (err && err.http) {
        toast('O daemon respondeu com erro: ' + err.message);
        return;
      }
      setOffline(true, err);
    }).then(function () {
      state.inFlight = false;
      tick();
    });
  }

  function setOffline(off, err) {
    state.offline = off;
    if (off) {
      $('banner-text').textContent = 'Sem resposta em ' + DEFAULT_BASE.replace(/^https?:\/\//, '') +
        (state.lastUpdated ? '. Mostrando os dados de ' + fmtClock(state.lastUpdated) + '.' : '.');
      $('state-name').textContent = 'Daemon fora do ar';
      $('hero').style.setProperty('--state-color', 'var(--err)');
      stopEvents();
    }
    updateBodyState();
  }

  function updateBodyState() {
    var session = state.data.session || {};
    document.body.dataset.state = state.offline ? 'offline' : (session.state === 'pairing' ? 'pairing' : 'normal');
  }

  function renderAll() {
    var d = state.data;
    updateBodyState();
    renderHero(d.session, d.gate, d.summary);
    renderPairing(d.session, d.status);
    renderDrafts(d.gate);
    renderSends(d.gate);
    renderFeed();
    renderKpis(d.summary);
    renderChart(d.summary, d.gate);
    renderAgents(d.summary);
    renderTools(d.summary);
    renderAudit(d.audit);
    renderCalls(d.calls);
    renderHealth(d.status);
    var st = d.status || {};
    $('footer-version').textContent = st.version ? 'v' + st.version + ' · schema ' + st.schemaVersion : '';
  }

  // ------------------------------------------------------------------ sessão

  var SESSION = {
    open: ['Conectado', 'var(--ok)'],
    pairing: ['Aguardando pareamento', 'var(--warn)'],
    connecting: ['Conectando', 'var(--warn)'],
    close: ['Desconectado', 'var(--err)']
  };

  function renderHero(session, gate, summary) {
    session = session || {};
    gate = gate || { drafts: [], sends: [] };
    var def = SESSION[session.state] || ['Sem dados', 'var(--text-3)'];
    $('state-name').textContent = def[0];
    $('hero').style.setProperty('--state-color', def[1]);

    var who = $('who');
    clear(who);
    if (session.me) {
      if (session.me.name) who.appendChild(document.createTextNode(session.me.name + ' · '));
      who.appendChild(el('span', 'num', maskPhone(session.me.jid)));
    }
    $('since').textContent = session.since
      ? 'desde ' + fmtDayTime(session.since) + (session.state === 'open' ? ' · ' + fmtUptime(session.since) + ' no ar' : '')
      : '';
    var errBox = $('session-error');
    var showErr = session.lastError && session.state !== 'open';
    errBox.textContent = showErr ? session.lastError : '';
    errBox.classList.toggle('hidden', !showErr);

    var max = gate.sendsPerHour || 10;
    var used = gate.sendsLastHour || 0;
    $('sent-hour').textContent = String(used);
    $('sent-limit').textContent = ' / ' + max;
    var slots = $('slots');
    clear(slots);
    var n = Math.min(max, 30);
    slots.style.setProperty('--slots', n);
    for (var i = 0; i < n; i++) slots.appendChild(el('i', i < used ? 'on' : ''));
    slots.classList.toggle('near', used >= Math.ceil(max * 0.8) && used < max);
    slots.classList.toggle('full', used >= max);
    $('sent-hint').textContent = used >= max
      ? 'limite atingido: novos envios esperam a janela andar'
      : (max - used) + ' livres · janela móvel de 1h';

    var quiet = gate.quietHours || { active: false, window: '' };
    var q = $('quiet');
    q.textContent = quiet.active ? 'ativo' : 'inativo';
    q.classList.toggle('on', !!quiet.active);
    $('quiet-hint').textContent = (quiet.window ? quiet.window.replace('-', ' às ') + ' · ' : '') + 'nessa janela o envio exige urgent';

    $('pending-count').textContent = String((gate.drafts || []).length);
    var blocked = (summary && summary.totals && summary.totals.blocked) || 0;
    var sends = (gate.sends || []).length;
    $('gate-hint').textContent = sends + (sends === 1 ? ' envio' : ' envios') + ' em andamento · ' +
      blocked + (blocked === 1 ? ' bloqueio' : ' bloqueios') + ' na janela';
  }

  function renderPairing(session, status) {
    session = session || {};
    var qr = session.qrDataUrl || null;
    if (qr && qr !== state.lastQr) {
      state.lastQr = qr;
      state.qrSeenAt = Date.now();
      $('qr-image').src = qr;
    }
    var days = status && typeof status.historyDays === 'number' ? status.historyDays : 7;
    $('history-days').textContent = days > 0 ? days + (days === 1 ? ' dia' : ' dias') : 'nenhum dia (histórico desligado)';
  }

  // ------------------------------------------------------------------- gate

  var WARNING_LABEL = {
    NEVER_CONTACTED: ['nunca contatado', 'warn'],
    QUIET_HOURS: ['horário de silêncio', 'warn'],
    GROUP_CHAT: ['grupo', ''],
    LARGE_TEXT: ['texto longo', '']
  };

  function renderDrafts(gate) {
    var drafts = (gate && gate.drafts) || [];
    var box = $('drafts');
    clear(box);
    setEmpty('panel-drafts', drafts.length === 0);
    var ttl = (gate && gate.draftTtlMs) || 300000;
    drafts.forEach(function (d) {
      var it = el('div', 'item');
      var top = el('div', 'item-top');
      top.appendChild(el('span', 'name', d.name || d.maskedNumber));
      if (d.name) top.appendChild(el('span', 'num', d.maskedNumber));
      top.appendChild(el('span', 'end', d.agent || 'agente'));
      it.appendChild(top);
      (d.bubbles || []).forEach(function (b) { it.appendChild(el('div', 'bubble', b)); });
      var chips = el('div', 'chips');
      if (d.action === 'edit') chips.appendChild(el('span', 'chip', 'edita mensagem enviada'));
      if (d.action === 'delete') chips.appendChild(el('span', 'chip warn', 'apaga para todos'));
      if (d.mediaPath) {
        var mc = el('span', 'chip');
        mc.appendChild(icon('i-file'));
        mc.appendChild(document.createTextNode(d.mediaPath.split('/').pop()));
        chips.appendChild(mc);
      }
      (d.warnings || []).forEach(function (w) {
        var def = WARNING_LABEL[w] || [w, ''];
        chips.appendChild(el('span', 'chip ' + def[1], def[0]));
      });
      if (d.mentions) chips.appendChild(el('span', 'chip', 'menciona ' + d.mentions + (d.mentions === 1 ? ' pessoa' : ' pessoas')));
      if (chips.childNodes.length) it.appendChild(chips);

      var foot = el('div', 'item-foot');
      var bar = el('div', 'bar');
      var fill = el('i');
      bar.appendChild(fill);
      foot.appendChild(bar);
      var left = el('span', 'mono muted-note');
      foot.appendChild(left);
      var discard = el('button', 'btn sm danger', 'Descartar');
      discard.addEventListener('click', function () {
        discard.disabled = true;
        apiFetch('/gate/drafts/' + encodeURIComponent(d.id) + '/discard', { method: 'POST' }).then(function () {
          toast('Rascunho descartado. Se o agente tentar confirmar, recebe DRAFT_NOT_FOUND.');
          refreshAll();
        }, function (err) {
          discard.disabled = false;
          toast(err.code === 'DRAFT_NOT_FOUND' ? 'Esse rascunho já tinha expirado ou sido usado.' : 'Não deu para descartar: ' + err.message);
          refreshAll();
        });
      });
      foot.appendChild(discard);
      it.appendChild(foot);
      it.dataset.expires = String(d.expiresAt);
      it.dataset.ttl = String(ttl);
      box.appendChild(it);
    });
    if (drafts.length) box.appendChild(el('p', 'muted-note', 'Aprovar continua sendo no agente; aqui você só descarta.'));
    updateCountdowns();
  }

  function updateCountdowns() {
    var now = Date.now();
    Array.prototype.forEach.call($('drafts').querySelectorAll('.item'), function (it) {
      var left = Number(it.dataset.expires) - now;
      var ttl = Number(it.dataset.ttl) || 300000;
      var bar = it.querySelector('.bar');
      bar.firstChild.style.width = Math.max(0, Math.min(100, left / ttl * 100)) + '%';
      bar.classList.toggle('warn', left < 60000);
      it.querySelector('.item-foot .mono').textContent = left > 0 ? 'expira em ' + mmss(left) : 'expirado';
    });
  }

  var STAGE_LABEL = { queued: 'na fila', reading: 'lendo a conversa', typing: 'digitando', sending: 'enviando' };

  function renderSends(gate) {
    var sends = (gate && gate.sends) || [];
    var box = $('sends');
    clear(box);
    setEmpty('panel-sends', sends.length === 0);
    sends.forEach(function (s) {
      var it = el('div', 'item');
      var top = el('div', 'item-top');
      top.appendChild(el('span', 'name', chatLabel(s.chatJid, s.name)));
      top.appendChild(el('span', 'end', s.agent || 'agente'));
      it.appendChild(top);
      var foot = el('div', 'item-foot');
      var dots = el('div', 'dots');
      var total = Math.max(1, s.bubblesTotal || 1);
      for (var i = 0; i < total; i++) {
        var cls = i < s.bubblesSent ? 'sent' : (i === s.bubblesSent && s.stage !== 'queued' ? 'typing' : '');
        dots.appendChild(el('i', cls));
      }
      foot.appendChild(dots);
      foot.appendChild(el('span', 'muted-note', s.bubblesSent + ' de ' + total + (total === 1 ? ' bolha' : ' bolhas') + ' · ' + (STAGE_LABEL[s.stage] || s.stage)));
      var cancel = el('button', 'btn sm danger', 'Cancelar');
      cancel.addEventListener('click', function () {
        cancel.disabled = true;
        apiFetch('/send/cancel', { method: 'POST', body: { sendId: s.sendId } }).then(function (res) {
          toast(res && res.cancelled ? 'Cancelado antes da próxima bolha.' : 'Esse envio já tinha terminado.');
          refreshAll();
        }, function (err) {
          cancel.disabled = false;
          toast('Não deu para cancelar: ' + err.message);
        });
      });
      foot.appendChild(cancel);
      it.appendChild(foot);
      box.appendChild(it);
    });
  }

  // --------------------------------------------------------------- ao vivo

  /*
   * O stream /events é Server-Sent Events, mas o EventSource do navegador não manda
   * header de autorização. Por isso lemos o stream com fetch, que manda o token.
   */
  function startEvents() {
    if (state.paused || state.eventsCtl || state.offline) return;
    if (MOCK) {
      if (!state.mockFeed && MOCK !== 'empty') {
        state.mockFeed = window.WA_MOCK.startFeed(function (p) { addFeedItem(p.message, p.chatName, true); });
      }
      return;
    }
    var ctl = new AbortController();
    state.eventsCtl = ctl;
    fetch(DEFAULT_BASE + '/events', {
      headers: { Authorization: 'Bearer ' + getToken(), 'X-WA-Agent': AGENT, Accept: 'text/event-stream' },
      signal: ctl.signal
    }).then(function (res) {
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      $('live-sub').textContent = 'mensagens chegando';
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) throw new Error('stream encerrado');
          buf += decoder.decode(r.value, { stream: true });
          var frames = buf.split('\n\n');
          buf = frames.pop();
          frames.forEach(handleFrame);
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      if (ctl.signal.aborted) return;
      state.eventsCtl = null;
      $('live-sub').textContent = 'reconectando ao stream...';
      clearTimeout(state.eventsRetry);
      state.eventsRetry = setTimeout(startEvents, 5000);
    });
  }

  function stopEvents() {
    if (state.eventsCtl) state.eventsCtl.abort();
    state.eventsCtl = null;
    clearTimeout(state.eventsRetry);
    if (state.mockFeed) { clearInterval(state.mockFeed); state.mockFeed = null; }
  }

  function handleFrame(frame) {
    var type = 'message';
    var data = '';
    frame.split('\n').forEach(function (line) {
      if (line.indexOf('event: ') === 0) type = line.slice(7).trim();
      else if (line.indexOf('data: ') === 0) data += line.slice(6);
    });
    if (type !== 'message' || !data) return;
    try {
      var payload = JSON.parse(data);
      addFeedItem(payload.message, payload.chatName, true);
    } catch (e) { /* frame malformado: ignora */ }
  }

  function addFeedItem(message, chatName, fresh) {
    if (!message) return;
    state.feed.unshift({ message: message, chatName: chatName, fresh: fresh });
    if (state.feed.length > FEED_MAX) state.feed.length = FEED_MAX;
    renderFeed();
  }

  var MEDIA_PREVIEW = {
    audio: ['i-mic', 'áudio'],
    image: ['i-image', 'imagem'],
    video: ['i-media', 'vídeo'],
    document: ['i-file', 'documento'],
    sticker: ['i-image', 'figurinha']
  };

  function renderFeed() {
    var ul = $('feed');
    clear(ul);
    setEmpty('panel-live', state.feed.length === 0);
    state.feed.forEach(function (item) {
      var m = item.message;
      var title = chatLabel(m.chatJid, item.chatName);
      var li = el('li', item.fresh ? 'enter' : '');
      item.fresh = false;
      li.appendChild(el('span', 'avatar', initials(title)));
      var meta = el('div', 'meta');
      var l1 = el('div', 'line1');
      l1.appendChild(el('span', 'chat', title));
      if (isGroup(m.chatJid) && m.senderName) l1.appendChild(el('span', 'sender', m.senderName));
      meta.appendChild(l1);
      var pv = el('div', 'preview');
      var media = MEDIA_PREVIEW[m.type];
      if (media) pv.appendChild(icon(media[0]));
      var text = media ? (m.caption || media[1]) : (m.text || '[' + m.type + ']');
      pv.appendChild(el('span', '', text));
      meta.appendChild(pv);
      li.appendChild(meta);
      var t = el('time', '', relTime(m.ts));
      t.dataset.ts = String(m.ts);
      li.appendChild(t);
      ul.appendChild(li);
    });
  }

  // -------------------------------------------------------------------- kpis

  function sparkline(series, alarm) {
    var w = 120, h = 28;
    var s = svgEl('svg', { class: 'spark', viewBox: '0 0 ' + w + ' ' + h, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    // Série sem nenhum valor não desenha nada: uma linha reta no chão parece dado.
    if (!series || series.length < 2 || !series.some(function (v) { return v > 0; })) return s;
    var max = Math.max.apply(null, series.concat([1]));
    var pts = series.map(function (v, i) {
      return (i / (series.length - 1) * w).toFixed(1) + ',' + (h - 2 - v / max * (h - 4)).toFixed(1);
    });
    s.appendChild(svgEl('polygon', { class: 'area', points: '0,' + h + ' ' + pts.join(' ') + ' ' + w + ',' + h }));
    s.appendChild(svgEl('polyline', { points: pts.join(' ') }));
    return s;
  }

  function delta(cur, prev) {
    var vs = (WINDOW_TEXT[state.windowMs] || {}).vs || '';
    if (!cur && !prev) return null;
    if (!prev) return { text: '+' + fmtInt(cur) + ' ' + vs, dir: 'up' };
    var p = Math.round((cur - prev) / prev * 100);
    return { text: (p > 0 ? '+' : '') + p + '% ' + vs, dir: p > 0 ? 'up' : (p < 0 ? 'down' : '') };
  }

  function renderKpis(summary) {
    summary = summary || {};
    var t = summary.totals || {};
    var p = summary.previousTotals || {};
    var tl = summary.timeline || [];
    var series = function (k) { return tl.map(function (b) { return b[k] || 0; }); };
    var defs = [
      { label: 'Chamadas dos agentes', value: t.calls, series: series('calls'), delta: delta(t.calls || 0, p.calls || 0) },
      t.errors
        ? { label: 'Erros', value: t.errors, series: series('errors'), alarm: true, note: pct(t.errors, t.calls) + ' das chamadas' }
        : { label: 'Erros', value: 0, series: [], calm: 'nenhum erro' },
      { label: 'Envios', value: t.sends, series: series('sends'), delta: delta(t.sends || 0, p.sends || 0) },
      t.blocked
        ? { label: 'Bloqueios', value: t.blocked, series: [], note: 'o gate barrou envio para destino bloqueado' }
        : { label: 'Bloqueios', value: 0, series: [], calm: 'nenhum' },
      { label: 'Mídias processadas', value: t.mediaProcessed, series: [], note: fmtInt(t.messagesRead) + ' leituras de conversa' }
    ];
    var box = $('kpis');
    clear(box);
    defs.forEach(function (k) {
      var c = el('div', 'card kpi' + (k.alarm ? ' alarm' : ''));
      c.appendChild(el('span', 'micro', k.label));
      c.appendChild(el('span', 'value', fmtInt(k.value)));
      c.appendChild(sparkline(k.series, k.alarm));
      var f = el('div', 'foot');
      if (k.calm) {
        var calm = el('span', 'calm');
        calm.appendChild(icon('i-check'));
        calm.appendChild(document.createTextNode(k.calm));
        f.appendChild(calm);
      }
      if (k.delta) f.appendChild(el('span', 'delta ' + k.delta.dir, k.delta.text));
      if (k.note) f.appendChild(el('span', '', k.note));
      c.appendChild(f);
      box.appendChild(c);
    });
  }

  // ---------------------------------------------------------------- gráfico

  function bucketLabel(ts) {
    var d = new Date(ts);
    if (state.windowMs <= 3600000) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (state.windowMs <= 86400000) return String(d.getHours()).padStart(2, '0') + 'h';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  function renderChart(summary, gate) {
    var tl = (summary && summary.timeline) || [];
    var box = $('chart');
    clear(box);
    var text = WINDOW_TEXT[state.windowMs] || WINDOW_TEXT[86400000];
    $('chart-sub').textContent = text.range + ', ' + text.bucket;
    var active = tl.some(function (b) { return b.calls || b.sends; });
    setEmpty('panel-chart', !active);
    if (!active) return;

    var hourly = state.windowMs === 86400000;
    var limit = (gate && gate.sendsPerHour) || 10;
    $('legend-limit').classList.toggle('hidden', !hourly);

    var W = 1000, top = 10, h1 = 150, gap = 28, h2 = 60, axisH = 22;
    var H = top + h1 + gap + h2 + axisH;
    var s = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Chamadas e envios ' + text.bucket + ' em ' + text.range });
    var maxC = Math.max.apply(null, tl.map(function (b) { return b.calls; }).concat([1]));
    var step = maxC <= 10 ? 5 : maxC <= 50 ? 10 : maxC <= 200 ? 50 : Math.pow(10, Math.floor(Math.log10(maxC)));
    var ceilC = Math.ceil(maxC / step) * step;
    var maxS = Math.max.apply(null, tl.map(function (b) { return b.sends; }).concat([hourly ? limit : 1]));

    [0, 0.5, 1].forEach(function (f) {
      var y = top + h1 - f * h1;
      s.appendChild(svgEl('line', { class: 'gridline', x1: 40, x2: W, y1: y, y2: y }));
      var lbl = svgEl('text', { class: 'axis', x: 0, y: y + 4 });
      lbl.textContent = String(Math.round(ceilC * f));
      s.appendChild(lbl);
    });
    var y2base = top + h1 + gap + h2;
    s.appendChild(svgEl('line', { class: 'gridline', x1: 40, x2: W, y1: y2base, y2: y2base }));
    var zero = svgEl('text', { class: 'axis', x: 0, y: y2base + 4 });
    zero.textContent = '0';
    s.appendChild(zero);
    var lbl2 = svgEl('text', { class: 'axis', x: 44, y: top + h1 + 18 });
    lbl2.textContent = 'ENVIOS';
    s.appendChild(lbl2);
    if (hourly) {
      var limY = y2base - limit / maxS * h2;
      s.appendChild(svgEl('line', { class: 'limit', x1: 40, x2: W, y1: limY, y2: limY }));
      var limLbl = svgEl('text', { class: 'axis', x: 0, y: limY + 4 });
      limLbl.textContent = String(limit);
      s.appendChild(limLbl);
    }

    var colW = (W - 44) / tl.length;
    var every = Math.max(1, Math.ceil(tl.length / 9));
    var tip = el('div', 'tip');
    tl.forEach(function (b, i) {
      var x = 44 + i * colW;
      var g = svgEl('g', { class: 'col' });
      g.appendChild(svgEl('rect', { class: 'hot', x: x, y: top, width: colW, height: H - top - axisH }));
      var bw = Math.max(2, colW * 0.56);
      var bx = x + (colW - bw) / 2;
      var errH = (b.errors || 0) / ceilC * h1;
      var okH = Math.max(0, b.calls - (b.errors || 0)) / ceilC * h1;
      if (b.calls) {
        g.appendChild(svgEl('rect', { class: 'b-ok', x: bx, y: top + h1 - okH - errH, width: bw, height: Math.max(okH, b.errors ? 0 : 1), rx: 2 }));
        if (b.errors) g.appendChild(svgEl('rect', { class: 'b-err', x: bx, y: top + h1 - errH - okH, width: bw, height: Math.max(errH, 3), rx: 2 }));
      }
      if (b.sends) {
        var sh = b.sends / maxS * h2;
        g.appendChild(svgEl('rect', { class: 'b-send', x: bx, y: y2base - sh, width: bw, height: sh, rx: 2 }));
      }
      if (i % every === 0) {
        var lt = svgEl('text', { class: 'axis', x: x + colW / 2, y: H - 4, 'text-anchor': 'middle' });
        lt.textContent = bucketLabel(b.bucketTs);
        s.appendChild(lt);
      }
      g.addEventListener('mousemove', function (ev) {
        clear(tip);
        tip.appendChild(el('div', 'micro', bucketLabel(b.bucketTs)));
        [['chamadas', fmtInt(b.calls)], ['com erro', fmtInt(b.errors || 0)], ['envios', fmtInt(b.sends) + (hourly ? ' de ' + limit : '')]].forEach(function (r) {
          var row = el('div', 'row');
          row.appendChild(el('span', '', r[0]));
          row.appendChild(el('b', '', r[1]));
          tip.appendChild(row);
        });
        var rect = box.getBoundingClientRect();
        var left = ev.clientX - rect.left + 14;
        if (left > rect.width - 170) left = ev.clientX - rect.left - 170;
        tip.style.left = left + 'px';
        tip.style.top = (ev.clientY - rect.top - 10) + 'px';
        tip.classList.add('on');
      });
      g.addEventListener('mouseleave', function () { tip.classList.remove('on'); });
      s.appendChild(g);
    });
    box.appendChild(s);
    box.appendChild(tip);
  }

  // ------------------------------------------------------- agentes e tools

  function renderAgents(summary) {
    var agents = ((summary && summary.byAgent) || []).filter(function (a) { return a.agent !== AGENT; });
    var box = $('agents');
    clear(box);
    setEmpty('panel-agents', agents.length === 0);
    var max = Math.max.apply(null, agents.map(function (a) { return a.calls; }).concat([1]));
    agents.forEach(function (a) {
      var row = el('div', 'agent');
      var nm = el('div', 'nm');
      var recent = a.lastCallAt && Date.now() - a.lastCallAt < 10 * 60000;
      nm.appendChild(el('span', 'st' + (recent ? ' active' : '')));
      nm.appendChild(el('span', '', a.agent));
      if (a.lastCallAt) nm.appendChild(el('span', 'seen', 'visto ' + relTime(a.lastCallAt)));
      row.appendChild(nm);
      var st = el('div', 'stats');
      [['calls', fmtInt(a.calls)], ['erros', pct(a.errors, a.calls)], ['envios', fmtInt(a.sends)], ['p95', fmtMs(a.p95Ms)]].forEach(function (pair) {
        var sp = el('span', '', pair[0] + ' ');
        sp.appendChild(el('b', '', pair[1]));
        st.appendChild(sp);
      });
      row.appendChild(st);
      var bar = el('div', 'bar');
      var f = el('i');
      f.style.width = (a.calls / max * 100) + '%';
      bar.appendChild(f);
      row.appendChild(bar);
      box.appendChild(row);
    });
  }

  function renderTools(summary) {
    var tools = (summary && summary.byTool) || [];
    var tb = document.querySelector('#tools tbody');
    clear(tb);
    setEmpty('panel-tools', tools.length === 0);
    var max = Math.max.apply(null, tools.map(function (t) { return t.calls; }).concat([1]));
    tools.forEach(function (t) {
      var tr = el('tr');
      tr.appendChild(el('td', 'mono', t.tool));
      var td = el('td');
      var sh = el('div', 'share');
      var bar = el('div', 'bar');
      var f = el('i');
      f.style.width = (t.calls / max * 100) + '%';
      bar.appendChild(f);
      sh.appendChild(bar);
      td.appendChild(sh);
      tr.appendChild(td);
      tr.appendChild(el('td', 'r num', fmtInt(t.calls)));
      tr.appendChild(el('td', 'r num' + (t.errors ? ' err-num' : ''), fmtInt(t.errors)));
      tr.appendChild(el('td', 'r num', fmtMs(t.p95Ms)));
      tb.appendChild(tr);
    });
  }

  // -------------------------------------------------------------- auditoria

  var AUDIT = {
    'draft.created': ['i-draft', '', 'rascunho criado'],
    'draft.expired': ['i-draft', '', 'rascunho expirou'],
    'send.confirmed': ['i-send', 'info', 'envio confirmado'],
    'send.completed': ['i-check', 'ok', 'envio concluído'],
    'send.cancelled': ['i-x', 'err', 'envio cancelado'],
    'send.failed': ['i-x', 'err', 'envio falhou'],
    'send.blocked': ['i-ban', 'block', 'envio bloqueado'],
    'message.edited': ['i-draft', 'info', 'mensagem editada'],
    'message.deleted': ['i-x', 'info', 'mensagem apagada para todos'],
    'media.materialized': ['i-media', 'info', 'mídia processada'],
    'session.paired': ['i-link', 'ok', 'sessão pareada'],
    'session.lost': ['i-unlink', 'err', 'sessão perdida'],
    'alias.set': ['i-tag', '', 'apelido definido']
  };

  function renderAudit(events) {
    var ul = $('audit');
    clear(ul);
    setEmpty('panel-audit', !events.length);
    events.forEach(function (ev) {
      var def = AUDIT[ev.action] || ['i-info', '', ev.action];
      var label = def[2];
      if (ev.action === 'send.cancelled' && ev.detail && ev.detail.stage === 'draft') label = 'rascunho descartado';
      var cls = ev.outcome === 'error' && def[1] !== 'block' ? 'err' : def[1];
      var li = el('li');
      var ico = el('span', 'ico ' + cls);
      ico.appendChild(icon(def[0]));
      li.appendChild(ico);
      var mid = el('div');
      mid.style.minWidth = '0';
      mid.appendChild(el('div', 't1', label + (ev.outcome && ev.outcome !== 'ok' ? ' · ' + (ev.outcome === 'denied' ? 'negado' : 'erro') : '')));
      var bits = [];
      if (ev.chatJid) bits.push(maskPhone(ev.chatJid));
      if (ev.detail && typeof ev.detail === 'object') {
        var note = ev.detail.reason || ev.detail.note || ev.detail.message || ev.detail.alias;
        if (note) bits.push(String(note));
      }
      mid.appendChild(el('div', 't2', bits.join(' · ') || '—'));
      li.appendChild(mid);
      var when = el('div', 'when');
      when.appendChild(el('div', '', ev.agent || '—'));
      when.appendChild(el('div', '', relTime(ev.ts)));
      li.appendChild(when);
      ul.appendChild(li);
    });
  }

  // ------------------------------------------------------- chamadas recentes

  var STATUS_LABEL = { ok: 'ok', error: 'erro', denied: 'negado' };

  function renderCalls(calls) {
    var tb = document.querySelector('#calls tbody');
    clear(tb);
    setEmpty('panel-calls', !calls.length);
    calls.forEach(function (c) {
      var hasDetail = !!c.error;
      var tr = el('tr', hasDetail ? 'expandable' : '');
      tr.appendChild(el('td', 'num', fmtClock(c.ts)));
      tr.appendChild(el('td', '', c.agent));
      tr.appendChild(el('td', 'mono', c.tool));
      tr.appendChild(el('td', 'r num', fmtMs(c.durationMs)));
      var st = el('td');
      var pill = el('span', 'pill ' + c.status);
      if (c.status === 'ok') pill.appendChild(icon('i-check'));
      pill.appendChild(document.createTextNode(STATUS_LABEL[c.status] || c.status));
      st.appendChild(pill);
      if (hasDetail) st.appendChild(icon('i-chev', 'chev'));
      tr.appendChild(st);
      tb.appendChild(tr);
      if (!hasDetail) return;

      var key = c.traceId + c.ts;
      var det = el('tr', 'detail');
      det.hidden = !state.expandedCalls[key];
      tr.tabIndex = 0;
      tr.setAttribute('aria-expanded', String(!det.hidden));
      var td = el('td');
      td.colSpan = 5;
      var grid = el('div', 'detail-grid');
      grid.appendChild(el('span', 'micro', 'erro'));
      var msg = el('span', 'mono', c.error);
      msg.style.gridColumn = 'span 2';
      grid.appendChild(msg);
      grid.appendChild(el('span', 'micro', 'traceId'));
      grid.appendChild(el('span', 'mono', c.traceId));
      var cp = el('button', 'btn sm');
      cp.appendChild(icon('i-copy'));
      cp.appendChild(document.createTextNode('copiar busca no log'));
      cp.addEventListener('click', function (ev) {
        ev.stopPropagation();
        copyText("jq 'select(.traceId == \"" + c.traceId + "\")' ~/.wa-bridge/logs/daemon.log", 'Comando copiado: cole no terminal.');
      });
      grid.appendChild(cp);
      td.appendChild(grid);
      det.appendChild(td);
      tb.appendChild(det);
      var toggle = function () {
        det.hidden = !det.hidden;
        state.expandedCalls[key] = !det.hidden;
        tr.setAttribute('aria-expanded', String(!det.hidden));
      };
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
      });
    });
  }

  // ------------------------------------------------------------------ saúde

  function renderHealth(st) {
    var box = $('health');
    clear(box);
    if (!st || !st.version) return;
    var r = st.retention || {};
    var days = function (n) { return n ? n + 'd' : 'nunca'; };
    var last = r.last;
    var lastText = last
      ? relTime(last.at) + ' · ' + fmtInt(last.result.mediaFiles) + ' arquivos, ' + fmtInt(last.result.messages) + ' mensagens'
      : 'ainda não rodou';
    var q = st.mediaQueue || { running: 0, queued: 0, max: 0 };
    var items = [
      ['Versão', 'v' + st.version + ' · desde ' + fmtDayTime(st.startedAt), 'ok'],
      ['Banco', 'schema ' + st.schemaVersion + ' · ' + fmtBytes(st.dbBytes), 'ok'],
      ['Mídia em disco', fmtBytes(st.media && st.media.bytes) + ' · ' + fmtInt(st.media && st.media.files) + ' arquivos', 'ok'],
      ['Serviço', st.service || 'script (./wa-bridge start)', st.service ? 'ok' : 'off'],
      ['Node', st.node + ' · pid ' + st.pid, 'ok'],
      ['Retenção', 'mensagens ' + days(r.messagesDays) + ' · mídia ' + days(r.mediaDays) + ' · métricas ' + days(r.metricsDays), 'ok'],
      ['Última limpeza', lastText, last ? 'ok' : 'off'],
      ['Histórico', st.historyDays ? st.historyDays + ' dias no pareamento' : 'desligado', st.historyDays ? 'ok' : 'off'],
      ['Fila de mídia', q.running + ' rodando · ' + q.queued + ' na fila (teto ' + q.max + ')', q.queued ? 'warn' : 'ok'],
      ['Streams /events', st.eventStreams + (st.eventStreams === 1 ? ' conectado' : ' conectados'), 'ok'],
      ['Transcrição', st.whisperModel && st.whisperModel.present ? st.whisperModel.name : 'modelo ausente', st.whisperModel && st.whisperModel.present ? 'ok' : 'warn'],
      ['Permissões', 'pasta de estado ' + (st.stateDirMode || '?') + (st.stateDirMode === '700' ? '' : ' (esperado 700)'), st.stateDirMode === '700' ? 'ok' : 'warn']
    ];
    items.forEach(function (it) {
      var d = el('div');
      d.appendChild(el('span', 'micro', it[0]));
      var v = el('span', 'v');
      v.appendChild(el('span', 'dot' + (it[2] === 'ok' ? '' : ' ' + it[2])));
      v.appendChild(document.createTextNode(it[1]));
      d.appendChild(v);
      box.appendChild(d);
    });
  }

  // ------------------------------------------------------------------ busca

  var search = { seq: 0, timer: null, selected: 0 };

  function openPalette() {
    var p = $('palette');
    p.classList.add('open');
    p.setAttribute('aria-hidden', 'false');
    $('q').focus();
    $('q').select();
    runSearch();
  }

  function closePalette() {
    var p = $('palette');
    p.classList.remove('open');
    p.setAttribute('aria-hidden', 'true');
    $('open-search').focus();
  }

  function infoResult(text) {
    var ul = $('results');
    clear(ul);
    ul.appendChild(el('li', 'info', text));
  }

  function runSearch() {
    var q = $('q').value.trim();
    clearTimeout(search.timer);
    if (q.length < 2) { infoResult('Digite pelo menos 2 letras. Ex.: pix, reuniao, deslog*'); return; }
    search.timer = setTimeout(function () {
      var seq = ++search.seq;
      apiFetch('/search?q=' + encodeURIComponent(q) + '&limit=20').then(function (res) {
        if (seq !== search.seq) return;
        renderResults((res && res.hits) || []);
      }, function (err) {
        if (seq !== search.seq) return;
        infoResult(err && err.http ? 'A busca falhou: ' + err.message : 'Daemon fora do ar.');
      });
    }, 180);
  }

  /** Converte o trecho do FTS ("... «termo» ...") em texto com <mark>, sem innerHTML. */
  function snippetNode(snippet) {
    var frag = document.createDocumentFragment();
    String(snippet || '').split(/«|»/).forEach(function (part, i) {
      if (!part) return;
      frag.appendChild(i % 2 ? el('mark', '', part) : document.createTextNode(part));
    });
    return frag;
  }

  function renderResults(hits) {
    var ul = $('results');
    clear(ul);
    search.selected = 0;
    if (!hits.length) { infoResult('Nada encontrado. A busca só enxerga áudio que já foi transcrito.'); return; }
    hits.forEach(function (h, i) {
      var m = h.message || {};
      var li = el('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === 0));
      var r1 = el('div', 'r1');
      r1.appendChild(el('span', 'chat', chatLabel(m.chatJid, h.chatName)));
      var sender = m.fromMe ? 'você' : (isGroup(m.chatJid) ? m.senderName : '');
      if (sender) r1.appendChild(el('span', 'sender', sender));
      r1.appendChild(el('span', 'chip' + (h.source === 'transcript' ? ' ok' : ''), h.source === 'transcript' ? 'transcrição' : 'texto'));
      r1.appendChild(el('time', '', fmtDayTime(m.ts)));
      li.appendChild(r1);
      var sn = el('div', 'snip');
      sn.appendChild(snippetNode(h.snippet));
      li.appendChild(sn);
      ul.appendChild(li);
    });
  }

  function moveSelection(dir) {
    var items = $('results').querySelectorAll('[role=option]');
    if (!items.length) return;
    items[search.selected].setAttribute('aria-selected', 'false');
    search.selected = (search.selected + dir + items.length) % items.length;
    items[search.selected].setAttribute('aria-selected', 'true');
    items[search.selected].scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------------ tick

  function tick() {
    var label;
    if (state.paused) label = 'pausado';
    else if (state.offline) label = 'sem conexão';
    else if (!state.lastUpdated) label = 'conectando';
    else {
      var s = Math.floor((Date.now() - state.lastUpdated) / 1000);
      label = s < 3 ? 'ao vivo · agora' : 'ao vivo · há ' + s + 's';
    }
    $('updated').textContent = label;
    $('live').dataset.paused = String(state.paused);
    $('retry').textContent = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000)) + 's';
    updateCountdowns();
    Array.prototype.forEach.call(document.querySelectorAll('#feed time'), function (t) {
      t.textContent = relTime(Number(t.dataset.ts));
    });
    if (state.qrSeenAt) {
      var left = 1 - (Date.now() - state.qrSeenAt) / QR_LIFETIME_MS;
      $('qr-bar').style.width = Math.max(0, left * 100) + '%';
    }
  }

  var refreshTimer = null;
  function scheduleRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(function () { if (!state.paused) refreshAll(); }, REFRESH_MS);
  }

  // ------------------------------------------------------------------- init

  function bindEvents() {
    $('token-submit').addEventListener('click', submitToken);
    $('token-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitToken(); });
    $('change-token').addEventListener('click', function () { showAuthScreen(null); });

    $('pause').addEventListener('click', function () {
      state.paused = !state.paused;
      this.setAttribute('aria-pressed', String(state.paused));
      this.setAttribute('aria-label', state.paused ? 'Retomar atualização' : 'Pausar atualização');
      this.querySelector('use').setAttribute('href', state.paused ? '#i-play' : '#i-pause');
      if (state.paused) stopEvents(); else refreshAll();
      tick();
    });

    $('window-seg').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      Array.prototype.forEach.call(this.children, function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      state.windowMs = parseInt(b.getAttribute('data-window'), 10);
      refreshAll();
    });

    $('retry-now').addEventListener('click', refreshAll);

    $('calls-more').addEventListener('click', function () {
      var more = state.callsLimit === 8;
      state.callsLimit = more ? 100 : 8;
      this.textContent = more ? 'mostrar menos' : 'ver as 100';
      this.setAttribute('aria-expanded', String(more));
      refreshAll();
    });
    $('audit-more').addEventListener('click', function () {
      var more = state.auditLimit === 8;
      state.auditLimit = more ? 50 : 8;
      this.textContent = more ? 'mostrar menos' : 'ver mais';
      this.setAttribute('aria-expanded', String(more));
      refreshAll();
    });

    var repair = $('confirm-repair');
    $('repair').addEventListener('click', function () { repair.showModal(); });
    $('repair-cancel').addEventListener('click', function () { repair.close(); });
    $('repair-ok').addEventListener('click', function () {
      repair.close();
      apiFetch('/session/pair', { method: 'POST' }).then(function () {
        toast('Aparelho desvinculado. O QR aparece aqui em instantes.');
        setTimeout(refreshAll, 1500);
      }, function (err) { toast('Não deu para parear de novo: ' + err.message); });
    });

    var logs = $('logs-dialog');
    $('show-logs').addEventListener('click', function () { logs.showModal(); });
    $('logs-close').addEventListener('click', function () { logs.close(); });
    $('logs-copy').addEventListener('click', function () { copyText('./wa-bridge logs', 'Comando copiado.'); });

    $('open-search').addEventListener('click', openPalette);
    $('q').addEventListener('input', runSearch);
    $('palette').addEventListener('click', function (ev) { if (ev.target === $('palette')) closePalette(); });
    document.addEventListener('keydown', function (ev) {
      var open = $('palette').classList.contains('open');
      var typing = /^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '');
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); if ($('app').classList.contains('hidden')) return; openPalette(); return; }
      if (ev.key === '/' && !open && !typing && !$('app').classList.contains('hidden')) { ev.preventDefault(); openPalette(); return; }
      if (!open) return;
      if (ev.key === 'Escape') { ev.preventDefault(); closePalette(); }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSelection(1); }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); moveSelection(-1); }
    });
  }

  function submitToken() {
    var v = $('token-input').value.trim();
    if (!v) {
      $('auth-error').textContent = 'Cole o token antes de continuar.';
      $('auth-error').classList.remove('hidden');
      return;
    }
    setToken(v);
    showApp();
    refreshAll();
  }

  function init() {
    bindEvents();
    if (MOCK) $('mock-badge').classList.remove('hidden');
    loadIdentity();

    // `./wa-bridge open` abre o painel com `#token=...`: o fragmento nunca vai ao servidor,
    // e sai da barra de endereço logo depois de guardado, para não ficar à vista.
    var hashToken = /(?:^#|&)token=([^&]+)/.exec(location.hash);
    if (hashToken) {
      setToken(decodeURIComponent(hashToken[1]));
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignora */ }
    }

    if (MOCK || getToken()) {
      showApp();
      refreshAll();
    } else {
      showAuthScreen(null);
    }
    scheduleRefresh();
    setInterval(tick, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
