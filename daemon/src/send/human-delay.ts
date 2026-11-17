/**
 * Simulação de digitação humana: quebra o texto em "bubbles" (balões), monta um
 * plano de tempos (leitura, digitação com jitter, pausas) e executa esse plano
 * emitindo presença no WhatsApp. Não é anti-ban: é naturalidade para quem recebe
 * e uma janela de oportunidade para `wa_cancel` funcionar antes do envio.
 */
import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DelayPlan } from '../types.js';

// --------------------------------------------------------------- constantes

const READ_MIN_MS = 1500;
const READ_MAX_MS = 4000;
const CHARS_PER_SECOND = 5;
const TYPE_JITTER_SIGMA = 0.25;
const TYPE_MAX_MS = 20_000;
const PAUSE_MIN_MS = 800;
const PAUSE_MAX_MS = 2500;
const PRESENCE_REFRESH_MS = 8000; // a presença "composing"/"paused" expira no WhatsApp
/** Latência de ida e volta por `sendMessage`, medida em envio real (~2,6s/bubble). */
const NETWORK_PER_BUBBLE_MS = 2600;
const MIN_BUBBLES = 2;
const MAX_BUBBLES = 4;
const SHORT_TEXT_THRESHOLD = 120;
const LARGE_FENCE_RE = /```[\s\S]*?```/g;
const URL_RE = /(https?:\/\/\S+|www\.\S+)/gi;
// fronteira de frase: terminador(es) + fecho opcional de aspas/parênteses + espaço,
// seguido de algo que pareça início de nova frase (maiúscula, dígito, aspas, parêntese).
/**
 * Fronteira de sentença.
 *
 * O lookahead aceita minúscula de propósito. Exigir maiúscula depois do ponto é a
 * convenção de texto formal, mas mensagem de WhatsApp raramente é formal — quem escreve
 * tudo em minúsculo ficaria com ZERO fronteiras e levaria uma parede de texto num bubble
 * só, que é exatamente o que o split existe para evitar. O preço de aceitar minúscula é
 * cortar em abreviação ("etc. e tal"), e disso cuida `ABBREV_BEFORE_RE`.
 */
const SENTENCE_BOUNDARY_RE = /[.!?…]+[)"'”’]*\s+(?=[\p{L}\p{N}"'“(])/gu;

/**
 * Abreviações e iniciais que terminam em ponto sem encerrar a frase. Usado para
 * descartar fronteiras falsas (ex.: "sr. silva", "etc. e tal", "j. silva").
 */
const ABBREV_BEFORE_RE =
  /(?:^|[\s(])(?:sr|sra|srta|dr|dra|prof|profa|etc|ex|vs|obs|aprox|num|núm|pag|pág|fig|art|av|cia|ltda|jr|tel|cel|est|\p{L})[.!?…]+[)"'”’]*\s*$/iu;
/**
 * Marcador de lista numerada no começo da linha ("1. Arroz"). O ponto dele não encerra
 * frase: cortar ali deixaria o número num bubble e o item no seguinte. Só no começo da
 * linha, para "o jogo é às 20. Leva bola" continuar sendo fronteira.
 */
const LIST_MARKER_BEFORE_RE = /(?:^|\n)[ \t]*\d{1,3}\.\s*$/u;
// pontuação "forte" o suficiente para justificar split mesmo em texto curto.
const STRONG_PUNCT_RE = /[.!?…]\s|[.!?…]$/u;

type Span = { start: number; end: number };

/** Gera um PRNG determinístico simples (mulberry32) a partir de uma seed numérica. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fonte de aleatoriedade [0,1) criptograficamente forte, usada quando não há seed. */
function cryptoRng(): number {
  // randomInt é exclusivo no limite superior; usamos um denominador grande para granularidade.
  return randomInt(0, 1_000_000_000) / 1_000_000_000;
}

/** Normal padrão (média 0, desvio 1) via transformação de Box-Muller. */
function standardNormal(rng: () => number): number {
  const u1 = Math.max(rng(), Number.EPSILON); // evita log(0)
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Multiplicador log-normal (média ~1 para sigma pequeno) para o jitter de digitação. */
function lognormalJitter(rng: () => number, sigma: number): number {
  return Math.exp(sigma * standardNormal(rng));
}

/** Conta code points (não code units) — seguro para surrogate pairs e sequências ZWJ. */
function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** Acha todos os blocos de código cercados por ``` no texto original (índices UTF-16). */
function findCodeFences(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(LARGE_FENCE_RE)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/** Acha URLs fora dos trechos já mascarados (ex.: código), para nunca cortar no meio delas. */
function findUrls(maskedText: string): Span[] {
  const spans: Span[] = [];
  for (const match of maskedText.matchAll(URL_RE)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/**
 * Substitui os trechos indicados por um caractere neutro ('#'), preservando o
 * comprimento exato (em code units) para que os índices continuem válidos na
 * string original. Usado para blindar código/URLs contra o regex de frase.
 */
function maskSpans(text: string, spans: Span[]): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of sorted) {
    out += text.slice(cursor, span.start);
    out += '#'.repeat(span.end - span.start);
    cursor = span.end;
  }
  out += text.slice(cursor);
  return out;
}

/** Divide `text` em 2-4 bubbles por fronteira de frase, sem cortar palavra/URL/código/emoji. */
export function splitBubbles(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const codeSpans = findCodeFences(trimmed);
  const maskedForCode = maskSpans(trimmed, codeSpans);
  const urlSpans = findUrls(maskedForCode);
  const fullyMasked = maskSpans(maskedForCode, urlSpans);

  // Texto curto sem pontuação forte: um bubble só, sempre.
  if (trimmed.length < SHORT_TEXT_THRESHOLD && codeSpans.length === 0 && !STRONG_PUNCT_RE.test(trimmed)) {
    return [trimmed];
  }

  const sentenceBoundaries: number[] = [];
  for (const match of fullyMasked.matchAll(SENTENCE_BOUNDARY_RE)) {
    // Descarta fronteira que na verdade é abreviação ou inicial ("etc. e tal"), ou o
    // marcador de um item de lista numerada.
    const before = fullyMasked.slice(0, match.index + match[0].length);
    if (ABBREV_BEFORE_RE.test(before) || LIST_MARKER_BEFORE_RE.test(before)) continue;
    sentenceBoundaries.push(match.index + match[0].length);
  }

  const forced = new Set<number>();
  for (const span of codeSpans) {
    forced.add(span.start);
    forced.add(span.end);
  }
  for (const b of sentenceBoundaries) forced.add(b);
  forced.add(0);
  forced.add(trimmed.length);

  const cuts = [...forced].sort((a, b) => a - b);
  const codeStarts = new Set(codeSpans.map((s) => s.start));

  type Segment = { text: string; isCode: boolean };
  const segments: Segment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i] as number;
    const end = cuts[i + 1] as number;
    const raw = trimmed.slice(start, end);
    const content = raw.trim();
    if (content.length === 0) continue;
    segments.push({ text: content, isCode: codeStarts.has(start) });
  }

  if (segments.length === 0) return [trimmed];

  // Comprime excesso de bubbles (>4) mesclando vizinhos simples (nunca um bloco de código).
  while (segments.length > MAX_BUBBLES) {
    let mergeAt = -1;
    let smallest = Infinity;
    for (let i = 0; i < segments.length - 1; i++) {
      const a = segments[i] as Segment;
      const b = segments[i + 1] as Segment;
      if (a.isCode || b.isCode) continue;
      const combined = a.text.length + b.text.length;
      if (combined < smallest) {
        smallest = combined;
        mergeAt = i;
      }
    }
    if (mergeAt === -1) break; // só restam blocos de código isolados; não há o que mesclar
    const a = segments[mergeAt] as Segment;
    const b = segments[mergeAt + 1] as Segment;
    segments.splice(mergeAt, 2, { text: `${a.text} ${b.text}`, isCode: false });
  }

  void MIN_BUBBLES; // documentado no contrato como meta, não como mínimo rígido quando não há fronteira natural
  return segments.map((s) => s.text);
}

/** Produz o plano de delay humano para os bubbles. Com `seed`, é determinístico. */
export function planDelay(bubbles: string[], seed?: number): DelayPlan {
  const rng = seed !== undefined ? mulberry32(seed) : cryptoRng;
  const readMs = Math.round(READ_MIN_MS + rng() * (READ_MAX_MS - READ_MIN_MS));

  const planBubbles = bubbles.map((text, i) => {
    const chars = codePointLength(text);
    const baseTypeMs = (chars / CHARS_PER_SECOND) * 1000;
    const jitter = lognormalJitter(rng, TYPE_JITTER_SIGMA);
    const typeMs = Math.min(TYPE_MAX_MS, Math.max(200, Math.round(baseTypeMs * jitter)));
    const isLast = i === bubbles.length - 1;
    const pauseAfterMs = isLast ? 0 : Math.round(PAUSE_MIN_MS + rng() * (PAUSE_MAX_MS - PAUSE_MIN_MS));
    return { text, typeMs, pauseAfterMs };
  });

  // O `totalMs` é o ETA que o gate devolve, e é a janela de cancelamento que o humano
  // enxerga. Só somar os tempos planejados subestima: cada `sendMessage` tem ida e volta
  // de rede que o plano não controla. Medido num envio real de 3 bubbles: 23,6s planejados
  // contra 31,5s reais (~2,6s por bubble). Contabilizamos essa latência aqui para o ETA
  // não mentir — ela NÃO vira espera artificial, só entra na estimativa.
  const plannedMs = readMs + planBubbles.reduce((sum, b) => sum + b.typeMs + b.pauseAfterMs, 0);
  const totalMs = plannedMs + planBubbles.length * NETWORK_PER_BUBBLE_MS;

  return { readMs, bubbles: planBubbles, totalMs, compressed: false };
}

/**
 * Comprime proporcionalmente um `DelayPlan` para caber em `maxMs`, sem jamais
 * truncar texto — só os tempos são reduzidos. Usado pelo gate com `config.sendMaxDelayMs`.
 */
export function compressPlan(plan: DelayPlan, maxMs: number): DelayPlan {
  if (plan.totalMs <= maxMs || plan.totalMs === 0) return plan;

  // A rede é custo fixo que não dá para comprimir — ninguém acelera um round-trip
  // encurtando o "digitando". Então ela sai do orçamento ANTES, e a compressão atua só
  // sobre o que é de fato controlável. Comprimir contra `maxMs` cheio e somar a rede
  // depois estouraria o teto justamente nos planos que ele deveria limitar.
  const networkMs = plan.bubbles.length * NETWORK_PER_BUBBLE_MS;
  const budgetMs = Math.max(1000, maxMs - networkMs);
  const plannedBefore = plan.totalMs - networkMs;
  const ratio = plannedBefore > 0 ? budgetMs / plannedBefore : 1;
  // `floor`, não `round`: a soma de valores arredondados para cima estoura o orçamento
  // por alguns milissegundos e o plano passa a violar o teto que deveria respeitar.
  // Com piso, a soma é sempre <= orçamento. Os mínimos (100ms/500ms) podem estourar em
  // casos patológicos com dezenas de bubbles; aí o ETA reporta o valor honesto.
  const bubbles = plan.bubbles.map((b) => ({
    text: b.text,
    typeMs: Math.max(100, Math.floor(b.typeMs * ratio)),
    pauseAfterMs: Math.floor(b.pauseAfterMs * ratio),
  }));
  const readMs = Math.max(500, Math.floor(plan.readMs * ratio));
  // Mesma regra do `planDelay`: a latência de rede entra no ETA, senão o plano comprimido
  // volta a subestimar a janela de cancelamento.
  const plannedMs = readMs + bubbles.reduce((sum, b) => sum + b.typeMs + b.pauseAfterMs, 0);
  const totalMs = plannedMs + bubbles.length * NETWORK_PER_BUBBLE_MS;
  return { readMs, bubbles, totalMs, compressed: true };
}

/** Espera `totalMs` em fatias de até 8s, reemitindo presença e checando aborto a cada fatia. */
async function waitWithPresence(
  totalMs: number,
  emitPresence: () => Promise<void>,
  shouldAbort: () => boolean,
): Promise<boolean> {
  if (shouldAbort()) return true;
  await emitPresence();
  let remaining = totalMs;
  while (remaining > 0) {
    const chunk = Math.min(PRESENCE_REFRESH_MS, remaining);
    await sleep(chunk);
    remaining -= chunk;
    if (shouldAbort()) return true;
    if (remaining > 0) await emitPresence(); // a presença expira no WhatsApp; reemite
  }
  return false;
}

/**
 * Executa o plano: `composing` antes de cada bubble, `paused` entre bubbles, ao final e
 * ao abortar. Nunca `available`: marcar a conta como online faz o celular parar de
 * notificar (ver `markOnlineOnConnect` na conexão). Consulta `shouldAbort` antes de cada
 * bubble e em toda reemissão de presença. Devolve os ids já enviados.
 */
export async function executePlan(
  plan: DelayPlan,
  io: {
    presence: (p: 'composing' | 'paused') => Promise<void>;
    send: (bubble: string) => Promise<string>;
    shouldAbort: () => boolean;
  },
): Promise<string[]> {
  const sent: string[] = [];

  const abortedDuringRead = await waitWithPresence(
    plan.readMs,
    () => io.presence('composing'),
    io.shouldAbort,
  );
  if (abortedDuringRead) {
    await io.presence('paused');
    return sent;
  }

  for (const bubble of plan.bubbles) {
    if (io.shouldAbort()) {
      await io.presence('paused');
      return sent;
    }

    const abortedWhileTyping = await waitWithPresence(
      bubble.typeMs,
      () => io.presence('composing'),
      io.shouldAbort,
    );
    if (abortedWhileTyping) {
      await io.presence('paused');
      return sent;
    }

    const id = await io.send(bubble.text);
    sent.push(id);

    if (bubble.pauseAfterMs > 0) {
      const abortedWhilePaused = await waitWithPresence(
        bubble.pauseAfterMs,
        () => io.presence('paused'),
        io.shouldAbort,
      );
      if (abortedWhilePaused) {
        await io.presence('paused');
        return sent;
      }
    }
  }

  await io.presence('paused');
  return sent;
}
