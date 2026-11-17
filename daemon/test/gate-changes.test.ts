/**
 * Edição e exclusão pelo gate: mesmo protocolo de dois passos do envio (rascunho com
 * preview, confirm de uso único), só para mensagem do usuário e dentro do prazo, e um
 * token de um tipo não serve no confirm do outro. SQLite temporário e WhatsApp falso.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pino from 'pino';
import type { Config } from '../src/config.js';
import { Audit } from '../src/obs/audit.js';
import { Metrics } from '../src/obs/metrics.js';
import { AppError } from '../src/send/errors.js';
import { SendGate } from '../src/send/gate.js';
import { Store } from '../src/store/store.js';
import type { StoredMessage } from '../src/types.js';
import type { WhatsAppConnection } from '../src/whatsapp/connection.js';

const ANA = '5551999998888@s.whatsapp.net';
const BETO = '5551988887777@s.whatsapp.net';
const CAIO = '5551977776666@s.whatsapp.net';
const MIN = 60_000;

let dir: string;
let store: Store;
let gate: SendGate;
const chamadas: string[] = [];

/** Mensagem no banco, `minutos` atrás. */
function mensagem(id: string, chat: string, minutos: number, extra: Partial<StoredMessage> = {}): void {
  store.upsertMessage(
    {
      id, chatJid: chat, senderJid: null, senderName: null, fromMe: true, ts: Date.now() - minutos * MIN,
      type: 'text', text: `texto de ${id}`, caption: null, viewOnce: false, quotedText: null,
      hasMedia: false, mediaState: 'none', ...extra,
    },
    JSON.stringify({ key: { remoteJid: chat, id, fromMe: extra.fromMe ?? true } }),
  );
}

/** A promise falha com este código de `AppError`. */
async function falhaCom(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof AppError && e.code === code);
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-bridge-gate-changes-'));
  store = new Store(join(dir, 'wa.db'));
  store.migrate();

  const config = {
    home: dir,
    blocklistPath: join(dir, 'blocklist.json'),
    quietHours: { startMinute: 0, endMinute: 0, raw: '00:00-00:00' },
    sendMaxDelayMs: 1000,
    draftTtlMs: 60_000,
    sendsPerHour: 10,
    sendsPerDay: 40,
    newContactsPerDay: 3,
    chatMinIntervalMs: 30_000,
  } as Config;

  const wa = {
    getGroupParticipants: async () => [],
    getNewChatQuota: () => null,
    editMessage: async (chat: string, id: string, text: string) => {
      chamadas.push(`edit ${chat} ${id} ${text}`);
    },
    deleteMessage: async (chat: string, id: string) => {
      chamadas.push(`delete ${chat} ${id}`);
    },
  } as unknown as WhatsAppConnection;

  gate = new SendGate({ wa, store, log: pino({ level: 'silent' }), metrics: new Metrics(store), audit: new Audit(store), config });

  mensagem('recente', ANA, 2);
  mensagem('velha', ANA, 20);
  mensagem('foto', BETO, 1, { type: 'image', hasMedia: true, text: '[Imagem] praia' });
  mensagem('dela', ANA, 1, { fromMe: false, senderJid: ANA });
  mensagem('antiga', CAIO, 3 * 24 * 60);
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('editar: rascunho mostra a mensagem de hoje e o texto novo; só o confirm de edição executa', async () => {
  const draft = await gate.draftEdit({ messageId: 'recente', text: 'texto corrigido' }, { agent: 'teste' });
  assert.equal(draft.action, 'edit');
  assert.deepEqual(draft.targetPreview?.text, 'texto de recente');
  assert.deepEqual(draft.bubbles, ['texto corrigido']);
  assert.deepEqual(draft.warnings, [], 'edição não pede acknowledge nem urgent');
  assert.deepEqual(chamadas, [], 'o rascunho não muda nada');

  // Token de edição no confirm de envio sairia como mensagem nova: recusado, sem queimar.
  await falhaCom(gate.confirm(draft.confirmToken, 'teste'), 'WRONG_DRAFT_ACTION');
  await falhaCom(gate.confirmChange(draft.confirmToken, 'delete', 'teste'), 'WRONG_DRAFT_ACTION');
  assert.equal(store.getDraft(draft.confirmToken)?.status, 'pending');

  const done = await gate.confirmChange(draft.confirmToken, 'edit', 'teste');
  assert.deepEqual(done, { action: 'edit', messageId: 'recente', chatJid: ANA });
  assert.deepEqual(chamadas, [`edit ${ANA} recente texto corrigido`]);
  await falhaCom(gate.confirmChange(draft.confirmToken, 'edit', 'teste'), 'DRAFT_NOT_FOUND');
});

test('editar: só mensagem própria, de texto, dentro de 15 minutos e com texto diferente', async () => {
  await falhaCom(gate.draftEdit({ messageId: 'nao-existe', text: 'x' }), 'NOT_FOUND');
  await falhaCom(gate.draftEdit({ messageId: 'dela', text: 'x' }), 'NOT_OWN_MESSAGE');
  await falhaCom(gate.draftEdit({ messageId: 'velha', text: 'x' }), 'EDIT_WINDOW_EXPIRED');
  await falhaCom(gate.draftEdit({ messageId: 'foto', text: 'x' }), 'EDIT_NOT_SUPPORTED');
  await falhaCom(gate.draftEdit({ messageId: 'velha', text: '  ' }), 'VALIDATION');
  mensagem('igual', CAIO, 1);
  await falhaCom(gate.draftEdit({ messageId: 'igual', text: 'texto de igual' }), 'VALIDATION');
});

test('apagar: até 2 dias, um rascunho por conversa e sem os limites de volume', async () => {
  await falhaCom(gate.draftDelete({ messageId: 'antiga' }), 'DELETE_WINDOW_EXPIRED');
  await falhaCom(gate.draftDelete({ messageId: 'dela' }), 'NOT_OWN_MESSAGE');

  // Limite por hora estourado: envio novo pararia, a exclusão não.
  for (let i = 0; i < 10; i += 1) {
    store.insertSend({
      sendId: `s${i}`, chatJid: CAIO, agent: 't', traceId: 't', startedAt: Date.now(), finishedAt: Date.now(),
      stage: 'done', bubblesTotal: 1, bubblesSent: 1, cancelled: false, messageIdsJson: '[]', firstContact: false,
    });
  }
  const draft = await gate.draftDelete({ messageId: 'foto' }, { agent: 'teste' });
  assert.equal(draft.action, 'delete');
  assert.equal(draft.targetPreview?.messageId, 'foto');
  assert.deepEqual(draft.bubbles, []);
  mensagem('outra-do-beto', BETO, 1);
  await falhaCom(gate.draftEdit({ messageId: 'outra-do-beto', text: 'outra' }), 'DRAFT_ALREADY_PENDING');

  const done = await gate.confirmChange(draft.confirmToken, 'delete', 'teste');
  assert.equal(done.action, 'delete');
  assert.ok(chamadas.includes(`delete ${BETO} foto`));
});
