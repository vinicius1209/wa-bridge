# Operação

O caminho padrão é o script `./wa-bridge` (`setup`, `start`, `stop`, `status`, `logs`,
`service`, `open`, `qr`, `pair`, `mcp-config`, `doctor`). Este documento cobre o resto: rodar como
serviço (launchd/systemd), Docker, pareamento, troubleshooting, backup e reset.

> **Script nativo, serviço e Docker são formas EXCLUDENTES de rodar o wa-bridge, nunca
> complementares.** Escolha uma. Rodar os dois ao mesmo tempo (ou um `npm run
> dev` manual junto com qualquer um dos dois) é o cenário mais perigoso do
> projeto: duas sessões Baileys concorrentes lendo/escrevendo
> `~/.wa-bridge/auth` derrubam a conta do WhatsApp com `device_removed` e
> exigem reparelhamento (escanear QR de novo). Antes de subir um, pare o
> outro.

## Docker

Alternativa ao script nativo: builda a imagem do daemon (Node 24 + ffmpeg +
whisper-cli compilado para a arquitetura da máquina, arm64 ou amd64) e sobe num container. O `mcp/`
**não** entra na imagem — o shim MCP continua rodando no **host**, spawnado
por cada agente (Claude Code, Codex, opencode...) exatamente como hoje; ele
fala com o daemon por HTTP em `127.0.0.1:7788`, então a configuração dos
agentes **não muda nada**, Docker ou não.

### Por que o caminho de mídia funciona igual dentro e fora

O daemon devolve caminhos absolutos de arquivo (`MediaArtifact.path`,
`framePaths`) que quem lê é o agente de código rodando no **host**. O
`docker-compose.yml` faz bind-mount de `${HOME}/.wa-bridge` no **mesmo
caminho absoluto** dentro do container e aponta `WA_BRIDGE_HOME` para lá —
então um path como `/Users/voce/.wa-bridge/media/.../foo.jpg` resolve
identicamente dos dois lados. Isso depende de `$HOME` estar definido no
shell que roda `docker compose` (é o padrão em qualquer shell de login).

### Comandos

```bash
npm run docker:build   # docker compose build
npm run docker:up      # docker compose up -d (primeira vez / depois de down)
npm run docker:stop    # pausa: mantém o container e a sessão pareada
npm run docker:start   # retoma de onde parou, sem reparear
npm run docker:logs    # docker compose logs -f wa-bridge
npm run docker:down    # remove o container (mas NÃO o bind-mount —
                        # ~/.wa-bridge e a sessão pareada sobrevivem)
npm run docker:shell   # shell dentro do container, para inspeção/debug
```

**`stop`/`start` vs. `down`** — a distinção que importa: `stop` e `start`
preservam o container parado/pausado (estado interno intacto, reinício
rápido). `down` remove o container e a rede do compose, mas como
`~/.wa-bridge` é um **bind-mount** (não um volume Docker), apagar o
container não apaga nada do estado — `auth/`, `wa.db`, `media/`, `token`
continuam no disco do Mac. Rodar `docker:up` de novo recria o container e
ele volta a usar a mesma sessão, sem reparelhamento.

### Pareamento dentro do container

O QR não aparece em TTY nenhum quando o processo roda num container. Dois
caminhos:

1. **Dashboard** — `http://127.0.0.1:7788/dashboard/` (com a barra final;
   existe um redirect 308 de `/dashboard` para `/dashboard/`, mas prefira a
   forma com barra). O QR aparece ali quando a sessão está em `pairing`.
2. **Logs** — `docker compose logs -f wa-bridge` ou `npm run docker:logs`
   (o pino do daemon grava em `~/.wa-bridge/logs/daemon.log`, visível via
   bind-mount também pelo host; `docker logs` normalmente não mostra nada
   porque o logger escreve em arquivo, não em stdout).

Para **forçar um novo pareamento** (sessão morta, `device_removed`, etc.),
rode o `--pair` dentro do próprio container:

```bash
docker compose exec wa-bridge node dist/index.js --pair
```

(ou pare o container, apague `~/.wa-bridge/auth` no host, e suba de novo —
mesmo procedimento documentado abaixo para o modo launchd.)

### Detalhe de rede: por que a porta publicada não é `7788:7788` por dentro

O daemon sempre faz bind em
`127.0.0.1` — uma garantia de segurança intencional. Dentro de um
container, `127.0.0.1` é a loopback **do próprio container**, isolada da
rede: o encaminhamento de porta do Docker chega pela interface externa
(`eth0`), nunca pela loopback, então um bind estritamente em `127.0.0.1`
fica inalcançável de fora *mesmo publicando a porta* — isso não é bug do
projeto, é como containers funcionam em qualquer Docker, em qualquer SO.

A solução, sem tocar uma linha do daemon: a imagem sobe, ao lado do `node
dist/index.js`, um `socat` (`docker/entrypoint.sh`) que escuta em
`0.0.0.0:17788` **dentro** do container e repassa para
`127.0.0.1:7788` (onde o daemon realmente está). O `docker-compose.yml`
mapeia `127.0.0.1:7788` do **host** para a porta `17788` do container. Por
fora, nada muda — ainda é `127.0.0.1:7788`, ainda nunca é `0.0.0.0` do
host, e a garantia de bind em loopback continua intacta no
código. É só um detalhe de encanamento interno do container.

### Resultado medido (MacBook M1 Pro, Docker Desktop 29.4.3, 8 CPU / 8 GB)

- **Build do zero** (`docker compose build --no-cache`): ~3min25s.
- **Tamanho final da imagem**: ~1,05 GB.
- **HTTP**: `/health` → `ok:true`, sessão `open` sem reparelhamento;
  `/dashboard/` → 200; `/metrics/summary` sem token → 401; com
  `Authorization: Bearer $(cat ~/.wa-bridge/token)` → 200.
- **Path idêntico**: um arquivo escrito pelo container em
  `$WA_BRIDGE_HOME/media/...` aparece no host no mesmo caminho absoluto
  (confirmado).
- **`stop`/`start`**: checksum de `~/.wa-bridge/auth/` idêntico antes e
  depois; sessão volta a `open` sem escanear QR.
- **Whisper dentro do container é sensivelmente mais lento que no host.**
  Para 12,16s de áudio (frase de teste gerada com `say`), o host transcreveu
  em **4,25s**; o mesmo arquivo, mesmo modelo (`ggml-large-v3-turbo.bin`),
  dentro do container levou **173,75s** com o limite padrão de 4 CPUs
  (threads=4), e **70,78s** com 8 threads/sem limite de CPU — ainda ~16x
  mais lento que o host mesmo usando todos os núcleos. **O motivo não é a
  conteinerização em si: o whisper-cli do Homebrew usado no host carrega um
  backend Metal** (`load_backend: loaded MTL backend from
  .../libggml-metal.so`), ou seja, ele **usa a GPU do M1 Pro**, apesar da
  suposição inicial de que seria "CPU-only". Não existe Metal em Linux, então
  o whisper-cli compilado dentro do container (Debian/aarch64) roda em CPU
  pura e paga o preço disso. **Isso é uma regressão real de performance ao
  conteinerizar**, não um erro de configuração — reportado aqui para decisão
  consciente: se a latência de transcrição em uso real for um problema, a
  alternativa é manter o daemon no host (launchd) especificamente para
  manter a aceleração Metal, ou aceitar o custo em troca da conveniência de
  "um comando sobe, um comando pausa".

  Medição independente, feita depois, com áudio de **19,8s** e os limites
  padrão do compose: host **3,13s**, container **180,58s** — **58x mais
  lento**, ou seja, 9x *abaixo* do tempo real. Um áudio de 1 minuto levaria
  cerca de 9 minutos.

### Veredito: no Mac, use o script nativo; Docker é para servidor Linux

Interpretar áudio e vídeo é requisito central deste projeto, e o container o
inviabiliza. **No macOS o caminho padrão é `./wa-bridge start|stop`**, que
preserva o Metal e sobe/pausa com a mesma facilidade.

O Docker aqui não é desperdício: ele é o caminho para rodar o wa-bridge num
**servidor Linux** (onde não há Metal a perder de qualquer forma) e para
reproduzir o ambiente. Só não é a forma de rodar num Mac.

Nunca rode os dois ao mesmo tempo: as duas instâncias compartilhariam
`~/.wa-bridge/auth` e o WhatsApp derrubaria a sessão com `device_removed`.
O `./wa-bridge start` já se recusa a subir se houver container de pé.

## Rodando como serviço no macOS (launchd)

```bash
./wa-bridge service install     # instala (ou atualiza) e sobe; para antes o daemon do script
./wa-bridge service status      # carregado?, caminho do plist e do Node que vai rodar
./wa-bridge service uninstall   # para e remove; o daemon não sobe mais sozinho
```

O `install` grava `~/Library/LaunchAgents/local.wa-bridge.plist` (`RunAtLoad` e
`KeepAlive`: sobe no login e reinicia se cair). Instância com outra porta ganha o rótulo
`local.wa-bridge.<porta>`, então cada número tem o seu serviço:

```bash
WA_BRIDGE_HOME=~/.wa-bridge-trabalho WA_BRIDGE_PORT=7789 ./wa-bridge service install
```

O plist não chama o `node` direto: chama `bin/wa-bridge-daemon`, que a cada boot

- resolve um Node 24+ sem depender do PATH (o mesmo `resolve-node.sh` do shim MCP), então
  trocar de versão no nvm não quebra o serviço;
- lê o `.env` da raiz, que o launchd não leria sozinho. Mudou o `.env`? Rode
  `./wa-bridge restart`.

**Com o serviço instalado, o script vira controle remoto do launchd:**

| Comando | O que faz com o serviço |
|---|---|
| `./wa-bridge start` | carrega o serviço (`bootstrap`) ou garante o processo de pé (`kickstart`) |
| `./wa-bridge stop` | descarrega (`bootout`); volta no próximo login ou com `start` |
| `./wa-bridge restart` | `kickstart -k`: o próprio launchd encerra e sobe de novo |
| `./wa-bridge status` / `doctor` | mostram `serviço: launchd (local.wa-bridge)` |

O script nunca sobe um processo próprio ao lado do serviço. Isso importa porque o daemon
abre a conexão com o WhatsApp antes de ocupar a porta: um segundo processo chegaria a
iniciar a sessão antes de falhar, e duas sessões na mesma credencial derrubam a conta com
`device_removed`. Continua valendo: não rode `npm run dev` nem o Docker junto.

Depois de mudar o código: `npm run build` e `./wa-bridge restart`.

Logs do serviço: `~/.wa-bridge/logs/daemon.log` (o principal), mais `launchd.out.log` e
`launchd.err.log` (o `./wa-bridge logs` acompanha os três).

## Rodando como serviço no Linux (systemd, usuário)

Crie `~/.config/systemd/user/wa-bridge.service` (ajuste os caminhos):

```ini
[Unit]
Description=wa-bridge (WhatsApp para agentes)
After=network-online.target

[Service]
WorkingDirectory=/caminho/absoluto/para/wa-bridge/daemon
ExecStart=/caminho/absoluto/para/node /caminho/absoluto/para/wa-bridge/daemon/dist/index.js
Environment=WA_BRIDGE_HOME=%h/.wa-bridge
Environment=WA_BRIDGE_PORT=7788
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
./wa-bridge stop                                  # nunca junto com o script nativo
systemctl --user daemon-reload
systemctl --user enable --now wa-bridge
loginctl enable-linger "$USER"                    # continua rodando sem sessão aberta
journalctl --user -u wa-bridge -f                 # o log principal fica em ~/.wa-bridge/logs/daemon.log
```

## Pareamento e troubleshooting

O caminho normal: `./wa-bridge start`, depois `./wa-bridge open` (painel já autenticado,
com o QR) ou `./wa-bridge qr` (salva o QR como PNG e abre). No celular: WhatsApp >
Aparelhos conectados > Conectar aparelho.

Causas mais comuns de falha de pareamento, em ordem de probabilidade:

1. **QR expira em 20–60 segundos.** Se demorar para escanear, o QR mostrado fica
   inválido e a conexão nunca sai de `connecting`. O painel atualiza o QR sozinho;
   com `./wa-bridge qr`, rode de novo e escaneie rápido.
2. **Prefira QR a pairing code.** Pairing code (os 8 dígitos digitados no celular) é
   historicamente menos estável com Baileys — pode conectar e cair logo depois com
   `device_removed`. Use QR como caminho padrão.
3. **Sessão zumbi.** Se a conexão ficar presa em `connecting` sem nunca abrir e sem
   gerar QR novo, não insista — pare o daemon, verifique se não há outro processo
   disputando o mesmo `WA_BRIDGE_HOME/auth` (lembre-se: **uma única sessão, um único
   processo dono**; qualquer segundo processo lendo/escrevendo a mesma pasta de auth
   corrompe a sessão) e reinicie.
4. **Credencial morta.** Depois de um logout no próprio celular, ou de ban, a pasta
   `auth/` fica com credenciais que nunca mais vão autenticar. O sintoma é reconectar
   em loop sem nunca abrir, ou `whatsapp: close` com "sessão deslogada". Solução:
   `./wa-bridge pair` (faz backup de `auth/`, descarta a sessão e gera um QR novo).
5. **`device_removed` com a sessão recém-pareada.** Normalmente significa duas sessões
   Baileys concorrentes na mesma conta — confirme que só existe **um** processo do
   daemon rodando (`ps aux | grep index.js`, ou cheque se o serviço launchd/systemd e o
   `./wa-bridge start` não estão os dois de pé ao mesmo tempo).

### Versão do Baileys

Pinada em **`6.7.24`** (tag `legacy`) de propósito. A tag `latest` do pacote é um
`7.0.0-rc` — não deve ser usada sem validar o pareamento manualmente primeiro, porque
RCs de protocolo WhatsApp costumam introduzir quebras de pareamento sem aviso. Se o
pareamento começar a falhar depois de uma atualização do WhatsApp (app ou protocolo), a
**primeira coisa a testar** é subir a versão do Baileys (checando o changelog da tag
antes de trocar), não reescrever a lógica de conexão.

## Onde olhar quando algo falha

- **`~/.wa-bridge/logs/daemon.log`** — JSONL do Pino, uma linha por evento, com
  `traceId` propagado por request. Para seguir um fluxo específico:
  ```bash
  jq 'select(.traceId == "<trace-id>")' ~/.wa-bridge/logs/daemon.log
  ```
  Para ver só erros recentes:
  ```bash
  jq 'select(.level >= 50)' ~/.wa-bridge/logs/daemon.log | tail -n 50
  ```
- **Dashboard** (`http://127.0.0.1:7788/dashboard`) — estado da sessão, métricas por
  agente/tool, chamadas recentes.
- **Tabela `audit`** no SQLite (`~/.wa-bridge/wa.db`) — todo envio, bloqueio e troca de
  sessão deixa um evento append-only aqui (nunca é alterado ou apagado depois de
  gravado):
  ```bash
  sqlite3 ~/.wa-bridge/wa.db "SELECT ts, agent, action, chat_jid, outcome FROM audit ORDER BY ts DESC LIMIT 20;"
  ```

## Backup e reset

- **Seguro de apagar, sem perder nada essencial**: `~/.wa-bridge/media/` (mídia é
  rematerializável a partir da mensagem original, enquanto ela ainda existir nos
  servidores do WhatsApp) e `~/.wa-bridge/logs/` (apenas histórico de log).
- **Mata a sessão**: apagar `~/.wa-bridge/auth/` desconecta o WhatsApp — será preciso
  escanear um QR novo (`./wa-bridge pair`) para voltar a funcionar.
- **Zerar tudo**: pare o daemon e apague o diretório inteiro:
  ```bash
  ./wa-bridge stop
  rm -rf ~/.wa-bridge
  ```
  Na próxima inicialização, o daemon recria a estrutura de diretórios e gera um `token`
  novo; será necessário parear de novo.

## `blocklist.json`

Formato:

```json
{
  "jids": ["5511999999999@s.whatsapp.net"],
  "note": "motivo opcional, só para humano ler depois"
}
```

Para bloquear um contato, adicione o JID (número completo + `@s.whatsapp.net`, ou o JID
de grupo terminando em `@g.us`) ao array `jids` e salve o arquivo — não é preciso
reiniciar o daemon (o arquivo é relido a cada envio, com cache de 5 segundos).

A blocklist é **fail-open por design**: ela é uma camada extra de conveniência, não a
proteção principal. A proteção real contra envio indevido é o **gate de confirmação em
dois passos** — mesmo um JID fora da blocklist nunca recebe uma mensagem sem um draft
revisado e confirmado por um humano. Os defaults abaixo são embutidos no código e
**inegociáveis** (bloqueados mesmo com `blocklist.json` vazio ou ausente):

- `status@broadcast`
- qualquer JID terminando em `@newsletter`
- qualquer JID terminando em `@broadcast`
