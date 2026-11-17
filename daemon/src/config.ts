/**
 * Configuração e paths do wa-bridge.
 * Todo estado de runtime vive sob WA_BRIDGE_HOME e nada é escrito fora dele.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { VERSION } from './version.js';

/**
 * Identidade humana da instância, lida de `$WA_BRIDGE_HOME/account.json` (opcional).
 * Um daemon serve exatamente uma conta; com mais de uma instância rodando, é isto que
 * deixa painel e agentes dizerem de qual número se trata.
 */
export interface AccountInfo {
  /** Nome curto para o painel ("Pessoal", "Trabalho"). */
  label: string | null;
  /** Frase para o agente: o que é este número e quando usá-lo. */
  description: string | null;
  /** Cor de destaque do painel, `#rrggbb`. */
  color: string | null;
  /** Onde fica o token desta instância (para a dica da tela de login do painel). */
  tokenPath: string;
}

export interface QuietHours {
  startMinute: number;
  endMinute: number;
  raw: string;
}

export interface Config {
  home: string;
  authDir: string;
  dbPath: string;
  mediaDir: string;
  logFile: string;
  blocklistPath: string;
  modelsDir: string;
  port: number;
  host: '127.0.0.1';
  token: string;
  whisperBin: string;
  whisperModel: string;
  /** Idioma passado ao whisper (`pt`, `en`, ... ou `auto` para detectar). */
  whisperLanguage: string;
  ffmpegBin: string;
  quietHours: QuietHours;
  sendMaxDelayMs: number;
  draftTtlMs: number;
  sendsPerHour: number;
  logLevel: string;
  version: string;
  account: AccountInfo;
}

/** Converte "23:00-07:00" em minutos desde a meia-noite. */
function parseQuietHours(raw: string): QuietHours {
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) {
    throw new Error(`WA_QUIET_HOURS inválido: "${raw}" (esperado "HH:MM-HH:MM")`);
  }
  const [, sh, sm, eh, em] = match as unknown as [string, string, string, string, string];
  return {
    startMinute: Number(sh) * 60 + Number(sm),
    endMinute: Number(eh) * 60 + Number(em),
    raw: raw.trim(),
  };
}

/** Lê o Bearer token do disco; gera um na primeira execução com chmod 600. */
function loadOrCreateToken(home: string): string {
  const fromEnv = process.env.WA_BRIDGE_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const tokenPath = join(home, 'token');
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (existing.length > 0) return existing;
  }
  const generated = randomBytes(32).toString('base64url');
  writeFileSync(tokenPath, `${generated}\n`, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return generated;
}

/** Verdadeiro se o instante informado cai dentro da janela de silêncio. */
export function isQuietHour(config: Config, at: Date): boolean {
  const minute = at.getHours() * 60 + at.getMinutes();
  const { startMinute, endMinute } = config.quietHours;
  // Janela que cruza a meia-noite (ex.: 23:00-07:00).
  if (startMinute > endMinute) return minute >= startMinute || minute < endMinute;
  return minute >= startMinute && minute < endMinute;
}

/** Lê `account.json`. Ausente é o caso normal; inválido falha o boot, para o erro não passar calado. */
function loadAccount(home: string): AccountInfo {
  const path = join(home, 'account.json');
  const account: AccountInfo = { label: null, description: null, color: null, tokenPath: join(home, 'token') };
  if (!existsSync(path)) return account;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`account.json inválido em ${path}: ${(error as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`account.json inválido em ${path}: esperado um objeto`);
  }
  const data = raw as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = data[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new Error(`account.json: "${key}" precisa ser texto`);
    return value.trim() || null;
  };

  account.label = text('label');
  account.description = text('description');
  account.color = text('color');
  if (account.color && !/^#[0-9a-fA-F]{6}$/.test(account.color)) {
    throw new Error(`account.json: "color" precisa ser #rrggbb (veio "${account.color}")`);
  }
  return account;
}

/** Monta a configuração a partir do ambiente, criando os diretórios de estado. */
export function loadConfig(): Config {
  const home = resolve(process.env.WA_BRIDGE_HOME ?? join(homedir(), '.wa-bridge'));
  const dirs = [home, join(home, 'auth'), join(home, 'media'), join(home, 'logs'), join(home, 'models')];
  for (const dir of dirs) mkdirSync(dir, { recursive: true, mode: 0o700 });

  return {
    home,
    authDir: join(home, 'auth'),
    dbPath: join(home, 'wa.db'),
    mediaDir: join(home, 'media'),
    logFile: join(home, 'logs', 'daemon.log'),
    blocklistPath: join(home, 'blocklist.json'),
    modelsDir: join(home, 'models'),
    port: Number(process.env.WA_BRIDGE_PORT ?? 7788),
    host: '127.0.0.1',
    token: loadOrCreateToken(home),
    whisperBin: process.env.WHISPER_BIN ?? 'whisper-cli',
    whisperModel:
      process.env.WHISPER_MODEL ?? join(home, 'models', 'ggml-large-v3-turbo.bin'),
    whisperLanguage: process.env.WHISPER_LANGUAGE?.trim() || 'pt',
    ffmpegBin: process.env.FFMPEG_BIN ?? 'ffmpeg',
    quietHours: parseQuietHours(process.env.WA_QUIET_HOURS ?? '23:00-07:00'),
    sendMaxDelayMs: Number(process.env.WA_SEND_MAX_DELAY_MS ?? 45_000),
    draftTtlMs: Number(process.env.WA_DRAFT_TTL_MS ?? 300_000),
    sendsPerHour: Number(process.env.WA_SENDS_PER_HOUR ?? 10),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    version: VERSION,
    account: loadAccount(home),
  };
}

/**
 * Mascara um JID deixando só os 4 últimos dígitos visíveis.
 *
 * REGRA DE SEGURANÇA: só formata como telefone o que de fato é telefone
 * (`@s.whatsapp.net` / `@c.us`). O WhatsApp hoje endereça muita conversa por LID
 * (`@lid`), que é identificador opaco; formatá-lo como número produz coisas como
 * "+82 27 ****-5740" para um contato brasileiro. O preview do gate existe para o
 * humano RECONHECER o destinatário — número inventado ali é pior que nenhum, porque
 * convida a aprovar com base em informação falsa. Quando houver o telefone real
 * (via `key.senderPn`, guardado em `contacts.phone_jid`), passe ELE para esta função.
 */
export function maskNumber(jid: string): string {
  const [local = '', domain = ''] = jid.split('@');

  if (domain === 'g.us') return 'grupo';
  if (domain === 'broadcast' || domain === 'newsletter') return domain;

  const digits = local.replace(/\D/g, '');

  if (domain !== 's.whatsapp.net' && domain !== 'c.us') {
    const tail = digits.slice(-4);
    return tail.length > 0 ? `sem número (id ****${tail})` : 'sem número';
  }

  if (digits.length <= 4) return digits.length > 0 ? `****${digits}` : '****';
  const tail = digits.slice(-4);
  const country = digits.slice(0, 2);
  const area = digits.length >= 10 ? digits.slice(2, 4) : '';
  return `+${country} ${area} ****-${tail}`.replace(/\s+/g, ' ').trim();
}
