/**
 * Simulação de digitação humana: split em bubbles, plano de tempos, compressão pelo
 * teto e execução com presença. O relógio do `executePlan` é falso (mock de
 * `setTimeout`), então nenhum teste espera tempo de verdade e nada sai para a rede.
 */
import { strict as assert } from 'node:assert';
import { syncBuiltinESMExports } from 'node:module';
import { test, type TestContext } from 'node:test';
import { compressPlan, executePlan, planDelay, splitBubbles } from '../src/send/human-delay.js';
import type { DelayPlan } from '../src/types.js';

/** Teto padrão de `WA_SEND_MAX_DELAY_MS`. */
const TETO_PADRAO_MS = 45_000;

/** Palavras do texto, ignorando qualquer espaço ou quebra de linha. */
function palavras(text: string): string[] {
  return text.split(/\s+/).filter((p) => p.length > 0);
}

/** Verdadeiro se a string tem metade de um surrogate pair sem o par. */
function temSurrogateSolto(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/** Soma dos tempos que o plano de fato espera (sem a latência de rede estimada). */
function planejado(plan: DelayPlan): number {
  return plan.readMs + plan.bubbles.reduce((s, b) => s + b.typeMs + b.pauseAfterMs, 0);
}

// ------------------------------------------------------------ splitBubbles

test('splitBubbles: texto curto sem pontuação forte vira 1 bubble, já aparado', () => {
  assert.deepEqual(splitBubbles('oi tudo bem'), ['oi tudo bem']);
  assert.deepEqual(splitBubbles('  oi, tudo bem  \n'), ['oi, tudo bem']);
});

test('splitBubbles: texto vazio ou só espaço não gera bubble nenhum', () => {
  assert.deepEqual(splitBubbles(''), []);
  assert.deepEqual(splitBubbles('   \n\t '), []);
});

test('splitBubbles: texto longo sem fronteira natural continua em 1 bubble', () => {
  const texto = 'vou passar aí mais tarde pra gente conversar com calma sobre aquele assunto ' +
    'do projeto e ver o que dá pra fazer até o fim do mês sem atropelar ninguém';
  assert.ok(texto.length > 120);
  assert.deepEqual(splitBubbles(texto), [texto]);
});

test('splitBubbles: quebra por fronteira de sentença', () => {
  assert.deepEqual(splitBubbles('Oi. Tudo bem?'), ['Oi.', 'Tudo bem?']);
  assert.deepEqual(splitBubbles('Chego às 10h! Pode ser? Me avisa.'), ['Chego às 10h!', 'Pode ser?', 'Me avisa.']);
});

test('splitBubbles: aceita fronteira seguida de minúscula (WhatsApp informal)', () => {
  assert.deepEqual(splitBubbles('isso aí. depois a gente vê. valeu'), ['isso aí.', 'depois a gente vê.', 'valeu']);
});

test('splitBubbles: mais de 4 sentenças são mescladas até 4 bubbles, sem perder palavra', () => {
  const texto = 'Primeiro ponto. Segundo ponto. Terceiro ponto. Quarto ponto. Quinto ponto. Sexto.';
  const bubbles = splitBubbles(texto);
  assert.equal(bubbles.length, 4);
  assert.deepEqual(palavras(bubbles.join(' ')), palavras(texto));
});

test('splitBubbles: nunca corta palavra no meio', () => {
  const textos = [
    'Oi. Tudo bem? Queria confirmar a reunião de amanhã. Pode ser às 15h? Abraço!',
    'Paralelepípedo. Inconstitucionalissimamente falando, não. Otorrinolaringologista amanhã.',
    'Ok! Então fica assim: eu levo o bolo. Você leva o refri. A Bia leva os salgados. Combinado? Fechou.',
  ];
  for (const texto of textos) {
    const bubbles = splitBubbles(texto);
    assert.deepEqual(palavras(bubbles.join(' ')), palavras(texto), texto);
    for (const b of bubbles) assert.equal(b, b.trim(), 'bubble não começa nem termina com espaço');
  }
});

test('splitBubbles: abreviação comum não vira fronteira', () => {
  assert.deepEqual(splitBubbles('Falei com o sr. Silva hoje. Ele vem amanhã.'), [
    'Falei com o sr. Silva hoje.',
    'Ele vem amanhã.',
  ]);
  assert.deepEqual(splitBubbles('Traz arroz, feijão etc. e tal. Valeu.'), ['Traz arroz, feijão etc. e tal.', 'Valeu.']);
});

test('splitBubbles: número decimal não vira fronteira', () => {
  assert.deepEqual(splitBubbles('O valor é 2.5 reais. Ok?'), ['O valor é 2.5 reais.', 'Ok?']);
});

test('splitBubbles: nunca corta URL, nem usa o ponto dela como fronteira', () => {
  const url = 'https://exemplo.com.br/docs/v1.2/guia.html?x=1.5&y=a.b';
  const texto = `Dá uma olhada. O link é ${url}. Depois me fala. Valeu!`;
  const bubbles = splitBubbles(texto);
  assert.equal(bubbles.filter((b) => b.includes(url)).length, 1, 'a URL inteira aparece em um único bubble');
  assert.deepEqual(palavras(bubbles.join(' ')), palavras(texto));

  const www = 'www.site.com.br/A.B.C';
  const comWww = splitBubbles(`Entra em ${www}. Ali tem tudo. Beleza?`);
  assert.equal(comWww.filter((b) => b.includes(www)).length, 1);
});

test('splitBubbles: bloco de código ``` vira bubble próprio e intacto', () => {
  const bloco = '```\nnpm i. npm test. Feito.\nconst a = b.c(); x = 1. Y = 2.\n```';
  const texto = `Rode isto:\n${bloco}\nDepois me conta. Valeu.`;
  const bubbles = splitBubbles(texto);
  assert.ok(bubbles.includes(bloco), 'o bloco sai inteiro, com quebras de linha e pontos internos');
  assert.deepEqual(bubbles, ['Rode isto:', bloco, 'Depois me conta.', 'Valeu.']);
});

test('splitBubbles: bloco de código nunca é mesclado com o texto vizinho', () => {
  const bloco = '```ts\nconst x = 1. Mais texto. Outro.\n```';
  const texto = `Um. Dois. Três. Quatro.\n${bloco}\nCinco. Seis. Sete.`;
  const bubbles = splitBubbles(texto);
  assert.ok(bubbles.length <= 4);
  assert.ok(bubbles.includes(bloco), 'o bloco continua sendo um bubble sozinho');
  for (const b of bubbles) {
    if (b !== bloco) assert.equal(b.includes('```'), false, `bubble de texto não pode conter cerca: ${b}`);
  }
});

test('splitBubbles: emoji e surrogate pair nunca são partidos', () => {
  const textos = [
    'Que legal! 😀 Vamos amanhã. 👍🏽 Combinado? Sim.',
    'Bora!😀 Vai ser top. Leva a família 👨‍👩‍👧‍👦. Até! 🇧🇷',
    '😀😀😀. 🎉 Feliz aniversário! Muitas felicidades. Te amo ❤️. Beijo 😘😘',
  ];
  for (const texto of textos) {
    const bubbles = splitBubbles(texto);
    for (const b of bubbles) assert.equal(temSurrogateSolto(b), false, `surrogate solto em ${JSON.stringify(b)}`);
    assert.equal(bubbles.join('').replace(/\s+/g, ''), texto.replace(/\s+/g, ''), 'nenhum code unit some ou muda');
  }
});

test('splitBubbles: lista numerada não separa o número do item', () => {
  for (const texto of ['Itens:\n1. Arroz\n2. Feijão\n3. Carne', '1. Arroz\n2. Feijão\n  3. Carne']) {
    const bubbles = splitBubbles(texto);
    for (const b of bubbles) {
      assert.doesNotMatch(b, /(^|\s)\d+\.$/, `bubble terminou no marcador da lista: ${JSON.stringify(b)}`);
    }
    assert.equal(bubbles.join(' ').replace(/\s+/g, ' '), texto.replace(/\s+/g, ' '), 'nenhum texto some');
  }
});

test('splitBubbles: frase que termina em número no meio da linha continua sendo fronteira', () => {
  assert.deepEqual(splitBubbles('O jogo é às 20. Leva bola e água. Chega cedo.'), [
    'O jogo é às 20.',
    'Leva bola e água.',
    'Chega cedo.',
  ]);
});

// --------------------------------------------------------------- planDelay

test('planDelay: com a mesma seed o plano é idêntico; seeds diferentes variam', () => {
  const bubbles = ['Oi.', 'Tudo bem com você?', 'Queria marcar aquele café.'];
  assert.deepEqual(planDelay(bubbles, 42), planDelay(bubbles, 42));
  assert.notDeepEqual(planDelay(bubbles, 1), planDelay(bubbles, 2));
});

test('planDelay: preserva o texto de cada bubble e não marca como comprimido', () => {
  const bubbles = ['Oi.', 'Tudo bem? 😀', '```\ncodigo\n```'];
  const plan = planDelay(bubbles, 7);
  assert.deepEqual(plan.bubbles.map((b) => b.text), bubbles);
  assert.equal(plan.compressed, false);
});

test('planDelay: leitura, pausas e digitação ficam dentro das faixas documentadas', () => {
  const bubbles = ['Oi.', 'Tudo bem?', 'Me conta como foi a viagem, quero saber de tudo.', 'Beijo!'];
  for (let seed = 1; seed <= 300; seed++) {
    const plan = planDelay(bubbles, seed);
    assert.ok(plan.readMs >= 1500 && plan.readMs <= 4000, `readMs ${plan.readMs} (seed ${seed})`);
    plan.bubbles.forEach((b, i) => {
      assert.ok(b.typeMs >= 200 && b.typeMs <= 20_000, `typeMs ${b.typeMs} (seed ${seed})`);
      if (i === plan.bubbles.length - 1) assert.equal(b.pauseAfterMs, 0, 'último bubble não tem pausa depois');
      else assert.ok(b.pauseAfterMs >= 800 && b.pauseAfterMs <= 2500, `pauseAfterMs ${b.pauseAfterMs} (seed ${seed})`);
    });
  }
});

test('planDelay: digitação conta code points, então emoji pesa como 1 caractere', () => {
  for (const seed of [1, 2, 3, 99]) {
    const emoji = planDelay(['😀'.repeat(20)], seed).bubbles[0]?.typeMs;
    const letras = planDelay(['a'.repeat(20)], seed).bubbles[0]?.typeMs;
    const dobro = planDelay(['a'.repeat(40)], seed).bubbles[0]?.typeMs;
    assert.equal(emoji, letras, '20 emojis (40 code units) digitam como 20 letras');
    assert.notEqual(emoji, dobro);
  }
});

test('planDelay: teto de 20s de digitação por bubble', () => {
  for (let seed = 1; seed <= 50; seed++) {
    assert.equal(planDelay(['a'.repeat(1000)], seed).bubbles[0]?.typeMs, 20_000);
  }
});

test('planDelay: jitter varia a digitação em torno de ~5 caracteres/s', () => {
  const base = (50 / 5) * 1000;
  const tempos = Array.from({ length: 300 }, (_, i) => planDelay(['a'.repeat(50)], i + 1).bubbles[0]?.typeMs ?? 0);
  assert.ok(new Set(tempos).size > 50, 'tempos variam entre seeds');
  for (const t of tempos) assert.ok(t > base * 0.3 && t < base * 3.4, `typeMs ${t} fora do esperado`);
  const mediana = [...tempos].sort((a, b) => a - b)[150] ?? 0;
  assert.ok(mediana > base * 0.85 && mediana < base * 1.15, `mediana ${mediana} longe de ${base}`);
});

test('planDelay: o ETA inclui uma latência fixa por bubble além do que é esperado', () => {
  const um = planDelay(['Oi.'], 5);
  const tres = planDelay(['Oi.', 'Tudo bem?', 'Beijo.'], 5);
  const redeUm = um.totalMs - planejado(um);
  const redeTres = tres.totalMs - planejado(tres);
  assert.ok(redeUm > 0, 'ETA não pode ser só a soma dos tempos planejados');
  assert.equal(redeTres, redeUm * 3, 'latência proporcional ao número de bubbles');
});

test('planDelay: sem bubbles o total é só a leitura', () => {
  const plan = planDelay([], 3);
  assert.deepEqual(plan.bubbles, []);
  assert.equal(plan.totalMs, plan.readMs);
});

test('planDelay: sem seed usa aleatoriedade forte e respeita as mesmas faixas', () => {
  for (let i = 0; i < 50; i++) {
    const plan = planDelay(['Oi.', 'Tudo bem?']);
    assert.ok(plan.readMs >= 1500 && plan.readMs <= 4000);
    assert.ok((plan.bubbles[0]?.pauseAfterMs ?? 0) >= 800);
    assert.equal(plan.bubbles[1]?.pauseAfterMs, 0);
  }
});

// ------------------------------------------------------------- compressPlan

test('compressPlan: plano dentro do teto volta intacto', () => {
  const plan = planDelay(['Oi.', 'Tudo bem?'], 11);
  assert.ok(plan.totalMs <= TETO_PADRAO_MS);
  assert.equal(compressPlan(plan, TETO_PADRAO_MS), plan);
});

test('compressPlan: plano acima do teto cabe nele, sem truncar nem reordenar texto', () => {
  const bubbles = ['a'.repeat(400), 'b'.repeat(300), 'c'.repeat(200), `${'d'.repeat(150)} 😀`];
  for (let seed = 1; seed <= 100; seed++) {
    const plan = planDelay(bubbles, seed);
    assert.ok(plan.totalMs > TETO_PADRAO_MS, 'o cenário precisa estourar o teto');
    const comprimido = compressPlan(plan, TETO_PADRAO_MS);
    assert.ok(comprimido.totalMs <= TETO_PADRAO_MS, `total ${comprimido.totalMs} > teto (seed ${seed})`);
    assert.equal(comprimido.compressed, true);
    assert.deepEqual(comprimido.bubbles.map((b) => b.text), bubbles);
    assert.ok(comprimido.readMs >= 500);
    for (const b of comprimido.bubbles) assert.ok(b.typeMs >= 100);
    assert.equal(comprimido.bubbles.at(-1)?.pauseAfterMs, 0);
  }
});

test('compressPlan: comprime proporcionalmente, mantendo a razão entre bubbles', () => {
  const plan = planDelay(['a'.repeat(40), 'b'.repeat(80)], 21);
  const comprimido = compressPlan(plan, 20_000);
  assert.equal(comprimido.compressed, true);
  const [a0, b0] = plan.bubbles;
  const [a1, b1] = comprimido.bubbles;
  assert.ok(a0 && b0 && a1 && b1);
  assert.ok(a1.typeMs < a0.typeMs && b1.typeMs < b0.typeMs);
  const antes = b0.typeMs / a0.typeMs;
  const depois = b1.typeMs / a1.typeMs;
  assert.ok(Math.abs(antes - depois) / antes < 0.01, `razão mudou de ${antes} para ${depois}`);
});

test('compressPlan: teto menor que a latência de rede ainda preserva o texto e devolve ETA honesto', () => {
  const bubbles = ['Um texto qualquer.', 'Outro texto.', 'Mais um.', 'Fim.'];
  const plan = planDelay(bubbles, 4);
  const comprimido = compressPlan(plan, 1000);
  assert.deepEqual(comprimido.bubbles.map((b) => b.text), bubbles);
  assert.ok(comprimido.totalMs < plan.totalMs);
  assert.ok(comprimido.totalMs >= planejado(comprimido), 'ETA nunca menor que o tempo realmente esperado');
});

// -------------------------------------------------------------- executePlan

type Bubble = DelayPlan['bubbles'][number];

/** Monta um plano à mão; `totalMs` não é usado pelo `executePlan`. */
function plano(bubbles: Bubble[], readMs = 1000): DelayPlan {
  return { readMs, bubbles, totalMs: 0, compressed: false };
}

/**
 * Roda o `executePlan` com relógio falso, registrando presença, envios e consultas a
 * `shouldAbort` na ordem em que acontecem. `abortar` recebe quantos bubbles já saíram
 * e o tempo (falso) decorrido desde o início.
 */
async function executar(
  t: TestContext,
  plan: DelayPlan,
  abortar: (ctx: { enviados: number; decorridoMs: number }) => boolean = () => false,
): Promise<{ ids: string[]; eventos: string[] }> {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  // O mock troca `setTimeout` no objeto CJS de `node:timers/promises`, mas o
  // `import { setTimeout as sleep }` do módulo ESM só enxerga a troca depois do sync.
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  const eventos: string[] = [];
  let enviados = 0;
  let terminou = false;
  const execucao = executePlan(plan, {
    presence: async (p) => {
      eventos.push(p);
    },
    send: async (bubble) => {
      enviados += 1;
      eventos.push(`send:${bubble}`);
      return `id-${enviados}`;
    },
    shouldAbort: () => {
      eventos.push('abort?');
      return abortar({ enviados, decorridoMs: Date.now() });
    },
  }).finally(() => {
    terminou = true;
  });
  for (let i = 0; !terminou; i++) {
    if (i > 100_000) throw new Error('executePlan não terminou');
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(100);
  }
  return { ids: await execucao, eventos };
}

/** Só os eventos de presença e envio, sem as consultas a `shouldAbort`. */
function semConsultas(eventos: string[]): string[] {
  return eventos.filter((e) => e !== 'abort?');
}

test('executePlan: composing na leitura e em cada bubble, paused entre bubbles, available no fim', async (t) => {
  const { ids, eventos } = await executar(
    t,
    plano([
      { text: 'Oi.', typeMs: 1000, pauseAfterMs: 1000 },
      { text: 'Tudo bem?', typeMs: 1500, pauseAfterMs: 0 },
    ]),
  );
  assert.deepEqual(ids, ['id-1', 'id-2']);
  assert.deepEqual(semConsultas(eventos), [
    'composing', // leitura
    'composing', // digitando o 1º
    'send:Oi.',
    'paused',
    'composing', // digitando o 2º
    'send:Tudo bem?',
    'available',
  ]);
});

test('executePlan: espera longa reemite a presença a cada 8s', async (t) => {
  const { eventos } = await executar(
    t,
    plano(
      [
        { text: 'um', typeMs: 100, pauseAfterMs: 17_000 },
        { text: 'dois', typeMs: 100, pauseAfterMs: 0 },
      ],
      20_000,
    ),
  );
  assert.deepEqual(semConsultas(eventos), [
    'composing', // leitura: 0s
    'composing', // leitura: 8s
    'composing', // leitura: 16s
    'composing', // digitando o 1º
    'send:um',
    'paused', // pausa: 0s
    'paused', // pausa: 8s
    'paused', // pausa: 16s
    'composing',
    'send:dois',
    'available',
  ]);
});

test('executePlan: shouldAbort é consultado antes de cada bubble', async (t) => {
  const { eventos } = await executar(
    t,
    plano([
      { text: 'um', typeMs: 100, pauseAfterMs: 0 },
      { text: 'dois', typeMs: 100, pauseAfterMs: 0 },
      { text: 'três', typeMs: 100, pauseAfterMs: 0 },
    ]),
  );
  let anterior = -1;
  for (const [i, e] of eventos.entries()) {
    if (!e.startsWith('send:')) continue;
    const consultas = eventos.slice(anterior + 1, i).filter((x) => x === 'abort?').length;
    assert.ok(consultas >= 1, `nenhuma consulta a shouldAbort antes de ${e}`);
    anterior = i;
  }
});

test('executePlan: abortado antes de começar não envia nada e devolve available', async (t) => {
  const { ids, eventos } = await executar(t, plano([{ text: 'um', typeMs: 100, pauseAfterMs: 0 }]), () => true);
  assert.deepEqual(ids, []);
  assert.deepEqual(semConsultas(eventos), ['available']);
});

test('executePlan: abortado durante a leitura não envia nada', async (t) => {
  const { ids, eventos } = await executar(
    t,
    plano([{ text: 'um', typeMs: 100, pauseAfterMs: 0 }], 20_000),
    ({ decorridoMs }) => decorridoMs >= 5000,
  );
  assert.deepEqual(ids, []);
  assert.deepEqual(semConsultas(eventos), ['composing', 'available']);
});

test('executePlan: abortado durante a digitação não envia o bubble em curso', async (t) => {
  const { ids, eventos } = await executar(
    t,
    plano([
      { text: 'um', typeMs: 20_000, pauseAfterMs: 0 },
      { text: 'dois', typeMs: 100, pauseAfterMs: 0 },
    ], 100),
    ({ decorridoMs }) => decorridoMs >= 5000,
  );
  assert.deepEqual(ids, []);
  assert.deepEqual(semConsultas(eventos), ['composing', 'composing', 'available']);
});

test('executePlan: cancelado logo após o 1º bubble (sem pausa) não envia o 2º', async (t) => {
  const { ids, eventos } = await executar(
    t,
    plano([
      { text: 'um', typeMs: 100, pauseAfterMs: 0 },
      { text: 'dois', typeMs: 100, pauseAfterMs: 0 },
    ]),
    ({ enviados }) => enviados >= 1,
  );
  assert.deepEqual(ids, ['id-1']);
  assert.deepEqual(semConsultas(eventos), ['composing', 'composing', 'send:um', 'available']);
});

test('executePlan: cancelado no meio da pausa para antes do próximo bubble', async (t) => {
  // leitura 0-1000ms, digitação 1000-1100ms, envio do 1º em 1100ms, pausa até 3100ms.
  const { ids, eventos } = await executar(
    t,
    plano([
      { text: 'um', typeMs: 100, pauseAfterMs: 2000 },
      { text: 'dois', typeMs: 100, pauseAfterMs: 0 },
    ]),
    ({ decorridoMs }) => decorridoMs >= 1500,
  );
  assert.deepEqual(ids, ['id-1']);
  assert.deepEqual(semConsultas(eventos), ['composing', 'composing', 'send:um', 'paused', 'available']);
  assert.equal(eventos.filter((e) => e === 'available').length, 1, 'available só uma vez');
});
