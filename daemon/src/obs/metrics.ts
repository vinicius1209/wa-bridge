/**
 * Métricas de uso do wa-bridge: cada chamada de tool/rota é registrada em
 * `metrics_calls` e agregada para alimentar o dashboard (`MetricsSummary`).
 *
 * `recordCall` é chamado pelas rotas HTTP em `onResponse` — por isso tem que
 * ser barato e nunca propagar erro. Em vez de escrever no SQLite a cada
 * chamada, bufferizamos em memória e fazemos flush a cada ~500ms ou a cada
 * 50 registros, com flush síncrono final em `beforeExit`.
 */
import type { Store } from '../store/store.js';
import type { AuditEvent, CallRecord, MetricsSummary, MetricsTotals, SessionState } from '../types.js';

/** Intervalo máximo entre flushes do buffer de chamadas. */
const FLUSH_INTERVAL_MS = 500;
/** Tamanho do buffer que força um flush imediato. */
const FLUSH_THRESHOLD = 50;

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

/** Tamanho de bucket do timeline, adaptado à janela pedida. */
function bucketSizeMs(windowMs: number): number {
  if (windowMs <= TWO_HOURS_MS) return 5 * 60 * 1000;
  if (windowMs <= FORTY_EIGHT_HOURS_MS) return 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

/** Calcula um percentil por interpolação linear sobre uma lista já ordenada. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0] ?? 0;
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lowerIdx = Math.floor(rank);
  const upperIdx = Math.ceil(rank);
  const lower = sortedAsc[lowerIdx] ?? 0;
  const upper = sortedAsc[upperIdx] ?? lower;
  const weight = rank - lowerIdx;
  return lower + (upper - lower) * weight;
}

/** Estado de sessão honesto para quando nenhum provider foi registrado. */
function noSessionProvider(): SessionState {
  return {
    state: 'close',
    me: null,
    qrDataUrl: null,
    since: 0,
    lastError: 'session provider não registrado',
  };
}

/** Classe responsável por coletar e agregar métricas de uso do daemon. */
export class Metrics {
  private readonly store: Store;
  private buffer: CallRecord[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private sessionProvider: (() => SessionState) | null = null;

  constructor(store: Store) {
    this.store = store;
    // Último recurso: garante que nada fique só em memória se o processo sair.
    process.on('beforeExit', () => this.flush());
  }

  /**
   * Registra quem sabe o estado real da sessão Baileys. `Metrics` não recebe a
   * conexão no construtor (dependência circular), então `summary().session` só é
   * honesto depois que o `index.ts` chama isto.
   */
  setSessionProvider(fn: () => SessionState): void {
    this.sessionProvider = fn;
  }

  /** Registra uma chamada de tool/rota; nunca lança — falha de métrica não pode derrubar uma rota HTTP. */
  recordCall(c: CallRecord): void {
    try {
      this.buffer.push(c);
      if (this.buffer.length >= FLUSH_THRESHOLD) {
        this.flush();
      } else {
        this.scheduleFlush();
      }
    } catch (error) {
      console.error('metrics: falha ao bufferizar chamada', error);
    }
  }

  /** Agenda um flush do buffer se ainda não houver um pendente. */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    const timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    timer.unref();
    this.flushTimer = timer;
  }

  /** Grava o buffer pendente no Store de uma vez; captura e loga falhas sem propagar. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const pending = this.buffer;
    this.buffer = [];
    for (const call of pending) {
      try {
        this.store.insertCall(call);
      } catch (error) {
        console.error('metrics: falha ao gravar chamada', error);
      }
    }
  }

  /** Lista as chamadas mais recentes (já persistidas), do mais novo para o mais antigo. */
  recentCalls(limit: number): CallRecord[] {
    this.flush(); // garante que o que está só no buffer também apareça
    return this.store.recentCalls(limit);
  }

  /** Monta o `MetricsSummary` completo para a janela `windowMs`, no formato que o painel consome. */
  summary(windowMs: number): MetricsSummary {
    this.flush();
    const generatedAt = Date.now();
    const since = generatedAt - windowMs;

    // Uma consulta cobre a janela atual e a anterior (para a variação no painel).
    const callsBoth = this.store.callsSince(since - windowMs); // consulta indexada (idx_metrics_ts)
    const auditsBoth = this.store.auditSince(since - windowMs); // consulta indexada (idx_audit_ts)
    const calls = callsBoth.filter((c) => c.ts >= since);
    const audits = auditsBoth.filter((a) => a.ts >= since);

    return {
      windowMs,
      generatedAt,
      totals: this.computeTotals(calls, audits),
      previousTotals: this.computeTotals(
        callsBoth.filter((c) => c.ts < since),
        auditsBoth.filter((a) => a.ts < since),
      ),
      byAgent: this.computeByAgent(calls, audits),
      byTool: this.computeByTool(calls),
      timeline: this.computeTimeline(calls, audits, since, generatedAt),
      session: this.sessionProvider ? this.sessionProvider() : noSessionProvider(),
    };
  }

  /**
   * Totais da janela. `messagesRead` não tem uma contagem exata de mensagens
   * devolvidas disponível aqui (essa informação vive na rota HTTP, não no
   * `CallRecord`) — por isso é uma APROXIMAÇÃO: contamos quantas vezes a tool
   * `wa_read_messages` foi chamada com sucesso, não quantas mensagens foram
   * de fato devolvidas. Documentado conforme pedido, sem inventar um número.
   */
  private computeTotals(calls: CallRecord[], audits: AuditEvent[]): MetricsTotals {
    return {
      calls: calls.length,
      errors: calls.filter((c) => c.status === 'error').length,
      sends: audits.filter((a) => a.action === 'send.completed' && a.outcome === 'ok').length,
      cancels: audits.filter((a) => a.action === 'send.cancelled').length,
      blocked: audits.filter((a) => a.action === 'send.blocked').length,
      mediaProcessed: audits.filter((a) => a.action === 'media.materialized').length,
      messagesRead: calls.filter((c) => c.tool === 'wa_read_messages' && c.status === 'ok').length,
    };
  }

  /** Agrega calls/errors/sends/p50/p95 por agente. */
  private computeByAgent(calls: CallRecord[], audits: AuditEvent[]): MetricsSummary['byAgent'] {
    const agents = new Set<string>([...calls.map((c) => c.agent), ...audits.map((a) => a.agent)]);
    const result: MetricsSummary['byAgent'] = [];
    for (const agent of agents) {
      const agentCalls = calls.filter((c) => c.agent === agent);
      const durations = agentCalls.map((c) => c.durationMs).sort((a, b) => a - b);
      result.push({
        agent,
        calls: agentCalls.length,
        errors: agentCalls.filter((c) => c.status === 'error').length,
        sends: audits.filter(
          (a) => a.agent === agent && a.action === 'send.completed' && a.outcome === 'ok',
        ).length,
        p50Ms: percentile(durations, 50),
        p95Ms: percentile(durations, 95),
        lastCallAt: agentCalls.length > 0 ? Math.max(...agentCalls.map((c) => c.ts)) : null,
      });
    }
    return result.sort((a, b) => b.calls - a.calls);
  }

  /** Agrega calls/errors/p95 por tool. */
  private computeByTool(calls: CallRecord[]): MetricsSummary['byTool'] {
    const tools = new Set(calls.map((c) => c.tool));
    const result: MetricsSummary['byTool'] = [];
    for (const tool of tools) {
      const toolCalls = calls.filter((c) => c.tool === tool);
      const durations = toolCalls.map((c) => c.durationMs).sort((a, b) => a - b);
      result.push({
        tool,
        calls: toolCalls.length,
        errors: toolCalls.filter((c) => c.status === 'error').length,
        p95Ms: percentile(durations, 95),
      });
    }
    return result.sort((a, b) => b.calls - a.calls);
  }

  /** Monta a série temporal com buckets de tamanho adaptativo, incluindo buckets vazios. */
  private computeTimeline(
    calls: CallRecord[],
    audits: AuditEvent[],
    since: number,
    now: number,
  ): MetricsSummary['timeline'] {
    const bucketMs = bucketSizeMs(now - since);
    const startBucket = Math.floor(since / bucketMs) * bucketMs;
    const endBucket = Math.floor(now / bucketMs) * bucketMs;

    const buckets = new Map<number, { calls: number; sends: number; errors: number }>();
    for (let ts = startBucket; ts <= endBucket; ts += bucketMs) {
      buckets.set(ts, { calls: 0, sends: 0, errors: 0 });
    }

    for (const call of calls) {
      const bucketTs = Math.floor(call.ts / bucketMs) * bucketMs;
      const entry = buckets.get(bucketTs);
      if (!entry) continue; // fora da janela computada (não deveria ocorrer)
      entry.calls += 1;
      if (call.status === 'error') entry.errors += 1;
    }

    for (const audit of audits) {
      if (audit.action !== 'send.completed' || audit.outcome !== 'ok') continue;
      const bucketTs = Math.floor(audit.ts / bucketMs) * bucketMs;
      const entry = buckets.get(bucketTs);
      if (entry) entry.sends += 1;
    }

    return Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([bucketTs, agg]) => ({ bucketTs, ...agg }));
  }
}
