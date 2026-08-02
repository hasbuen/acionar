const PAID_STATUSES = new Set(['pago', 'recebido', 'quitado']);
const CANCELLED_STATUSES = new Set(['cancelado', 'estornado', 'excluido', 'excluído']);

export function toCents(value) {
    if (typeof value === 'string') {
        value = value.trim().replace(/R\$\s*/gi, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

export function fromCents(value) {
    return (Number(value) || 0) / 100;
}

export function formatBRL(valueInCents) {
    return fromCents(valueInCents).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function normalizeStatus(status) {
    return String(status || '').trim().toLowerCase();
}

export function isCancelled(record) {
    return CANCELLED_STATUSES.has(normalizeStatus(record?.status_pagamento));
}

export function isPaid(record) {
    return !isCancelled(record) && PAID_STATUSES.has(normalizeStatus(record?.status_pagamento));
}

export function isOutgoing(record) {
    return String(record?.tipo_movimento || 'entrada').toLowerCase() === 'saida';
}

export function getCashFlowDate(record, fallback = new Date()) {
    const dateValue = isPaid(record) ? (record?.data_pagamento || record?.criado_em) : (record?.data_vencimento || record?.criado_em);
    const date = new Date(dateValue || fallback);
    return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
}

export function summarizeCashFlow(records = []) {
    const summary = {
        receivedCents: 0,
        receivedCount: 0,
        receivableCents: 0,
        receivableCount: 0,
        outgoingPaidCents: 0,
        outgoingPaidCount: 0,
        outgoingPendingCents: 0,
        outgoingPendingCount: 0
    };

    records.forEach(record => {
        if (!record || isCancelled(record)) return;
        const amount = toCents(record.valor_final);
        if (isPaid(record)) {
            if (isOutgoing(record)) {
                summary.outgoingPaidCents += amount;
                summary.outgoingPaidCount += 1;
            } else {
                summary.receivedCents += amount;
                summary.receivedCount += 1;
            }
        } else if (isOutgoing(record)) {
            summary.outgoingPendingCents += amount;
            summary.outgoingPendingCount += 1;
        } else {
            summary.receivableCents += amount;
            summary.receivableCount += 1;
        }
    });

    summary.realizedBalanceCents = summary.receivedCents - summary.outgoingPaidCents;
    return summary;
}

export function filterCashFlowByPeriod(records, period, now = new Date()) {
    if (period === 'todos') return records;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return records.filter(record => {
        const date = getCashFlowDate(record, now);
        const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        if (period === 'hoje') return dateOnly.getTime() === today.getTime();
        if (period === 'semana') {
            const diffDays = (today - dateOnly) / 86400000;
            return diffDays >= 0 && diffDays <= 7;
        }
        if (period === 'mes') return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
        return true;
    });
}

export function getRealizedRecords(records = []) {
    return records.filter(record => isPaid(record) && !isCancelled(record));
}
