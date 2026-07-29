// Service Worker do Acionar Agendamentos para Notificações em Segundo Plano (Android & iOS PWA)

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Listener para disparar Notificação Nativa do SO em segundo plano
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
        const title = event.data.title || '🔔 Novo Agendamento Recebido!';
        const options = {
            body: event.data.body || 'Um novo cliente agendou um horário!',
            icon: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f514.png',
            badge: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f514.png',
            vibrate: [300, 100, 300, 100, 300],
            tag: 'novo-agendamento',
            renotify: true,
            data: {
                url: './dashboard.html'
            }
        };

        event.waitUntil(
            self.registration.showNotification(title, options)
        );
    }
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
