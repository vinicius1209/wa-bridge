#!/usr/bin/env bash
#
# load_dotenv ARQUIVO: carrega um `.env` sem sobrescrever o que já veio do ambiente.
#
# Usado pelo `./wa-bridge` e pelo `bin/wa-bridge-daemon` (o que o serviço executa): o
# launchd não passa pelo script, então sem isto o daemon do serviço ignoraria o `.env`.
# Não usamos `source` porque ele executaria o arquivo como shell e sobrescreveria
# variáveis já definidas. Nada aqui escreve em stdout.

load_dotenv() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
    key="${line%%=*}"; value="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${value%%[[:space:]]#*}"                     # comentário no fim da linha
    value="${value%"${value##*[![:space:]]}"}"          # espaços no fim
    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
    value="${value/#\~/$HOME}"
    [[ -n "${!key+x}" || -z "$value" ]] && continue
    export "$key=$value"
  done <"$file"
}
