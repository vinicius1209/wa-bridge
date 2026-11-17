/**
 * Cliente HTTP stateless que fala com o daemon wa-bridge via fetch nativo.
 * Nenhuma lógica de negócio aqui — só transporte, auth e tradução de erro.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_URL = 'http://127.0.0.1:7788';

/**
 * Tool MCP em execução. Vai no header `X-WA-Tool` para o daemon registrar nas métricas o
 * nome da tool (`wa_read_messages`) em vez da rota HTTP. Contexto assíncrono, e não uma
 * variável global, porque o cliente pode chamar várias tools ao mesmo tempo.
 */
export const currentTool = new AsyncLocalStorage<string>();
const DEFAULT_TIMEOUT_MS = 30_000;
/** Timeout estendido para /media/:id — transcrição local de vídeo é lenta. */
export const MEDIA_TIMEOUT_MS = 360_000;

/** Corpo de erro padronizado devolvido pelo daemon em qualquer rota. */
interface DaemonErrorBody {
  error?: {
    code?: string;
    message?: string;
    detail?: unknown;
  };
}

/** Erro de alto nível pronto para ser mostrado ao modelo, com code/detail preservados. */
export class WaBridgeClientError extends Error {
  readonly code: string | undefined;
  readonly detail: unknown;

  constructor(message: string, code?: string, detail?: unknown) {
    super(message);
    this.name = 'WaBridgeClientError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Descreve a conta WhatsApp deste daemon para o agente: `WA_ACCOUNT_LABEL` (override)
 * ou `description`/`label` de `<WA_BRIDGE_HOME>/account.json`, o mesmo arquivo que
 * o daemon usa para o painel. Lido do disco, não do HTTP, para não atrasar o boot do
 * shim nem depender do daemon estar de pé.
 */
export function resolveAccountLabel(): string | null {
  const fromEnv = process.env.WA_ACCOUNT_LABEL?.trim();
  if (fromEnv) return fromEnv;
  const home = process.env.WA_BRIDGE_HOME ?? join(homedir(), '.wa-bridge');
  try {
    const data = JSON.parse(readFileSync(join(home, 'account.json'), 'utf8')) as Record<string, unknown>;
    for (const key of ['description', 'label']) {
      const value = data[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    // Sem account.json (ou ilegível): o shim segue sem instrução de conta.
  }
  return null;
}

/** Lê o Bearer token de WA_BRIDGE_TOKEN ou de `<WA_BRIDGE_HOME>/token`, já trimado. */
function resolveToken(): string | null {
  const fromEnv = process.env.WA_BRIDGE_TOKEN;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  const home = process.env.WA_BRIDGE_HOME ?? join(homedir(), '.wa-bridge');
  try {
    const raw = readFileSync(join(home, 'token'), 'utf8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** Monta a URL base do daemon a partir de WA_BRIDGE_URL, com default local. */
function resolveBaseUrl(): string {
  const url = process.env.WA_BRIDGE_URL;
  return url && url.trim().length > 0 ? url.trim() : DEFAULT_URL;
}

/** Nome do agente chamador, enviado em X-WA-Agent para métricas do daemon. */
function resolveAgentName(): string {
  return process.env.WA_AGENT_NAME ?? 'unknown';
}

export interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

/** Monta a querystring a partir de um objeto, ignorando valores undefined. */
function buildQuery(query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

/**
 * Executa uma requisição HTTP contra o daemon, injetando auth e traduzindo erros.
 * Lança `WaBridgeClientError` em qualquer falha (sem token, sem conexão, erro HTTP).
 */
export async function requestDaemon<T>(opts: RequestOptions): Promise<T> {
  const token = resolveToken();
  if (!token) {
    throw new WaBridgeClientError(
      'Token do daemon não encontrado (procurado em $WA_BRIDGE_HOME/token, padrão ' +
        '~/.wa-bridge/token). Suba o daemon com `./wa-bridge start` na pasta do projeto, ' +
        'ou defina WA_BRIDGE_TOKEN / WA_BRIDGE_HOME na config do MCP.',
      'NO_TOKEN',
    );
  }

  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}${opts.path}${buildQuery(opts.query)}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetch(url, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-WA-Agent': resolveAgentName(),
        ...(currentTool.getStore() ? { 'X-WA-Tool': currentTool.getStore() } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new WaBridgeClientError(
        `Timeout de ${timeoutMs}ms ao chamar o daemon em ${baseUrl}${opts.path}.`,
        'TIMEOUT',
      );
    }
    throw new WaBridgeClientError(
      `Não foi possível conectar ao daemon em ${baseUrl}. Ele está fora do ar? ` +
        'Suba com `./wa-bridge start` na pasta do projeto e confira com `./wa-bridge status`.',
      'CONNECTION_REFUSED',
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!response.ok) {
    let body: DaemonErrorBody = {};
    try {
      body = (await response.json()) as DaemonErrorBody;
    } catch {
      // corpo não era JSON; segue com mensagem genérica
    }
    const code = body.error?.code ?? `HTTP_${response.status}`;
    const message = body.error?.message ?? `Erro HTTP ${response.status} em ${opts.path}.`;
    throw new WaBridgeClientError(message, code, body.error?.detail);
  }

  return (await response.json()) as T;
}
