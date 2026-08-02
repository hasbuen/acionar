import test from 'node:test';
import assert from 'node:assert/strict';
import {
    filterCashFlowByPeriod,
    getCashFlowDate,
    summarizeCashFlow,
    toCents
} from '../js/cashflow.mjs';

test('converte valores monetários para centavos sem erro de ponto flutuante', () => {
    assert.equal(toCents('R$ 1.234,56'), 123456);
    assert.equal(toCents(19.99), 1999);
});

test('saldo realizado considera somente entradas e saídas pagas', () => {
    const summary = summarizeCashFlow([
        { valor_final: 100, status_pagamento: 'pago', tipo_movimento: 'entrada' },
        { valor_final: 25, status_pagamento: 'a_receber', tipo_movimento: 'entrada' },
        { valor_final: 30, status_pagamento: 'pago', tipo_movimento: 'saida' },
        { valor_final: 40, status_pagamento: 'a_pagar', tipo_movimento: 'saida' }
    ]);

    assert.equal(summary.receivedCents, 10000);
    assert.equal(summary.receivableCents, 2500);
    assert.equal(summary.outgoingPaidCents, 3000);
    assert.equal(summary.outgoingPendingCents, 4000);
    assert.equal(summary.realizedBalanceCents, 7000);
});

test('período usa data de vencimento para pendentes e data de pagamento para pagos', () => {
    const now = new Date('2026-08-02T12:00:00');
    const paid = { status_pagamento: 'pago', data_pagamento: '2026-08-02T09:00:00', criado_em: '2026-07-01T09:00:00' };
    const pending = { status_pagamento: 'a_receber', data_vencimento: '2026-08-02T15:00:00', criado_em: '2026-07-01T09:00:00' };

    assert.equal(getCashFlowDate(paid, now).getDate(), 2);
    assert.equal(getCashFlowDate(pending, now).getDate(), 2);
    assert.equal(filterCashFlowByPeriod([paid, pending], 'hoje', now).length, 2);
});
