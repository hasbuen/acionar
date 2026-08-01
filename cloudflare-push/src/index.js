import webpush from 'web-push';

const TIME_ZONE = 'America/Sao_Paulo';
const REQUEST_STATUSES = new Set(['aguardando_confirmacao', 'solicitado', 'pendente']);

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
}

function supabaseHeaders(env, extra = {}) {
    return {
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_PUBLISHABLE_KEY}`,
        ...extra
    };
}

async function supabaseRequest(env, table, params = {}, options = {}) {
    const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
        ...options,
        headers: supabaseHeaders(env, options.headers || {})
    });

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Supabase ${table}: ${response.status} ${detail}`);
    }

    if (response.status === 204) return null;
    return response.json();
}

async function optionalRows(env, table, params) {
    try {
        return await supabaseRequest(env, table, params);
    } catch (error) {
        console.warn(`Tabela opcional ${table} indisponível`, error);
        return [];
    }
}

function normalizeRelation(value) {
    return Array.isArray(value) ? value[0] || null : value || null;
}

function normalizePhone(value) {
    return String(value || '').replace(/\D/g, '');
}

function zonedParts(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type)?.value || '';
    const days = { Sun: '0', Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6' };
    return {
        day: days[part('weekday')] || '0',
        minutes: Number(part('hour')) * 60 + Number(part('minute'))
    };
}

function timeToMinutes(value) {
    const [hours, minutes] = String(value || '').slice(0, 5).split(':').map(Number);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
    return hours * 60 + minutes;
}

function appointmentRange(appointment) {
    const start = new Date(appointment?.data_hora_inicio);
    if (Number.isNaN(start.getTime())) return null;

    let end = appointment?.data_hora_fim ? new Date(appointment.data_hora_fim) : null;
    if (!end || Number.isNaN(end.getTime()) || end <= start) {
        const service = normalizeRelation(appointment?.servicos);
        const duration = Math.max(Number(service?.duracao_minutos || 30), 15);
        end = new Date(start.getTime() + duration * 60000);
    }
    return { start, end };
}

function rangesOverlap(first, second) {
    return first && second && first.start < second.end && first.end > second.start;
}

function canHandleService(professionalId, appointment, serviceRows, subserviceRows) {
    const explicitServices = serviceRows.filter((row) => row.profissional_id === professionalId);
    if (
        explicitServices.length > 0 &&
        !explicitServices.some((row) => row.servico_id === appointment.servico_id && row.ativo !== false)
    ) return false;

    if (!appointment.subservico_id) return true;
    const subservice = subserviceRows.find((row) =>
        row.profissional_id === professionalId && row.subservico_id === appointment.subservico_id
    );
    return subservice ? subservice.ativo !== false : true;
}

function scheduleForProfessional(professional, configRows) {
    const globalConfig = configRows.find((row) => row.chave === 'horario_funcionamento')?.valor || null;
    if (String(professional?.cargo || '').toLowerCase() === 'proprietario') return globalConfig;
    return configRows.find((row) => row.chave === `horario_funcionamento_${professional.id}`)?.valor || globalConfig;
}

function canAttendSchedule(professional, appointment, configRows) {
    const range = appointmentRange(appointment);
    if (!range) return false;
    const start = zonedParts(range.start);
    const end = zonedParts(range.end);
    if (start.day !== end.day) return false;

    const dayConfig = scheduleForProfessional(professional, configRows)?.dias?.[start.day];
    if (!dayConfig?.ativo || !Array.isArray(dayConfig.turnos)) return false;
    return dayConfig.turnos.some((shift) => {
        const shiftStart = timeToMinutes(shift?.inicio);
        const shiftEnd = timeToMinutes(shift?.fim);
        return shiftStart !== null && shiftEnd !== null && shiftEnd > shiftStart &&
            start.minutes >= shiftStart && end.minutes <= shiftEnd;
    });
}

async function hasConflict(env, professionalId, appointment) {
    const target = appointmentRange(appointment);
    if (!target) return true;
    const rows = await supabaseRequest(env, 'agendamentos', {
        select: 'id,data_hora_inicio,data_hora_fim,status,profissional_id,servicos(duracao_minutos)',
        profissional_id: `eq.${professionalId}`,
        status: 'neq.cancelado',
        data_hora_inicio: `gte.${new Date(target.start.getTime() - 86400000).toISOString()}`,
        and: `(data_hora_inicio.lte.${new Date(target.end.getTime() + 86400000).toISOString()})`
    });

    return (rows || []).some((row) => row.id !== appointment.id && rangesOverlap(target, appointmentRange(row)));
}

async function eligibleProfessionalIds(env, appointment) {
    if (appointment.profissional_id) return [appointment.profissional_id];
    if (!REQUEST_STATUSES.has(String(appointment.status || '').toLowerCase())) return [];

    const [professionals, serviceRows, subserviceRows, configRows] = await Promise.all([
        supabaseRequest(env, 'profissionais', {
            select: 'id,nome,cargo,ativo,aceita_atendimento_externo',
            ativo: 'eq.true'
        }),
        optionalRows(env, 'profissional_servicos', {
            select: 'profissional_id,servico_id,ativo'
        }),
        optionalRows(env, 'profissional_subservicos', {
            select: 'profissional_id,subservico_id,ativo'
        }),
        supabaseRequest(env, 'configuracoes', {
            select: 'chave,valor',
            chave: 'like.horario_funcionamento*'
        })
    ]);

    const external = ['cliente', 'externo'].includes(String(appointment.tipo_atendimento || 'salao').toLowerCase());
    const eligible = [];
    for (const professional of professionals || []) {
        if (external && professional.aceita_atendimento_externo !== true) continue;
        if (!canHandleService(professional.id, appointment, serviceRows || [], subserviceRows || [])) continue;
        if (!canAttendSchedule(professional, appointment, configRows || [])) continue;
        if (await hasConflict(env, professional.id, appointment)) continue;
        eligible.push(professional.id);
    }
    return eligible;
}

function formatDate(date) {
    return new Intl.DateTimeFormat('pt-BR', {
        timeZone: TIME_ZONE,
        day: '2-digit', month: '2-digit', year: 'numeric'
    }).format(date);
}

function formatTime(date) {
    return new Intl.DateTimeFormat('pt-BR', {
        timeZone: TIME_ZONE,
        hour: '2-digit', minute: '2-digit'
    }).format(date);
}

function notificationPayload(appointment) {
    const client = normalizeRelation(appointment.clientes) || {};
    const service = normalizeRelation(appointment.servicos) || {};
    const start = new Date(appointment.data_hora_inicio);
    const external = ['cliente', 'externo'].includes(String(appointment.tipo_atendimento || 'salao').toLowerCase());
    const location = external ? 'No local do cliente' : 'No salão';
    const notes = String(appointment.observacoes || '').trim();
    const phone = normalizePhone(client.whatsapp) || 'Não informado';

    return {
        title: `Novo agendamento: ${client.nome || 'Cliente'}`,
        body: [
            `WhatsApp: ${phone}`,
            `Serviço: ${service.nome || 'Serviço'}`,
            `Data: ${formatDate(start)} às ${formatTime(start)}`,
            `Local: ${location}`,
            notes ? `Obs: ${notes}` : ''
        ].filter(Boolean).join('\n'),
        url: './dashboard.html',
        agendamento_id: appointment.id,
        tag: `new-agendamento-${appointment.id}`,
        data: {
            url: './dashboard.html',
            agendamento_id: appointment.id,
            agendamentoId: appointment.id,
            clienteNome: client.nome || 'Cliente',
            telefone: phone,
            servicoNome: service.nome || 'Serviço',
            data: formatDate(start),
            hora: formatTime(start),
            local: location,
            observacoes: notes,
            kind: 'new'
        }
    };
}

async function deactivateSubscription(env, id) {
    try {
        await supabaseRequest(env, 'push_subscriptions', { id: `eq.${id}` }, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ ativo: false, atualizado_em: new Date().toISOString() })
        });
    } catch (error) {
        console.warn('Não foi possível inativar assinatura expirada', error);
    }
}

async function sendAppointmentPush(env, appointmentId) {
    const appointments = await supabaseRequest(env, 'agendamentos', {
        select: 'id,cliente_id,servico_id,subservico_id,profissional_id,data_hora_inicio,data_hora_fim,status,tipo_atendimento,endereco_atendimento,observacoes,clientes(nome,whatsapp),servicos(nome,duracao_minutos)',
        id: `eq.${appointmentId}`,
        limit: '1'
    });
    const appointment = appointments?.[0];
    if (!appointment) return { ok: false, status: 404, error: 'Agendamento não encontrado' };

    const professionalIds = await eligibleProfessionalIds(env, appointment);
    if (professionalIds.length === 0) {
        return { ok: true, sent: 0, professionals: 0, reason: 'Nenhum profissional elegível' };
    }

    const subscriptions = await supabaseRequest(env, 'push_subscriptions', {
        select: 'id,endpoint,p256dh,auth,profissional_id',
        ativo: 'eq.true',
        profissional_id: `in.(${professionalIds.join(',')})`
    });

    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    const payload = JSON.stringify(notificationPayload(appointment));
    let sent = 0;
    const failures = [];

    for (const subscription of subscriptions || []) {
        if (!subscription.endpoint || !subscription.p256dh || !subscription.auth) continue;
        try {
            await webpush.sendNotification({
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth }
            }, payload);
            sent += 1;
        } catch (error) {
            const statusCode = error instanceof webpush.WebPushError ? error.statusCode : Number(error?.statusCode || 0);
            failures.push({ id: subscription.id, status: statusCode || 500 });
            if ([401, 403, 404, 410].includes(statusCode)) {
                await deactivateSubscription(env, subscription.id);
            }
            console.error('Falha no envio Web Push', { subscriptionId: subscription.id, statusCode, message: error?.message });
        }
    }

    return {
        ok: true,
        sent,
        professionals: professionalIds.length,
        subscriptions: subscriptions?.length || 0,
        failures
    };
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/health') {
            return json({ ok: true, service: 'acionar-push' });
        }
        if (request.method !== 'POST') return json({ error: 'Not found' }, 404);

        if (!env.PUSH_WEBHOOK_SECRET || request.headers.get('x-push-secret') !== env.PUSH_WEBHOOK_SECRET) {
            return json({ error: 'Unauthorized' }, 401);
        }

        try {
            const body = await request.json().catch(() => ({}));
            const appointmentId = body.agendamento_id || body.record?.id || body.new?.id;
            if (!appointmentId) return json({ error: 'agendamento_id obrigatório' }, 400);
            const result = await sendAppointmentPush(env, String(appointmentId));
            return json(result, result.status || 200);
        } catch (error) {
            console.error(error);
            return json({ error: String(error?.message || error) }, 500);
        }
    }
};
