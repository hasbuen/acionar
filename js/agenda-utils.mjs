export function formatDateInput(date = new Date()) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export function getLocalDayRange(dateInput) {
    const [year, month, day] = String(dateInput || '').split('-').map(Number);
    if (!year || !month || !day) return null;
    const start = new Date(year, month - 1, day);
    const end = new Date(year, month - 1, day + 1);
    return { start: start.toISOString(), end: end.toISOString() };
}

export function isSameLocalDate(value, dateInput) {
    if (!value || !dateInput) return false;
    const date = new Date(value);
    return !Number.isNaN(date.getTime()) && formatDateInput(date) === dateInput;
}

export function filterAppointmentsForDate(records = [], dateInput, { excludeMaintenance = false } = {}) {
    return records.filter(record => {
        if (!isSameLocalDate(record?.data_hora_inicio, dateInput)) return false;
        return !excludeMaintenance || record?.is_manutencao !== true;
    });
}

export function compactAppointmentsForCache(records = [], limit = 120) {
    return records.slice(0, limit).map(record => ({
        id: record.id,
        cliente_id: record.cliente_id || null,
        servico_id: record.servico_id || null,
        subservico_id: record.subservico_id || null,
        profissional_id: record.profissional_id || null,
        data_hora_inicio: record.data_hora_inicio,
        data_hora_fim: record.data_hora_fim || null,
        status: record.status,
        tipo_atendimento: record.tipo_atendimento || 'salao',
        is_manutencao: record.is_manutencao === true,
        agendamento_pai_id: record.agendamento_pai_id || null,
        periodicidade_dias: record.periodicidade_dias || null,
        clientes: record.clientes ? {
            id: record.clientes.id || record.cliente_id || null,
            nome: record.clientes.nome || 'Cliente',
            whatsapp: record.clientes.whatsapp || null
        } : null,
        servicos: record.servicos ? {
            id: record.servicos.id || record.servico_id || null,
            nome: record.servicos.nome || 'Serviço',
            duracao_minutos: record.servicos.duracao_minutos || 30,
            tabela_precos: Array.isArray(record.servicos.tabela_precos)
                ? record.servicos.tabela_precos.slice(0, 1)
                : []
        } : null,
        profissionais: record.profissionais ? {
            id: record.profissionais.id || record.profissional_id || null,
            nome: record.profissionais.nome || 'Profissional',
            cor_identificadora: record.profissionais.cor_identificadora || null
        } : null
    }));
}
