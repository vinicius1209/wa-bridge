/**
 * Stream de eventos do daemon (`GET /events`, Server-Sent Events). Transmite cada
 * mensagem nova que chega, para quem precisa reagir sem ficar consultando `/chats`
 * (notificação, scripts, um agente escutando).
 *
 * O conteúdo é texto de terceiros: quem consome trata como dado, nunca como instrução.
 */
import type { ServerResponse } from 'node:http';
import type { StoredMessage } from '../types.js';

/** Intervalo do comentário de keep-alive (proxies e o próprio cliente derrubam conexão muda). */
const HEARTBEAT_MS = 25_000;

/** Cliente que não lê o que mandamos é desligado antes de acumular memória sem fim. */
const MAX_BUFFERED_BYTES = 1_000_000;

/** Filtros de um cliente conectado. */
export interface StreamFilter {
  /** Inclui mensagens enviadas pelo próprio número (default: não). */
  includeFromMe: boolean;
  /** Só mensagens desta conversa, quando informado. */
  chatJid: string | null;
}

/** Payload do evento `message`. */
export interface MessageEventData {
  message: StoredMessage;
  chatName: string | null;
}

interface Client {
  res: ServerResponse;
  filter: StreamFilter;
  heartbeat: NodeJS.Timeout;
}

/** Formata um evento SSE. `JSON.stringify` não gera quebra de linha, então `data:` é uma linha só. */
function formatEvent(event: string, data: unknown, id?: string): string {
  return `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Mantém os clientes SSE conectados e distribui os eventos entre eles. */
export class EventHub {
  private readonly clients = new Set<Client>();
  private readonly maxClients: number;

  constructor(maxClients = 20) {
    this.maxClients = maxClients;
  }

  /** Clientes conectados agora. */
  get size(): number {
    return this.clients.size;
  }

  /** Verdadeiro se ainda cabe mais um cliente. */
  hasRoom(): boolean {
    return this.clients.size < this.maxClients;
  }

  /**
   * Passa a transmitir para `res` (headers já escritos por quem chama). Manda o evento
   * `ready` com `hello` na hora e devolve a função que desconecta o cliente.
   */
  attach(res: ServerResponse, filter: StreamFilter, hello: unknown): () => void {
    const client: Client = {
      res,
      filter,
      heartbeat: setInterval(() => this.write(client, ': ping\n\n'), HEARTBEAT_MS),
    };
    client.heartbeat.unref();
    this.clients.add(client);
    // `retry` diz ao cliente SSE quanto esperar antes de reconectar sozinho.
    this.write(client, `retry: 5000\n\n${formatEvent('ready', hello)}`);
    return () => this.detach(client);
  }

  /** Publica uma mensagem nova para os clientes cujo filtro aceita. */
  publishMessage(message: StoredMessage, chatName: string | null): void {
    const payload = formatEvent('message', { message, chatName } satisfies MessageEventData, message.id);
    for (const client of this.clients) {
      if (message.fromMe && !client.filter.includeFromMe) continue;
      if (client.filter.chatJid && client.filter.chatJid !== message.chatJid) continue;
      this.write(client, payload);
    }
  }

  /** Encerra todos os streams (desligamento): sem isto o `close` do HTTP esperaria para sempre. */
  closeAll(): void {
    for (const client of [...this.clients]) {
      this.detach(client);
      client.res.end();
    }
  }

  private write(client: Client, chunk: string): void {
    if (client.res.writableEnded || client.res.destroyed) {
      this.detach(client);
      return;
    }
    if (client.res.writableLength > MAX_BUFFERED_BYTES) {
      this.detach(client);
      client.res.destroy();
      return;
    }
    client.res.write(chunk);
  }

  private detach(client: Client): void {
    clearInterval(client.heartbeat);
    this.clients.delete(client);
  }
}
