/**
 * Materialização de mídia do WhatsApp: download, transcrição local (whisper.cpp) e
 * extração de keyframes de vídeo (ffmpeg). Nunca interpreta conteúdo com LLM — quem
 * "vê" a imagem é o agente consumidor, que recebe apenas o `path`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { downloadMediaMessage, getContentType } from '@whiskeysockets/baileys';
import type { WAMessage, WAMessageContent } from '@whiskeysockets/baileys';

import type { Config } from '../config.js';
import type { Store } from '../store/store.js';
import type { WhatsAppConnection } from '../whatsapp/connection.js';
import type { Logger, MediaArtifact, MediaKind } from '../types.js';
import { ConcurrencyLimiter } from './limiter.js';

/** Teto de tempo para qualquer chamada ao ffmpeg/ffprobe. */
const FFMPEG_TIMEOUT_MS = 60_000;
/** Teto de tempo para a transcrição via whisper-cli (modelos grandes são lentos). */
const WHISPER_TIMEOUT_MS = 300_000;
/** Teto de keyframes extraídos por vídeo, conforme contrato. */
const MAX_FRAMES = 12;

/** Extensões conhecidas por mime type; fallback por `kind` quando o mime é exótico. */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

const FALLBACK_EXT_BY_KIND: Record<MediaKind, string> = {
  image: 'jpg',
  video: 'mp4',
  audio: 'ogg',
  document: 'bin',
  sticker: 'webp',
};

/** Erros "leves": a mídia materializou, só a parte extra (transcrição/frames) falhou. */
const SOFT_ERROR_PREFIXES = [
  'WHISPER_MODEL_MISSING',
  'WHISPER_FAILED',
  'FFMPEG_AUDIO_EXTRACT_FAILED',
  'FFMPEG_FRAMES_FAILED',
];

type RawResolution = { content: WAMessageContent; chatJid: string; fromMe: boolean };

/** Mapeia a chave de conteúdo do Baileys para o `MediaKind` do contrato. */
function kindFromContentType(contentType: keyof WAMessageContent | undefined): MediaKind | null {
  switch (contentType) {
    case 'imageMessage':
      return 'image';
    case 'videoMessage':
      return 'video';
    case 'audioMessage':
      return 'audio';
    case 'documentMessage':
      return 'document';
    case 'stickerMessage':
      return 'sticker';
    default:
      return null;
  }
}

/** Troca tudo que não é `[A-Za-z0-9._-]` por `_`, para usar o JID como nome de pasta. */
function sanitizeJidForPath(jid: string): string {
  return jid.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Escolhe a extensão de arquivo a partir do mime, com fallback por tipo de mídia. */
function extensionFromMime(mime: string, kind: MediaKind): string {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return EXT_BY_MIME[base] ?? EXT_BY_MIME[mime.toLowerCase()] ?? FALLBACK_EXT_BY_KIND[kind];
}

/** Normaliza qualquer `unknown` capturado em `catch` para uma mensagem de erro legível. */
function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Sufixo curto e aleatório para nomes de arquivo temporário. */
function randomSuffix(): string {
  return randomBytes(4).toString('hex');
}

/** Verdadeiro se o erro de download indica mídia expirada nos servidores do WhatsApp (410/404). */
function isExpiredMediaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const rec = error as Record<string, unknown>;
  const output = rec.output as Record<string, unknown> | undefined;
  if (output?.statusCode === 410 || output?.statusCode === 404) return true;
  const response = rec.response as Record<string, unknown> | undefined;
  if (response?.status === 410 || response?.status === 404) return true;
  return false;
}

/** Verdadeiro se o erro registrado no artifact é "leve" (mídia ok, só extra faltou). */
function isSoftError(error: string | null): boolean {
  if (error === null) return true;
  return SOFT_ERROR_PREFIXES.some((prefix) => error.startsWith(prefix));
}

/** Executa um binário externo com array de argumentos (sem shell), com timeout obrigatório. */
function runProcess(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * Baixa, transcreve (áudio local via whisper.cpp) e extrai keyframes (ffmpeg) da mídia
 * de uma mensagem do WhatsApp, de forma idempotente e deduplicada entre chamadas concorrentes.
 */
export class MediaProcessor {
  private readonly wa: WhatsAppConnection;
  private readonly store: Store;
  private readonly log: Logger;
  private readonly home: string;
  private readonly config: Config;
  /** Trabalhos em voo por messageId, para colapsar chamadas concorrentes na mesma promise. */
  private readonly inFlight = new Map<string, Promise<MediaArtifact>>();
  /**
   * Teto de mídias processando ao mesmo tempo (`WA_MEDIA_CONCURRENCY`). Cada whisper
   * carrega o modelo inteiro na memória e disputa a GPU: sem teto, um agente pedindo 30
   * áudios de uma vez abria 30 processos.
   */
  private readonly limiter: ConcurrencyLimiter;

  constructor(deps: { wa: WhatsAppConnection; store: Store; log: Logger; home: string; config: Config }) {
    this.wa = deps.wa;
    this.store = deps.store;
    this.log = deps.log;
    this.home = deps.home;
    this.config = deps.config;
    this.limiter = new ConcurrencyLimiter(deps.config.mediaConcurrency);
  }

  /**
   * Materializa a mídia de `messageId` em disco, idempotente e sem baixar duas vezes em
   * paralelo. Passado o teto de concorrência, a chamada espera na fila.
   */
  async materialize(
    messageId: string,
    opts: { transcribe?: boolean; frames?: boolean } = {},
  ): Promise<MediaArtifact> {
    const existing = this.inFlight.get(messageId);
    if (existing) return existing;

    const job = this.limiter.run(() => this.doMaterialize(messageId, opts)).finally(() => {
      this.inFlight.delete(messageId);
    });
    this.inFlight.set(messageId, job);
    return job;
  }

  /** Implementação de fato de `materialize`, sem a lógica de deduplicação de chamadas. */
  private async doMaterialize(
    messageId: string,
    opts: { transcribe?: boolean; frames?: boolean },
  ): Promise<MediaArtifact> {
    const cached = this.store.getMedia(messageId);
    // Áudio cujo arquivo a retenção apagou: o que o agente usa é a transcrição, e ela
    // ficou no banco. Não há por que baixar de novo.
    if (cached?.error === 'PRUNED' && cached.kind === 'audio' && cached.transcript !== null) return cached;
    if (cached && cached.path.length > 0 && existsSync(cached.path) && isSoftError(cached.error)) {
      if (cached.error === null) {
        const wantTranscript =
          Boolean(opts.transcribe) && cached.transcript === null && (cached.kind === 'audio' || cached.kind === 'video');
        const wantFrames = Boolean(opts.frames) && cached.kind === 'video' && cached.framePaths.length === 0;
        if (!wantTranscript && !wantFrames) return cached;
      }
      return this.completeCached(cached, opts);
    }

    const resolved = this.resolveRaw(messageId);
    if (!resolved) {
      return this.finish(
        {
          messageId,
          kind: 'document',
          mime: '',
          path: '',
          bytes: 0,
          durationMs: null,
          transcript: null,
          framePaths: [],
          viewOnce: false,
          error: 'RAW_UNAVAILABLE',
        },
        'failed',
      );
    }

    const { content, chatJid, fromMe } = resolved;
    // viewOnce é avaliado sobre o raw original, ANTES do unwrap — é o próprio objeto que
    // carrega o invólucro viewOnceMessage(V2/Extension) que o unwrap remove.
    const viewOnce = this.wa.isViewOnceMessage(content);
    const unwrapped = this.wa.unwrapRawMessage(content);
    const contentType = getContentType(unwrapped);
    const kind = contentType ? kindFromContentType(contentType) : null;

    if (!kind || !contentType) {
      return this.finish(
        {
          messageId,
          kind: 'document',
          mime: '',
          path: '',
          bytes: 0,
          durationMs: null,
          transcript: null,
          framePaths: [],
          viewOnce,
          error: `UNSUPPORTED_MEDIA_TYPE: ${String(contentType)}`,
        },
        'failed',
      );
    }

    const mediaField = (unwrapped as Record<string, unknown>)[contentType] as
      | { mimetype?: string | null; seconds?: number | null }
      | null
      | undefined;
    const mime = mediaField?.mimetype ?? 'application/octet-stream';

    const chatDir = join(this.config.mediaDir, sanitizeJidForPath(chatJid));
    await mkdir(chatDir, { recursive: true });
    const ext = extensionFromMime(mime, kind);
    const mediaPath = join(chatDir, `${messageId}.${ext}`);

    // downloadMediaMessage exige um WAMessage completo (key + message); como só temos o
    // conteúdo, construímos a chave minimamente a partir do que já sabemos. `fromMe` tem
    // que ser o real: chave errada quebra o download de mídia de mensagem própria.
    const waMessage: WAMessage = {
      key: { remoteJid: chatJid, id: messageId, fromMe },
      message: unwrapped,
    };

    let buffer: Buffer;
    try {
      buffer = await downloadMediaMessage(waMessage, 'buffer', {});
    } catch (error) {
      if (isExpiredMediaError(error)) {
        this.log.warn({ messageId, chatJid }, 'mídia expirada nos servidores do WhatsApp');
        return this.finish(
          { messageId, kind, mime, path: '', bytes: 0, durationMs: null, transcript: null, framePaths: [], viewOnce, error: 'MEDIA_EXPIRED' },
          'expired',
        );
      }
      this.log.error({ messageId, error: toMessage(error) }, 'falha ao baixar mídia do WhatsApp');
      return this.finish(
        {
          messageId,
          kind,
          mime,
          path: '',
          bytes: 0,
          durationMs: null,
          transcript: null,
          framePaths: [],
          viewOnce,
          error: `DOWNLOAD_FAILED: ${toMessage(error)}`,
        },
        'failed',
      );
    }

    await writeFile(mediaPath, buffer);

    const artifact: MediaArtifact = {
      messageId,
      kind,
      mime,
      path: mediaPath,
      bytes: buffer.length,
      durationMs: typeof mediaField?.seconds === 'number' ? mediaField.seconds * 1000 : null,
      transcript: null,
      framePaths: [],
      viewOnce,
      error: null,
    };
    const errorParts: string[] = [];

    if (kind === 'audio') {
      if (artifact.durationMs === null) artifact.durationMs = await this.probeDurationMs(mediaPath);
      if (opts.transcribe) {
        const result = await this.transcribeAudio(messageId, mediaPath, chatDir, false);
        artifact.transcript = result.transcript;
        if (result.error) errorParts.push(result.error);
      }
    } else if (kind === 'video') {
      if (artifact.durationMs === null) artifact.durationMs = await this.probeDurationMs(mediaPath);
      if (opts.transcribe) {
        const hasAudio = await this.hasAudioStream(mediaPath);
        if (hasAudio) {
          const result = await this.transcribeAudio(messageId, mediaPath, chatDir, true);
          artifact.transcript = result.transcript;
          if (result.error) errorParts.push(result.error);
        }
        // vídeo sem trilha de áudio não é erro: transcript permanece null.
      }
      if (opts.frames) {
        const result = await this.extractFrames(messageId, mediaPath, chatDir);
        artifact.framePaths = result.framePaths;
        if (result.error) errorParts.push(result.error);
      }
    }
    // imagem, sticker e documento: só materializa — nunca chama LLM aqui.

    artifact.error = errorParts.length > 0 ? errorParts.join('; ') : null;
    return this.finish(artifact, artifact.error && !isSoftError(artifact.error) ? 'failed' : 'ready');
  }

  /** Completa transcrição e/ou frames de um artifact já em cache, sem rebaixar o arquivo original. */
  private async completeCached(
    cached: MediaArtifact,
    opts: { transcribe?: boolean; frames?: boolean },
  ): Promise<MediaArtifact> {
    const chatDir = dirname(cached.path);
    const artifact: MediaArtifact = { ...cached, framePaths: [...cached.framePaths] };
    const errorParts: string[] = [];

    if (opts.transcribe && artifact.transcript === null && (cached.kind === 'audio' || cached.kind === 'video')) {
      if (cached.kind === 'video') {
        const hasAudio = await this.hasAudioStream(cached.path);
        if (hasAudio) {
          const result = await this.transcribeAudio(cached.messageId, cached.path, chatDir, true);
          artifact.transcript = result.transcript;
          if (result.error) errorParts.push(result.error);
        }
      } else {
        const result = await this.transcribeAudio(cached.messageId, cached.path, chatDir, false);
        artifact.transcript = result.transcript;
        if (result.error) errorParts.push(result.error);
      }
      if (artifact.durationMs === null) artifact.durationMs = await this.probeDurationMs(cached.path);
    }

    if (opts.frames && cached.kind === 'video' && artifact.framePaths.length === 0) {
      const result = await this.extractFrames(cached.messageId, cached.path, chatDir);
      artifact.framePaths = result.framePaths;
      if (result.error) errorParts.push(result.error);
    }

    artifact.error = errorParts.length > 0 ? errorParts.join('; ') : null;
    return this.finish(artifact, artifact.error && !isSoftError(artifact.error) ? 'failed' : 'ready');
  }

  /**
   * Obtém o `WAMessageContent` da mensagem e o `chatJid` para nomear o diretório de mídia.
   * Tenta primeiro o raw em memória (`wa.getRawMessage`); se não existir mais, reparseia o
   * `raw_json` persistido pelo store na hora do recebimento.
   */
  private resolveRaw(messageId: string): RawResolution | null {
    const stored = this.store.getMessage(messageId);
    const live = this.wa.getRawMessage(messageId);
    if (live) {
      return { content: live, chatJid: stored?.chatJid ?? messageId, fromMe: stored?.fromMe ?? false };
    }
    const persisted = this.extractPersistedRaw(messageId);
    if (persisted && stored) {
      return { content: persisted, chatJid: stored.chatJid, fromMe: stored.fromMe };
    }
    return null;
  }

  /**
   * Reparseia o `raw_json` persistido da mensagem. É o caminho que faz mídia antiga
   * (de antes do último restart do daemon, quando o cache em memória já não tem o raw)
   * continuar materializável — sem isso tudo cai em RAW_UNAVAILABLE.
   */
  private extractPersistedRaw(messageId: string): WAMessageContent | null {
    const rawJson = this.store.getRawJson(messageId);
    if (rawJson === null || rawJson.length === 0) return null;
    try {
      // `raw_json` guarda o WAMessage INTEIRO (`{key, message, messageTimestamp, ...}`),
      // enquanto o cache em memória de `getRawMessage` guarda só o `message` interno.
      // Devolver o invólucro aqui faz `getContentType` não reconhecer nada e o artefato
      // morrer com UNSUPPORTED_MEDIA_TYPE. Normalizamos para o conteúdo interno.
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      const inner = parsed.message;
      if (inner && typeof inner === 'object') return inner as WAMessageContent;
      return parsed as WAMessageContent;
    } catch (error) {
      this.log.warn({ error: toMessage(error) }, 'raw_json persistido inválido');
      return null;
    }
  }

  /**
   * Converte para WAV 16kHz mono e transcreve com whisper-cli. Se `audioOptional` for
   * verdadeiro (caso de vídeo) e a extração de áudio falhar, não é tratado como erro.
   */
  private async transcribeAudio(
    messageId: string,
    sourcePath: string,
    chatDir: string,
    audioOptional: boolean,
  ): Promise<{ transcript: string | null; error: string | null }> {
    if (!existsSync(this.config.whisperModel)) {
      this.log.warn(
        { model: this.config.whisperModel },
        'modelo whisper ausente — rode `./wa-bridge setup` (baixa o modelo) ou aponte WHISPER_MODEL para um .bin',
      );
      return { transcript: null, error: `WHISPER_MODEL_MISSING: ${this.config.whisperModel}` };
    }

    const wavPath = join(tmpdir(), `wa-bridge-${messageId}-${randomSuffix()}.wav`);
    try {
      try {
        // ffmpeg -y -i <origem> -vn -ar 16000 -ac 1 -c:a pcm_s16le <wav>
        await runProcess(
          this.config.ffmpegBin,
          ['-y', '-i', sourcePath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
          FFMPEG_TIMEOUT_MS,
        );
      } catch (error) {
        if (audioOptional) return { transcript: null, error: null };
        return { transcript: null, error: `FFMPEG_AUDIO_EXTRACT_FAILED: ${toMessage(error)}` };
      }

      const outBase = join(tmpdir(), `wa-bridge-whisper-${messageId}-${randomSuffix()}`);
      try {
        // whisper-cli -m <model> -f <wav> -l <idioma> -otxt -of <saida_sem_extensao> --no-prints
        await runProcess(
          this.config.whisperBin,
          ['-m', this.config.whisperModel, '-f', wavPath, '-l', this.config.whisperLanguage, '-otxt', '-of', outBase, '--no-prints'],
          WHISPER_TIMEOUT_MS,
        );
        const txtPath = `${outBase}.txt`;
        const rawText = await readFile(txtPath, 'utf8');
        await unlink(txtPath).catch(() => {});
        const transcript = rawText.replace(/\s+/g, ' ').trim();
        await writeFile(join(chatDir, `${messageId}.transcript.txt`), transcript, 'utf8');
        return { transcript, error: null };
      } catch (error) {
        return { transcript: null, error: `WHISPER_FAILED: ${toMessage(error)}` };
      }
    } finally {
      await unlink(wavPath).catch(() => {});
    }
  }

  /** Extrai até `MAX_FRAMES` keyframes a 1 por 3s em `<messageId>.frames/frame-%03d.jpg`. */
  private async extractFrames(
    messageId: string,
    videoPath: string,
    chatDir: string,
  ): Promise<{ framePaths: string[]; error: string | null }> {
    const framesDir = join(chatDir, `${messageId}.frames`);
    try {
      await mkdir(framesDir, { recursive: true });
      // ffmpeg -y -i <video> -vf fps=1/3 -frames:v 12 -q:v 3 <dir>/frame-%03d.jpg
      await runProcess(
        this.config.ffmpegBin,
        ['-y', '-i', videoPath, '-vf', 'fps=1/3', '-frames:v', String(MAX_FRAMES), '-q:v', '3', join(framesDir, 'frame-%03d.jpg')],
        FFMPEG_TIMEOUT_MS,
      );
      const entries = await readdir(framesDir);
      const framePaths = entries
        .filter((name) => name.endsWith('.jpg'))
        .sort()
        .map((name) => join(framesDir, name));
      return { framePaths, error: null };
    } catch (error) {
      return { framePaths: [], error: `FFMPEG_FRAMES_FAILED: ${toMessage(error)}` };
    }
  }

  /** Verdadeiro se o arquivo de mídia tiver ao menos uma trilha de áudio (via ffprobe). */
  private async hasAudioStream(filePath: string): Promise<boolean> {
    try {
      const bin = this.ffprobeBin();
      const { stdout } = await runProcess(
        bin,
        ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath],
        FFMPEG_TIMEOUT_MS,
      );
      return stdout.trim().length > 0;
    } catch (error) {
      this.log.debug({ error: toMessage(error) }, 'ffprobe falhou ao checar trilha de áudio');
      return false;
    }
  }

  /** Lê a duração em ms via ffprobe; `null` se o probe falhar ou a duração não vier no stdout. */
  private async probeDurationMs(filePath: string): Promise<number | null> {
    try {
      const bin = this.ffprobeBin();
      const { stdout } = await runProcess(
        bin,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
        FFMPEG_TIMEOUT_MS,
      );
      const seconds = Number.parseFloat(stdout.trim());
      if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
      return null;
    } catch (error) {
      this.log.debug({ error: toMessage(error) }, 'ffprobe falhou ao ler duração');
      return null;
    }
  }

  /** Deriva o binário do ffprobe a partir de `config.ffmpegBin`, trocando o basename. */
  private ffprobeBin(): string {
    const dir = dirname(this.config.ffmpegBin);
    const base = basename(this.config.ffmpegBin).replace(/ffmpeg/i, 'ffprobe');
    return dir === '.' ? base : join(dir, base);
  }

  /** Persiste o artifact (sempre, inclusive em erro) e loga o desfecho. */
  private finish(artifact: MediaArtifact, state: 'ready' | 'failed' | 'expired'): MediaArtifact {
    // Uma transcrição conhecida nunca se perde: quando a retenção apagou o arquivo e o
    // download de novo falha (ex.: MEDIA_EXPIRED), o texto que já existia continua.
    if (artifact.transcript === null) {
      const previous = this.store.getMedia(artifact.messageId);
      if (previous?.transcript) artifact.transcript = previous.transcript;
    }
    // store.saveMedia é quem mantém messages.media_state coerente com o artifact
    // (ready/failed/expired) — não há método separado no contrato para isso.
    this.store.saveMedia(artifact);
    if (state === 'ready' && artifact.error === null) {
      this.log.info({ messageId: artifact.messageId, kind: artifact.kind }, 'mídia materializada');
    } else {
      this.log.warn({ messageId: artifact.messageId, kind: artifact.kind, state, error: artifact.error }, 'mídia processada com observação');
    }
    return artifact;
  }
}
