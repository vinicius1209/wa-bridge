/**
 * Saúde da instalação para o painel (`GET /status`): o que hoje só aparece espalhado
 * pelo terminal (versão, banco, mídia em disco, serviço, retenção, fila, streams).
 * Nada aqui é segredo: sem token, credencial nem número.
 */
import { existsSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Config, RetentionConfig } from '../config.js';
import type { EventHub } from '../events/hub.js';
import type { MediaProcessor } from '../media/processor.js';
import type { RetentionResult } from '../store/retention.js';
import type { Store } from '../store/store.js';

/** Medir a pasta de mídia percorre o disco: o resultado vale por este tempo. */
const MEDIA_SCAN_TTL_MS = 60_000;

/** Retrato da instalação devolvido por `GET /status`. */
export interface StatusSnapshot {
  version: string;
  pid: number;
  node: string;
  startedAt: number;
  /** Quem supervisiona o processo: `launchd (<rótulo>)`, `systemd`, `docker` ou `null` (script). */
  service: string | null;
  schemaVersion: number;
  dbBytes: number;
  media: { bytes: number; files: number; measuredAt: number };
  retention: RetentionConfig & { last: { at: number; result: RetentionResult } | null };
  historyDays: number;
  mediaQueue: { running: number; queued: number; max: number };
  eventStreams: number;
  whisperModel: { name: string; present: boolean };
  /** Permissão da pasta de estado em octal (`700` esperado), ou `null` se não deu para ler. */
  stateDirMode: string | null;
}

/** Descobre quem supervisiona o processo, pelas pistas que cada supervisor deixa no ambiente. */
export function detectService(env: NodeJS.ProcessEnv = process.env): string | null {
  const xpc = env.XPC_SERVICE_NAME;
  if (xpc && xpc.startsWith('local.wa-bridge')) return `launchd (${xpc})`;
  if (env.INVOCATION_ID) return 'systemd';
  if (existsSync('/.dockerenv')) return 'docker';
  return null;
}

/** Soma tamanho e quantidade de arquivos de uma pasta, recursivamente. */
async function measureDir(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await measureDir(path);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      try {
        bytes += (await stat(path)).size;
        files += 1;
      } catch {
        // arquivo sumiu no meio da varredura (retenção, por exemplo): ignora
      }
    }
  }
  return { bytes, files };
}

/** Tamanho de um arquivo, ou 0 se não existir. */
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Monta o retrato da instalação; guarda a última retenção e cacheia a medição da mídia. */
export class StatusProvider {
  private readonly config: Config;
  private readonly store: Store;
  private readonly media: MediaProcessor;
  private readonly events: EventHub;
  private readonly startedAt = Date.now();
  private lastRetention: { at: number; result: RetentionResult } | null = null;
  private mediaCache: { bytes: number; files: number; measuredAt: number } | null = null;

  constructor(deps: { config: Config; store: Store; media: MediaProcessor; events: EventHub }) {
    this.config = deps.config;
    this.store = deps.store;
    this.media = deps.media;
    this.events = deps.events;
  }

  /** Registra o resultado da última rodada de retenção. */
  recordRetention(result: RetentionResult, at: number = Date.now()): void {
    this.lastRetention = { at, result };
  }

  /** Retrato atual. A medição da pasta de mídia é refeita no máximo uma vez por minuto. */
  async snapshot(now: number = Date.now()): Promise<StatusSnapshot> {
    if (!this.mediaCache || now - this.mediaCache.measuredAt > MEDIA_SCAN_TTL_MS) {
      const measured = await measureDir(this.config.mediaDir);
      this.mediaCache = { ...measured, measuredAt: now };
    }
    let stateDirMode: string | null = null;
    try {
      stateDirMode = (statSync(this.config.home).mode & 0o777).toString(8);
    } catch {
      stateDirMode = null;
    }
    const db = this.config.dbPath;
    return {
      version: this.config.version,
      pid: process.pid,
      node: process.version,
      startedAt: this.startedAt,
      service: detectService(),
      schemaVersion: this.store.schemaVersion(),
      dbBytes: sizeOf(db) + sizeOf(`${db}-wal`) + sizeOf(`${db}-shm`),
      media: this.mediaCache,
      retention: { ...this.config.retention, last: this.lastRetention },
      historyDays: this.config.historyDays,
      mediaQueue: this.media.queueStats(),
      eventStreams: this.events.size,
      whisperModel: { name: basename(this.config.whisperModel), present: existsSync(this.config.whisperModel) },
      stateDirMode,
    };
  }
}
