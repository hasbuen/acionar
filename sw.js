// Service Worker do Acionar Agendamentos para Notificações em Segundo Plano (Android & iOS PWA)

const DEFAULT_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='24' fill='%232563eb'/%3E%3Ctext x='50' y='66' font-size='54' font-weight='800' text-anchor='middle' fill='white' font-family='Arial'%3EA%3C/text%3E%3C/svg%3E";
const DEFAULT_BADGE = DEFAULT_ICON;

function normalizeNotificationPayload(raw = {}) {
    const data = raw.data || {};
    const clienteNome = data.clienteNome || raw.clienteNome || 'Cliente';
    const telefone = data.telefone || raw.telefone || 'Não informado';
    const servicoNome = data.servicoNome || raw.servicoNome || 'Serviço';
    const dataLabel = data.data || raw.dataLabel || '';
    const hora = data.hora || raw.hora || '';
    const local = data.local || raw.local || '';
    const observacoes = data.observacoes || raw.observacoes || '';

    const body = raw.body || [
        `WhatsApp: ${telefone}`,
        `Serviço: ${servicoNome}`,
        dataLabel || hora ? `Data: ${dataLabel}${hora ? ` às ${hora}` : ''}` : '',
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
            tag: raw.tag || `agendamento-${data.agendamentoId || Date.now()}`,
            renotify: true,
            requireInteraction: true,
            data: {
                url: './dashboard.html',
                ...data
            },
            actions: [
                { action: 'open', title: 'Abrir agenda' }
            ]
        }
    };
}

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Listener para disparar Notificação Nativa do SO em segundo plano
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
        const { title, options } = normalizeNotificationPayload(event.data);

        event.waitUntil(
            self.registration.showNotification(title, options)
        );
    }
});

// Web Push real: necessário para Android/iOS notificarem com o PWA fechado ou em segundo plano.
self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (e) {
        payload = { body: event.data ? event.data.text() : '' };
    }

    const { title, options } = normalizeNotificationPayload(payload);
    event.waitUntil(self.registration.showNotification(title, options));
});

// Clique na Notificação abre ou traz o aplicativo para o primeiro plano
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const urlToOpen = event.notification.data?.url || './dashboard.html';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            for (let i = 0; i < windowClients.length; i++) {
                const client = windowClients[i];
                if (client.url.includes('dashboard.html') && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(urlToOpen);
            }
        })
    );
});
