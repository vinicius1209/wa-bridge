/**
 * Retenção: limpa o que só cresce. Arquivos de mídia saem depois de
 * `WA_RETENTION_MEDIA_DAYS` (a transcrição fica no banco), mensagens depois de
 * `WA_RETENTION_MESSAGES_DAYS`, chamadas de métrica e rascunhos vencidos depois de
 * `WA_RETENTION_METRICS_DAYS`. A auditoria nunca é apagada: é append-only por contrato.
 */
import { rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Config } from '../config.js';
import type { Logger, MediaFiles } from '../types.js';
import type { Store } from './store.js';

const DAY_MS = 86_400_000;

/** De quanto em quanto tempo o daemon roda a retenção (além do boot). */
export const RETENTION_INTERVAL_MS = 6 * 3_600_000;

/** Mídias processadas por lote, para não segurar o banco numa consulta gigante. */
const MEDIA_BATCH = 500;

/** O que uma rodada de retenção apagou. */
export interface RetentionResult {
  messages: number;
  mediaFiles: number;
  calls: number;
  drafts: number;
}

/** Verdadeiro se `target` está dentro de `root` (nunca apagamos nada fora da pasta de mídia). */
function isInside(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Remove do disco o arquivo de uma mídia, os keyframes e o `.transcript.txt` dela. */
async function removeMediaFiles(files: MediaFiles, mediaDir: string): Promise<void> {
  if (files.path.length === 0) return;
  const dir = dirname(files.path);
  const targets = [
    files.path,
    join(dir, `${files.messageId}.transcript.txt`),
    join(dir, `${files.messageId}.frames`),
  ];
  for (const target of targets) {
    if (!isInside(target, mediaDir)) continue;
    await rm(target, { recursive: true, force: true });
  }
}

/** Aplica a retenção uma vez. Item com `0` dias fica desligado. */
export async function runRetention(
  deps: { store: Store; log: Logger; config: Config },
  now: number = Date.now(),
): Promise<RetentionResult> {
  const { store, log, config } = deps;
  const { messagesDays, mediaDays, metricsDays } = config.retention;
  const result: RetentionResult = { messages: 0, mediaFiles: 0, calls: 0, drafts: 0 };

  if (messagesDays > 0) {
    const { deleted, files } = store.deleteMessagesBefore(now - messagesDays * DAY_MS);
    result.messages = deleted;
    for (const f of files) {
      try {
        await removeMediaFiles(f, config.mediaDir);
      } catch (error) {
        log.warn({ error, messageId: f.messageId }, 'retenção: falha ao apagar arquivo de mídia');
      }
    }
  }

  if (mediaDays > 0) {
    const cutoff = now - mediaDays * DAY_MS;
    // Lote a lote. Arquivo que não sai (permissão, por exemplo) fica para a próxima
    // rodada; se um lote inteiro falhar, para aqui em vez de girar no mesmo lote.
    for (;;) {
      const batch = store.mediaFilesProcessedBefore(cutoff, MEDIA_BATCH);
      let pruned = 0;
      for (const f of batch) {
        try {
          await removeMediaFiles(f, config.mediaDir);
          store.markMediaPruned(f.messageId);
          pruned += 1;
        } catch (error) {
          log.warn({ error, messageId: f.messageId }, 'retenção: falha ao apagar arquivo de mídia');
        }
      }
      result.mediaFiles += pruned;
      if (batch.length < MEDIA_BATCH || pruned === 0) break;
    }
  }

  if (metricsDays > 0) {
    const cutoff = now - metricsDays * DAY_MS;
    result.calls = store.deleteCallsBefore(cutoff);
    result.drafts = store.deleteDraftsExpiredBefore(cutoff);
  }

  const total = result.messages + result.mediaFiles + result.calls + result.drafts;
  if (total > 0) log.info({ ...result }, 'retenção aplicada');
  else log.debug('retenção: nada a apagar');
  return result;
}
