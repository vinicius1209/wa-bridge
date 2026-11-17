/**
 * Tipos de `protocolMessage` que os aparelhos da própria conta trocam só para se manter em
 * sincronia: histórico, chaves de app state, configurações de segurança e respostas do
 * celular. Não são conversa. Chegam como mensagem do usuário na conversa com ele mesmo e,
 * gravadas, viravam linhas `unknown` lá.
 *
 * Os números são os do enum `proto.Message.ProtocolMessage.Type` do Baileys (um teste
 * confere); os nomes são como o `toJSON` do protobuf grava no `raw_json`. Edição, apagar
 * para todos e similares ficam de fora: vêm de outras pessoas e dizem respeito à conversa.
 */
export const DEVICE_SYNC_PROTOCOL_TYPES = {
  EPHEMERAL_SYNC_RESPONSE: 4,
  HISTORY_SYNC_NOTIFICATION: 5,
  APP_STATE_SYNC_KEY_SHARE: 6,
  APP_STATE_SYNC_KEY_REQUEST: 7,
  MSG_FANOUT_BACKFILL_REQUEST: 8,
  INITIAL_SECURITY_NOTIFICATION_SETTING_SYNC: 9,
  APP_STATE_FATAL_EXCEPTION_NOTIFICATION: 10,
  PEER_DATA_OPERATION_REQUEST_MESSAGE: 16,
  PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE: 17,
  LID_MIGRATION_MAPPING_SYNC: 22,
} as const;

const NAMES = new Set<string>(Object.keys(DEVICE_SYNC_PROTOCOL_TYPES));
const IDS = new Set<number>(Object.values(DEVICE_SYNC_PROTOCOL_TYPES));

/** Verdadeiro se o tipo (número do enum ou nome) for de sincronização entre aparelhos. */
export function isDeviceSyncProtocolType(type: unknown): boolean {
  if (typeof type === 'number') return IDS.has(type);
  return typeof type === 'string' && NAMES.has(type);
}

/**
 * Tipos de `messageAssociation` em que o filho (`associatedChildMessage`) é só outra cópia
 * de uma mídia que já chegou como mensagem própria: a versão HD de foto ou vídeo (dual
 * upload) e a parte em vídeo de uma foto com movimento. A original, apontada em
 * `parentMessageKey`, é a que vai para o banco e é baixada; gravada, a cópia virava uma
 * linha `unknown` a mais na conversa (e uma não lida a mais).
 *
 * Números do enum `proto.MessageAssociation.AssociationType` (um teste confere). Álbum
 * (`MEDIA_ALBUM`) fica de fora: cada foto do álbum chega como mensagem normal.
 */
export const MEDIA_COPY_ASSOCIATION_TYPES = {
  HD_VIDEO_DUAL_UPLOAD: 5,
  HD_IMAGE_DUAL_UPLOAD: 10,
  MOTION_PHOTO: 12,
  HEVC_VIDEO_DUAL_UPLOAD: 19,
} as const;

const COPY_NAMES = new Set<string>(Object.keys(MEDIA_COPY_ASSOCIATION_TYPES));
const COPY_IDS = new Set<number>(Object.values(MEDIA_COPY_ASSOCIATION_TYPES));

/** Verdadeiro se a associação (número do enum ou nome) for de cópia de mídia. */
export function isMediaCopyAssociation(type: unknown): boolean {
  if (typeof type === 'number') return COPY_IDS.has(type);
  return typeof type === 'string' && COPY_NAMES.has(type);
}

/**
 * Tipos de `protocolMessage` que mudam uma mensagem que já está na conversa: "apagar para
 * todos" (`REVOKE`) e edição (`MESSAGE_EDIT`). Não viram mensagem própria: são aplicados na
 * original. Números do enum `proto.Message.ProtocolMessage.Type` (um teste confere).
 */
export const MESSAGE_CHANGE_PROTOCOL_TYPES = {
  REVOKE: 0,
  MESSAGE_EDIT: 14,
} as const;

/** `revoke` para "apagar para todos", `edit` para edição, `null` para qualquer outro tipo. */
export function messageChangeKind(type: unknown): 'revoke' | 'edit' | null {
  if (type === MESSAGE_CHANGE_PROTOCOL_TYPES.REVOKE || type === 'REVOKE') return 'revoke';
  if (type === MESSAGE_CHANGE_PROTOCOL_TYPES.MESSAGE_EDIT || type === 'MESSAGE_EDIT') return 'edit';
  return null;
}
