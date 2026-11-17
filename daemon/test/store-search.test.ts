/**
 * Busca textual (FTS5) em mensagens e transcrições, e a migração versionada que cria o
 * índice. Usa SQLite temporário, nunca o banco de um daemon em execução.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { Store, toFtsQuery } from '../src/store/store.js';
import type { MediaArtifact, StoredMessage } from '../src/types.js';

const GRUPO = '120363000000000000@g.us';
const ANA = '5551999998888@s.whatsapp.net';

let dir: string;
let store: Store;

/** Monta uma mensagem recebida mínima. */
function msg(id: string, chatJid: string, text: string | null, ts: number, type: StoredMessage['type'] = 'text'): StoredMessage {
  return {
    id, chatJid, senderJid: ANA, senderName: 'Ana', fromMe: false, ts, type, text,
    caption: null, viewOnce: false, quotedText: null,
    hasMedia: type !== 'text', mediaState: type === 'text' ? 'none' : 'pending',
  };
}

/** Artefato de áudio já transcrito. */
function audio(messageId: string, transcript: string | null): MediaArtifact {
  return {
    messageId, kind: 'audio', mime: 'audio/ogg', path: `/tmp/${messageId}.ogg`, bytes: 10,
    durationMs: 1000, transcript, framePaths: [], viewOnce: false, error: null,
  };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-bridge-search-'));
  store = new Store(join(dir, 'wa.db'));
  store.migrate();
  store.upsertChat({ jid: GRUPO, name: 'Padel de segunda', isGroup: true, lastMessageAt: 3000, unreadCount: 0 });
  store.upsertChat({ jid: ANA, name: null, isGroup: false, lastMessageAt: 3000, unreadCount: 0 });
  store.upsertContact({ jid: ANA, pushName: 'Ana', alias: null, phoneJid: null, lastInboundAt: 1, lastOutboundAt: null });

  store.upsertMessage(msg('m1', GRUPO, 'Reunião do clube amanhã às 20h', 1000), '{}');
  store.upsertMessage(msg('m2', ANA, 'manda o pix da mensalidade', 2000), '{}');
  store.upsertMessage(msg('m3', ANA, '[Áudio enviado]', 3000, 'audio'), '{}');
  store.saveMedia(audio('m3', 'o jogo de sexta foi cancelado por causa da chuva'));
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('toFtsQuery: cada termo vira frase entre aspas e caractere especial não quebra a query', () => {
  assert.equal(toFtsQuery('pix mensalidade'), '"pix" "mensalidade"');
  assert.equal(toFtsQuery('reuni*'), '"reuni"*');
  assert.equal(toFtsQuery('  "aspas"  '), '"aspas"');
  assert.equal(toFtsQuery('   '), null);
  assert.equal(toFtsQuery('""'), null);
});

test('busca ignora acentos e maiúsculas e devolve nome da conversa e trecho', () => {
  const hits = store.searchMessages({ query: 'REUNIAO', limit: 10 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.message.id, 'm1');
  assert.equal(hits[0]?.chatName, 'Padel de segunda');
  assert.equal(hits[0]?.source, 'text');
  assert.match(hits[0]?.snippet ?? '', /«Reunião»/);
});

test('busca acha termo dentro da transcrição de áudio', () => {
  const hits = store.searchMessages({ query: 'chuva', limit: 10 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.message.id, 'm3');
  assert.equal(hits[0]?.source, 'transcript');
  assert.equal(hits[0]?.chatName, 'Ana', 'conversa individual sem nome cai no pushName');
});

test('todos os termos precisam aparecer, e prefixo funciona', () => {
  assert.equal(store.searchMessages({ query: 'pix clube', limit: 10 }).length, 0);
  assert.equal(store.searchMessages({ query: 'mensal*', limit: 10 })[0]?.message.id, 'm2');
});

test('filtros por conversa e por data, e ordem mais recente primeiro', () => {
  store.upsertMessage(msg('m4', GRUPO, 'pix do aluguel da quadra', 4000), '{}');
  const todos = store.searchMessages({ query: 'pix', limit: 10 }).map((h) => h.message.id);
  assert.deepEqual(todos, ['m4', 'm2']);
  assert.deepEqual(store.searchMessages({ query: 'pix', chatJid: ANA, limit: 10 }).map((h) => h.message.id), ['m2']);
  assert.deepEqual(store.searchMessages({ query: 'pix', since: 3000, limit: 10 }).map((h) => h.message.id), ['m4']);
  assert.equal(store.searchMessages({ query: 'pix', limit: 1 }).length, 1);
});

test('editar o texto e regravar a transcrição reindexa; apagar tira do índice', () => {
  store.upsertMessage(msg('m2', ANA, 'manda o boleto da mensalidade', 2000), '{}');
  assert.equal(store.searchMessages({ query: 'pix', chatJid: ANA, limit: 10 }).length, 0);
  assert.equal(store.searchMessages({ query: 'boleto', limit: 10 })[0]?.message.id, 'm2');

  store.saveMedia(audio('m3', 'o jogo de sexta foi remarcado'));
  assert.equal(store.searchMessages({ query: 'chuva', limit: 10 }).length, 0);
  assert.equal(store.searchMessages({ query: 'remarcado', limit: 10 })[0]?.message.id, 'm3');

  store.deleteMessagesBefore(3500);
  assert.equal(store.searchMessages({ query: 'boleto', limit: 10 }).length, 0);
  assert.equal(store.searchMessages({ query: 'remarcado', limit: 10 }).length, 0);
});

test('banco antigo (sem versão) migra e passa a buscar o que já existia', () => {
  const legacyPath = join(dir, 'legado.db');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, chat_jid TEXT NOT NULL, sender_jid TEXT, sender_name TEXT,
      from_me INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL,
      text TEXT, caption TEXT, view_once INTEGER NOT NULL DEFAULT 0, quoted_text TEXT,
      has_media INTEGER NOT NULL DEFAULT 0, media_state TEXT NOT NULL DEFAULT 'none',
      raw_json TEXT);
    CREATE TABLE contacts (jid TEXT PRIMARY KEY, push_name TEXT, alias TEXT,
      last_inbound_at INTEGER, last_outbound_at INTEGER);
    INSERT INTO messages (id, chat_jid, from_me, ts, type, text)
      VALUES ('velha', '${ANA}', 0, 500, 'text', 'mensagem de antes da busca existir');
  `);
  legacy.close();

  const migrated = new Store(legacyPath);
  try {
    migrated.migrate();
    assert.equal(migrated.schemaVersion(), 5);
    assert.equal(migrated.searchMessages({ query: 'antes busca', limit: 10 })[0]?.message.id, 'velha');
    // Rodar de novo não repete passo nenhum.
    migrated.migrate();
    assert.equal(migrated.schemaVersion(), 5);
  } finally {
    migrated.close();
  }
});
