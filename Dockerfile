# syntax=docker/dockerfile:1
#
# wa-bridge — imagem do daemon (apenas daemon + dashboard; o mcp-shim continua
# no host, spawnado pelos agentes). Ver docs/ARQUITETURA.md e docs/OPERACAO.md.
#
# Três estágios:
#   1. whisper-build  — compila whisper.cpp (tag v1.8.4) para a arquitetura do
#      build (arm64 ou amd64).
#   2. deps           — instala deps de produção do workspace e builda o
#      TypeScript do daemon.
#   3. final          — runtime: node:24-bookworm-slim + ffmpeg + whisper-cli +
#      dist/node_modules do daemon + dashboard estático.

# ---------------------------------------------------------------------------
# Stage 1: whisper-build
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS whisper-build

ARG WHISPER_CPP_TAG=v1.8.4

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch ${WHISPER_CPP_TAG} \
      https://github.com/ggml-org/whisper.cpp.git whisper.cpp

WORKDIR /src/whisper.cpp
# Build CPU-only: não existe Metal em Linux, então aqui dentro é sempre CPU
# pura (BLAS também fica de fora — o toolchain padrão do Debian não traz
# OpenBLAS). IMPORTANTE (achado na validação, não presumido): o whisper-cli
# do Homebrew no HOST na verdade carrega um backend Metal
# (`load_backend: loaded MTL backend from .../libggml-metal.so`) e usa a GPU
# do Apple Silicon — não é CPU-only como se assumiu ao planejar este empacotamento.
# Isso significa que conteinerizar a transcrição É uma perda real de
# performance (medida em docs/OPERACAO.md: ~16-40x mais lento), não uma
# equivalência 1:1 com o host.
#
# GGML_CPU_ARM_ARCH fixa um único -march para todo o backend de CPU (em vez
# de deixar o ggml gerar function multiversioning via target_clones a partir
# de autodetecção). Sem isso, a autodetecção do ggml mistura, numa mesma
# unidade de compilação, símbolos NEON inlinados a partir de
# <arm_neon.h> com um -march "base" diferente do -march usado no
# target_clones de FP16 FMA, e o GCC 12 do bookworm rejeita o inline com
# "target specific option mismatch" (incompatibilidade conhecida entre o
# autodetect do ggml e esse GCC em arm64). armv8.2-a+fp16 é o nível de ISA
# do Docker Desktop aarch64 em Apple Silicon.
# Em x86_64 (servidor Linux comum) a flag acima não se aplica e o build padrão
# do ggml funciona sem ajuste; por isso ela só entra em arm64.
ARG TARGETARCH
RUN ARCH_FLAGS=""; \
    if [ "$TARGETARCH" = "arm64" ]; then ARCH_FLAGS="-DGGML_CPU_ARM_ARCH=armv8.2-a+fp16"; fi; \
    cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON \
      -DGGML_NATIVE=OFF $ARCH_FLAGS \
    && cmake --build build --config Release -j"$(nproc)" --target whisper-cli

# Reúne o binário e todas as libs compartilhadas que ele precisa num único
# diretório, para copiar de forma previsível no estágio final.
RUN mkdir -p /out/bin /out/lib \
    && cp build/bin/whisper-cli /out/bin/ \
    && find build -name 'libggml*.so*' -o -name 'libwhisper*.so*' \
      | xargs -I{} cp {} /out/lib/

# ---------------------------------------------------------------------------
# Stage 2: deps (instala + builda o TypeScript do daemon)
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps

WORKDIR /app

# Copia o workspace completo (package.json da raiz referencia daemon/ e mcp/)
# para que `npm ci` resolva o lockfile igual ao host. O mcp/ é compilado aqui
# só porque faz parte do workspace raiz; ele NÃO vai para a imagem final —
# o shim MCP continua rodando no host (ver docs/ARQUITETURA.md).
COPY package.json package-lock.json ./
COPY daemon/package.json daemon/package.json
COPY mcp/package.json mcp/package.json

RUN npm ci

COPY daemon daemon
COPY mcp mcp

RUN npm run build -w daemon

# Remove devDependencies para deixar só o node_modules de produção do daemon.
RUN npm prune --omit=dev -w daemon

# ---------------------------------------------------------------------------
# Stage 3: final (runtime)
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS final

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libgomp1 socat \
    && rm -rf /var/lib/apt/lists/*

# whisper-cli + libs compartilhadas do estágio 1.
COPY --from=whisper-build /out/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-build /out/lib/ /usr/local/lib/
RUN ldconfig

WORKDIR /app

# Preserva a mesma profundidade de diretório que `resolveDashboardDir()` espera
# em daemon/src/api/server.ts: a partir de dist/api/ ele sobe 3 níveis
# (dist/api -> dist -> daemon -> raiz) e procura `dashboard/` na raiz. Por
# isso o dashboard precisa estar em /app/dashboard, irmão de /app/daemon.
COPY --from=deps /app/daemon/dist daemon/dist
COPY --from=deps /app/daemon/package.json daemon/package.json
# A versão do wa-bridge mora só no package.json da raiz (daemon/src/version.ts
# lê `../../package.json` a partir de dist/), então ele vem junto.
COPY package.json package.json
# `npm ci` roda num workspace (raiz referencia daemon/ e mcp/), então o npm
# hoisteia as deps de produção para /app/node_modules em vez de
# /app/daemon/node_modules. A resolução ESM do Node sobe diretórios em busca
# de node_modules, então basta copiar para /app/node_modules aqui também.
COPY --from=deps /app/node_modules node_modules
COPY dashboard dashboard
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Usuário não-root: a imagem base node:24-bookworm-slim já traz o usuário
# "node" (uid/gid 1000), então reaproveitamos em vez de criar um novo (uid
# 1000 já existe na imagem base e colide com groupadd/useradd). No Docker
# Desktop para Mac o bind-mount de ${HOME}/.wa-bridge é servido via
# gRPC-FUSE/VirtioFS e aceita escrita de qualquer UID do container (o
# mapeamento de permissões é feito pelo próprio Docker Desktop, não pelo UID
# numérico do host). Validado em runtime escrevendo um arquivo de teste
# dentro do bind-mount — ver docs/OPERACAO.md.
USER node

ENV NODE_ENV=production
ENV RELAY_PORT=17788
EXPOSE 17788

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7788/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/daemon
# Ver docker/entrypoint.sh: sobe `node dist/index.js` (que faz bind em
# 127.0.0.1, por segurança) e um `socat` que repassa
# 0.0.0.0:$RELAY_PORT -> 127.0.0.1:$WA_BRIDGE_PORT, para a porta publicada
# pelo compose alcançar o processo sem alterar o bind do daemon.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
