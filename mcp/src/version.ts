/**
 * Versão do wa-bridge. A fonte única é o campo `version` do `package.json` da raiz do
 * repo: daemon e shim MCP leem de lá, e nenhum outro arquivo guarda o número.
 */
import { readFileSync } from 'node:fs';

/** Lê `version` do package.json da raiz (dois níveis acima de `src/` ou `dist/`). */
function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : 'desconhecida';
  } catch {
    // Versão é só metadado: sem o package.json da raiz o shim sobe do mesmo jeito.
    return 'desconhecida';
  }
}

export const VERSION = readVersion();
