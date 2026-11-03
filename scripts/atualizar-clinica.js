'use strict';

/**
 * Troca o nome, o telefone ou o endereço da clínica — para pôr os dados reais
 * da clínica parceira no lugar dos fictícios do seed, antes das sessões.
 *
 *   npm run clinica:atualizar -- --nome "Clínica X" --telefone "(88) 3412-0000" --endereco "Rua Y, 10 - Centro, Quixadá - CE"
 *
 * Só os campos informados mudam. O seed não serve para isso: ele usa
 * `ON CONFLICT (cnpj) DO NOTHING` e nunca sobrescreve a clínica que já existe.
 *
 * O banco é o de DATABASE_URL; para o de produção, defina-a no seu terminal
 * antes (o mesmo procedimento do seed em produção). O script mostra o host e o
 * nome do banco, a linha atual e a nova, e só escreve depois de um "s".
 *
 * Nada fica travado enquanto a pergunta espera: o UPDATE só vale se a linha
 * ainda estiver igual à que foi mostrada. Se alguém a mudou no meio, ele
 * recusa e pede para rodar de novo, em vez de escrever por cima.
 */

const readline = require('node:readline/promises');
const config = require('../src/config');
const { consultar, encerrar } = require('../src/infra/db/pool');
const { descreverBanco } = require('./descreverBanco');

const CAMPOS = ['nome', 'telefone', 'endereco'];

const USO =
  'Uso: npm run clinica:atualizar -- [--id N] [--nome "…"] [--telefone "…"] [--endereco "…"]';

class Recusa extends Error {}

/**
 * @param {string[]} args
 * @returns {{ id: number|undefined, novos: {nome?: string, telefone?: string, endereco?: string} }}
 */
function lerArgumentos(args) {
  const novos = {};
  let id;

  for (let i = 0; i < args.length; i += 2) {
    const nome = args[i];
    const valor = args[i + 1];
    const campo = nome?.startsWith('--') ? nome.slice(2) : null;

    if (campo !== 'id' && !CAMPOS.includes(campo)) {
      throw new Recusa(`Argumento desconhecido: "${nome}".\n${USO}`);
    }
    if (valor === undefined || valor.startsWith('--') || valor.trim() === '') {
      throw new Recusa(`${nome} precisa de um valor.\n${USO}`);
    }
    if (campo === 'id') {
      if (!/^\d+$/.test(valor) || Number(valor) < 1) {
        throw new Recusa(`--id precisa ser um número inteiro positivo; recebi "${valor}".`);
      }
      id = Number(valor);
    } else {
      novos[campo] = valor.trim();
    }
  }

  if (Object.keys(novos).length === 0) {
    throw new Recusa(`Diga ao menos um campo para mudar.\n${USO}`);
  }
  return { id, novos };
}

/**
 * @param {object} opcoes
 * @param {number} [opcoes.id] obrigatório quando houver mais de uma clínica
 * @param {{nome?: string, telefone?: string, endereco?: string}} opcoes.novos
 * @param {(mudanca: {id: number, atual: object, depois: object}) => Promise<boolean>} opcoes.confirmar
 *        recebe a linha atual e a nova; só um `true` escreve
 * @returns {Promise<{id: number, atual: object, depois: object, escrito: boolean}>}
 */
async function atualizarClinica({ id, novos, confirmar }) {
  const { rows } = await consultar('SELECT id, nome, telefone, endereco FROM clinica ORDER BY id');

  if (rows.length === 0) {
    throw new Recusa('Não há clínica neste banco. Rode o seed antes.');
  }

  let alvo;
  if (id === undefined) {
    if (rows.length > 1) {
      const ids = rows.map((r) => `${r.id} (${r.nome})`).join(', ');
      throw new Recusa(`Há ${rows.length} clínicas neste banco; diga qual com --id: ${ids}.`);
    }
    [alvo] = rows;
  } else {
    alvo = rows.find((r) => Number(r.id) === id);
    if (!alvo) throw new Recusa(`Não há clínica com id ${id} neste banco.`);
  }

  const atual = { nome: alvo.nome, telefone: alvo.telefone, endereco: alvo.endereco };
  const depois = { ...atual, ...novos };
  const resultado = { id: Number(alvo.id), atual, depois, escrito: false };

  if (CAMPOS.every((c) => depois[c] === atual[c])) return resultado;
  if (!(await confirmar({ id: resultado.id, atual, depois }))) return resultado;

  // Só se a linha ainda for a que foi mostrada. IS NOT DISTINCT FROM porque
  // telefone e endereço podem ser nulos, e NULL = NULL não é verdadeiro.
  const { rowCount } = await consultar(
    `UPDATE clinica
        SET nome = $5, telefone = $6, endereco = $7
      WHERE id = $1
        AND nome = $2
        AND telefone IS NOT DISTINCT FROM $3
        AND endereco IS NOT DISTINCT FROM $4`,
    [alvo.id, atual.nome, atual.telefone, atual.endereco, depois.nome, depois.telefone, depois.endereco]
  );
  if (rowCount === 0) {
    throw new Recusa('A clínica mudou enquanto você confirmava. Nada foi escrito; rode de novo.');
  }
  return { ...resultado, escrito: true };
}

function mostrar(rotulo, linha) {
  console.log(`  ${rotulo}`);
  for (const c of CAMPOS) console.log(`    ${c.padEnd(9)} ${linha[c] ?? '(vazio)'}`);
}

async function principal() {
  let argumentos;
  try {
    argumentos = lerArgumentos(process.argv.slice(2));
  } catch (erro) {
    if (!(erro instanceof Recusa)) throw erro;
    console.error(`\n${erro.message}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nBanco: ${descreverBanco(config.urlDoBanco)}`);

  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const r = await atualizarClinica({
      ...argumentos,
      confirmar: async ({ id, atual, depois }) => {
        console.log(`\nClínica ${id}:`);
        mostrar('agora', atual);
        mostrar('depois', depois);
        const resposta = await terminal.question('\nGravar? (s/N) ');
        return resposta.trim().toLowerCase() === 's';
      },
    });
    if (r.escrito) console.log('\nGravado.\n');
    else if (CAMPOS.every((c) => r.depois[c] === r.atual[c])) console.log('\nJá está assim. Nada a mudar.\n');
    else console.log('\nNada foi escrito.\n');
  } catch (erro) {
    if (!(erro instanceof Recusa)) throw erro;
    console.error(`\n${erro.message}\n`);
    process.exitCode = 1;
  } finally {
    terminal.close();
    await encerrar();
  }
}

if (require.main === module) {
  principal().catch((erro) => {
    console.error(erro);
    process.exitCode = 1;
  });
}

module.exports = { atualizarClinica, lerArgumentos, Recusa };
