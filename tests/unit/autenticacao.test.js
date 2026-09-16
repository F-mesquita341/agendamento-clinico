'use strict';

/**
 * O adaptador do Firebase e o middleware de autenticação, sem rede.
 *
 * O ponto central dos testes do adaptador: só erros de token viram 401. Erro
 * de credencial, de configuração ou de rede precisa continuar sendo erro do
 * servidor — traduzi-lo em 401 mandaria a pessoa refazer login num sistema
 * quebrado do lado de cá.
 */

const { criarVerificadorFirebase } = require('../../src/infra/firebase/verificadorDeToken');
const { criarAutenticar } = require('../../src/interfaces/http/middlewares/autenticar');
const { ErroDeDominio } = require('../../src/domain/erros');

/** Firebase Auth falso: devolve a identidade ou lança o código pedido. */
function authQue({ devolve, lancaCodigo }) {
  return {
    verifyIdToken: async () => {
      if (lancaCodigo) {
        const erro = new Error(`falso: ${lancaCodigo}`);
        erro.code = lancaCodigo;
        throw erro;
      }
      return devolve;
    },
  };
}

describe('verificador do Firebase', () => {
  test('token válido devolve uid e e-mail', async () => {
    const verificar = criarVerificadorFirebase({
      auth: authQue({ devolve: { uid: 'u1', email: 'a@example.com', outro: 'x' } }),
    });

    await expect(verificar('qualquer')).resolves.toEqual({ uid: 'u1', email: 'a@example.com' });
  });

  test('token expirado vira SESSAO_EXPIRADA', async () => {
    const verificar = criarVerificadorFirebase({
      auth: authQue({ lancaCodigo: 'auth/id-token-expired' }),
    });

    await expect(verificar('t')).rejects.toMatchObject({
      codigo: 'SESSAO_EXPIRADA',
      status: 401,
      acao: 'renovar_token',
    });
  });

  test.each([
    'auth/argument-error',
    'auth/invalid-id-token',
    'auth/id-token-revoked',
    'auth/user-disabled',
  ])('%s vira NAO_AUTENTICADO', async (codigo) => {
    const verificar = criarVerificadorFirebase({ auth: authQue({ lancaCodigo: codigo }) });

    await expect(verificar('t')).rejects.toMatchObject({ codigo: 'NAO_AUTENTICADO', status: 401 });
  });

  test.each([
    ['credencial inválida', 'app/invalid-credential'],
    ['erro interno do Firebase', 'auth/internal-error'],
  ])('%s NÃO vira 401 — é falha do servidor', async (_rotulo, codigo) => {
    const verificar = criarVerificadorFirebase({ auth: authQue({ lancaCodigo: codigo }) });

    const erro = await verificar('t').catch((e) => e);

    expect(erro).not.toBeInstanceOf(ErroDeDominio);
    expect(erro.code).toBe(codigo);
  });

  test('erro sem código, como queda de rede, NÃO vira 401', async () => {
    const quedaDeRede = new Error('rede caiu');
    const verificar = criarVerificadorFirebase({
      auth: { verifyIdToken: async () => { throw quedaDeRede; } },
    });

    await expect(verificar('t')).rejects.toBe(quedaDeRede);
  });

  test('conta sem e-mail devolve email nulo, sem quebrar', async () => {
    const verificar = criarVerificadorFirebase({ auth: authQue({ devolve: { uid: 'u2' } }) });

    await expect(verificar('t')).resolves.toEqual({ uid: 'u2', email: null });
  });
});

describe('middleware autenticar', () => {
  function requisicaoCom(cabecalho) {
    return { get: (nome) => (nome.toLowerCase() === 'authorization' ? cabecalho : undefined) };
  }

  async function rodar(cabecalho, verificarToken = async () => ({ uid: 'u', email: 'e@example.com' })) {
    const req = requisicaoCom(cabecalho);
    let recebido = 'nao-chamado';
    await criarAutenticar(verificarToken)(req, {}, (erro) => {
      recebido = erro ?? null;
    });
    return { req, recebido };
  }

  test('Bearer válido preenche req.usuario e segue adiante', async () => {
    const { req, recebido } = await rodar('Bearer abc');

    expect(recebido).toBeNull();
    expect(req.usuario).toEqual({ uid: 'u', email: 'e@example.com' });
  });

  test('aceita "bearer" em minúsculas, como a especificação permite', async () => {
    const { recebido } = await rodar('bearer abc');

    expect(recebido).toBeNull();
  });

  test.each([undefined, '', 'Bearer', 'Basic abc', 'Bearer abc def', 'abc'])(
    'cabeçalho %p → NAO_AUTENTICADO sem consultar o verificador',
    async (cabecalho) => {
      let consultado = false;
      const { recebido } = await rodar(cabecalho, async () => {
        consultado = true;
      });

      expect(recebido).toMatchObject({ codigo: 'NAO_AUTENTICADO' });
      expect(consultado).toBe(false);
    }
  );

  test('erro do verificador é repassado intacto', async () => {
    const falhaDoServidor = new Error('credencial ausente');
    const { recebido } = await rodar('Bearer abc', async () => {
      throw falhaDoServidor;
    });

    expect(recebido).toBe(falhaDoServidor);
  });
});
