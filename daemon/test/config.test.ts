/**
 * Máscara de número do preview do gate e janela de silêncio. O preview existe para o
 * humano reconhecer o destinatário: número inventado ali convida a aprovar com base em
 * informação falsa. Funções puras; o `Config` é montado só com o que `isQuietHour` lê.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isQuietHour, maskNumber, type Config } from '../src/config.js';

// -------------------------------------------------------------- maskNumber

test('maskNumber: celular BR mostra DDI, DDD e só os 4 últimos dígitos do número', () => {
  assert.equal(maskNumber('5551999998888@s.whatsapp.net'), '+55 51 ****-8888');
  assert.equal(maskNumber('5551999998888@c.us'), '+55 51 ****-8888');
  assert.equal(maskNumber('555133334444@s.whatsapp.net'), '+55 51 ****-4444', 'fixo, sem o nono dígito');
});

test('maskNumber: o miolo do número nunca aparece', () => {
  const masked = maskNumber('5511987654321@s.whatsapp.net');
  assert.equal(masked, '+55 11 ****-4321');
  assert.equal(masked.includes('98765'), false);
  assert.equal(masked.replace(/\D/g, ''), '55114321', 'só DDI + DDD + 4 últimos');
});

test('maskNumber: LID é identificador opaco, nunca vira telefone', () => {
  assert.equal(maskNumber('123456789012345@lid'), 'sem número (id ****2345)');
  assert.equal(maskNumber('123456789012345@lid').startsWith('+'), false);
  assert.equal(maskNumber('@lid'), 'sem número');
});

test('maskNumber: domínio desconhecido ou ausente também não vira telefone', () => {
  assert.equal(maskNumber('5551999998888'), 'sem número (id ****8888)');
  assert.equal(maskNumber('abc@algum.dominio'), 'sem número');
  assert.equal(maskNumber(''), 'sem número');
});

test('maskNumber: grupo, broadcast e newsletter não expõem dígito nenhum', () => {
  assert.equal(maskNumber('120363012345678901@g.us'), 'grupo');
  assert.equal(maskNumber('5551999998888-1612345678@g.us'), 'grupo');
  assert.equal(maskNumber('status@broadcast'), 'broadcast');
  assert.equal(maskNumber('1234567890@broadcast'), 'broadcast');
  assert.equal(maskNumber('120363999999999999@newsletter'), 'newsletter');
});

test('maskNumber: números curtos', () => {
  assert.equal(maskNumber('1234@s.whatsapp.net'), '****1234');
  assert.equal(maskNumber('12@s.whatsapp.net'), '****12');
  assert.equal(maskNumber('@s.whatsapp.net'), '****');
  assert.equal(maskNumber('12345678@s.whatsapp.net'), '+12 ****-5678', 'sem DDD, sem espaço duplo');
  assert.equal(maskNumber('12345@s.whatsapp.net'), '+12 ****-2345');
});

// ------------------------------------------------------------- isQuietHour

/** Monta o mínimo de `Config` que `isQuietHour` lê. */
function configCom(inicio: string, fim: string): Config {
  const minutos = (hhmm: string): number => {
    const [h = 0, m = 0] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const quietHours: Config['quietHours'] = {
    startMinute: minutos(inicio),
    endMinute: minutos(fim),
    raw: `${inicio}-${fim}`,
  };
  return { quietHours } as Pick<Config, 'quietHours'> as Config;
}

/** Instante no horário local (é o que `isQuietHour` usa), num dia qualquer. */
function as(hora: number, minuto: number, segundo = 0, ms = 0): Date {
  return new Date(2026, 5, 15, hora, minuto, segundo, ms);
}

test('isQuietHour: janela que cruza a meia-noite (23:00-07:00)', () => {
  const config = configCom('23:00', '07:00');
  const casos: [Date, boolean][] = [
    [as(22, 59), false],
    [as(23, 0), true], // início inclusivo
    [as(23, 59), true],
    [as(0, 0), true],
    [as(3, 30), true],
    [as(6, 59), true],
    [as(7, 0), false], // fim exclusivo
    [as(12, 0), false],
  ];
  for (const [at, esperado] of casos) {
    assert.equal(isQuietHour(config, at), esperado, at.toTimeString());
  }
});

test('isQuietHour: janela normal no mesmo dia (13:00-14:30)', () => {
  const config = configCom('13:00', '14:30');
  const casos: [Date, boolean][] = [
    [as(12, 59), false],
    [as(13, 0), true], // início inclusivo
    [as(14, 29), true],
    [as(14, 30), false], // fim exclusivo
    [as(0, 0), false],
    [as(23, 0), false],
  ];
  for (const [at, esperado] of casos) {
    assert.equal(isQuietHour(config, at), esperado, at.toTimeString());
  }
});

test('isQuietHour: segundos e milissegundos não deslocam as bordas', () => {
  const config = configCom('23:00', '07:00');
  assert.equal(isQuietHour(config, as(22, 59, 59, 999)), false);
  assert.equal(isQuietHour(config, as(23, 0, 0, 0)), true);
  assert.equal(isQuietHour(config, as(6, 59, 59, 999)), true);
  assert.equal(isQuietHour(config, as(7, 0, 0, 0)), false);
});

test('isQuietHour: início igual ao fim é janela vazia, nunca silêncio', () => {
  for (const [inicio, fim] of [['00:00', '00:00'], ['22:00', '22:00']] as const) {
    const config = configCom(inicio, fim);
    for (const [h, m] of [[0, 0], [21, 59], [22, 0], [22, 1], [23, 59]] as const) {
      assert.equal(isQuietHour(config, as(h, m)), false, `${inicio}-${fim} às ${h}:${m}`);
    }
  }
});

test('isQuietHour: janela que começa à meia-noite (00:00-06:00)', () => {
  const config = configCom('00:00', '06:00');
  assert.equal(isQuietHour(config, as(23, 59)), false);
  assert.equal(isQuietHour(config, as(0, 0)), true);
  assert.equal(isQuietHour(config, as(5, 59)), true);
  assert.equal(isQuietHour(config, as(6, 0)), false);
});
