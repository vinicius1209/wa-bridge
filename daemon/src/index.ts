/**
 * Bootstrap do wa-daemon: costura os módulos e define a ordem de inicialização.
 */
import { loadConfig, restrictStateDirs } from './config.js';
import { createApi } from './api/server.js';
import { EventHub } from './events/hub.js';
import { MediaProcessor } from './media/processor.js';
import { Audit } from './obs/audit.js';
import { createLogger } from './obs/log.js';
import { Metrics } from './obs/metrics.js';
import { StatusProvider } from './obs/status.js';
import { SendGate } from './send/gate.js';
import { RETENTION_INTERVAL_MS, runRetention } from './store/retention.js';
import { Store } from './store/store.js';
import { WhatsAppConnection } from './whatsapp/connection.js';

/** Teto para o desligamento limpo; passou disso, sai mesmo assim (launchd/systemd matam depois). */
const SHUTDOWN_TIMEOUT_MS = 8_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, file: config.logFile });

  log.info({ home: config.home, port: config.port, version: config.version }, 'iniciando wa-daemon');
  for (const warning of restrictStateDirs(config)) log.warn(warning);

  // 1. Persistência primeiro: todo o resto depende do store.
  const store = new Store(config.dbPath);
  store.migrate();
  log.info({ schema: store.schemaVersion() }, 'banco migrado');
  const orphans = store.failOrphanSends(Date.now());
  if (orphans > 0) log.warn({ orphans }, 'envios interrompidos pelo último encerramento marcados como falha');

  // 2. Observabilidade antes do WhatsApp, para capturar eventos de pareamento.
  const metrics = new Metrics(store);
  const audit = new Audit(store);
  const events = new EventHub();

  // 3. Conexão WhatsApp. Única dona das credenciais e do socket.
  const wa = new WhatsAppConnection({
    store,
    log,
    metrics,
    home: config.home,
    historyDays: config.historyDays,
    deviceName: config.deviceName,
  });

  // O `Metrics` não recebe a conexão no construtor (dependência circular), então o estado
  // da sessão chega por provider. Sem este wiring o dashboard mostra a sessão sempre fechada.
  metrics.setSessionProvider(() => wa.getSessionState());

  // 4. Mídia e gate de envio dependem da conexão viva.
  const media = new MediaProcessor({ wa, store, log, home: config.home, config });
  const gate = new SendGate({ wa, store, log, metrics, audit, config });

  const status = new StatusProvider({ config, store, media, events });

  // 5. HTTP só sobe depois que tudo existe, para nunca servir 500 por dependência nula.
  const api = await createApi({ config, store, wa, media, gate, metrics, audit, events, status, log });

  // Mensagem nova (ao vivo ou da fila offline) vai para o stream `/events`. Histórico
  // importado no pareamento não passa por `onMessage`.
  wa.onMessage((message) => {
    events.publishMessage(message, store.getChatName(message.chatJid));
  });

  // Retenção no boot e a cada 6h. Falha aqui nunca derruba o daemon.
  const retention = (): void => {
    runRetention({ store, log, config })
      .then((result) => status.recordRetention(result))
      .catch((error: unknown) => log.error({ error }, 'falha na retenção'));
  };
  retention();
  const retentionTimer = setInterval(retention, RETENTION_INTERVAL_MS);
  retentionTimer.unref();

  await wa.connect();
  await api.listen({ host: config.host, port: config.port });

  log.info(
    { url: `http://${config.host}:${config.port}`, dashboard: `http://${config.host}:${config.port}/dashboard` },
    'wa-daemon pronto',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'encerrando wa-daemon');
    setTimeout(() => {
      log.warn('desligamento passou do tempo; saindo assim mesmo');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    clearInterval(retentionTimer);
    try {
      await api.close();
    } catch (error) {
      log.error({ error }, 'falha ao fechar a API');
    }
    // Fecha o socket do WhatsApp sem logout: a credencial continua valendo no próximo boot.
    wa.close();
    // `process.exit` não dispara `beforeExit`: sem isto as últimas chamadas somem das métricas.
    metrics.flush();
    try {
      store.close();
    } catch (error) {
      log.error({ error }, 'falha ao fechar o banco');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (process.argv.includes('--pair')) {
    await wa.forcePair();
  }
}

main().catch((error: unknown) => {
  console.error('falha fatal no wa-daemon:', error);
  process.exit(1);
});
