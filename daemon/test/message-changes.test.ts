/**
 * Edição e "apagar para todos" que chegam do WhatsApp: mudam a mensagem original em vez
 * de virar mensagem `unknown`, só valem vindas do autor (ou de admin, para apagar em
 * grupo), e as que versões anteriores gravaram como `unknown` são reaplicadas na subida.
 */
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { Store } from '../src/store/store.js';
import type { StoredMessage } from '../src/types.js';
import { WhatsAppConnection } from '../src/whatsapp/connection.js';
import { MESSAGE_CHANGE_PROTOCOL_TYPES, messageChangeKind } from '../src/whatsapp/protocol.js';

const ANA = '5551999998888@s.whatsapp.net';
const GRUPO = '120363000000000001@g.us';
const BIA = '5551977776666@s.whatsapp.net';
const CAIO = '5551955554444@s.whatsapp.net';
const ADMIN = '5551966665555@s.whatsapp.net';
const T = 1_800_000_000;

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-bridge-changes-'));
});

after(() => rmSync(dir, { recursive: true, force: true }));

/** Store novo e uma conexão sem socket, com acesso à entrada de mensagens. */
function abrir(nome: string): {
  store: Store;
  wa: WhatsAppConnection;
  receber: (raw: WAMessage, source?: 'live' | 'offline' | 'history') => boolean;
} {
  const home = join(dir, nome);
  mkdirSync(join(home, 'media'), { recursive: true });
  const store = new Store(join(home, 'wa.db'));
  store.migrate();
  const wa = new WhatsAppConnection({
    store,
    log: pino({ level: 'silent' }),
    metrics: { recordCall: () => {} },
    home,
    historyDays: 7,
    deviceName: 'wa-bridge',
  });
  const internals = wa as unknown as { handleIncomingMessage(raw: WAMessage, source: string): boolean };
  return { store, wa, receber: (raw, source = 'live') => internals.handleIncomingMessage(raw, source) };
}

/** Mensagem de texto de `quem` (ou do usuário, sem `quem`) numa conversa. */
function texto(id: string, chat: string, text: string, quem?: string): WAMessage {
  return {
    key: { remoteJid: chat, id, fromMe: !quem, ...(quem && chat.endsWith('@g.us') ? { participant: quem } : {}) },
    message: { conversation: text },
    messageTimestamp: T,
  } as unknown as WAMessage;
}

/** `protocolMessage` de edição ou exclusão, como o Baileys entrega. */
function mudanca(
  tipo: 'MESSAGE_EDIT' | 'REVOKE',
  id: string,
  chat: string,
  alvo: string,
  opts: { quem?: string; novoTexto?: string } = {},
): WAMessage {
  const fromMe = !opts.quem;
  const participant = opts.quem && chat.endsWith('@g.us') ? { participant: opts.quem } : {};
  return {
    key: { remoteJid: chat, id, fromMe, ...participant },
    message: {
      protocolMessage: {
        type: proto.Message.ProtocolMessage.Type[tipo],
        key: { remoteJid: chat, id: alvo, fromMe, ...participant },
        ...(opts.novoTexto ? { editedMessage: { conversation: opts.novoTexto }, timestampMs: (T + 60) * 1000 } : {}),
      },
    },
    messageTimestamp: T + 60,
  } as unknown as WAMessage;
}

test('os números batem com o enum do Baileys', () => {
  for (const [name, id] of Object.entries(MESSAGE_CHANGE_PROTOCOL_TYPES)) {
    assert.equal((proto.Message.ProtocolMessage.Type as unknown as Record<string, number>)[name], id, name);
  }
  assert.equal(messageChangeKind(proto.Message.ProtocolMessage.Type.REVOKE), 'revoke');
  assert.equal(messageChangeKind('MESSAGE_EDIT'), 'edit');
  assert.equal(messageChangeKind(proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION), null);
  assert.equal(messageChangeKind(undefined), null);
});

test('edição do autor troca o texto e não vira mensagem nem não lida', () => {
  const { store, receber } = abrir('edicao');
  try {
    assert.equal(receber(texto('m1', ANA, 'oi', ANA)), true);
    assert.equal(receber(mudanca('MESSAGE_EDIT', 'e1', ANA, 'm1', { quem: ANA, novoTexto: 'oi, tudo bem?' })), false);

    const m = store.getMessage('m1');
    assert.equal(m?.text, 'oi, tudo bem?');
    assert.equal(m?.editedAt, (T + 60) * 1000);
    assert.equal(store.getMessage('e1'), null, 'a edição não vira mensagem própria');
    assert.equal(store.listChats({ limit: 5, onlyUnread: false })[0]?.unreadCount, 1, 'só a original conta');
    assert.equal(store.searchMessages({ query: 'tudo', limit: 5 })[0]?.message.id, 'm1');

    // Reentrega da original (ex.: retry) não desfaz a edição.
    receber(texto('m1', ANA, 'oi', ANA));
    assert.equal(store.getMessage('m1')?.text, 'oi, tudo bem?');

    // Clientes novos embrulham a edição em `editedMessage`.
    const embrulhada = mudanca('MESSAGE_EDIT', 'e1b', ANA, 'm1', { quem: ANA, novoTexto: 'oi, tudo certo?' });
    const msg = embrulhada.message as Record<string, unknown>;
    embrulhada.message = { editedMessage: { message: msg } } as WAMessage['message'];
    assert.equal(receber(embrulhada), false);
    assert.equal(store.getMessage('m1')?.text, 'oi, tudo certo?');
    assert.equal(store.getMessage('e1b'), null);
  } finally {
    store.close();
  }
});

test('edição vinda de outra pessoa não muda a mensagem', () => {
  const { store, receber } = abrir('edicao-alheia');
  try {
    receber(texto('g1', GRUPO, 'reunião às 10h', BIA));
    receber(mudanca('MESSAGE_EDIT', 'e2', GRUPO, 'g1', { quem: CAIO, novoTexto: 'reunião cancelada' }));
    const m = store.getMessage('g1');
    assert.equal(m?.text, 'reunião às 10h');
    assert.equal(m?.editedAt, null);
  } finally {
    store.close();
  }
});

test('edição de mensagem que não está no banco vira a mensagem, já editada', () => {
  const { store, receber } = abrir('edicao-sem-original');
  try {
    receber(mudanca('MESSAGE_EDIT', 'e3', ANA, 'sumida', { quem: ANA, novoTexto: 'só veio na edição' }), 'history');
    const m = store.getMessage('sumida');
    assert.equal(m?.text, 'só veio na edição');
    assert.equal(m?.fromMe, false);
    assert.equal(m?.senderJid, ANA);
    assert.notEqual(m?.editedAt, null);
    assert.equal(store.getMessage('e3'), null);
    assert.equal(store.listChats({ limit: 5, onlyUnread: false })[0]?.unreadCount, 0, 'não soma não lida');
  } finally {
    store.close();
  }
});

test('apagar para todos tira texto, mídia e conteúdo do raw_json, e a reentrega não traz de volta', async () => {
  const { store, receber } = abrir('exclusao');
  try {
    const foto = {
      key: { remoteJid: ANA, id: 'f1', fromMe: false },
      message: { imageMessage: { caption: 'foto do contrato', mimetype: 'image/jpeg' } },
      messageTimestamp: T,
    } as unknown as WAMessage;
    receber(foto);
    const arquivo = join(dir, 'exclusao', 'media', 'f1.jpg');
    writeFileSync(arquivo, 'jpg');
    store.saveMedia({
      messageId: 'f1', kind: 'image', mime: 'image/jpeg', path: arquivo, bytes: 3,
      durationMs: null, transcript: null, framePaths: [], viewOnce: false, error: null,
    });

    receber(mudanca('REVOKE', 'r1', ANA, 'f1', { quem: ANA }));
    const m = store.getMessage('f1');
    assert.equal(m?.text, null);
    assert.equal(m?.caption, null);
    assert.equal(m?.hasMedia, false);
    assert.equal(m?.deletedAt, (T + 60) * 1000);
    assert.equal(store.getMedia('f1'), null);
    assert.deepEqual(Object.keys(JSON.parse(store.getRawJson('f1') ?? '{}')), ['key'], 'do raw só fica a key');
    assert.equal(store.searchMessages({ query: 'contrato', limit: 5 }).length, 0);
    assert.equal(store.getMessage('r1'), null);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(existsSync(arquivo), false, 'o arquivo sai do disco');

    receber(foto);
    assert.equal(store.getMessage('f1')?.text, null, 'reentrega não ressuscita a apagada');
  } finally {
    store.close();
  }
});

test('em grupo, admin apaga mensagem de outro; quem não é admin não apaga', () => {
  const { store, receber } = abrir('exclusao-grupo');
  try {
    store.replaceGroupParticipants(
      GRUPO,
      [
        { jid: BIA, phoneJid: BIA, name: null, isAdmin: false },
        { jid: CAIO, phoneJid: CAIO, name: null, isAdmin: false },
        { jid: ADMIN, phoneJid: ADMIN, name: null, isAdmin: true },
      ],
      Date.now(),
    );
    receber(texto('g2', GRUPO, 'spam', BIA));
    receber(mudanca('REVOKE', 'r2', GRUPO, 'g2', { quem: CAIO }));
    assert.equal(store.getMessage('g2')?.deletedAt, null, 'CAIO não é admin');
    receber(mudanca('REVOKE', 'r3', GRUPO, 'g2', { quem: ADMIN }));
    assert.notEqual(store.getMessage('g2')?.deletedAt, null);
  } finally {
    store.close();
  }
});

test('reapplyStoredChanges aplica as gravadas como unknown e tira essas linhas', () => {
  const { store, wa } = abrir('reaplicar');
  try {
    const base: StoredMessage = {
      id: '', chatJid: ANA, senderJid: ANA, senderName: 'Ana', fromMe: false, ts: T * 1000, type: 'text',
      text: null, caption: null, viewOnce: false, quotedText: null, hasMedia: false, mediaState: 'none',
    };
    store.upsertChat({ jid: ANA, name: 'Ana', isGroup: false, lastMessageAt: T * 1000, unreadCount: 0 });
    store.upsertMessage({ ...base, id: 'v1', text: 'versão 1' }, '{}');
    store.upsertMessage({ ...base, id: 'v2', text: 'vai sumir' }, '{}');
    // Como versões anteriores gravavam: `unknown`, com o `toJSON` do protobuf (enum pelo nome).
    const gravada = (id: string, tipo: 'MESSAGE_EDIT' | 'REVOKE', alvo: string, novo?: string) => {
      const raw = mudanca(tipo, id, ANA, alvo, { quem: ANA, ...(novo ? { novoTexto: novo } : {}) });
      const json = JSON.parse(JSON.stringify(raw)) as { message: { protocolMessage: { type: unknown } } };
      json.message.protocolMessage.type = tipo;
      store.upsertMessage({ ...base, id, type: 'unknown', ts: (T + 60) * 1000 }, JSON.stringify(json));
    };
    gravada('u1', 'MESSAGE_EDIT', 'v1', 'versão 2');
    gravada('u2', 'REVOKE', 'v2');
    gravada('u3', 'MESSAGE_EDIT', 'v3', 'só existia na edição');

    assert.equal(wa.reapplyStoredChanges(), 3);
    assert.equal(store.getMessage('v1')?.text, 'versão 2');
    assert.notEqual(store.getMessage('v2')?.deletedAt, null);
    assert.equal(store.getMessage('v3')?.text, 'só existia na edição');
    for (const id of ['u1', 'u2', 'u3']) assert.equal(store.getMessage(id), null, id);
    assert.equal(wa.reapplyStoredChanges(), 0, 'na próxima subida não há nada');
  } finally {
    store.close();
  }
});

test('migração 6 cria edited_at e deleted_at, e repetir não quebra', () => {
  const path = join(dir, 'migracao.db');
  const store = new Store(path);
  store.migrate();
  assert.equal(store.schemaVersion(), 6);
  store.close();

  const db = new DatabaseSync(path);
  const cols = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes('edited_at') && cols.includes('deleted_at'));
  db.exec('PRAGMA user_version = 5');
  db.close();

  const again = new Store(path);
  try {
    again.migrate();
    assert.equal(again.schemaVersion(), 6);
  } finally {
    again.close();
  }
});
