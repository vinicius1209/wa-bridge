/**
 * `Store.resolveContact`: alias > nome exato > nome parcial, número em modo próprio,
 * lista ordenada por score com `reason` e ambiguidade preservada (o gate usa isso para
 * recusar em vez de escolher). Usa um SQLite temporário, nunca o banco de um daemon.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/store/store.js';
import type { ContactMatch, ContactRecord } from '../src/types.js';

const ALLAN = '5551911111111@s.whatsapp.net';
const ALLAN_PEREIRA = '5551922222222@s.whatsapp.net';
const ALLAN_SILVA = '5551933333333@s.whatsapp.net';
const ROBERTO = '5551944444444@s.whatsapp.net';
const CHEFE_DE_NOME = '5551955555555@s.whatsapp.net';
const JOSE = '5551966666666@s.whatsapp.net';
const ANA_1 = '5551977777777@s.whatsapp.net';
const ANA_2 = '5521977777777@s.whatsapp.net';
const MARIA = '5551999990000@s.whatsapp.net';
const LID = '123456789012345@lid';
const LID_TELEFONE = '5551988888888@s.whatsapp.net';
const GRUPO = '120363000000000001@g.us';

let dir: string;
let store: Store;

/** Contato mínimo; os campos não informados ficam `null`. */
function contato(jid: string, pushName: string | null, extra: Partial<ContactRecord> = {}): ContactRecord {
  return { jid, pushName, alias: null, phoneJid: null, lastInboundAt: null, lastOutboundAt: null, ...extra };
}

/** Garante a ordenação por score decrescente que o contrato promete. */
function assertOrdenado(matches: ContactMatch[]): void {
  for (let i = 1; i < matches.length; i++) {
    const anterior = matches[i - 1] as ContactMatch;
    const atual = matches[i] as ContactMatch;
    assert.ok(anterior.score >= atual.score, `fora de ordem: ${anterior.score} antes de ${atual.score}`);
  }
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-bridge-resolve-'));
  store = new Store(join(dir, 'test.sqlite'));
  store.migrate();

  store.upsertContact(contato(ALLAN, 'Allan', { lastInboundAt: 1000, lastOutboundAt: 3000 }));
  store.upsertContact(contato(ALLAN_PEREIRA, 'Allan Pereira', { lastInboundAt: 2000 }));
  store.upsertContact(contato(ALLAN_SILVA, 'Allan Silva'));
  store.upsertContact(contato(ROBERTO, 'Roberto'));
  store.setAlias('Chefe', ROBERTO);
  store.upsertContact(contato(CHEFE_DE_NOME, 'Chefe'));
  store.upsertContact(contato(JOSE, 'José Araújo'));
  store.upsertContact(contato(ANA_1, 'Ana'));
  store.upsertContact(contato(ANA_2, 'ana'));
  store.upsertContact(contato(MARIA, 'Maria', { alias: 'maria' }));
  store.upsertContact(contato(LID, 'Lia', { phoneJid: LID_TELEFONE, lastInboundAt: 500 }));

  store.upsertChat({ jid: GRUPO, name: 'Condomínio Flores', isGroup: true, lastMessageAt: 1000, unreadCount: 0 });
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('alias vence nome exato: "chefe" traz o apelidado antes de quem se chama Chefe', () => {
  const matches = store.resolveContact('chefe');
  assert.deepEqual(
    matches.map((m) => [m.jid, m.reason, m.score]),
    [
      [ROBERTO, 'alias', 1.0],
      [CHEFE_DE_NOME, 'exact-name', 0.9],
    ],
  );
  assert.equal(matches[0]?.alias, 'Chefe');
  assert.equal(matches[0]?.name, 'Roberto');
});

test('nome exato vence nome parcial, e os parciais continuam na lista', () => {
  const matches = store.resolveContact('Allan');
  assertOrdenado(matches);
  assert.equal(matches[0]?.jid, ALLAN);
  assert.equal(matches[0]?.reason, 'exact-name');
  assert.equal(matches[0]?.score, 0.9);
  const parciais = matches.slice(1);
  assert.deepEqual(parciais.map((m) => m.jid).sort(), [ALLAN_PEREIRA, ALLAN_SILVA].sort());
  for (const m of parciais) {
    assert.equal(m.reason, 'partial-name');
    assert.ok(m.score > 0.5 && m.score <= 0.75, `score parcial ${m.score}`);
  }
});

test('nome parcial: quanto mais do nome a query cobre, maior o score', () => {
  const matches = store.resolveContact('allan p');
  assert.deepEqual(matches.map((m) => m.jid), [ALLAN_PEREIRA]);
  const curto = store.resolveContact('Pereira')[0];
  const longo = store.resolveContact('lan Pereira')[0];
  assert.ok(curto && longo);
  assert.ok(longo.score > curto.score);
});

test('ambiguidade preservada: dois contatos com nome parecido voltam os dois', () => {
  const allans = store.resolveContact('allan').filter((m) => m.reason === 'partial-name');
  assert.deepEqual(allans.map((m) => m.jid).sort(), [ALLAN_PEREIRA, ALLAN_SILVA].sort());

  const anas = store.resolveContact('ANA');
  assert.deepEqual(anas.map((m) => m.jid).sort(), [ANA_1, ANA_2].sort());
  for (const m of anas) {
    assert.equal(m.reason, 'exact-name');
    assert.equal(m.score, 0.9);
  }
});

test('comparação ignora caixa, acento e espaço nas pontas', () => {
  for (const q of ['josé araújo', '  JOSE ARAUJO ', 'José Araujo']) {
    const [m] = store.resolveContact(q);
    assert.equal(m?.jid, JOSE, q);
    assert.equal(m?.reason, 'exact-name', q);
  }
});

test('número: telefone completo, formatado, com JID ou só o final (8+ dígitos)', () => {
  for (const q of ['5551922222222', '+55 (51) 92222-2222', '51 92222-2222', '922222222', ALLAN_PEREIRA]) {
    const matches = store.resolveContact(q);
    assert.deepEqual(
      matches.map((m) => [m.jid, m.reason, m.score]),
      [[ALLAN_PEREIRA, 'number', 0.95]],
      q,
    );
  }
});

test('número: final que coincide em dois contatos devolve os dois', () => {
  const matches = store.resolveContact('977777777');
  assert.deepEqual(matches.map((m) => m.jid).sort(), [ANA_1, ANA_2].sort());
  for (const m of matches) assert.equal(m.reason, 'number');
});

test('número desconhecido não casa ninguém, e menos de 8 dígitos não é número', () => {
  assert.deepEqual(store.resolveContact('5551900000000'), []);
  assert.deepEqual(store.resolveContact('2222222'), [], '7 dígitos não bastam para casar por número');
});

test('número: contato LID é achado pelo telefone real (phone_jid)', () => {
  const matches = store.resolveContact('5551988888888');
  assert.deepEqual(matches.map((m) => [m.jid, m.reason]), [[LID, 'number']]);
  assert.deepEqual(store.resolveContact(LID_TELEFONE).map((m) => m.jid), [LID], 'pelo JID de telefone também');
  assert.deepEqual(store.resolveContact(LID).map((m) => m.jid), [LID], 'e pelo próprio LID');
});

test('cada contato aparece uma vez só, com o melhor motivo', () => {
  const matches = store.resolveContact('Maria');
  assert.deepEqual(matches.map((m) => [m.jid, m.reason]), [[MARIA, 'alias']], 'alias e nome iguais não duplicam');
});

test('contato LID: mascara o telefone real, nunca o LID', () => {
  const [m] = store.resolveContact('Lia');
  assert.equal(m?.jid, LID);
  assert.equal(m?.maskedNumber, '+55 51 ****-8888');
});

test('lastContactAt é o mais recente entre inbound e outbound, ou null', () => {
  assert.equal(store.resolveContact('Allan')[0]?.lastContactAt, 3000);
  assert.equal(store.resolveContact('Allan Pereira')[0]?.lastContactAt, 2000);
  assert.equal(store.resolveContact('Allan Silva')[0]?.lastContactAt, null);
});

test('grupo é resolvido pelo nome e mascarado como "grupo"', () => {
  const [parcial] = store.resolveContact('condominio');
  assert.equal(parcial?.jid, GRUPO);
  assert.equal(parcial?.reason, 'partial-name');
  assert.equal(parcial?.maskedNumber, 'grupo');
  const [exato] = store.resolveContact('Condomínio Flores');
  assert.equal(exato?.reason, 'exact-name');
  assert.equal(exato?.score, 0.9);
});

test('query vazia não casa nada', () => {
  assert.deepEqual(store.resolveContact(''), []);
  assert.deepEqual(store.resolveContact('   '), []);
});

test('toda resposta vem ordenada por score e com reason', () => {
  for (const q of ['allan', 'a', 'chefe', 'ana', 'lia', 'o', '977777777']) {
    const matches = store.resolveContact(q);
    assertOrdenado(matches);
    for (const m of matches) assert.ok(['alias', 'exact-name', 'partial-name', 'number'].includes(m.reason));
  }
});

test('número: mesma pessoa por telefone e por LID não vira ambiguidade, fica o telefone', () => {
  const telefone = '5548911112222@s.whatsapp.net';
  const lid = '987654321098765@lid';
  store.upsertContact(contato(telefone, 'Gêmeo', { lastOutboundAt: 100 }));
  store.upsertContact(contato(lid, 'Gêmeo', { phoneJid: telefone, lastInboundAt: 200 }));
  assert.deepEqual(store.resolveContact('5548911112222').map((m) => m.jid), [telefone]);
  assert.deepEqual(store.resolveContact(telefone).map((m) => m.jid), [telefone]);
  assert.deepEqual(store.resolveContact(lid).map((m) => m.jid), [lid], 'pedir o LID explicitamente devolve o LID');
});
