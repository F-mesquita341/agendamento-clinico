'use strict';

/**
 * Objeto de valor (EVANS, 2016) para quantias monetárias.
 *
 * Duas quantias de R$ 150,00 são a mesma coisa — não há identidade própria,
 * só valor. É o que distingue um value object de uma entidade.
 *
 * Guarda CENTAVOS como inteiro. Ponto flutuante acumula erro de arredondamento:
 * 0.1 + 0.2 não é 0.3 em IEEE 754, e num sistema que intermedeia pagamento isso
 * não é detalhe acadêmico.
 *
 * Imutável: qualquer operação devolve uma instância nova.
 */

const { RegraDeNegocio } = require('./erros');

class Dinheiro {
  #centavos;

  constructor(centavos) {
    if (!Number.isInteger(centavos)) {
      throw new RegraDeNegocio(
        'VALOR_INVALIDO',
        'Valor monetário precisa ser um número inteiro de centavos.'
      );
    }
    if (centavos < 0) {
      throw new RegraDeNegocio(
        'VALOR_NEGATIVO',
        'Valor monetário não pode ser negativo.'
      );
    }
    this.#centavos = centavos;
    Object.freeze(this);
  }

  static deCentavos(centavos) {
    return new Dinheiro(centavos);
  }

  static deReais(reais) {
    if (typeof reais !== 'number' || Number.isNaN(reais)) {
      throw new RegraDeNegocio('VALOR_INVALIDO', 'Valor em reais inválido.');
    }
    return new Dinheiro(Math.round(reais * 100));
  }

  get centavos() {
    return this.#centavos;
  }

  somar(outro) {
    return new Dinheiro(this.#centavos + outro.centavos);
  }

  igualA(outro) {
    return outro instanceof Dinheiro && outro.centavos === this.#centavos;
  }

  /** Formata no padrão brasileiro: R$ 1.250,00 */
  formatar() {
    const reais = Math.floor(this.#centavos / 100);
    const centavos = String(this.#centavos % 100).padStart(2, '0');
    const comMilhar = String(reais).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `R$ ${comMilhar},${centavos}`;
  }

  toJSON() {
    return this.#centavos;
  }
}

module.exports = { Dinheiro };
