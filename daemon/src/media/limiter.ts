/**
 * Limite de concorrência para tarefas assíncronas: no máximo `max` rodando ao mesmo
 * tempo, o resto espera em fila na ordem de chegada (FIFO).
 */
export class ConcurrencyLimiter {
  private readonly max: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`limite de concorrência inválido: ${max}`);
    this.max = max;
  }

  /** Roda `task` assim que houver vaga; a vaga é liberada mesmo se a tarefa falhar. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /** Tarefas rodando agora. */
  get running(): number {
    return this.active;
  }

  /** Tarefas esperando vaga. */
  get queued(): number {
    return this.waiting.length;
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    // Com fila, a vaga passa direto para o próximo: `active` não muda.
    if (next) next();
    else this.active -= 1;
  }
}
