/**
 * Menções (@marcar alguém) em mensagem de grupo.
 *
 * O WhatsApp exige DUAS coisas para uma menção funcionar, e errar uma delas falha
 * em silêncio: o JID da pessoa em `contextInfo.mentionedJid` (o que notifica) e um
 * literal `@<dígitos>` no texto (o que o app do destinatário renderiza como chip
 * clicável). Mandar só o JID notifica sem aparecer menção; mandar só o `@texto`
 * aparece como texto cru e não notifica ninguém. Este módulo garante o casamento.
 */

/** Menção já resolvida a um membro do grupo de destino. */
export interface ResolvedMention {
  /** JID de endereçamento do grupo — o que vai em `mentionedJid`. */
  jid: string;
  /** Telefone real, quando conhecido e diferente do `jid` (caso LID). */
  phoneJid: string | null;
  name: string | null;
  maskedNumber: string;
  /** Como o agente pediu a menção ("Allan", um número, ou o JID). */
  query: string;
  /** Literal que precisa aparecer no texto, ex. `@5551999998888`. */
  placeholder: string;
  /**
   * Todos os JIDs a notificar por esta menção. Em grupo endereçado por LID
   * mandamos LID e telefone: são a MESMA pessoa, e o app pode casar o
   * `@<dígitos>` do texto com qualquer um dos dois dependendo da versão.
   */
  mentionJids: string[];
}

/**
 * Captura tokens `@algumacoisa` escritos pelo agente, para trocar por `@<dígitos>`.
 * Ponto e hífen só valem no MEIO do nome (`@ana-maria`, `@jose.silva`): no fim são
 * pontuação da frase, e `@Allan.` precisa capturar `Allan`.
 */
const NAME_TOKEN_RE = /@([\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)*)/gu;

/** Remove acentos e normaliza caixa (mesma regra do helper homônimo em `store.ts`). */
function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Extrai só os dígitos de uma string (telefone ou JID). */
function onlyDigits(s: string): string {
  return s.replace(/\D/g, '');
}

/** Monta o literal `@<dígitos>` que o WhatsApp precisa ver no texto para um JID. */
export function placeholderFor(jid: string): string {
  const local = jid.split('@')[0] ?? '';
  return `@${onlyDigits(local)}`;
}

/**
 * Verdadeiro se o texto já contém este placeholder como número completo.
 *
 * O lookahead evita que `@5551999` case dentro de `@5551999998888` — dois membros
 * podem ter um prefixo em comum, e marcar a pessoa errada é pior que não marcar.
 */
export function containsPlaceholder(text: string, placeholder: string): boolean {
  const digits = placeholder.slice(1);
  if (digits.length === 0) return false;
  return new RegExp(`@${digits}(?!\\d)`).test(text);
}

/** Rótulos pelos quais o agente pode ter escrito `@Alguém` no texto. */
function labelsFor(mention: ResolvedMention): string[] {
  const raw = [mention.query, mention.name ?? ''];
  const labels = new Set<string>();
  for (const value of raw) {
    const normalized = normalizeText(value);
    if (normalized.length === 0 || normalized.includes('@') || onlyDigits(normalized).length >= 8) continue;
    labels.add(normalized);
    const first = normalized.split(/\s+/)[0];
    if (first && first.length > 0) labels.add(first);
  }
  return [...labels];
}

/**
 * Troca o primeiro `@Nome` que corresponda à menção pelo placeholder numérico.
 * Devolve `null` se não achou nada para trocar.
 *
 * Comparamos o token normalizado mas cortamos a string ORIGINAL pelos índices do
 * match — normalizar a string inteira mudaria o comprimento (NFD decompõe acento)
 * e os índices apontariam para o lugar errado.
 */
function replaceNameToken(text: string, mention: ResolvedMention): string | null {
  const labels = labelsFor(mention);
  if (labels.length === 0) return null;
  for (const match of text.matchAll(NAME_TOKEN_RE)) {
    const token = match[1] ?? '';
    if (!labels.includes(normalizeText(token))) continue;
    const start = match.index;
    const end = start + match[0].length;
    return text.slice(0, start) + mention.placeholder + text.slice(end);
  }
  return null;
}

/**
 * Garante que cada menção tem seu `@<dígitos>` no texto, devolvendo o texto final.
 *
 * Três casos, em ordem: o placeholder já está lá (não mexe); o agente escreveu
 * `@Allan` (troca pelo número — o app renderiza o nome de volta); nada (prefixa no
 * começo, que é como um humano marca alguém antes de falar).
 */
export function applyMentionPlaceholders(text: string, mentions: ResolvedMention[]): string {
  if (mentions.length === 0) return text;
  let out = text;
  const missing: string[] = [];
  for (const mention of mentions) {
    if (containsPlaceholder(out, mention.placeholder)) continue;
    const replaced = replaceNameToken(out, mention);
    if (replaced !== null) {
      out = replaced;
      continue;
    }
    missing.push(mention.placeholder);
  }
  if (missing.length > 0) out = `${missing.join(' ')} ${out}`.trim();
  return out;
}

/**
 * JIDs a notificar num pedaço específico do envio (um bubble, ou a legenda da mídia).
 *
 * O texto é fatiado em bubbles, e cada mensagem leva só as menções que de fato
 * aparecem nela: mandar `mentionedJid` num bubble onde o `@<dígitos>` não está
 * notifica a pessoa sem mostrar menção, e o bubble que tem o `@` ficaria texto cru.
 */
export function mentionsForChunk(chunk: string, mentions: ResolvedMention[]): string[] {
  const jids = new Set<string>();
  for (const mention of mentions) {
    if (!containsPlaceholder(chunk, mention.placeholder)) continue;
    for (const jid of mention.mentionJids) jids.add(jid);
  }
  return [...jids];
}
