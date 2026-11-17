/**
 * Stream SSE de mensagens novas: formato do evento, filtros por cliente, keep-alive
 * e encerramento no desligamento. Usa um `ServerResponse` falso, sem rede.
 */
import { strict as assert } from 'node:assert';
import type { ServerResponse } from 'node:http';
import { test } from 'node:test';
import { EventHub } from '../src/events/hub.js';
import type { StoredMessage } from '../src/types.js';

/** Resposta HTTP falsa que só acumula o que foi escrito. */
function fakeResponse(): ServerResponse & { chunks: string[] } {
  const res = {
    chunks: [] as string[],
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
    write(chunk: string) {
      this.chunks.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  return res as unknown as ServerResponse & { chunks: string[] };
}

/** Mensagem mínima. */
function msg(id: string, chatJid: string, fromMe = false): StoredMessage {
  return {
    id, chatJid, senderJid: fromMe ? null : chatJid, senderName: 'Ana', fromMe, ts: 1000,
    type: 'text', text: 'oi', caption: null, viewOnce: false, quotedText: null,
    hasMedia: false, mediaState: 'none',
  };
}

/** Eventos `message` já parseados do que foi escrito no stream. */
function messageEvents(res: { chunks: string[] }): Array<{ id: string; data: { message: StoredMessage; chatName: string | null } }> {
  return res.chunks
    .filter((c) => c.includes('event: message'))
    .map((c) => {
      const id = /^id: (.+)$/m.exec(c)?.[1] ?? '';
      const data = JSON.parse(/^data: (.+)$/m.exec(c)?.[1] ?? '{}') as { message: StoredMessage; chatName: string | null };
      return { id, data };
    });
}

test('conexão recebe retry e evento ready com o hello', () => {
  const hub = new EventHub();
  const res = fakeResponse();
  hub.attach(res, { includeFromMe: false, chatJid: null }, { version: '1.2.3' });
  assert.match(res.chunks[0] ?? '', /^retry: 5000\n\nevent: ready\ndata: \{"version":"1.2.3"\}\n\n$/);
  hub.closeAll();
});

test('mensagem nova sai como evento message com id e nome da conversa', () => {
  const hub = new EventHub();
  const res = fakeResponse();
  hub.attach(res, { includeFromMe: false, chatJid: null }, {});
  hub.publishMessage(msg('m1', 'a@s.whatsapp.net'), 'Ana');
  const [event] = messageEvents(res);
  assert.equal(event?.id, 'm1');
  assert.equal(event?.data.message.text, 'oi');
  assert.equal(event?.data.chatName, 'Ana');
  hub.closeAll();
});

test('filtros: própria mensagem só com includeFromMe, e chat restringe a conversa', () => {
  const hub = new EventHub();
  const todos = fakeResponse();
  const soAna = fakeResponse();
  const comProprias = fakeResponse();
  hub.attach(todos, { includeFromMe: false, chatJid: null }, {});
  hub.attach(soAna, { includeFromMe: false, chatJid: 'a@s.whatsapp.net' }, {});
  hub.attach(comProprias, { includeFromMe: true, chatJid: null }, {});

  hub.publishMessage(msg('m1', 'a@s.whatsapp.net'), null);
  hub.publishMessage(msg('m2', 'b@s.whatsapp.net'), null);
  hub.publishMessage(msg('m3', 'a@s.whatsapp.net', true), null);

  assert.deepEqual(messageEvents(todos).map((e) => e.id), ['m1', 'm2']);
  assert.deepEqual(messageEvents(soAna).map((e) => e.id), ['m1']);
  assert.deepEqual(messageEvents(comProprias).map((e) => e.id), ['m1', 'm2', 'm3']);
  hub.closeAll();
});

test('desconectar para de transmitir; closeAll encerra todo mundo', () => {
  const hub = new EventHub();
  const a = fakeResponse();
  const b = fakeResponse();
  const detachA = hub.attach(a, { includeFromMe: false, chatJid: null }, {});
  hub.attach(b, { includeFromMe: false, chatJid: null }, {});
  detachA();
  hub.publishMessage(msg('m1', 'x@s.whatsapp.net'), null);
  assert.equal(messageEvents(a).length, 0);
  assert.equal(messageEvents(b).length, 1);
  hub.closeAll();
  assert.equal(b.writableEnded, true);
  assert.equal(hub.size, 0);
});

test('cliente que não lê é derrubado antes de acumular memória', () => {
  const hub = new EventHub();
  const lento = fakeResponse();
  hub.attach(lento, { includeFromMe: false, chatJid: null }, {});
  (lento as unknown as { writableLength: number }).writableLength = 2_000_000;
  hub.publishMessage(msg('m1', 'x@s.whatsapp.net'), null);
  assert.equal(lento.destroyed, true);
  assert.equal(hub.size, 0);
});

test('limite de clientes', () => {
  const hub = new EventHub(1);
  assert.equal(hub.hasRoom(), true);
  hub.attach(fakeResponse(), { includeFromMe: false, chatJid: null }, {});
  assert.equal(hub.hasRoom(), false);
  hub.closeAll();
});
