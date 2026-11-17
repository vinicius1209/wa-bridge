/**
 * Menções em grupo: o literal `@<dígitos>` no texto e o `mentionedJid` de cada
 * bubble precisam casar. Errar qualquer um falha em silêncio, ou pior, marca a
 * pessoa errada. Funções puras, sem rede nem banco.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { splitBubbles } from '../src/send/human-delay.js';
import {
  applyMentionPlaceholders,
  containsPlaceholder,
  mentionsForChunk,
  placeholderFor,
  type ResolvedMention,
} from '../src/send/mentions.js';

/** Monta uma menção resolvida a partir do JID de endereçamento do grupo. */
function mencao(jid: string, name: string | null, query: string, phoneJid: string | null = null): ResolvedMention {
  return {
    jid,
    phoneJid,
    name,
    maskedNumber: '+55 51 ****-0000',
    query,
    placeholder: placeholderFor(jid),
    mentionJids: phoneJid && phoneJid !== jid ? [jid, phoneJid] : [jid],
  };
}

const ALLAN = mencao('5551999998888@s.whatsapp.net', 'Allan Pereira', 'Allan');
const BIA = mencao('5551977776666@s.whatsapp.net', 'Beatriz Souza', 'Bia');
/** Número curto que é prefixo do número do Allan. */
const PREFIXO = mencao('5551999@s.whatsapp.net', 'Prefixo', 'Prefixo');
/** Membro de grupo endereçado por LID, com telefone real conhecido. */
const JOSE_LID = mencao('123456789012345@lid', 'José', 'José', '5551955554444@s.whatsapp.net');

// ---------------------------------------------------------- placeholderFor

test('placeholderFor: @ seguido só dos dígitos da parte local do JID', () => {
  assert.equal(placeholderFor('5551999998888@s.whatsapp.net'), '@5551999998888');
  assert.equal(placeholderFor('5551999998888@c.us'), '@5551999998888');
  assert.equal(placeholderFor('123456789012345@lid'), '@123456789012345');
});

// ----------------------------------------------------- containsPlaceholder

test('containsPlaceholder: acha o número completo em qualquer posição', () => {
  assert.equal(containsPlaceholder('@5551999998888 bom dia', '@5551999998888'), true);
  assert.equal(containsPlaceholder('bom dia @5551999998888, tudo?', '@5551999998888'), true);
  assert.equal(containsPlaceholder('bom dia @5551999998888', '@5551999998888'), true);
});

test('containsPlaceholder: prefixo não casa dentro de um número maior (lookahead)', () => {
  assert.equal(containsPlaceholder('oi @5551999998888', '@5551999'), false);
  assert.equal(containsPlaceholder('oi @5551999', '@5551999998888'), false);
  assert.equal(containsPlaceholder('oi @5551999 e @5551999998888', '@5551999'), true);
});

test('containsPlaceholder: dígitos sem @ ou placeholder vazio não contam', () => {
  assert.equal(containsPlaceholder('liga no 5551999998888', '@5551999998888'), false);
  assert.equal(containsPlaceholder('oi @ todos', '@'), false);
});

// ------------------------------------------------ applyMentionPlaceholders

test('applyMentionPlaceholders: sem menções devolve o texto intacto', () => {
  assert.equal(applyMentionPlaceholders('  oi @Allan  ', []), '  oi @Allan  ');
});

test('applyMentionPlaceholders: placeholder já presente não é duplicado', () => {
  assert.equal(applyMentionPlaceholders('valeu @5551999998888!', [ALLAN]), 'valeu @5551999998888!');
});

test('applyMentionPlaceholders: troca "@Allan" pelo número, ignorando caixa e acento', () => {
  assert.equal(applyMentionPlaceholders('Bom dia @Allan, tudo bem?', [ALLAN]), 'Bom dia @5551999998888, tudo bem?');
  assert.equal(applyMentionPlaceholders('valeu @allan!', [ALLAN]), 'valeu @5551999998888!');
  assert.equal(applyMentionPlaceholders('oi @ÁLLAN', [ALLAN]), 'oi @5551999998888');
});

test('applyMentionPlaceholders: casa pelo primeiro nome mesmo quando a query foi um número', () => {
  const porNumero = mencao('5551999998888@s.whatsapp.net', 'Allan Pereira', '5551999998888');
  assert.equal(applyMentionPlaceholders('fala @Allan', [porNumero]), 'fala @5551999998888');
});

test('applyMentionPlaceholders: corta a string original, mesmo com acento antes do token', () => {
  const jose = mencao('5551955554444@s.whatsapp.net', 'José', 'José');
  assert.equal(
    applyMentionPlaceholders('Ação pendente: @José, revisão até sexta.', [jose]),
    'Ação pendente: @5551955554444, revisão até sexta.',
  );
});

test('applyMentionPlaceholders: sem token correspondente, prefixa no começo', () => {
  assert.equal(applyMentionPlaceholders('bom dia', [ALLAN]), '@5551999998888 bom dia');
  assert.equal(applyMentionPlaceholders('falei com o @Bruno', [ALLAN]), '@5551999998888 falei com o @Bruno');
});

test('applyMentionPlaceholders: várias menções, uma trocada no lugar e as outras prefixadas em ordem', () => {
  const carla = mencao('5551933332222@s.whatsapp.net', 'Carla', 'Carla');
  assert.equal(
    applyMentionPlaceholders('pessoal, @Bia vai apresentar', [ALLAN, BIA, carla]),
    '@5551999998888 @5551933332222 pessoal, @5551977776666 vai apresentar',
  );
});

test('applyMentionPlaceholders: número que é prefixo de outro não é dado como presente', () => {
  assert.equal(applyMentionPlaceholders('oi @5551999998888', [PREFIXO]), '@5551999 oi @5551999998888');
  assert.equal(
    applyMentionPlaceholders('oi @5551999998888', [ALLAN, PREFIXO]),
    '@5551999 oi @5551999998888',
  );
});

test('applyMentionPlaceholders: menção por LID usa os dígitos do LID no texto', () => {
  assert.equal(applyMentionPlaceholders('valeu @Jose', [JOSE_LID]), 'valeu @123456789012345');
});

test('applyMentionPlaceholders: "@Allan." no fim da frase é trocado, sem duplicar a menção', () => {
  assert.equal(applyMentionPlaceholders('Valeu @Allan.', [ALLAN]), 'Valeu @5551999998888.');
  assert.equal(applyMentionPlaceholders('Valeu @Allan...', [ALLAN]), 'Valeu @5551999998888...');
  assert.equal(applyMentionPlaceholders('@Allan- tudo certo?', [ALLAN]), '@5551999998888- tudo certo?');
});

test('applyMentionPlaceholders: ponto e hífen no meio do nome continuam fazendo parte dele', () => {
  const anaMaria = mencao('5551933332222@s.whatsapp.net', 'Ana-Maria', 'Ana-Maria');
  const joseSilva = mencao('5551944443333@s.whatsapp.net', 'jose.silva', 'jose.silva');
  assert.equal(applyMentionPlaceholders('oi @Ana-Maria.', [anaMaria]), 'oi @5551933332222.');
  assert.equal(applyMentionPlaceholders('e @jose.silva?', [joseSilva]), 'e @5551944443333?');
});

// --------------------------------------------------------- mentionsForChunk

test('mentionsForChunk: cada bubble leva só as menções cujo placeholder aparece nele', () => {
  const mentions = [ALLAN, BIA];
  assert.deepEqual(mentionsForChunk('@5551999998888 bom dia', mentions), ['5551999998888@s.whatsapp.net']);
  assert.deepEqual(mentionsForChunk('e você, @5551977776666?', mentions), ['5551977776666@s.whatsapp.net']);
  assert.deepEqual(mentionsForChunk('tchau', mentions), []);
  assert.deepEqual(mentionsForChunk('@5551977776666 e @5551999998888', mentions), [
    '5551999998888@s.whatsapp.net',
    '5551977776666@s.whatsapp.net',
  ]);
});

test('mentionsForChunk: prefixo não traz a menção errada (lookahead)', () => {
  assert.deepEqual(mentionsForChunk('oi @5551999998888', [PREFIXO]), []);
  assert.deepEqual(mentionsForChunk('oi @5551999998888', [PREFIXO, ALLAN]), ['5551999998888@s.whatsapp.net']);
});

test('mentionsForChunk: menção por LID notifica LID e telefone, sem repetir JID', () => {
  assert.deepEqual(mentionsForChunk('@123456789012345 e de novo @123456789012345', [JOSE_LID]), [
    '123456789012345@lid',
    '5551955554444@s.whatsapp.net',
  ]);
});

test('menções + split: cada bubble notifica exatamente quem aparece nele e ninguém some', () => {
  const texto = applyMentionPlaceholders(
    'Bom dia @Allan, pode revisar o PR hoje? Preciso disso até o almoço. Depois fala com a @Bia sobre o deploy.',
    [ALLAN, BIA],
  );
  const bubbles = splitBubbles(texto);
  assert.ok(bubbles.length >= 2);

  const porBubble = bubbles.map((b) => mentionsForChunk(b, [ALLAN, BIA]));
  for (const [i, b] of bubbles.entries()) {
    assert.equal(porBubble[i]?.includes(ALLAN.jid), b.includes(ALLAN.placeholder), b);
    assert.equal(porBubble[i]?.includes(BIA.jid), b.includes(BIA.placeholder), b);
  }
  const todos = new Set(porBubble.flat());
  assert.deepEqual([...todos].sort(), [ALLAN.jid, BIA.jid].sort(), 'toda menção pedida chega em algum bubble');
});
