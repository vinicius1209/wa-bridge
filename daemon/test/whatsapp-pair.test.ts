/**
 * Novo pareamento (`forcePair`): faz logout do aparelho atual, para ele sair de "Aparelhos
 * conectados" no celular, antes de apagar a credencial e pedir um QR novo. Se o logout
 * falhar, o pareamento segue mesmo assim. Sem WhatsApp: socket falso e `connect` trocado.
 */
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pino from 'pino';
import { Store } from '../src/store/store.js';
import { WhatsAppConnection } from '../src/whatsapp/connection.js';

/** Acesso ao socket e ao `connect`, que o teste substitui. */
interface Internals {
  socket: unknown;
  connect(): Promise<void>;
}

let dir: string;
let store: Store;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-bridge-pair-'));
  store = new Store(join(dir, 'wa.db'));
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Conexão com credencial salva, um socket falso e `connect` contado. */
function setup(name: string, logout: () => Promise<void>) {
  const home = join(dir, name);
  mkdirSync(join(home, 'auth'), { recursive: true });
  writeFileSync(join(home, 'auth', 'creds.json'), '{}');
  const wa = new WhatsAppConnection({
    store,
    log: pino({ level: 'silent' }),
    metrics: { recordCall: () => {} },
    home,
    historyDays: 7,
    deviceName: 'wa-bridge',
  });
  const internals = wa as unknown as Internals;
  const calls: string[] = [];
  internals.socket = {
    logout: async () => {
      calls.push('logout');
      await logout();
    },
    end: () => calls.push('end'),
  };
  internals.connect = async () => {
    calls.push('connect');
  };
  return { wa, home, calls };
}

test('desvincula o aparelho atual antes de apagar a credencial e gerar QR', async () => {
  const { wa, home, calls } = setup('ok', async () => {});
  await wa.forcePair();
  assert.deepEqual(calls, ['logout', 'end', 'connect']);
  assert.equal(existsSync(join(home, 'auth')), false, 'credencial antiga apagada');
  assert.equal(wa.getSessionState().state, 'connecting');
});

test('logout que falha não impede o novo pareamento', async () => {
  const { wa, home, calls } = setup('falha', async () => {
    throw new Error('Connection Closed');
  });
  await wa.forcePair();
  assert.deepEqual(calls, ['logout', 'end', 'connect']);
  assert.equal(existsSync(join(home, 'auth')), false);
});
