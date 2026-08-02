import test from 'node:test';
import assert from 'node:assert/strict';
import {
    compactAppointmentsForCache,
    filterAppointmentsForDate,
    formatDateInput,
    getLocalDayRange
} from '../js/agenda-utils.mjs';

test('data local consolidada identifica somente o dia informado', () => {
    const today = new Date(2026, 7, 2, 12, 0);
    assert.equal(formatDateInput(today), '2026-08-02');
    assert.equal(filterAppointmentsForDate([
        { data_hora_inicio: '2026-08-02T09:00:00-03:00', is_manutencao: false },
        { data_hora_inicio: '2026-08-03T09:00:00-03:00', is_manutencao: false },
        { data_hora_inicio: '2026-08-02T10:00:00-03:00', is_manutencao: true }
    ], '2026-08-02', { excludeMaintenance: true }).length, 1);
});

test('limite do cache mantém somente campos de agenda necessários', () => {
    const result = compactAppointmentsForCache([{
        id: 'a1',
        cliente_id: 'c1',
        data_hora_inicio: '2026-08-02T09:00:00-03:00',
        observacoes: 'dado que não deve ser persistido no cache',
        clientes: { id: 'c1', nome: 'Cliente', whatsapp: '5511999999999' },
        servicos: { id: 's1', nome: 'Corte', duracao_minutos: 30, tabela_precos: [{ valor: 50 }] }
    }]);

    assert.equal(result.length, 1);
    assert.equal(result[0].clientes.nome, 'Cliente');
    assert.equal('observacoes' in result[0], false);
});

test('gera janela ISO do dia local para consulta enxuta', () => {
    const range = getLocalDayRange('2026-08-02');
    assert.ok(range.start < range.end);
    assert.equal(new Date(range.end).getTime() - new Date(range.start).getTime(), 86400000);
});
