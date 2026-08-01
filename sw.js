// Service Worker do painel Acionar: Web Push para Android e iOS instalado como PWA.

const DEFAULT_URL = new URL('dashboard.html', self.registration.scope).href;
const DEFAULT_ICON = new URL('icons/icon-192.png', self.registration.scope).href;
const DEFAULT_BADGE = new URL('icons/badge-96.png', self.registration.scope).href;

function normalizeNotificationPayload(raw = {}) {
    const nestedData = raw.data && typeof raw.data === 'object' ? raw.data : {};
    const appointmentId = raw.agendamento_id || raw.agendamentoId ||
        nestedData.agendamento_id || nestedData.agendamentoId || null;
    const clienteNome = nestedData.clienteNome || raw.clienteNome || 'Cliente';
    const telefone = nestedData.telefone || raw.telefone || 'Nao informado';
    const servicoNome = nestedData.servicoNome || raw.servicoNome || 'Servico';
    const dataLabel = nestedData.data || raw.dataLabel || '';
    const hora = nestedData.hora || raw.hora || '';
    const local = nestedData.local || raw.local || '';
    const observacoes = nestedData.observacoes || raw.observacoes || '';
    const requestedUrl = raw.url || nestedData.url || DEFAULT_URL;
    const notificationUrl = new URL(requestedUrl, self.registration.scope).href;

    const body = raw.body || [
        `WhatsApp: ${telefone}`,
        `Servico: ${servicoNome}`,
        dataLabel || hora ? `Data: ${dataLabel}${hora ? ` as ${hora}` : ''}` : '',
        local ? `Local: ${local}` : '',
        observacoes ? `Obs: ${observacoes}` : ''
    ].filter(Boolean).join('\n');

    return {
        title: raw.title || `Novo agendamento: ${clienteNome}`,
        options: {
            body,
            icon: raw.icon || DEFAULT_ICON,
            badge: raw.badge || DEFAULT_BADGE,
            vibrate: raw.vibrate || [300, 100, 300, 100, 300],
            tag: raw.tag || (appointmentId ? `agendamento-${appointmentId}` : 'novo-agendamento'),
            renotify: raw.renotify !== false,
            requireInteraction: raw.requireInteraction !== false,
            data: {
                ...nestedData,
                url: notificationUrl,
                agendamento_id: appointmentId
            },
            actions: [{ action: 'open', title: 'Abrir agenda' }]
        }
    };
}

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
    if (event.data?.type !== 'SHOW_NOTIFICATION') return;
    const { title, options } = normalizeNotificationPayload(event.data);
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (error) {
        payload = { body: event.data ? event.data.text() : '' };
    }

    const { title, options } = normalizeNotificationPayload(payload);
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = new URL(event.notification.data?.url || DEFAULT_URL, self.registration.scope);

    event.waitUntil((async () => {
        const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        const existingClient = windowClients.find(client => {
            const clientUrl = new URL(client.url);
            return clientUrl.origin === targetUrl.origin && clientUrl.pathname === targetUrl.pathname;
        });

        if (existingClient) {
            if ('navigate' in existingClient && existingClient.url !== targetUrl.href) {
                await existingClient.navigate(targetUrl.href);
            }
            return existingClient.focus();
        }

        return clients.openWindow ? clients.openWindow(targetUrl.href) : undefined;
    })());
});
