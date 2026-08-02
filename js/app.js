// Lógica da Aplicação Principal - Acionar Agendamentos
import { supabase } from './supabase.js';
import { formatDateInputValue, formatTimeInputValue, addDaysToDateInput, toLocalDateTimeISO } from './datetime.js';

const PUSH_SERVICE_URL = 'https://acionar-push.acionar-push-worker.workers.dev';

// --- REGISTRO DE SERVICE WORKER PARA NOTIFICAÇÕES EM SEGUNDO PLANO (ANDROID & IOS PWA) ---
export async function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        try {
            const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
            await reg.update().catch(() => {});
            console.log('✅ Service Worker registrado com sucesso:', reg);
            return reg;
        } catch (e) {
            console.warn('⚠️ Falha ao registrar Service Worker:', e);
        }
    }
    return null;
}

// Inicializa o SW assim que o app carrega
if (typeof window !== 'undefined') {
    window.addEventListener('load', () => {
        registerServiceWorker();
    });
}

// --- GERENCIAMENTO DE TEMA (DARK MODE) ---
export function initTheme() {
    const isDark = localStorage.getItem('color-theme') === 'dark' || 
        (!('color-theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches);

    if (isDark) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }

    updateThemeIcons();

    const themeToggleBtn = document.getElementById('theme-toggle');
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            const currentlyDark = document.documentElement.classList.contains('dark');
            if (currentlyDark) {
                document.documentElement.classList.remove('dark');
                localStorage.setItem('color-theme', 'light');
            } else {
                document.documentElement.classList.add('dark');
                localStorage.setItem('color-theme', 'dark');
            }
            updateThemeIcons();
        });
    }

    const logoutBtns = document.querySelectorAll('#btnLogout, [data-action="logout"]');
    logoutBtns.forEach(btn => {
        if (!btn.dataset.logoutBound) {
            btn.dataset.logoutBound = 'true';
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                await performLogout();
            });
        }
    });

    try {
        hydrateHeaderIdentity();
        ensurePushNotificationOnboarding().catch((err) => console.warn('Onboarding de Web Push indisponível:', err));
        startUpcoming5MinChecker();
    } catch (e) {}
}

function getSessionDisplayName(session) {
    const meta = session?.user?.user_metadata || {};
    const email = session?.user?.email || '';
    return meta.nome || meta.name || meta.full_name || email.split('@')[0] || 'Profissional';
}

function capitalizeDisplayName(name) {
    const text = String(name || '').trim();
    if (!text) return 'Profissional';
    return text.charAt(0).toLocaleUpperCase('pt-BR') + text.slice(1);
}

export async function hydrateHeaderIdentity() {
    const avatarEl = document.getElementById('headerUserAvatar');
    const nameEl = document.getElementById('headerUserName');
    const desktopLabel = document.getElementById('userLabelDesktop');

    try {
        const activeProf = getActiveProfessional() || await ensureActiveProfessionalFromSession();
        const { data: { session } = { session: null } } = await supabase.auth.getSession();
        const displayName = capitalizeDisplayName(activeProf?.nome || getSessionDisplayName(session));
        const initial = (displayName || 'P').trim().charAt(0).toUpperCase() || 'P';

        if (avatarEl) avatarEl.textContent = initial;
        if (nameEl) nameEl.textContent = displayName;
        if (desktopLabel) desktopLabel.textContent = activeProf?.email || session?.user?.email || '';
    } catch (e) {
        if (avatarEl) avatarEl.textContent = 'P';
        if (nameEl) nameEl.textContent = 'Profissional';
    }
}

function updateThemeIcons() {
    const darkIcon = document.getElementById('theme-toggle-dark-icon');
    const lightIcon = document.getElementById('theme-toggle-light-icon');
    if (!darkIcon || !lightIcon) return;

    if (document.documentElement.classList.contains('dark')) {
        lightIcon.classList.remove('hidden');
        darkIcon.classList.add('hidden');
    } else {
        lightIcon.classList.add('hidden');
        darkIcon.classList.remove('hidden');
    }
}

// --- SISTEMA DE ALARME SONORO E NOTIFICAÇÃO (COM DESATIVAÇÃO / LOCALSTORAGE) ---
let audioCtx = null;
let knownAgendamentoIds = new Set();
let isInitialLoadDone = false;
let pushRegistrationPromise = null;
let lastPushRegistrationError = '';

export function isAlarmEnabled() {
    const savedState = localStorage.getItem('alarm-enabled');
    if (savedState === null && 'Notification' in window) {
        return Notification.permission === 'granted';
    }
    return savedState === 'true';
}

export function setAlarmEnabled(enabled) {
    localStorage.setItem('alarm-enabled', enabled ? 'true' : 'false');
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

function pushSubscriptionUsesKey(subscription, publicKey) {
    const currentKey = subscription?.options?.applicationServerKey;
    if (!currentKey) return true;

    const current = new Uint8Array(currentKey);
    const expected = urlBase64ToUint8Array(publicKey);
    if (current.length !== expected.length) return false;
    return current.every((value, index) => value === expected[index]);
}

async function fetchWebPushPublicKey() {
    try {
        const response = await fetch(`${PUSH_SERVICE_URL}/public-key`, {
            method: 'GET',
            mode: 'cors',
            cache: 'no-store',
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        const currentKey = String(data?.publicKey || '').trim();
        if (!currentKey) throw new Error('Chave publica ausente na resposta');

        localStorage.setItem('web_push_public_key', currentKey);
        return currentKey;
    } catch (error) {
        console.warn('Nao foi possivel obter a chave publica do servico de notificacoes:', error);
        return '';
    }
}

async function performWebPushSubscriptionRegistration() {
    lastPushRegistrationError = '';
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.warn('Web Push não está disponível neste navegador/PWA.');
        lastPushRegistrationError = 'Este navegador não oferece notificações em segundo plano.';
        return null;
    }

    const activeProf = getActiveProfessional() || await ensureActiveProfessionalFromSession();
    if (!activeProf?.id) {
        console.warn('Web Push não registrado: profissional da sessão não identificado.');
        lastPushRegistrationError = 'Não foi possível identificar o profissional conectado. Abra o aplicativo novamente.';
        return null;
    }

    const publicKey = await fetchWebPushPublicKey();
    if (!publicKey) {
        console.warn('Servico de notificacoes indisponivel para registrar este aparelho.');
        lastPushRegistrationError = 'O serviço de notificações está temporariamente indisponível.';
        return null;
    }

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    // No iOS, a assinatura do PushManager pode sobreviver à limpeza do localStorage.
    // Recrie somente quando a chave VAPID realmente mudou; a ausência da marca local
    // não torna a assinatura da Apple inválida.
    const mustRenewSubscription = subscription && !pushSubscriptionUsesKey(subscription, publicKey);
    if (mustRenewSubscription) {
        await subscription.unsubscribe();
        subscription = null;
    }
    if (!subscription) {
        subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
    }

    const json = subscription.toJSON();
    const endpoint = json.endpoint || subscription.endpoint;
    const payload = {
        endpoint,
        p256dh: json.keys?.p256dh || null,
        auth: json.keys?.auth || null,
        profissional_id: activeProf?.id || null,
        user_agent: navigator.userAgent,
        plataforma: /iphone|ipad|ipod/i.test(navigator.userAgent) ? 'ios' : /android/i.test(navigator.userAgent) ? 'android' : 'web',
        ativo: true,
        atualizado_em: new Date().toISOString()
    };

    const { error } = await supabase
        .from('push_subscriptions')
        .upsert(payload, { onConflict: 'endpoint' });

    if (error) {
        console.warn('Nao foi possivel vincular este aparelho ao servico de notificacoes.', error);
        lastPushRegistrationError = 'Sua sessão não conseguiu vincular este aparelho. Abra o aplicativo novamente e tente ativar.';
        return null;
    }

    localStorage.setItem('web_push_registered', 'true');
    localStorage.setItem('web_push_registration_key', publicKey);
    return subscription;
}

export async function registerWebPushSubscription() {
    if (pushRegistrationPromise) return pushRegistrationPromise;

    pushRegistrationPromise = performWebPushSubscriptionRegistration();
    try {
        return await pushRegistrationPromise;
    } finally {
        pushRegistrationPromise = null;
    }
}

function removePushOnboarding() {
    document.getElementById('push-notification-onboarding')?.remove();
}

export async function ensurePushNotificationOnboarding() {
    const activeProf = getActiveProfessional() || await ensureActiveProfessionalFromSession();
    if (!activeProf?.id || !('Notification' in window)) return;

    if (Notification.permission === 'granted') {
        removePushOnboarding();
        await registerWebPushSubscription();
        return;
    }

    if (document.getElementById('push-notification-onboarding')) return;

    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const permissionDenied = Notification.permission === 'denied';
    const needsIOSInstall = isIOS && !isStandalone;
    const card = document.createElement('section');
    card.id = 'push-notification-onboarding';
    card.setAttribute('role', 'status');
    card.className = 'fixed z-[100] left-3 right-3 bottom-24 sm:left-auto sm:right-5 sm:bottom-5 sm:w-[390px] rounded-2xl border border-blue-400/30 bg-slate-950/95 text-white p-4 shadow-2xl backdrop-blur-xl';
    card.innerHTML = `
        <div class="flex items-start gap-3">
            <div class="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-500/20 text-blue-300">
                <span aria-hidden="true" class="text-xl">🔔</span>
            </div>
            <div class="min-w-0 flex-1">
                <p class="text-sm font-bold">Receba novos agendamentos</p>
                <p class="mt-1 text-xs leading-relaxed text-slate-300">
                    ${needsIOSInstall
                        ? 'No iPhone, instale o Acionar pela Tela de Início para liberar as notificações.'
                        : permissionDenied
                            ? 'As notificações estão bloqueadas nas configurações deste aparelho.'
                            : 'Ative uma vez neste aparelho. Depois o vínculo com seu perfil será automático.'}
                </p>
                <button type="button" class="mt-3 w-full rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-blue-500 active:scale-[0.98]">
                    ${needsIOSInstall ? 'Como instalar no iPhone' : permissionDenied ? 'Como desbloquear' : 'Ativar notificações'}
                </button>
            </div>
        </div>
    `;

    card.querySelector('button')?.addEventListener('click', () => {
        if (needsIOSInstall) {
            showToast('No Safari: Compartilhar > Adicionar à Tela de Início. Abra o Acionar pelo novo ícone e toque em Ativar notificações.', 'info');
            return;
        }
        if (permissionDenied) {
            showToast('Abra as configurações do aparelho, permita notificações para o Acionar e volte ao aplicativo.', 'error');
            return;
        }

        requestNotificationPermission(async (granted) => {
            if (!granted) return;
            setAlarmEnabled(true);
            const subscription = await registerWebPushSubscription().catch(() => null);
            if (subscription) {
                removePushOnboarding();
                showToast('Notificações ativadas neste aparelho.', 'success');
            }
        });
    });

    document.body.appendChild(card);
}

async function deactivateCurrentWebPushSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (!subscription?.endpoint) return;

        await supabase
            .from('push_subscriptions')
            .update({ ativo: false, atualizado_em: new Date().toISOString() })
            .eq('endpoint', subscription.endpoint);
    } catch (error) {
        console.warn('Não foi possível desativar o Push deste aparelho no logout:', error);
    }
}

export function initAudioContext() {
    try {
        if (!audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
                audioCtx = new AudioContextClass();
            }
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    } catch (e) {
        console.warn("AudioContext init warning:", e);
    }
}

// Desbloquear AudioContext no primeiro toque em qualquer parte da tela
if (typeof window !== 'undefined') {
    const unlockAudio = () => {
        initAudioContext();
        window.removeEventListener('click', unlockAudio);
        window.removeEventListener('touchstart', unlockAudio);
    };
    window.addEventListener('click', unlockAudio, { once: true });
    window.addEventListener('touchstart', unlockAudio, { once: true });
}

export function playNotificationSound() {
    if (!isAlarmEnabled()) return;

    try {
        initAudioContext();
        if (!audioCtx) return;

        const now = audioCtx.currentTime;

        // Tom 1 (E5 - 659.25Hz)
        const osc1 = audioCtx.createOscillator();
        const gain1 = audioCtx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(659.25, now);
        gain1.gain.setValueAtTime(0.4, now);
        gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
        osc1.connect(gain1);
        gain1.connect(audioCtx.destination);
        osc1.start(now);
        osc1.stop(now + 0.35);

        // Tom 2 (A5 - 880Hz)
        const osc2 = audioCtx.createOscillator();
        const gain2 = audioCtx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(880, now + 0.18);
        gain2.gain.setValueAtTime(0.5, now + 0.18);
        gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.65);
        osc2.connect(gain2);
        gain2.connect(audioCtx.destination);
        osc2.start(now + 0.18);
        osc2.stop(now + 0.65);

        // Vibrar celular se suportado
        if ('vibrate' in navigator) {
            navigator.vibrate([250, 120, 250]);
        }
    } catch (err) {
        console.warn("Erro ao reproduzir som de notificação:", err);
    }
}

export function toggleAlarmState(callback) {
    initAudioContext();
    const currentState = isAlarmEnabled();
    const newState = !currentState;

    if (newState) {
        requestNotificationPermission(async (granted) => {
            if (granted) {
                setAlarmEnabled(true);
                const subscription = await registerWebPushSubscription().catch((err) => {
                    console.warn('Registro Web Push não concluído:', err);
                    lastPushRegistrationError = err?.name === 'NotAllowedError'
                        ? 'O iPhone bloqueou a permissão de notificações para o Acionar.'
                        : 'O iPhone não concluiu o vínculo com as notificações. Feche o aplicativo, abra novamente e tente ativar.';
                    return null;
                });
                playNotificationSound();
                showToast(
                    subscription
                        ? 'Notificações ativadas neste dispositivo.'
                        : lastPushRegistrationError || 'Não foi possível vincular este aparelho às notificações em segundo plano.',
                    subscription ? 'success' : 'info'
                );
                if (callback) callback(true);
            } else {
                setAlarmEnabled(false);
                showToast('Permissão de notificação não foi liberada neste dispositivo.', 'error');
                if (callback) callback(false);
            }
        });
    } else {
        setAlarmEnabled(false);
        showToast('Alarme sonoro DESATIVADO.', 'info');
        if (callback) callback(false);
    }
}

export function requestNotificationPermission(callback) {
    initAudioContext();
    registerServiceWorker();

    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

    if (isIOS && !isStandalone) {
        showToast('No iPhone, abra no Safari e use Compartilhar > Adicionar à Tela de Início. Depois ative as notificações no app instalado.', 'error');
        if (callback) callback(false);
        return;
    }

    if (!('Notification' in window)) {
        showToast('Este dispositivo não oferece notificações para este aplicativo.', 'error');
        if (callback) callback(false);
        return;
    }

    if (Notification.permission === 'granted') {
        if (callback) callback(true);
        return;
    }

    if (Notification.permission === 'denied') {
        showToast('Notificações estão bloqueadas. Libere nas configurações do navegador/sistema.', 'error');
        if (callback) callback(false);
        return;
    }

    try {
        const req = Notification.requestPermission((permission) => {
            if (callback) callback(permission === 'granted');
        });

        if (req && typeof req.then === 'function') {
            req.then((permission) => {
                if (callback) callback(permission === 'granted');
            }).catch(() => {
                if (callback) callback(false);
            });
        }
    } catch (e) {
        if (callback) callback(false);
    }
}

function normalizeNotificationPayload(titleOrPayload, body = '') {
    if (titleOrPayload && typeof titleOrPayload === 'object') {
        return {
            title: titleOrPayload.title || 'Novo agendamento',
            body: titleOrPayload.body || '',
            tag: titleOrPayload.tag || 'acionar-notificacao',
            data: titleOrPayload.data || { url: './dashboard.html' }
        };
    }
    return {
        title: titleOrPayload || 'Novo agendamento',
        body: body || '',
        tag: 'acionar-notificacao',
        data: { url: './dashboard.html' }
    };
}

export function triggerSystemNotification(titleOrPayload, body = '') {
    const payload = normalizeNotificationPayload(titleOrPayload, body);
    playNotificationSound();

    const options = {
        body: payload.body,
        icon: './icons/icon-192.png',
        badge: './icons/badge-96.png',
        vibrate: [300, 100, 300],
        tag: payload.tag,
        renotify: true,
        requireInteraction: true,
        data: payload.data
    };

    if ('Notification' in window && Notification.permission === 'granted' && isAlarmEnabled()) {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.ready
                .then((reg) => reg.showNotification(payload.title, options))
                .catch(() => new Notification(payload.title, options));
            return;
        }

        try {
            // Emite notificação nativa através do Service Worker (compatível com Android e iOS PWA em segundo plano)
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.ready.then((reg) => {
                    reg.showNotification(payload.title, {
                        body: payload.body,
                        icon: './icons/icon-192.png',
                        badge: './icons/badge-96.png',
                        vibrate: [300, 100, 300],
                        tag: payload.tag,
                        renotify: true,
                        requireInteraction: true,
                        data: payload.data
                    });
                }).catch(() => {
                    new Notification(payload.title, { body: payload.body, data: payload.data });
                });
            } else {
                new Notification(payload.title, { body: payload.body, data: payload.data });
            }
        } catch (e) {
            console.warn("Erro ao emitir notificação nativa:", e);
        }
    }
}

// --- SUPABASE REALTIME COM ALERTA SONORO ---
export function subscribeToAgendamentos(callback) {
    try {
        const channel = supabase
            .channel('realtime_agendamentos')
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'agendamentos' },
                (payload) => {
                    console.log('⚡ Atualização em tempo real detectada:', payload);

                    if (payload.eventType === 'INSERT') {
                        notifyInsertedAppointment(payload.new?.id);
                    }

                    if (callback) callback(payload);
                }
            )
            .subscribe((status) => {
                console.log('Status da assinatura Realtime:', status);
            });

        return channel;
    } catch (err) {
        console.warn("Erro ao assinar canal Realtime no Supabase:", err);
        return null;
    }
}

async function fetchAppointmentNotificationRecord(id) {
    if (!id) return null;
    const { data, error } = await supabase
        .from('agendamentos')
        .select(`
            id,
            cliente_id,
            servico_id,
            subservico_id,
            profissional_id,
            data_hora_inicio,
            data_hora_fim,
            status,
            tipo_atendimento,
            endereco_atendimento,
            observacoes,
            clientes ( id, nome, whatsapp ),
            servicos ( id, nome, duracao_minutos )
        `)
        .eq('id', id)
        .maybeSingle();

    if (error) {
        console.warn('Erro ao buscar detalhes da notificação:', error);
        return null;
    }
    return data || null;
}

async function notifyInsertedAppointment(id) {
    try {
        await ensureActiveProfessionalFromSession();
        await fetchActiveProfessionalServiceIds();
        await fetchActiveProfessionalExternalAcceptance();
        await fetchActiveProfessionalHorarioConfig();

        const agendamento = await fetchAppointmentNotificationRecord(id);
        if (!agendamento) return;

        const start = new Date(agendamento.data_hora_inicio);
        let relatedAgendamentos = [agendamento];
        if (!Number.isNaN(start.getTime())) {
            const inicioDia = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0).toISOString();
            const fimDia = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 59).toISOString();
            const { data: dayItems } = await supabase
                .from('agendamentos')
                .select('id, data_hora_inicio, data_hora_fim, status, profissional_id, servico_id, subservico_id, tipo_atendimento, servicos(duracao_minutos)')
                .gte('data_hora_inicio', inicioDia)
                .lte('data_hora_inicio', fimDia)
                .neq('status', 'cancelado');
            if (Array.isArray(dayItems) && dayItems.length > 0) {
                relatedAgendamentos = dayItems.map(item => item.id === agendamento.id ? { ...agendamento, ...item } : item);
            }
        }

        if (!filterAppointmentsForActiveProfessional(relatedAgendamentos).some(item => item.id === agendamento.id)) return;

        triggerSystemNotification(buildAppointmentNotificationPayload(agendamento, 'new'));
    } catch (err) {
        console.warn('Erro ao notificar novo agendamento:', err);
    }
}

// --- CONFIGURAÇÃO DE MENSAGEM DO WHATSAPP E ENDEREÇO ---
export const MENSAGEM_WHATSAPP_PADRAO = `Olá, *{cliente}*! 👋

Seu agendamento para *{servico}* foi *CONFIRMADO* para o dia *{data}* às *{hora}*.

📍 *Endereço*: {endereco}

Por gentileza, informe se concorda com este horário ou se prefere realizar alguma alteração.

📌 *Lembrete importante*: Pedimos a gentileza de chegar com **15 minutos de antecedência**.

Agradecemos a preferência e aguardamos você!😊`;

export const MENSAGEM_MANUTENCAO_PADRAO = `Olá, *{cliente}*! 👋

Passando para lembrar que sua *MANUTENÇÃO PERIÓDICA* de *{servico}* está agendada para o dia *{data}* às *{hora}*.

📍 *Endereço*: {endereco}

📌 *Lembrete*: Essa manutenção é essencial para garantir o melhor resultado do seu serviço!

Caso precise fazer algum ajuste de horário, por favor nos responda por aqui. Aguardamos você! 😊`;

export async function fetchConfiguracaoMensagemWhatsApp(profissionalId = null) {
    const activeProf = getActiveProfessional();
    const targetProfId = profissionalId || activeProf?.id;

    try {
        if (targetProfId) {
            const { data: indData } = await supabase
                .from('configuracoes')
                .select('valor')
                .eq('chave', `mensagem_whatsapp_${targetProfId}`)
                .maybeSingle();

            if (indData && indData.valor) return indData.valor;
        }

        const { data, error } = await supabase
            .from('configuracoes')
            .select('valor')
            .eq('chave', 'mensagem_whatsapp')
            .maybeSingle();

        if (!error && data && data.valor) return data.valor;
    } catch (err) {
        console.warn("Usando configuração padrão de mensagem WhatsApp:", err);
    }

    return {
        mensagem: MENSAGEM_WHATSAPP_PADRAO,
        mensagem_manutencao: MENSAGEM_MANUTENCAO_PADRAO,
        endereco: "Rua Principal, 123 - Centro"
    };
}

export async function saveConfiguracaoMensagemWhatsApp({ mensagem, mensagem_manutencao, endereco }) {
    const activeProf = getActiveProfessional();
    const chave = activeProf?.id ? `mensagem_whatsapp_${activeProf.id}` : 'mensagem_whatsapp';

    const { error } = await supabase
        .from('configuracoes')
        .upsert({
            chave,
            valor: { mensagem, mensagem_manutencao, endereco },
            descricao: `Template personalizado de mensagem no WhatsApp do profissional ${activeProf?.nome || ''}`
        }, { onConflict: 'chave' });

    if (error) throw error;
    return true;
}

// --- GERADOR DE MENSAGEM CORDIAL DE WHATSAPP ---
export async function generateWhatsAppConfirmMessage({ clienteNome, servicoNome, dataFormatada, horaInicio, profissionalId = null }) {
    const config = await fetchConfiguracaoMensagemWhatsApp(profissionalId);
    let template = config.mensagem || MENSAGEM_WHATSAPP_PADRAO;
    const endereco = config.endereco || "Nosso Endereço";

    template = template
        .replace(/\{cliente\}/g, clienteNome || '')
        .replace(/\{servico\}/g, servicoNome || '')
        .replace(/\{data\}/g, dataFormatada || '')
        .replace(/\{hora\}/g, horaInicio || '')
        .replace(/\{endereco\}/g, endereco || '');

    return encodeURIComponent(template);
}

export async function generateWhatsAppManutencaoMessage({ clienteNome, servicoNome, dataFormatada, horaInicio, profissionalId = null }) {
    const config = await fetchConfiguracaoMensagemWhatsApp(profissionalId);
    let template = config.mensagem_manutencao || MENSAGEM_MANUTENCAO_PADRAO;
    const endereco = config.endereco || "Nosso Endereço";

    template = template
        .replace(/\{cliente\}/g, clienteNome || '')
        .replace(/\{servico\}/g, servicoNome || '')
        .replace(/\{data\}/g, dataFormatada || '')
        .replace(/\{hora\}/g, horaInicio || '')
        .replace(/\{endereco\}/g, endereco || '');

    return encodeURIComponent(template);
}

// --- MODAL DE ALTERAÇÃO DE STATUS ---
export function showChangeStatusModal({ id, currentStatus, clienteNome, servicoNome, onSelect }) {
    let modal = document.getElementById('global-status-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'global-status-modal';
        modal.className = 'fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/80 backdrop-blur-md p-0 sm:p-4 transition-all duration-200 hidden';
        modal.innerHTML = `
            <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-[2.5rem] sm:rounded-[2.5rem] w-full max-w-sm p-6 shadow-2xl space-y-4 my-0 sm:my-auto">
                <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
                    <div>
                        <h3 class="text-base font-extrabold text-slate-900 dark:text-white">Alterar Status</h3>
                        <p id="global-status-subtitle" class="text-xs text-slate-500 dark:text-slate-400 font-medium truncate max-w-[240px]"></p>
                    </div>
                    <button id="global-status-close" class="h-8 w-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-200">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
                    </button>
                </div>

                <div class="space-y-2" id="global-status-options">
                    <!-- Preenchido via JS -->
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    const subtitleEl = document.getElementById('global-status-subtitle');
    const optionsContainer = document.getElementById('global-status-options');
    const closeBtn = document.getElementById('global-status-close');

    subtitleEl.textContent = `${clienteNome} — ${servicoNome}`;

    const statuses = [
        { key: 'pendente', label: 'Confirmado / Pendente', sub: 'Aguardando atendimento', color: 'blue', icon: 'calendar-check' },
        { key: 'em_atendimento', label: 'Em Atendimento', sub: 'Serviço em andamento', color: 'sky', icon: 'play-circle' },
        { key: 'concluido', label: 'Já Atendido / Concluído', sub: 'Serviço finalizado', color: 'emerald', icon: 'check-circle-2' },
        { key: 'agendar_manutencao', label: '🔧 Agendar Manutenção Periódica', sub: 'Programar retorno (30, 45, 60 dias)', color: 'purple', icon: 'wrench' },
        { key: 'cancelado', label: 'Cancelado / Recusado', sub: 'Agendamento desmarcado', color: 'rose', icon: 'x-circle' }
    ];

    optionsContainer.innerHTML = '';
    statuses.forEach(st => {
        const isCurrent = (currentStatus || '').toLowerCase() === st.key;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `w-full flex items-center justify-between p-3.5 rounded-2xl border text-left transition-all ${
            isCurrent 
                ? 'border-blue-600 bg-blue-500/10 dark:bg-blue-500/20 text-slate-900 dark:text-white shadow-sm' 
                : 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
        }`;

        btn.innerHTML = `
            <div class="flex items-center gap-3 min-w-0">
                <div class="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${
                    st.color === 'blue' ? 'bg-blue-500/10 text-blue-500' :
                    st.color === 'sky' ? 'bg-sky-500/10 text-sky-500' :
                    st.color === 'emerald' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'
                }">
                    <i data-lucide="${st.icon}" class="h-5 w-5"></i>
                </div>
                <div class="min-w-0">
                    <span class="block font-extrabold text-xs text-slate-900 dark:text-white truncate">${st.label}</span>
                    <span class="block text-[11px] text-slate-400 font-medium truncate">${st.sub}</span>
                </div>
            </div>
            ${isCurrent ? '<i data-lucide="check" class="h-4 w-4 text-blue-500 shrink-0"></i>' : ''}
        `;

        btn.addEventListener('click', () => {
            modal.classList.add('hidden');
            if (onSelect) onSelect(st.key);
        });

        optionsContainer.appendChild(btn);
    });

    if (window.lucide) window.lucide.createIcons();
    modal.classList.remove('hidden');

    closeBtn.onclick = () => modal.classList.add('hidden');
}

// --- MODAL DE AGENDAMENTO DE MANUTENÇÃO PERIÓDICA ---
// --- MODAL DE OBSERVACOES DO AGENDAMENTO ---
export function showAppointmentNotesModal({ id, clienteNome, servicoNome, observacoes = '', onSave }) {
    let modal = document.getElementById('global-appointment-notes-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'global-appointment-notes-modal';
        modal.className = 'fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/80 backdrop-blur-md p-0 sm:p-4 transition-all duration-200 hidden';
        modal.innerHTML = `
            <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-[2.5rem] sm:rounded-[2rem] w-full max-w-md p-6 shadow-2xl space-y-4 my-0 sm:my-auto">
                <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
                    <div class="flex items-center gap-3 min-w-0">
                        <div class="h-10 w-10 rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-300 flex items-center justify-center shrink-0">
                            <i class="fa-solid fa-note-sticky text-base"></i>
                        </div>
                        <div class="min-w-0">
                            <h3 class="text-base font-extrabold text-slate-900 dark:text-white">Observacoes</h3>
                            <p id="appointment-notes-subtitle" class="text-xs text-slate-500 dark:text-slate-400 font-medium truncate max-w-[260px]"></p>
                        </div>
                    </div>
                    <button id="appointment-notes-close" class="h-8 w-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-200">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
                    </button>
                </div>

                <div id="appointment-notes-original-wrap" class="hidden rounded-2xl border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/10 p-3">
                    <div class="flex items-center gap-2 text-[10px] font-black uppercase text-amber-700 dark:text-amber-300 mb-1">
                        <i class="fa-solid fa-circle-info text-xs"></i>
                        Observacao atual
                    </div>
                    <p id="appointment-notes-original" class="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap break-words"></p>
                </div>

                <label class="block space-y-2">
                    <span class="text-[11px] font-black uppercase tracking-wide text-slate-500 dark:text-slate-400">Anotacoes do profissional</span>
                    <textarea id="appointment-notes-textarea" rows="6" maxlength="1000" class="w-full resize-none rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-4 py-3 text-sm text-slate-900 dark:text-white outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500" placeholder="Digite uma observacao ou complemento interno..."></textarea>
                </label>

                <div class="flex items-center justify-between gap-3 pt-1">
                    <button id="appointment-notes-clear" type="button" class="h-11 px-4 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-extrabold hover:bg-slate-200 dark:hover:bg-slate-700">
                        Limpar
                    </button>
                    <button id="appointment-notes-save" type="button" class="h-11 px-5 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-500 text-white text-xs font-extrabold shadow-lg shadow-amber-500/20">
                        Salvar observacao
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    const subtitleEl = document.getElementById('appointment-notes-subtitle');
    const originalWrap = document.getElementById('appointment-notes-original-wrap');
    const originalEl = document.getElementById('appointment-notes-original');
    const textarea = document.getElementById('appointment-notes-textarea');
    const closeBtn = document.getElementById('appointment-notes-close');
    const clearBtn = document.getElementById('appointment-notes-clear');
    const saveBtn = document.getElementById('appointment-notes-save');
    const currentNotes = String(observacoes || '').trim();

    subtitleEl.textContent = `${clienteNome || 'Cliente'} - ${servicoNome || 'Servico'}`;
    textarea.value = currentNotes;
    originalEl.textContent = currentNotes;
    originalWrap.classList.toggle('hidden', !currentNotes);

    const close = () => modal.classList.add('hidden');
    closeBtn.onclick = close;
    clearBtn.onclick = () => {
        textarea.value = '';
        textarea.focus();
    };
    saveBtn.onclick = async () => {
        if (!id || !onSave) return;
        const nextValue = textarea.value.trim();
        saveBtn.disabled = true;
        saveBtn.classList.add('opacity-70', 'cursor-wait');
        try {
            await onSave(nextValue);
            close();
        } finally {
            saveBtn.disabled = false;
            saveBtn.classList.remove('opacity-70', 'cursor-wait');
        }
    };

    modal.classList.remove('hidden');
    setTimeout(() => textarea.focus(), 50);
}

export function showManutencaoPromptModal({ agendamento, onSchedule, onSkip }) {
    let modal = document.getElementById('global-manutencao-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'global-manutencao-modal';
        modal.className = 'fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/80 backdrop-blur-md p-0 sm:p-4 transition-all duration-200 hidden overflow-y-auto';
        modal.innerHTML = `
            <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-[2.5rem] sm:rounded-[2.5rem] w-full max-w-md p-6 shadow-2xl space-y-5 my-0 sm:my-auto max-h-[92vh] overflow-y-auto">
                <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
                    <div class="flex items-center gap-3">
                        <div class="h-10 w-10 rounded-2xl bg-purple-500/10 text-purple-600 dark:text-purple-400 flex items-center justify-center font-bold">
                            <i data-lucide="wrench" class="h-5 w-5"></i>
                        </div>
                        <div>
                            <h3 class="text-base font-extrabold text-slate-900 dark:text-white">Manutenção Periódica</h3>
                            <p id="manutencao-subtitle" class="text-xs text-slate-500 dark:text-slate-400 font-medium truncate max-w-[220px]"></p>
                        </div>
                    </div>
                    <button id="manutencao-close" class="h-8 w-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-200">
                        <i data-lucide="x" class="h-4 w-4"></i>
                    </button>
                </div>

                <div class="p-3.5 rounded-2xl bg-purple-500/10 border border-purple-500/20 space-y-1">
                    <p class="text-xs font-bold text-purple-700 dark:text-purple-300">Deseja agendar a manutenção periódica deste serviço?</p>
                    <p class="text-[11px] text-purple-600/80 dark:text-purple-400/80 font-medium leading-relaxed">
                        Defina em quanto tempo o cliente deve retornar ao salão para realizar a manutenção do serviço aplicado.
                    </p>
                </div>

                <!-- Chips de Periodicidade -->
                <div class="space-y-2">
                    <label class="block text-xs font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400">Tempo para Retorno / Manutenção</label>
                    <div class="grid grid-cols-3 gap-2" id="manutencao-chips-container">
                        <button type="button" data-days="15" class="chip-periodicity active p-2.5 rounded-xl border-2 border-purple-600 bg-purple-500/10 text-xs font-black text-purple-600 dark:text-purple-400 transition-all text-center">
                            15 Dias
                        </button>
                        <button type="button" data-days="30" class="chip-periodicity p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 hover:border-purple-500 hover:bg-purple-50 dark:hover:bg-purple-950/30 text-xs font-extrabold text-slate-700 dark:text-slate-300 transition-all text-center">
                            30 Dias (1 Mês)
                        </button>
                        <button type="button" data-days="45" class="chip-periodicity p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 hover:border-purple-500 hover:bg-purple-50 dark:hover:bg-purple-950/30 text-xs font-extrabold text-slate-700 dark:text-slate-300 transition-all text-center">
                            45 Dias
                        </button>
                        <button type="button" data-days="60" class="chip-periodicity p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 hover:border-purple-500 hover:bg-purple-50 dark:hover:bg-purple-950/30 text-xs font-extrabold text-slate-700 dark:text-slate-300 transition-all text-center">
                            60 Dias (2 M)
                        </button>
                        <button type="button" data-days="90" class="chip-periodicity p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 hover:border-purple-500 hover:bg-purple-50 dark:hover:bg-purple-950/30 text-xs font-extrabold text-slate-700 dark:text-slate-300 transition-all text-center">
                            90 Dias (3 M)
                        </button>
                        <button type="button" data-days="custom" class="chip-periodicity p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 hover:border-purple-500 hover:bg-purple-50 dark:hover:bg-purple-950/30 text-xs font-extrabold text-slate-700 dark:text-slate-300 transition-all text-center">
                            Outro
                        </button>
                    </div>
                </div>

                <!-- Data e Hora -->
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label for="manutencao-data" class="block text-xs font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Data de Retorno</label>
                        <input type="date" id="manutencao-data" required class="w-full rounded-2xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 px-3 py-3 text-xs font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500">
                    </div>
                    <div>
                        <label for="manutencao-hora" class="block text-xs font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Horário</label>
                        <input type="time" id="manutencao-hora" required value="09:00" class="w-full rounded-2xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 px-3 py-3 text-xs font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500">
                    </div>
                </div>

                <!-- Observação -->
                <div>
                    <label for="manutencao-obs" class="block text-xs font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Observações (Opcional)</label>
                    <input type="text" id="manutencao-obs" placeholder="Ex: Manutenção periódica do serviço" class="w-full rounded-2xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 px-3 py-3 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500">
                </div>

                <!-- Ações -->
                <div class="flex items-center gap-2 pt-2">
                    <button type="button" id="manutencao-skip" class="flex-1 py-3.5 rounded-2xl text-xs font-bold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
                        Não Agendar
                    </button>
                    <button type="button" id="manutencao-submit" class="flex-1 py-3.5 rounded-2xl text-xs font-extrabold text-white bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 shadow-lg shadow-purple-600/25 transition-all">
                        Confirmar e Agendar
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    const subtitleEl = document.getElementById('manutencao-subtitle');
    const inputData = document.getElementById('manutencao-data');
    const inputHora = document.getElementById('manutencao-hora');
    const inputObs = document.getElementById('manutencao-obs');
    const skipBtn = document.getElementById('manutencao-skip');
    const submitBtn = document.getElementById('manutencao-submit');
    const closeBtn = document.getElementById('manutencao-close');
    const chipsContainer = document.getElementById('manutencao-chips-container');

    const clienteNome = agendamento.clienteNome || agendamento.clientes?.nome || 'Cliente';
    const servicoNome = agendamento.servicoNome || agendamento.servicos?.nome || 'Serviço';
    
    subtitleEl.textContent = `${clienteNome} — ${servicoNome}`;

    const baseDate = agendamento.data_hora_inicio ? new Date(agendamento.data_hora_inicio) : new Date();
    
    let selectedDays = 15;
    function applyDays(days) {
        const parsedDays = Number.parseInt(days, 10) || 15;
        selectedDays = parsedDays;
        const targetDate = new Date(baseDate.getTime());
        targetDate.setDate(targetDate.getDate() + parsedDays);
        inputData.value = formatDateInputValue(targetDate);
    }
    
    applyDays(15);

    if (agendamento.data_hora_inicio) {
        const d = new Date(agendamento.data_hora_inicio);
        inputHora.value = formatTimeInputValue(d);
    } else {
        inputHora.value = '09:00';
    }

    const chips = chipsContainer.querySelectorAll('.chip-periodicity');
    chips.forEach(chip => {
        chip.onclick = () => {
            chips.forEach(c => {
                c.className = 'chip-periodicity p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 hover:border-purple-500 hover:bg-purple-50 dark:hover:bg-purple-950/30 text-xs font-extrabold text-slate-700 dark:text-slate-300 transition-all text-center';
            });
            chip.className = 'chip-periodicity active p-2.5 rounded-xl border-2 border-purple-600 bg-purple-500/10 text-xs font-black text-purple-600 dark:text-purple-400 transition-all text-center';
            
            const daysAttr = chip.dataset.days;
            if (daysAttr !== 'custom') {
                const days = Number.parseInt(daysAttr, 10);
                applyDays(days);
            }
        };
    });

    modal.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons();

    const closeModal = () => modal.classList.add('hidden');

    closeBtn.onclick = () => {
        closeModal();
        if (onSkip) onSkip();
    };

    skipBtn.onclick = () => {
        closeModal();
        if (onSkip) onSkip();
    };

    submitBtn.onclick = () => {
        const dateVal = inputData.value;
        const timeVal = inputHora.value;
        if (!dateVal || !timeVal) {
            showToast('Por favor, selecione a data e horário para a manutenção.', 'error');
            return;
        }

        // Calcular dias exatos entre a data base e a data escolhida
        const [y, m, d] = dateVal.split('-').map(Number);
        const chosenDate = new Date(y, m - 1, d);
        const baseDateZero = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
        const diffDaysCalculated = Math.max(1, Math.round((chosenDate.getTime() - baseDateZero.getTime()) / (1000 * 60 * 60 * 24)));
        const finalPeriodicidade = selectedDays || diffDaysCalculated || 15;

        const dataHoraInicioISO = toLocalDateTimeISO(dateVal, timeVal);
        const obs = inputObs.value.trim() || `Manutenção Periódica de ${servicoNome}`;

        closeModal();
        if (onSchedule) {
            onSchedule({
                periodicidadeDias: finalPeriodicidade,
                dataHoraInicioISO,
                observacoes: obs
            });
        }
    };
}

// --- MODAL DE CONFIRMAÇÃO E ALERTA ELEGANTE E CURTO ---
export function showConfirmModal({ title = 'Confirmação', message, confirmText = 'Confirmar', cancelText = 'Cancelar', type = 'danger', onConfirm }) {
    let modal = document.getElementById('global-confirm-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'global-confirm-modal';
        modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm p-4 transition-all duration-200 hidden';
        modal.innerHTML = `
            <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[2.5rem] w-full max-w-sm p-6 shadow-2xl space-y-5 text-center transform transition-all duration-200 my-auto" id="global-confirm-card">
                <div id="global-confirm-icon-bg" class="h-14 w-14 rounded-full flex items-center justify-center mx-auto bg-rose-500/10 text-rose-500 border border-rose-500/20">
                    <i data-lucide="alert-triangle" id="global-confirm-icon" class="h-7 w-7"></i>
                </div>
                <div class="space-y-1.5">
                    <h3 id="global-confirm-title" class="text-base sm:text-lg font-extrabold text-slate-900 dark:text-white"></h3>
                    <p id="global-confirm-message" class="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-medium leading-relaxed"></p>
                </div>
                <div class="flex items-center justify-center gap-2.5 pt-2">
                    <button id="global-confirm-cancel" class="flex-1 py-3 rounded-full text-xs font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
                        Cancelar
                    </button>
                    <button id="global-confirm-ok" class="flex-1 py-3 rounded-full text-xs font-extrabold text-white bg-rose-600 hover:bg-rose-500 shadow-lg shadow-rose-600/20 transition-all">
                        Confirmar
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    const titleEl = document.getElementById('global-confirm-title');
    const msgEl = document.getElementById('global-confirm-message');
    const okBtn = document.getElementById('global-confirm-ok');
    const cancelBtn = document.getElementById('global-confirm-cancel');
    const iconBg = document.getElementById('global-confirm-icon-bg');
    const iconEl = document.getElementById('global-confirm-icon');

    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    cancelBtn.style.display = 'block';

    if (type === 'danger') {
        iconBg.className = 'h-14 w-14 rounded-full flex items-center justify-center mx-auto bg-rose-500/10 text-rose-500 border border-rose-500/20';
        iconEl.setAttribute('data-lucide', 'trash-2');
        okBtn.className = 'flex-1 py-3 rounded-full text-xs font-extrabold text-white bg-rose-600 hover:bg-rose-500 shadow-lg shadow-rose-600/20 transition-all';
    } else {
        iconBg.className = 'h-14 w-14 rounded-full flex items-center justify-center mx-auto bg-blue-500/10 text-blue-500 border border-blue-500/20';
        iconEl.setAttribute('data-lucide', 'check-circle');
        okBtn.className = 'flex-1 py-3 rounded-full text-xs font-extrabold text-white bg-blue-600 hover:bg-blue-500 shadow-lg shadow-blue-600/20 transition-all';
    }

    if (window.lucide) window.lucide.createIcons();
    modal.classList.remove('hidden');

    const handleOk = () => {
        modal.classList.add('hidden');
        okBtn.removeEventListener('click', handleOk);
        cancelBtn.removeEventListener('click', handleCancel);
        if (onConfirm) onConfirm();
    };

    const handleCancel = () => {
        modal.classList.add('hidden');
        okBtn.removeEventListener('click', handleOk);
        cancelBtn.removeEventListener('click', handleCancel);
    };

    okBtn.addEventListener('click', handleOk);
    cancelBtn.addEventListener('click', handleCancel);
}

export function showAlertModal({ title = 'Aviso', message, type = 'info', onOk }) {
    showConfirmModal({
        title,
        message,
        confirmText: 'Entendido',
        cancelText: '',
        type: type === 'error' ? 'danger' : 'info',
        onConfirm: onOk
    });
    const cancelBtn = document.getElementById('global-confirm-cancel');
    if (cancelBtn) cancelBtn.style.display = 'none';
}

// --- SISTEMA DE TOAST / NOTIFICAÇÕES ---
export function showToast(message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'fixed top-5 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-full max-w-sm px-4 pointer-events-none';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    const bgColor = type === 'error' 
        ? 'bg-rose-900/90 text-rose-100 border-rose-700/50 shadow-rose-900/20' 
        : type === 'info'
        ? 'bg-sky-900/90 text-sky-100 border-sky-700/50 shadow-sky-900/20'
        : 'bg-emerald-900/90 text-emerald-100 border-emerald-700/50 shadow-emerald-900/20';

    toast.className = `pointer-events-auto flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border text-sm font-medium shadow-xl backdrop-blur-md transition-all duration-300 transform translate-y-[-10px] opacity-0 ${bgColor}`;
    
    toast.innerHTML = `
        <div class="flex items-center gap-2">
            <i data-lucide="${type === 'error' ? 'alert-circle' : type === 'info' ? 'info' : 'check-circle'}" class="h-5 w-5 shrink-0"></i>
            <span>${escapeHtml(message)}</span>
        </div>
        <button class="shrink-0 p-1 text-slate-300 hover:text-white" onclick="this.parentElement.remove()">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
        </button>
    `;

    container.appendChild(toast);
    if (window.lucide) window.lucide.createIcons();

    setTimeout(() => {
        toast.classList.remove('translate-y-[-10px]', 'opacity-0');
    }, 10);

    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-[-10px]');
        setTimeout(() => toast.remove(), 300);
    }, 4500);
}

export function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
}

// --- MÁSCARA E FORMATAÇÃO DE WHATSAPP ---
export function applyPhoneMask(inputElement) {
    if (!inputElement) return;

    inputElement.addEventListener('input', (e) => {
        let value = e.target.value.replace(/\D/g, '');
        if (value.length > 11) value = value.slice(0, 11);

        if (value.length > 10) {
            e.target.value = `(${value.slice(0, 2)}) ${value.slice(2, 7)}-${value.slice(7)}`;
        } else if (value.length > 6) {
            e.target.value = `(${value.slice(0, 2)}) ${value.slice(2, 6)}-${value.slice(6)}`;
        } else if (value.length > 2) {
            e.target.value = `(${value.slice(0, 2)}) ${value.slice(2)}`;
        } else if (value.length > 0) {
            e.target.value = `(${value}`;
        }
    });
}

export function cleanPhone(formatted) {
    return (formatted || '').replace(/\D/g, '');
}

function formatPhoneDisplay(value) {
    const digits = cleanPhone(value);
    if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
    if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
    return value || digits || 'Não informado';
}

function getAppointmentCustomerName(agendamento) {
    return agendamento?.clientes?.nome || agendamento?.cliente_nome || 'Cliente';
}

function getAppointmentCustomerPhone(agendamento) {
    return agendamento?.clientes?.whatsapp || agendamento?.cliente_whatsapp || '';
}

function getAppointmentServiceName(agendamento) {
    return agendamento?.servicos?.nome || agendamento?.servico_nome || 'Serviço';
}

function getAppointmentDateParts(agendamento) {
    const date = new Date(agendamento?.data_hora_inicio);
    if (Number.isNaN(date.getTime())) {
        return { date, dateStr: 'Data não informada', timeStr: 'Horário não informado' };
    }
    return {
        date,
        dateStr: date.toLocaleDateString('pt-BR'),
        timeStr: date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };
}

function getAppointmentLocationLabel(agendamento) {
    const tipo = (agendamento?.tipo_atendimento || 'salao').toLowerCase();
    if (tipo === 'cliente' || tipo === 'externo') return 'No local do cliente';
    return 'No salão';
}

function getAppointmentObservation(agendamento) {
    return String(agendamento?.observacoes || agendamento?.observacao || '').trim();
}

export function buildAppointmentNotificationPayload(agendamento, kind = 'new') {
    const clienteNome = getAppointmentCustomerName(agendamento);
    const telefone = formatPhoneDisplay(getAppointmentCustomerPhone(agendamento));
    const servicoNome = getAppointmentServiceName(agendamento);
    const { dateStr, timeStr } = getAppointmentDateParts(agendamento);
    const local = getAppointmentLocationLabel(agendamento);
    const observacoes = getAppointmentObservation(agendamento);

    const title = kind === 'upcoming'
        ? `Atendimento em breve: ${clienteNome}`
        : `Novo agendamento: ${clienteNome}`;

    return {
        title,
        body: [
            `WhatsApp: ${telefone}`,
            `Servico: ${servicoNome}`,
            `Data: ${dateStr} as ${timeStr}`,
            `Local: ${local}`,
            observacoes ? `Obs: ${observacoes}` : ''
        ].filter(Boolean).join('\n'),
        tag: `${kind}-agendamento-${agendamento?.id || Date.now()}`,
        data: {
            url: './dashboard.html',
            agendamento_id: agendamento?.id || null,
            agendamentoId: agendamento?.id || null,
            clienteNome,
            telefone,
            servicoNome,
            data: dateStr,
            hora: timeStr,
            local,
            observacoes,
            kind
        }
    };
}

function isMissingColumnError(error, columnName) {
    const text = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`;
    return text.includes(columnName);
}

function isRequestStatus(status) {
    const statusLower = (status || '').toLowerCase();
    return statusLower === 'aguardando_confirmacao' || statusLower === 'solicitado';
}

function isUnassignedRequest(agendamento) {
    const statusLower = (agendamento?.status || '').toLowerCase();
    const isPendingPublicRequest = statusLower === 'pendente' && !getAppointmentProfessionalId(agendamento);
    return !getAppointmentProfessionalId(agendamento) && (isRequestStatus(statusLower) || isPendingPublicRequest);
}

function isAppointmentRequest(agendamento) {
    return isRequestStatus(agendamento?.status) || isUnassignedRequest(agendamento);
}

function getActiveProfessionalId() {
    const activeProf = getActiveProfessional();
    return activeProf?.id || null;
}

function getAppointmentProfessionalId(agendamento) {
    return agendamento?.profissional_id || agendamento?.profissionais?.id || null;
}

let activeProfessionalServiceIdsCache = null;
let activeProfessionalServiceRuleIdsCache = null;
let activeProfessionalSubserviceIdsCache = null;
let activeProfessionalSubserviceRuleIdsCache = null;
let activeProfessionalDisabledSubserviceIdsCache = null;
let activeProfessionalHorarioConfigCache = null;
let activeProfessionalExternalAcceptanceCache = null;

async function fetchActiveProfessionalServiceIds() {
    const activeProfId = getActiveProfessionalId();
    if (!activeProfId) {
        activeProfessionalServiceIdsCache = null;
        activeProfessionalServiceRuleIdsCache = null;
        activeProfessionalSubserviceIdsCache = null;
        activeProfessionalSubserviceRuleIdsCache = null;
        activeProfessionalDisabledSubserviceIdsCache = null;
        return null;
    }

    try {
        const [servicesRes, subservicesRes] = await Promise.all([
            supabase
                .from('profissional_servicos')
                .select('servico_id, ativo')
                .eq('profissional_id', activeProfId),
            supabase
                .from('profissional_subservicos')
                .select('subservico_id, ativo')
                .eq('profissional_id', activeProfId)
        ]);

        if (servicesRes.error) throw servicesRes.error;
        if (subservicesRes.error) throw subservicesRes.error;

        const serviceRows = servicesRes.data || [];
        const subserviceRows = subservicesRes.data || [];

        activeProfessionalServiceRuleIdsCache = new Set(serviceRows.map(row => row.servico_id).filter(Boolean));
        activeProfessionalServiceIdsCache = new Set(serviceRows.filter(row => row.ativo !== false).map(row => row.servico_id).filter(Boolean));
        activeProfessionalSubserviceRuleIdsCache = new Set(subserviceRows.map(row => row.subservico_id).filter(Boolean));
        activeProfessionalSubserviceIdsCache = new Set(subserviceRows.filter(row => row.ativo !== false).map(row => row.subservico_id).filter(Boolean));
        activeProfessionalDisabledSubserviceIdsCache = new Set(subserviceRows.filter(row => row.ativo === false).map(row => row.subservico_id).filter(Boolean));
        return activeProfessionalServiceIdsCache;
    } catch (err) {
        console.warn('Tabelas de habilitacao profissional indisponiveis, usando catalogo legado.', err);
        activeProfessionalServiceIdsCache = null;
        activeProfessionalServiceRuleIdsCache = null;
        activeProfessionalSubserviceIdsCache = null;
        activeProfessionalSubserviceRuleIdsCache = null;
        activeProfessionalDisabledSubserviceIdsCache = null;
        return null;
    }
}

function canActiveProfessionalHandleService(servicoId, subservicoId = null) {
    if (!servicoId) return true;
    if (
        activeProfessionalServiceRuleIdsCache &&
        activeProfessionalServiceRuleIdsCache.size > 0 &&
        !activeProfessionalServiceIdsCache?.has(servicoId)
    ) {
        return false;
    }
    if (subservicoId && activeProfessionalDisabledSubserviceIdsCache?.has(subservicoId)) {
        return false;
    }
    if (subservicoId && activeProfessionalSubserviceRuleIdsCache?.has(subservicoId)) {
        return activeProfessionalSubserviceIdsCache?.has(subservicoId) === true;
    }
    return true;
}

async function fetchActiveProfessionalHorarioConfig() {
    const activeProfId = getActiveProfessionalId();
    if (!activeProfId) {
        activeProfessionalHorarioConfigCache = null;
        return null;
    }

    try {
        activeProfessionalHorarioConfigCache = await fetchConfiguracaoHorarios(activeProfId);
        return activeProfessionalHorarioConfigCache;
    } catch (err) {
        console.warn('Configuracao de horario do profissional indisponivel:', err);
        activeProfessionalHorarioConfigCache = null;
        return null;
    }
}

async function fetchActiveProfessionalExternalAcceptance() {
    const activeProfId = getActiveProfessionalId();
    if (!activeProfId) {
        activeProfessionalExternalAcceptanceCache = null;
        return null;
    }

    try {
        const { data, error } = await supabase
            .from('profissionais')
            .select('aceita_atendimento_externo')
            .eq('id', activeProfId)
            .maybeSingle();

        if (error) throw error;
        activeProfessionalExternalAcceptanceCache = Boolean(data?.aceita_atendimento_externo);
        return activeProfessionalExternalAcceptanceCache;
    } catch (err) {
        console.warn('Parametro de atendimento externo indisponivel:', err);
        activeProfessionalExternalAcceptanceCache = null;
        return null;
    }
}

function canActiveProfessionalHandleLocation(agendamento) {
    const tipo = (agendamento?.tipo_atendimento || 'salao').toLowerCase();
    if (tipo !== 'cliente' && tipo !== 'externo') return true;
    return activeProfessionalExternalAcceptanceCache === true;
}

function horarioToMinutes(value) {
    const [hours, minutes] = String(value || '').slice(0, 5).split(':').map(Number);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
    return (hours * 60) + minutes;
}

function canActiveProfessionalAttendAppointment(agendamento) {
    const activeProfId = getActiveProfessionalId();
    if (!activeProfId || !activeProfessionalHorarioConfigCache) return true;

    const range = getAgendamentoRangeMs(agendamento);
    if (!range) return false;

    const startDate = new Date(range.start);
    const endDate = new Date(range.end);
    if (
        Number.isNaN(startDate.getTime()) ||
        Number.isNaN(endDate.getTime()) ||
        startDate.toDateString() !== endDate.toDateString()
    ) {
        return false;
    }

    const dayConfig = activeProfessionalHorarioConfigCache?.dias?.[String(startDate.getDay())];
    if (!dayConfig?.ativo || !Array.isArray(dayConfig.turnos) || dayConfig.turnos.length === 0) {
        return false;
    }

    const startMinutes = (startDate.getHours() * 60) + startDate.getMinutes();
    const endMinutes = (endDate.getHours() * 60) + endDate.getMinutes();

    return dayConfig.turnos.some(turno => {
        const turnoStart = horarioToMinutes(turno?.inicio);
        const turnoEnd = horarioToMinutes(turno?.fim);
        if (turnoStart === null || turnoEnd === null || turnoEnd <= turnoStart) return false;
        return startMinutes >= turnoStart && endMinutes <= turnoEnd;
    });
}

function belongsToActiveProfessional(record, columnName = 'profissional_id') {
    const activeProf = getActiveProfessional();
    const activeProfId = activeProf?.id || null;
    const recordProfId = record?.[columnName] || record?.profissionais?.id || record?.agendamentos?.profissional_id || null;
    if (!activeProfId) return !recordProfId;
    if (recordProfId) return recordProfId === activeProfId;
    return activeProf?.cargo !== 'auxiliar';
}

function hasProfessionalMarker(record, columnName = 'profissional_id') {
    return Object.prototype.hasOwnProperty.call(record || {}, columnName) ||
        Object.prototype.hasOwnProperty.call(record?.agendamentos || {}, 'profissional_id') ||
        Boolean(record?.profissionais?.id);
}

function filterRecordsForActiveProfessional(records, columnName = 'profissional_id') {
    const list = records || [];
    if (getActiveProfessionalId() && !list.some(record => hasProfessionalMarker(record, columnName))) {
        return list;
    }
    return list.filter(record => belongsToActiveProfessional(record, columnName));
}

function getAgendamentoRangeMs(agendamento) {
    if (!agendamento?.data_hora_inicio) return null;
    const start = new Date(agendamento.data_hora_inicio).getTime();
    if (Number.isNaN(start)) return null;

    let end = agendamento.data_hora_fim ? new Date(agendamento.data_hora_fim).getTime() : NaN;
    if (Number.isNaN(end) || end <= start) {
        const duration = Number(
            agendamento?.servicos?.duracao_minutos ||
            agendamento?.servico_duracao_minutos ||
            30
        );
        end = start + Math.max(duration || 30, 15) * 60000;
    }

    return { start, end };
}

function rangesOverlap(a, b) {
    return Boolean(a && b && a.start < b.end && a.end > b.start);
}

function professionalHasConflictWithAppointment(targetAgendamento, allAgendamentos, profissionalId) {
    if (!targetAgendamento || !profissionalId) return false;
    const targetRange = getAgendamentoRangeMs(targetAgendamento);
    if (!targetRange) return false;

    return (allAgendamentos || []).some(ag => {
        if (!ag || ag.id === targetAgendamento.id) return false;
        if ((ag.status || '').toLowerCase() === 'cancelado') return false;
        if ((getAppointmentProfessionalId(ag) || null) !== profissionalId) return false;
        return rangesOverlap(targetRange, getAgendamentoRangeMs(ag));
    });
}

function canActiveProfessionalSeeSharedRequest(agendamento, allAgendamentos) {
    const activeProfId = getActiveProfessionalId();
    if (!activeProfId) return true;
    if (!canActiveProfessionalHandleService(agendamento?.servico_id || agendamento?.servicos?.id, agendamento?.subservico_id)) {
        return false;
    }
    if (!canActiveProfessionalHandleLocation(agendamento)) {
        return false;
    }
    if (!canActiveProfessionalAttendAppointment(agendamento)) {
        return false;
    }
    return !professionalHasConflictWithAppointment(agendamento, allAgendamentos, activeProfId);
}

function filterAppointmentsForActiveProfessional(agendamentos) {
    const list = agendamentos || [];
    return list.filter(ag => {
        // Solicitacoes publicas sem responsavel aparecem para toda a equipe.
        // Habilitacao, horario e conflito continuam validados ao aceitar.
        if (isUnassignedRequest(ag)) return true;
        return belongsToActiveProfessional(ag);
    });
}

async function assertProfessionalCanClaimAppointment(agendamentoId, currentAgendamento, profissionalId) {
    if (!agendamentoId || !profissionalId) return;

    await fetchActiveProfessionalServiceIds();
    if (!canActiveProfessionalHandleService(currentAgendamento?.servico_id, currentAgendamento?.subservico_id)) {
        const err = new Error('Este profissional nao esta habilitado para este servico.');
        err.isNotAllowed = true;
        throw err;
    }

    await fetchActiveProfessionalExternalAcceptance();
    if (!canActiveProfessionalHandleLocation(currentAgendamento)) {
        const err = new Error('Este profissional nao aceita atendimento no local do cliente.');
        err.isNotAllowed = true;
        throw err;
    }

    await fetchActiveProfessionalHorarioConfig();
    if (!canActiveProfessionalAttendAppointment(currentAgendamento)) {
        const err = new Error('Este profissional nao atende neste dia ou horario.');
        err.isNotAllowed = true;
        throw err;
    }

    const currentRange = getAgendamentoRangeMs(currentAgendamento);
    if (!currentRange) return;

    const { data, error } = await supabase
        .from('agendamentos')
        .select('id, data_hora_inicio, data_hora_fim, status, profissional_id, servicos(duracao_minutos)')
        .eq('profissional_id', profissionalId)
        .neq('status', 'cancelado');

    if (error) throw error;

    const conflito = (data || []).some(ag => {
        if (ag.id === agendamentoId) return false;
        return rangesOverlap(currentRange, getAgendamentoRangeMs(ag));
    });

    if (conflito) {
        const err = new Error('Este profissional ja possui agendamento neste horario.');
        err.isConflict = true;
        throw err;
    }
}

async function updateClienteProfessional(clienteId, profissionalId) {
    if (!clienteId) return;

    try {
        const { error } = await supabase
            .from('clientes')
            .update({ profissional_id: profissionalId || null })
            .eq('id', clienteId);

        if (error && !String(error.message || '').includes('profissional_id')) {
            console.warn('Erro ao atualizar profissional do cliente:', error);
        }
    } catch (err) {
        console.warn('Coluna profissional_id em clientes indisponivel:', err);
    }
}

// --- GESTÃO DE CONFIGURAÇÕES DE HORÁRIO DE FUNCIONAMENTO ---
async function resolveProfessionalScheduleRole(profissionalId, activeProf = null) {
    if (!profissionalId) return null;

    let cargo = activeProf?.id === profissionalId ? activeProf?.cargo : null;

    try {
        const { data, error } = await supabase
            .from('profissionais')
            .select('id, cargo')
            .eq('id', profissionalId)
            .maybeSingle();

        if (!error && data?.cargo) {
            cargo = data.cargo;

            // Mantém a sessão local coerente depois de uma correção de cargo no banco.
            if (activeProf?.id === profissionalId && activeProf.cargo !== data.cargo) {
                localStorage.setItem('active_professional', JSON.stringify({ ...activeProf, cargo: data.cargo }));
            }
        }
    } catch (err) {
        console.warn(`Erro ao identificar o perfil do profissional ${profissionalId}:`, err);
    }

    return String(cargo || '').toLowerCase() || null;
}

export async function fetchConfiguracaoHorarios(profissionalId = null) {
    const activeProf = getActiveProfessional() || (!profissionalId ? await ensureActiveProfessionalFromSession() : null);
    const targetProfId = profissionalId || activeProf?.id || null;
    const targetRole = await resolveProfessionalScheduleRole(targetProfId, activeProf);
    const usesIndividualSchedule = targetProfId && targetRole !== 'proprietario';

    if (usesIndividualSchedule) {
        try {
            const { data, error } = await supabase
                .from('configuracoes')
                .select('valor')
                .eq('chave', `horario_funcionamento_${targetProfId}`)
                .maybeSingle();

            if (!error && data && data.valor) {
                return data.valor;
            }
        } catch (err) {
            console.warn(`Erro ao buscar horário individual do profissional ${targetProfId}:`, err);
        }
    }

    try {
        const { data, error } = await supabase
            .from('configuracoes')
            .select('valor')
            .eq('chave', 'horario_funcionamento')
            .maybeSingle();

        if (error) throw error;
        if (data && data.valor) return data.valor;
    } catch (err) {
        console.warn("Usando configuração de horário padrão:", err);
    }

    return {
        intervalo_minutos: 30,
        dias: {
            "1": { ativo: true, turnos: [{ inicio: "08:00", fim: "12:00" }, { inicio: "14:00", fim: "18:00" }] },
            "2": { ativo: true, turnos: [{ inicio: "08:00", fim: "12:00" }, { inicio: "14:00", fim: "18:00" }] },
            "3": { ativo: true, turnos: [{ inicio: "08:00", fim: "12:00" }, { inicio: "14:00", fim: "18:00" }] },
            "4": { ativo: true, turnos: [{ inicio: "08:00", fim: "12:00" }, { inicio: "14:00", fim: "18:00" }] },
            "5": { ativo: true, turnos: [{ inicio: "08:00", fim: "12:00" }, { inicio: "14:00", fim: "18:00" }] },
            "6": { ativo: true, turnos: [{ inicio: "08:00", fim: "14:00" }] },
            "0": { ativo: false, turnos: [{ inicio: "08:00", fim: "12:00" }] }
        }
    };
}

export async function saveConfiguracaoHorarios(configValor) {
    const activeProf = getActiveProfessional() || await ensureActiveProfessionalFromSession();
    const targetProfId = activeProf?.id || null;
    const targetRole = await resolveProfessionalScheduleRole(targetProfId, activeProf);
    const usesIndividualSchedule = targetProfId && targetRole !== 'proprietario';
    const chave = usesIndividualSchedule ? `horario_funcionamento_${targetProfId}` : 'horario_funcionamento';

    const { error } = await supabase
        .from('configuracoes')
        .upsert({
            chave: chave,
            valor: configValor,
            descricao: usesIndividualSchedule ? `Horário individual do profissional ${activeProf.nome || targetProfId}` : 'Configuração avançada de turnos e horários por dia da semana'
        }, { onConflict: 'chave' });

    if (error) throw error;
    return true;
}

const MANUAL_OUTSIDE_HOURS_KEY_PREFIX = 'permitir_edicao_manual_fora_expediente_';

function configuracaoBoolean(valor, fallback = false) {
    if (typeof valor === 'boolean') return valor;
    if (typeof valor === 'number') return valor !== 0;
    if (typeof valor === 'string') return ['1', 'true', 'sim', 'ativo'].includes(valor.trim().toLowerCase());
    if (valor && typeof valor === 'object') {
        return configuracaoBoolean(valor.ativo ?? valor.habilitado ?? valor.valor, fallback);
    }
    return fallback;
}

export async function fetchPermissaoEdicaoForaExpediente(profissionalId = null) {
    const activeProf = getActiveProfessional() || (!profissionalId ? await ensureActiveProfessionalFromSession() : null);
    const targetProfId = profissionalId || activeProf?.id || null;
    if (!targetProfId) return false;

    try {
        const { data, error } = await supabase
            .from('configuracoes')
            .select('valor')
            .eq('chave', `${MANUAL_OUTSIDE_HOURS_KEY_PREFIX}${targetProfId}`)
            .maybeSingle();

        if (error) throw error;
        return configuracaoBoolean(data?.valor, false);
    } catch (err) {
        console.warn('Não foi possível carregar a permissão de edição fora do expediente:', err);
        return false;
    }
}

export async function savePermissaoEdicaoForaExpediente(habilitado) {
    const activeProf = getActiveProfessional() || await ensureActiveProfessionalFromSession();
    const targetProfId = activeProf?.id || null;
    if (!targetProfId) throw new Error('Profissional ativo não identificado. Faça login novamente.');

    const { error } = await supabase
        .from('configuracoes')
        .upsert({
            chave: `${MANUAL_OUTSIDE_HOURS_KEY_PREFIX}${targetProfId}`,
            valor: { ativo: Boolean(habilitado), profissional_id: targetProfId },
            descricao: `Permite ao profissional ${activeProf.nome || targetProfId} ajustar manualmente os próprios agendamentos fora do expediente`
        }, { onConflict: 'chave' });

    if (error) throw error;
    return true;
}

// --- CÁLCULO INTELIGENTE DE HORÁRIOS DISPONÍVEIS COM BASE NA DURAÇÃO DO SERVIÇO ---
export async function getAvailableTimeSlots(dateStr, servicoDuracao = 30, options = {}) {
    if (!dateStr) return { closed: true, slots: [] };

    const [year, month, day] = dateStr.split('-').map(Number);
    const selectedDate = new Date(year, month - 1, day);
    const dayOfWeek = selectedDate.getDay().toString();
    const scope = options.scope || 'active';
    let activeProfId = getActiveProfessionalId();
    if (scope === 'active' && !activeProfId) {
        const resolvedProf = await ensureActiveProfessionalFromSession();
        activeProfId = resolvedProf?.id || null;
    }

    // 1. Obter profissionais ativos e carregar horários individuais
    let profConfigs = [];
    if (scope === 'public') {
        try {
            const { data: profs } = await supabase.from('profissionais').select('id, nome').eq('ativo', true);
            if (profs && profs.length > 0) {
                for (const p of profs) {
                    const cfg = await fetchConfiguracaoHorarios(p.id);
                    const dCfg = cfg && cfg.dias && cfg.dias[dayOfWeek] ? cfg.dias[dayOfWeek] : null;
                    if (dCfg && dCfg.ativo && dCfg.turnos && dCfg.turnos.length > 0) {
                        profConfigs.push({ profId: p.id, turnos: dCfg.turnos });
                    }
                }
            }
        } catch (e) {}
    }

    if (profConfigs.length === 0) {
        const targetProfId = scope === 'active' ? activeProfId : null;
        const globalCfg = await fetchConfiguracaoHorarios(targetProfId);
        const dCfg = globalCfg && globalCfg.dias && globalCfg.dias[dayOfWeek] ? globalCfg.dias[dayOfWeek] : null;
        if (dCfg && dCfg.ativo && dCfg.turnos && dCfg.turnos.length > 0) {
            profConfigs.push({ profId: targetProfId || 'global', turnos: dCfg.turnos });
        }
    }

    if (profConfigs.length === 0) {
        return { closed: true, slots: [] };
    }

    let occupiedRanges = [];
    try {
        const { data: agendamentos, error } = await supabase
            .from('agendamentos')
            .select(`
                data_hora_inicio, 
                data_hora_fim, 
                status,
                profissional_id,
                servicos ( duracao_minutos )
            `)
            .neq('status', 'cancelado');

        if (!error && agendamentos) {
            agendamentos.forEach(ag => {
                const agProfId = ag.profissional_id || null;
                const pendingSharedRequest = isRequestStatus(ag.status) && !agProfId;

                if (scope === 'active') {
                    const slotOwnerId = activeProfId || null;
                    if (!pendingSharedRequest && (agProfId || null) !== slotOwnerId) return;
                }

                const s = new Date(ag.data_hora_inicio);
                let e = ag.data_hora_fim ? new Date(ag.data_hora_fim) : null;
                
                const durMin = ag.servicos?.duracao_minutos || 30;
                if (!e || isNaN(e.getTime()) || e.getTime() <= s.getTime()) {
                    e = new Date(s.getTime() + durMin * 60000);
                }

                if (s.getFullYear() === year && s.getMonth() === month - 1 && s.getDate() === day) {
                    const startMin = s.getHours() * 60 + s.getMinutes();
                    const endMin = e.getHours() * 60 + e.getMinutes();
                    occupiedRanges.push({ start: startMin, end: endMin, profId: agProfId });
                }
            });
        }
    } catch (err) {
        console.warn("Erro ao verificar horários ocupados:", err);
    }

    const slots = [];
    const requestedDuration = Math.max(parseInt(servicoDuracao || 30), 15);
    const slotStep = 15;

    profConfigs.forEach(pc => {
        pc.turnos.forEach(turno => {
            if (!turno.inicio || !turno.fim) return;
            const [startH, startM] = turno.inicio.split(':').map(Number);
            const [endH, endM] = turno.fim.split(':').map(Number);

            let currentMinutes = startH * 60 + startM;
            const endMinutes = endH * 60 + endM;

            while (currentMinutes + requestedDuration <= endMinutes) {
                const h = Math.floor(currentMinutes / 60).toString().padStart(2, '0');
                const m = (currentMinutes % 60).toString().padStart(2, '0');
                const timeStr = `${h}:${m}`;

                const slotStart = currentMinutes;
                const slotEnd = currentMinutes + requestedDuration;

                // Conta quantos profissionais estão em turno ativo neste exato intervalo
                const openProfsCount = profConfigs.filter(pCfg => {
                    return pCfg.turnos.some(t => {
                        if (!t.inicio || !t.fim) return false;
                        const [sH, sM] = t.inicio.split(':').map(Number);
                        const [eH, eM] = t.fim.split(':').map(Number);
                        return slotStart >= (sH * 60 + sM) && slotEnd <= (eH * 60 + eM);
                    });
                }).length;

                const concurrentCount = occupiedRanges.filter(r => (slotStart < r.end && slotEnd > r.start)).length;
                const isOccupied = openProfsCount === 0 || concurrentCount >= openProfsCount;

                const existingSlot = slots.find(s => s.time === timeStr);
                if (existingSlot) {
                    existingSlot.available = existingSlot.available || !isOccupied;
                    existingSlot.occupied = !existingSlot.available;
                } else {
                    slots.push({
                        time: timeStr,
                        occupied: isOccupied,
                        available: !isOccupied
                    });
                }
                currentMinutes += slotStep;
            }
        });
    });

    slots.sort((a, b) => a.time.localeCompare(b.time));

    return { closed: false, slots };
}

// --- BUSCA DIRETA DE SERVIÇOS ATIVOS ---
export async function fetchServicosAtivos() {
    const { data, error } = await supabase
        .from('servicos')
        .select(`
            id,
            nome,
            descricao,
            duracao_minutos,
            ativo,
            tabela_precos (
                valor
            )
        `)
        .order('nome');

    if (error) throw error;

    const services = data || [];
    const activeProfId = getActiveProfessionalId();
    if (!activeProfId || services.length === 0) return services;

    try {
        const { data: habilitados, error: habilitadosErr } = await supabase
            .from('profissional_servicos')
            .select('servico_id, ativo')
            .eq('profissional_id', activeProfId);

        if (habilitadosErr) throw habilitadosErr;
        const rows = habilitados || [];
        const hasExplicitServiceConfig = rows.length > 0;
        const enabledIds = new Set(rows.filter(row => row.ativo !== false).map(row => row.servico_id));
        activeProfessionalServiceIdsCache = enabledIds;
        activeProfessionalServiceRuleIdsCache = new Set(rows.map(row => row.servico_id).filter(Boolean));
        return services.map(servico => ({
            ...servico,
            habilitado_profissional: hasExplicitServiceConfig ? enabledIds.has(servico.id) : true
        }));
    } catch (err) {
        return services.map(servico => ({ ...servico, habilitado_profissional: true }));
    }
}

export async function setProfessionalServiceEnabled(servicoId, enabled) {
    const activeProfId = getActiveProfessionalId();
    if (!activeProfId || !servicoId) return false;

    const payload = {
        profissional_id: activeProfId,
        servico_id: servicoId,
        ativo: enabled === true
    };

    const { error } = await supabase
        .from('profissional_servicos')
        .upsert(payload, { onConflict: 'profissional_id,servico_id' });

    if (error) throw error;
    await fetchActiveProfessionalServiceIds();
    return true;
}

export async function setProfessionalSubservicoEnabled(subservicoId, enabled) {
    const activeProfId = getActiveProfessionalId();
    if (!activeProfId || !subservicoId) return false;

    const payload = {
        profissional_id: activeProfId,
        subservico_id: subservicoId,
        ativo: enabled === true
    };

    const { error } = await supabase
        .from('profissional_subservicos')
        .upsert(payload, { onConflict: 'profissional_id,subservico_id' });

    if (error) throw error;
    await fetchActiveProfessionalServiceIds();
    return true;
}

export async function populateServicosDropdown(selectId, customComboboxListId = null) {
    const select = document.getElementById(selectId);
    const customList = customComboboxListId ? document.getElementById(customComboboxListId) : null;
    
    try {
        const servicos = await fetchServicosAtivos();
        const ativos = servicos.filter(s => s.ativo !== false && s.habilitado_profissional !== false);

        if (select) {
            if (!ativos || ativos.length === 0) {
                select.innerHTML = '<option value="" disabled selected>Nenhum serviço disponível</option>';
            } else {
                select.innerHTML = '<option value="" disabled selected>Selecione um serviço...</option>';
                ativos.forEach(servico => {
                    const preco = servico.tabela_precos && servico.tabela_precos[0] 
                        ? ` - R$ ${parseFloat(servico.tabela_precos[0].valor).toFixed(2)}` 
                        : '';
                    const option = document.createElement('option');
                    option.value = servico.id;
                    option.dataset.duracao = servico.duracao_minutos;
                    option.textContent = `${servico.nome}${preco} (${servico.duracao_minutos} min)`;
                    select.appendChild(option);
                });
            }
        }

        if (customList) {
            customList.innerHTML = '';
            if (!ativos || ativos.length === 0) {
                customList.innerHTML = '<div class="p-3 text-xs text-slate-400 text-center">Nenhum serviço cadastrado</div>';
            } else {
                ativos.forEach(servico => {
                    const preco = servico.tabela_precos && servico.tabela_precos[0] 
                        ? `R$ ${parseFloat(servico.tabela_precos[0].valor).toFixed(2)}` 
                        : '';
                    const item = document.createElement('div');
                    item.className = 'combobox-option p-3 hover:bg-blue-500/10 dark:hover:bg-slate-800 cursor-pointer flex items-center justify-between gap-3 text-xs font-medium text-slate-800 dark:text-slate-200 transition-colors border-b border-slate-100 dark:border-slate-800/50 last:border-0';
                    item.dataset.value = servico.id;
                    item.dataset.duracao = servico.duracao_minutos;
                    item.dataset.nome = servico.nome;
                    item.dataset.preco = preco;
                    item.innerHTML = `
                        <div class="min-w-0 flex-1">
                            <span class="font-extrabold text-slate-900 dark:text-white block truncate">${escapeHtml(servico.nome)}</span>
                            <span class="text-[11px] text-slate-400">${servico.duracao_minutos} minutos</span>
                        </div>
                        <span class="font-black text-emerald-600 dark:text-emerald-400 shrink-0 text-xs">${preco}</span>
                    `;
                    customList.appendChild(item);
                });
            }
        }

        return ativos;
    } catch (err) {
        if (select) select.innerHTML = '<option value="" disabled selected>Erro ao carregar serviços</option>';
        showToast('Erro ao carregar lista de serviços', 'error');
        return [];
    }
}

// --- SUBMISSÃO E CRUD DE AGENDAMENTOS VIA SUPABASE ---
export async function criarAgendamentoCliente({ nomeCliente, whatsappCliente, servicoIdSelecionado, dataHoraInicioISO, observacoesCliente }) {
    const { data, error } = await supabase.rpc('criar_agendamento_cliente', {
        p_nome: nomeCliente,
        p_whatsapp: cleanPhone(whatsappCliente),
        p_servico_id: servicoIdSelecionado,
        p_data_hora_inicio: dataHoraInicioISO,
        p_observacoes: observacoesCliente || null
    });

    if (error) throw error;
    return data;
}

export async function criarAgendamentoProfissional({ nomeCliente, whatsappCliente, servicoIdSelecionado, dataHoraInicioISO, observacoesCliente }) {
    const activeProf = getActiveProfessional() || await ensureActiveProfessionalFromSession();
    const activeProfId = activeProf?.id || null;
    const whatsapp = cleanPhone(whatsappCliente);

    const { data: servico, error: servicoErr } = await supabase
        .from('servicos')
        .select('duracao_minutos')
        .eq('id', servicoIdSelecionado)
        .single();

    if (servicoErr) throw servicoErr;

    const duracao = servico?.duracao_minutos || 30;
    const start = new Date(dataHoraInicioISO);
    const end = new Date(start.getTime() + duracao * 60000);
    const dateStrISO = dataHoraInicioISO.slice(0, 10);

    const { data: agsDia } = await supabase
        .from('agendamentos')
        .select('id, data_hora_inicio, data_hora_fim, status, profissional_id, servicos(duracao_minutos)')
        .neq('status', 'cancelado')
        .gte('data_hora_inicio', `${dateStrISO}T00:00:00.000Z`)
        .lte('data_hora_inicio', `${dateStrISO}T23:59:59.999Z`);

    const conflito = (agsDia || []).find(ag => {
        if ((ag.profissional_id || null) !== (activeProfId || null)) return false;
        const agStart = new Date(ag.data_hora_inicio).getTime();
        const agEnd = ag.data_hora_fim
            ? new Date(ag.data_hora_fim).getTime()
            : agStart + (ag.servicos?.duracao_minutos || 30) * 60000;
        return start.getTime() < agEnd && end.getTime() > agStart;
    });

    if (conflito) {
        const err = new Error('Horario indisponivel para este profissional.');
        err.isConflict = true;
        err.dateStrISO = dateStrISO;
        const slotsData = await getAvailableTimeSlots(dateStrISO, duracao);
        err.sugestoes = slotsData.closed ? [] : (slotsData.slots || []).filter(s => s.available).map(s => s.time);
        throw err;
    }

    let cliente = null;
    try {
        const { data } = await supabase
            .from('clientes')
            .select('*')
            .eq('whatsapp', whatsapp)
            .eq('profissional_id', activeProfId)
            .maybeSingle();
        cliente = data || null;
    } catch (e) {
        const { data } = await supabase
            .from('clientes')
            .select('*')
            .eq('whatsapp', whatsapp)
            .maybeSingle();
        cliente = data || null;
    }

    if (!cliente) {
        const payload = { nome: nomeCliente.trim(), whatsapp, profissional_id: activeProfId };
        let { data, error } = await supabase
            .from('clientes')
            .insert([payload])
            .select()
            .single();

        if (error && String(error.message || '').includes('profissional_id')) {
            const { profissional_id, ...fallbackPayload } = payload;
            const fallback = await supabase.from('clientes').insert([fallbackPayload]).select().single();
            data = fallback.data;
            error = fallback.error;
        }

        if (error) throw error;
        cliente = data;
    }

    const payload = {
        cliente_id: cliente.id,
        servico_id: servicoIdSelecionado,
        data_hora_inicio: dataHoraInicioISO,
        data_hora_fim: end.toISOString(),
        status: 'pendente',
        observacoes: observacoesCliente || null,
        profissional_id: activeProfId
    };

    let { data, error } = await supabase.from('agendamentos').insert(payload).select().single();
    if (error && String(error.message || '').includes('profissional_id')) {
        const { profissional_id, ...fallbackPayload } = payload;
        const fallback = await supabase.from('agendamentos').insert(fallbackPayload).select().single();
        data = fallback.data;
        error = fallback.error;
    }

    if (error) throw error;
    return data;
}

export async function criarAgendamentoManutencao({ clienteId, servicoId, dataHoraInicioISO, parentId, periodicidadeDias, observacoes }) {
    const { data: servico } = await supabase.from('servicos').select('duracao_minutos, nome').eq('id', servicoId).single();
    const duracao = servico?.duracao_minutos || 30;
    let activeProfId = getActiveProfessionalId();
    if (!activeProfId) {
        const resolvedProf = await ensureActiveProfessionalFromSession();
        activeProfId = resolvedProf?.id || null;
    }

    const startMs = new Date(dataHoraInicioISO).getTime();
    const endMs = startMs + duracao * 60000;
    const dateStrISO = dataHoraInicioISO.slice(0, 10);

    // CHECAGEM DE CONFLITO DE HORÁRIO COM OUTROS AGENDAMENTOS ATIVOS NO DIA
    const { data: agsDia } = await supabase
        .from('agendamentos')
        .select('id, data_hora_inicio, data_hora_fim, status, profissional_id, clientes(nome), servicos(nome, duracao_minutos)')
        .neq('status', 'cancelado')
        .gte('data_hora_inicio', `${dateStrISO}T00:00:00.000Z`)
        .lte('data_hora_inicio', `${dateStrISO}T23:59:59.999Z`);

    if (agsDia && agsDia.length > 0) {
        const conflito = agsDia.find(a => {
            if (parentId && a.id === parentId) return false;
            if ((a.profissional_id || null) !== (activeProfId || null)) return false;
            const aStart = new Date(a.data_hora_inicio).getTime();
            const aDur = a.servicos?.duracao_minutos || 30;
            const aEnd = a.data_hora_fim ? new Date(a.data_hora_fim).getTime() : aStart + aDur * 60000;

            return (startMs < aEnd && endMs > aStart);
        });

        if (conflito) {
            const clienteConflito = conflito.clientes?.nome || 'outro cliente';
            const servicoConflito = conflito.servicos?.nome || 'outro atendimento';
            const horaConflito = new Date(conflito.data_hora_inicio).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

            // Buscar sugestões de horários livres no dia
            const slotsData = await getAvailableTimeSlots(dateStrISO, duracao);
            const disponiveis = slotsData.closed ? [] : (slotsData.slots || []).filter(s => s.available).map(s => s.time);

            const err = new Error(`Já existe um agendamento com ${clienteConflito} (${servicoConflito}) às ${horaConflito}.`);
            err.isConflict = true;
            err.sugestoes = disponiveis;
            err.dateStrISO = dateStrISO;
            throw err;
        }
    }

    const dataFim = new Date(endMs);

    const payload = {
        cliente_id: clienteId,
        servico_id: servicoId,
        data_hora_inicio: dataHoraInicioISO,
        data_hora_fim: dataFim.toISOString(),
        status: 'pendente',
        is_manutencao: true,
        agendamento_pai_id: parentId || null,
        periodicidade_dias: periodicidadeDias || null,
        profissional_id: activeProfId || null,
        observacoes: observacoes || 'Manutenção Periódica'
    };

    let { data, error } = await supabase
        .from('agendamentos')
        .insert(payload)
        .select()
        .single();

    if (error && String(error.message || '').includes('profissional_id')) {
        const { profissional_id, ...fallbackPayload } = payload;
        const fallback = await supabase
            .from('agendamentos')
            .insert(fallbackPayload)
            .select()
            .single();
        data = fallback.data;
        error = fallback.error;
    }

    if (error) throw error;
    return data;
}

export function showConflictModalWithSuggestions({ message, dateStrISO, sugestoes, onSelectTime }) {
    let modal = document.getElementById('global-conflict-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'global-conflict-modal';
        modal.className = 'fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/85 backdrop-blur-md p-4 transition-all duration-300 hidden overflow-y-auto';
        modal.innerHTML = `
            <div class="bg-white dark:bg-slate-900 border-2 border-rose-500/50 rounded-[2.5rem] w-full max-w-md p-6 sm:p-7 shadow-2xl space-y-5 text-center my-auto animate-scale-in">
                <div class="h-16 w-16 rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center mx-auto border border-rose-500/20">
                    <i class="fa-solid fa-calendar-xmark text-2xl"></i>
                </div>

                <div class="space-y-1.5">
                    <span class="inline-block px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
                        Horário Indisponível
                    </span>
                    <h3 class="text-lg sm:text-xl font-extrabold text-slate-900 dark:text-white">Conflito de Horário!</h3>
                    <p id="conflict-message" class="text-xs text-slate-600 dark:text-slate-300 font-medium leading-relaxed"></p>
                </div>

                <div class="space-y-2 text-left">
                    <label class="block text-xs font-extrabold uppercase tracking-wider text-purple-600 dark:text-purple-400">Sugestões de Horários Livres no Dia:</label>
                    <div id="conflict-suggestions-container" class="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-40 overflow-y-auto p-1">
                        <!-- Preenchido via JS -->
                    </div>
                </div>

                <div class="pt-2 border-t border-slate-100 dark:border-slate-800">
                    <button type="button" id="btn-conflict-close" class="w-full py-3 rounded-full text-xs font-bold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
                        Escolher Outra Data / Fechar
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    const msgEl = document.getElementById('conflict-message');
    const container = document.getElementById('conflict-suggestions-container');
    const closeBtn = document.getElementById('btn-conflict-close');

    msgEl.textContent = message;

    if (!sugestoes || sugestoes.length === 0) {
        container.innerHTML = `<p class="col-span-full text-xs text-slate-400 font-medium text-center py-2">Nenhum outro horário livre encontrado nesta data.</p>`;
    } else {
        container.innerHTML = '';
        sugestoes.forEach(time => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-animated p-2 rounded-xl border border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-300 text-xs font-black hover:bg-purple-500/20 text-center';
            btn.textContent = time;
            btn.onclick = () => {
                modal.classList.add('hidden');
                if (onSelectTime) onSelectTime(time);
            };
            container.appendChild(btn);
        });
    }

    modal.classList.remove('hidden');

    closeBtn.onclick = () => modal.classList.add('hidden');
}

export async function updateAgendamentoStatus(id, newStatus, profissionalId = undefined) {
    let currentAgendamento = null;
    try {
        let { data, error: currentErr } = await supabase
            .from('agendamentos')
            .select('cliente_id, servico_id, subservico_id, status, profissional_id, data_hora_inicio, data_hora_fim, servicos(duracao_minutos)')
            .eq('id', id)
            .maybeSingle();

        if (currentErr && isMissingColumnError(currentErr, 'subservico_id')) {
            const fallback = await supabase
                .from('agendamentos')
                .select('cliente_id, servico_id, status, profissional_id, data_hora_inicio, data_hora_fim, servicos(duracao_minutos)')
                .eq('id', id)
                .maybeSingle();
            data = fallback.data;
        }
        currentAgendamento = data || null;
    } catch (e) {}

    let activeProfId = getActiveProfessionalId();
    if (!activeProfId) {
        const resolvedProf = await ensureActiveProfessionalFromSession();
        activeProfId = resolvedProf?.id || null;
    }
    const shouldClaim =
        isUnassignedRequest(currentAgendamento) &&
        !isRequestStatus(newStatus) &&
        (newStatus || '').toLowerCase() !== 'cancelado';

    const targetProfId = profissionalId !== undefined ? profissionalId : (shouldClaim ? activeProfId : undefined);
    const updatePayload = { status: newStatus };
    if (targetProfId !== undefined) {
        updatePayload.profissional_id = targetProfId || null;
    }

    if (shouldClaim && targetProfId) {
        await assertProfessionalCanClaimAppointment(id, currentAgendamento, targetProfId);

        // Atribui e confirma em uma unica escrita condicionada. Se outra pessoa
        // aceitar primeiro, nenhuma linha e alterada e o painel informa o motivo.
        const { data: claimed, error: claimError } = await supabase
            .from('agendamentos')
            .update({ status: newStatus, profissional_id: targetProfId })
            .eq('id', id)
            .is('profissional_id', null)
            .in('status', ['aguardando_confirmacao', 'solicitado', 'pendente'])
            .select('id, status, profissional_id')
            .maybeSingle();

        if (claimError) throw claimError;
        if (!claimed) {
            const { data: latest } = await supabase
                .from('agendamentos')
                .select('status, profissional_id')
                .eq('id', id)
                .maybeSingle();
            if (latest?.profissional_id === targetProfId && latest?.status === newStatus) return true;
            throw new Error('Esta solicitação já foi aceita por outro profissional. Atualize a agenda.');
        }

        if (currentAgendamento?.cliente_id) {
            await updateClienteProfessional(currentAgendamento.cliente_id, targetProfId);
        }
        return true;
    }

    // A conclusão passa pela RPC transacional do estoque. O banco valida todos os
    // produtos, baixa apenas consumos, preserva ferramentas e gera o caixa uma vez.
    const finalStatuses = new Set(['atendido', 'concluido', 'finalizado']);
    const isFinalTransition = finalStatuses.has(String(newStatus || '').toLowerCase())
        && !finalStatuses.has(String(currentAgendamento?.status || '').toLowerCase());

    if (isFinalTransition) {
        if (targetProfId && currentAgendamento?.profissional_id !== targetProfId) {
            const { error: claimError } = await supabase
                .from('agendamentos')
                .update({ profissional_id: targetProfId })
                .eq('id', id);
            if (claimError && !String(claimError.message || '').includes('profissional_id')) throw claimError;
            currentAgendamento.profissional_id = targetProfId;
        }

        const { error: estoqueError } = await supabase.rpc('finalizar_atendimento_com_estoque', {
            p_agendamento_id: id,
            p_novo_status: newStatus
        });
        const rpcMissing = estoqueError && (
            String(estoqueError.code || '').includes('PGRST202')
            || String(estoqueError.message || '').toLowerCase().includes('finalizar_atendimento_com_estoque')
        );
        if (estoqueError && !rpcMissing) throw estoqueError;
        if (!estoqueError) {
            if (shouldClaim && currentAgendamento?.cliente_id) {
                await updateClienteProfessional(currentAgendamento.cliente_id, targetProfId || null);
            }
            return true;
        }
        console.warn('RPC de estoque ainda não instalada; concluindo sem baixa automática.');
    }

    let { error } = await supabase
        .from('agendamentos')
        .update(updatePayload)
        .eq('id', id);

    if (error && String(error.message || '').includes('profissional_id')) {
        const { profissional_id, ...fallbackPayload } = updatePayload;
        const fallback = await supabase
            .from('agendamentos')
            .update(fallbackPayload)
            .eq('id', id);
        error = fallback.error;
    }

    if (error) throw error;

    if (shouldClaim && currentAgendamento?.cliente_id) {
        await updateClienteProfessional(currentAgendamento.cliente_id, targetProfId || null);
    }

    return true;
}

// --- GESTÃO DE PROFISSIONAIS E AUXILIARES ---
export async function fetchProfissionais() {
    try {
        const { data, error } = await supabase
            .from('profissionais')
            .select('*')
            .order('criado_em', { ascending: true });

        if (error) {
            console.warn("Tabela profissionais não encontrada ou erro:", error.message);
            return [];
        }
        return data || [];
    } catch (e) {
        console.warn("Erro ao buscar profissionais:", e);
        return [];
    }
}

export function getActiveProfessional() {
    try {
        const saved = localStorage.getItem('active_professional');
        if (saved) return JSON.parse(saved);
    } catch (e) {}
    return null;
}

export async function ensureActiveProfessionalFromSession() {
    const existing = getActiveProfessional();
    if (existing?.id) return existing;

    try {
        const { data: { session } } = await supabase.auth.getSession();
        const email = session?.user?.email?.trim().toLowerCase();
        if (!email) return null;

        const { data: profData, error } = await supabase
            .from('profissionais')
            .select('*')
            .eq('email', email)
            .eq('ativo', true)
            .maybeSingle();

        if (!error && profData) {
            localStorage.setItem('active_professional', JSON.stringify(profData));
            return profData;
        }

        const nome = session.user.user_metadata?.nome || session.user.user_metadata?.name || email.split('@')[0] || 'Profissional';
        const payload = {
            nome,
            email,
            senha_hash: 'auth',
            cargo: 'proprietario',
            cor_identificadora: '#2563eb',
            ativo: true
        };

        const { data: createdProf, error: createErr } = await supabase
            .from('profissionais')
            .insert(payload)
            .select()
            .single();

        if (!createErr && createdProf) {
            localStorage.setItem('active_professional', JSON.stringify(createdProf));
            return createdProf;
        }

        if (createErr) {
            const { data: retryProf } = await supabase
                .from('profissionais')
                .select('*')
                .eq('email', email)
                .maybeSingle();
            if (retryProf) {
                localStorage.setItem('active_professional', JSON.stringify(retryProf));
                return retryProf;
            }
        }
    } catch (e) {}

    return null;
}

export async function performLogout() {
    await deactivateCurrentWebPushSubscription();

    try {
        // Encerra somente a sessao deste aparelho. O escopo padrao do Supabase
        // e global e derrubava Android, iPhone e navegador quando um deles
        // usava "Sair do Aplicativo" com a mesma conta profissional.
        await supabase.auth.signOut({ scope: 'local' });
    } catch (e) {}

    try {
        localStorage.removeItem('active_professional');
    } catch (e) {}

    window.location.href = './index.html';
}

export async function saveProfissional({ id, nome, email, senha, cargo = 'auxiliar', cor_identificadora = '#8b5cf6', ativo = true, aceita_atendimento_externo = false }) {
    // Validação estrita do e-mail no domínio @acionar.online
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail.endsWith('@acionar.online')) {
        throw new Error("O e-mail do auxiliar deve obrigatoriamente utilizar o domínio @acionar.online (Ex: maria@acionar.online)");
    }

    const payload = {
        nome: (nome || '').trim(),
        email: cleanEmail,
        cargo,
        cor_identificadora,
        ativo,
        aceita_atendimento_externo: Boolean(aceita_atendimento_externo)
    };

    if (senha && senha.trim() !== '') {
        payload.senha_hash = senha.trim();
    }

    if (!id && !payload.senha_hash) {
        payload.senha_hash = '123456';
    }

    // Tenta registrar a conta no Supabase Auth (GoTrue) para permitir login direto
    if (!id && payload.senha_hash) {
        try {
            const { data: { session: ownerSession } } = await supabase.auth.getSession();
            await supabase.auth.signUp({
                email: cleanEmail,
                password: payload.senha_hash,
                options: {
                    data: { nome, cargo }
                }
            });
            // O cadastro de um auxiliar nunca deve trocar a sessão do proprietário.
            if (ownerSession?.access_token && ownerSession?.refresh_token) {
                await supabase.auth.setSession({
                    access_token: ownerSession.access_token,
                    refresh_token: ownerSession.refresh_token
                });
            }
        } catch (authErr) {
            console.warn("Registro no Supabase Auth falhou, mantendo cadastro na tabela profissionais:", authErr);
        }
    }

    if (id) {
        let { data, error } = await supabase
            .from('profissionais')
            .update(payload)
            .eq('id', id)
            .select()
            .single();

        if (error && String(error.message || '').includes('aceita_atendimento_externo')) {
            const { aceita_atendimento_externo, ...fallbackPayload } = payload;
            const fallback = await supabase
                .from('profissionais')
                .update(fallbackPayload)
                .eq('id', id)
                .select()
                .single();
            data = fallback.data;
            error = fallback.error;
        }

        if (error) throw error;
        return data;
    } else {
        let { data, error } = await supabase
            .from('profissionais')
            .insert(payload)
            .select()
            .single();

        if (error && String(error.message || '').includes('aceita_atendimento_externo')) {
            const { aceita_atendimento_externo, ...fallbackPayload } = payload;
            const fallback = await supabase
                .from('profissionais')
                .insert(fallbackPayload)
                .select()
                .single();
            data = fallback.data;
            error = fallback.error;
        }

        if (error) throw error;
        return data;
    }
}

export async function toggleProfissionalAtivo(id, novoStatusAtivo) {
    const { data, error } = await supabase
        .from('profissionais')
        .update({ ativo: novoStatusAtivo })
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    return data;
}

export async function deleteProfissional(id) {
    const { error } = await supabase
        .from('profissionais')
        .delete()
        .eq('id', id);

    if (error) throw error;
    return true;
}

export async function replicarClienteParaProfissional(clienteId, profissionalDestinoId) {
    if (!clienteId || !profissionalDestinoId) {
        throw new Error('Informe o cliente e o profissional de destino.');
    }

    const { data, error } = await supabase.rpc('replicar_cliente_profissional', {
        p_cliente_id: clienteId,
        p_profissional_destino_id: profissionalDestinoId
    });

    if (error) throw error;
    return data;
}

export async function transferirAgendamentoParaProfissional(agendamentoId, profissionalDestinoId) {
    if (!agendamentoId || !profissionalDestinoId) {
        throw new Error('Informe o agendamento e o profissional de destino.');
    }

    const { data, error } = await supabase.rpc('transferir_agendamento_profissional', {
        p_agendamento_id: agendamentoId,
        p_profissional_destino_id: profissionalDestinoId
    });

    if (error) throw error;
    return data;
}

export async function updateAgendamento(id, { servico_id, data_hora_inicio, observacoes, status }) {
    const activeProf = getActiveProfessional() || await ensureActiveProfessionalFromSession();
    const activeProfId = activeProf?.id || null;
    const { data: atual, error: atualError } = await supabase
        .from('agendamentos')
        .select('id, profissional_id, servico_id, data_hora_inicio, data_hora_fim, status')
        .eq('id', id)
        .maybeSingle();

    if (atualError) throw atualError;
    if (!atual) throw new Error('Agendamento não encontrado. Atualize a agenda e tente novamente.');

    const { data: servico } = await supabase.from('servicos').select('duracao_minutos').eq('id', servico_id).single();
    const duracao = servico?.duracao_minutos || 30;

    const dataInicio = new Date(data_hora_inicio);
    const dataFim = new Date(dataInicio.getTime() + duracao * 60000);
    if (Number.isNaN(dataInicio.getTime())) throw new Error('Informe uma data e horário válidos.');

    const isOwnAppointment = Boolean(activeProfId && atual.profissional_id === activeProfId);
    if (isOwnAppointment) {
        const candidato = {
            ...atual,
            servico_id,
            data_hora_inicio: dataInicio.toISOString(),
            data_hora_fim: dataFim.toISOString()
        };
        const allowOutsideHours = await fetchPermissaoEdicaoForaExpediente(activeProfId);

        if (!allowOutsideHours) {
            await fetchActiveProfessionalHorarioConfig();
            if (!canActiveProfessionalAttendAppointment(candidato)) {
                throw new Error('Profissional não atende neste dia ou horário. Ative a permissão de ajuste manual nas configurações para fazer uma exceção.');
            }
        }

        const { data: agendamentos, error: conflictError } = await supabase
            .from('agendamentos')
            .select('id, data_hora_inicio, data_hora_fim, status, profissional_id, servicos(duracao_minutos)')
            .eq('profissional_id', activeProfId)
            .neq('status', 'cancelado');

        if (conflictError) throw conflictError;
        if (professionalHasConflictWithAppointment(candidato, agendamentos || [], activeProfId)) {
            throw new Error('Já existe outro agendamento deste profissional neste horário.');
        }
    }

    const payload = {
        servico_id,
        data_hora_inicio,
        data_hora_fim: dataFim.toISOString(),
        observacoes: observacoes || null
    };
    if (status) payload.status = status;

    const { error } = await supabase
        .from('agendamentos')
        .update(payload)
        .eq('id', id);

    if (error) throw error;
    return true;
}

export async function updateAgendamentoObservacoes(id, observacoes) {
    const { error } = await supabase
        .from('agendamentos')
        .update({ observacoes: String(observacoes || '').trim() || null })
        .eq('id', id);

    if (error) throw error;
    return true;
}

export async function deleteAgendamento(id) {
    const { error } = await supabase
        .from('agendamentos')
        .delete()
        .eq('id', id);

    if (error) throw error;
    return true;
}

// --- BUSCA E GERAÇÃO DE NOTIFICAÇÕES (SOLICITAÇÕES E MANUTENÇÕES D-2) ---
export async function fetchNotificationsList() {
    try {
        await ensureActiveProfessionalFromSession();
        let agendamentos = null;
        const rpcRes = await supabase.rpc('listar_agendamentos_painel');
        if (!rpcRes.error && Array.isArray(rpcRes.data)) {
            agendamentos = rpcRes.data.map(mapPanelAppointment);
        } else {
            const directRes = await supabase
                .from('agendamentos')
                .select(`
                    id,
                    cliente_id,
                    servico_id,
                    subservico_id,
                    profissional_id,
                    data_hora_inicio,
                    data_hora_fim,
                    status,
                    tipo_atendimento,
                    endereco_atendimento,
                    is_manutencao,
                    observacoes,
                    clientes ( id, nome, whatsapp ),
                    servicos ( id, nome, duracao_minutos )
                `)
                .neq('status', 'cancelado')
                .order('data_hora_inicio', { ascending: true });
            if (directRes.error) throw directRes.error;
            agendamentos = directRes.data || [];
        }

        const visibleAgendamentos = filterAppointmentsForActiveProfessional(agendamentos);

        const now = new Date();
        const todayZero = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const notifications = [];

        visibleAgendamentos.forEach(ag => {
            const clienteNome = ag.clientes?.nome || 'Cliente';
            const clientePhone = cleanPhone(ag.clientes?.whatsapp || '');
            const servicoNome = ag.servicos?.nome || 'Serviço';
            const d = new Date(ag.data_hora_inicio);
            const dataFormatada = d.toLocaleDateString('pt-BR');
            const horaInicio = d.toTimeString().slice(0, 5);

            const statusLower = (ag.status || '').toLowerCase();

            // 1. Novas Solicitações Aguardando Confirmação
            if (isAppointmentRequest(ag)) {
                notifications.push({
                    id: `solicitation-${ag.id}`,
                    type: 'solicitacao',
                    title: '🔔 Nova Solicitação de Agendamento',
                    message: `${clienteNome} solicitou ${servicoNome} para ${dataFormatada} às ${horaInicio}.`,
                    dateStr: dataFormatada,
                    timeStr: horaInicio,
                    agendamentoId: ag.id,
                    agendamento: ag,
                    timestamp: d.getTime()
                });
            }

            // 2. Lembrete de Manutenção (2 Dias Antes, Amanhã ou Hoje)
            if (ag.is_manutencao && statusLower !== 'concluido' && statusLower !== 'atendido') {
                const agDateZero = new Date(d.getFullYear(), d.getMonth(), d.getDate());
                const diffDays = Math.round((agDateZero - todayZero) / (1000 * 60 * 60 * 24));

                if (diffDays >= 0 && diffDays <= 2) {
                    const tempoLabel = diffDays === 0 ? 'Hoje' : diffDays === 1 ? 'Amanhã' : 'Em 2 dias';
                    notifications.push({
                        id: `manutencao-remind-${ag.id}`,
                        type: 'manutencao_lembrete',
                        title: `🔧 Lembrete: Mensagem de Manutenção (${tempoLabel})`,
                        message: `${clienteNome} possui retorno de manutenção (${servicoNome}) agendado para ${dataFormatada} às ${horaInicio}. Dispare a mensagem prévia no WhatsApp.`,
                        dateStr: dataFormatada,
                        timeStr: horaInicio,
                        diffDays,
                        clienteNome,
                        clientePhone,
                        servicoNome,
                        agendamentoId: ag.id,
                        agendamento: ag,
                        timestamp: d.getTime()
                    });
                }
            }
        });

        notifications.sort((a, b) => a.timestamp - b.timestamp);
        return notifications;
    } catch (err) {
        console.error("Erro ao buscar notificações:", err);
        return [];
    }
}

// --- SISTEMA DE ALERTA DE ATENDIMENTO PRÓXIMO (CONFIGURÁVEL) ---
let notifiedUpcomingIds = new Set(JSON.parse(localStorage.getItem('notified_5min_ids') || '[]'));

export function isUpcomingAlertEnabled() {
    return localStorage.getItem('upcoming-alert-enabled') !== 'false';
}

export function setUpcomingAlertEnabled(enabled) {
    localStorage.setItem('upcoming-alert-enabled', enabled ? 'true' : 'false');
}

export function getUpcomingAlertMinutes() {
    const val = Number.parseInt(localStorage.getItem('upcoming-alert-minutes') || '5', 10);
    return Number.isNaN(val) || val <= 0 ? 5 : val;
}

export function setUpcomingAlertMinutes(minutes) {
    const val = Number.parseInt(minutes, 10);
    localStorage.setItem('upcoming-alert-minutes', String(Number.isNaN(val) || val <= 0 ? 5 : val));
}

export function showUpcomingAppointmentModal({ agendamento, alertMinutes = 5, onStartAtendimento }) {
    let modal = document.getElementById('global-upcoming-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'global-upcoming-modal';
        modal.className = 'fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/85 backdrop-blur-md p-4 transition-all duration-300 hidden overflow-y-auto';
        modal.innerHTML = `
            <div class="bg-white dark:bg-slate-900 border-2 border-amber-500/50 rounded-[2.5rem] w-full max-w-md p-6 sm:p-7 shadow-2xl space-y-5 text-center my-auto animate-scale-in">
                <div class="relative mx-auto h-20 w-20 rounded-full bg-amber-500/10 text-amber-500 flex items-center justify-center border-2 border-amber-500/30 animate-pulse">
                    <i class="fa-solid fa-bell text-3xl"></i>
                    <span class="absolute -top-1 -right-1 flex h-4 w-4">
                        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                        <span class="relative inline-flex rounded-full h-4 w-4 bg-amber-500"></span>
                    </span>
                </div>

                <div class="space-y-1.5">
                    <span class="inline-block px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                        ⚡ Atendimento Em Instantes
                    </span>
                    <h3 id="upcoming-modal-title" class="text-xl sm:text-2xl font-black text-slate-900 dark:text-white">Faltam 5 Minutos!</h3>
                    <p class="text-xs text-slate-500 dark:text-slate-400 font-medium">Seu próximo cliente está agendado para iniciar em breve.</p>
                </div>

                <div class="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 text-left space-y-3">
                    <div class="flex items-center gap-3">
                        <div class="h-10 w-10 shrink-0 rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400 font-extrabold flex items-center justify-center text-sm border border-amber-500/20" id="upcoming-avatar">
                            U
                        </div>
                        <div class="min-w-0 flex-1">
                            <h4 id="upcoming-cliente-nome" class="font-extrabold text-slate-900 dark:text-white text-sm truncate">Cliente</h4>
                            <p id="upcoming-whatsapp-link" class="text-xs text-slate-500 dark:text-slate-400 font-medium flex items-center gap-1">
                                <i class="fa-brands fa-whatsapp text-emerald-500"></i>
                                <span id="upcoming-phone">--</span>
                            </p>
                        </div>
                    </div>

                    <div class="pt-2 border-t border-slate-200/60 dark:border-slate-700/60 grid grid-cols-2 gap-2 text-xs">
                        <div>
                            <span class="block text-[10px] font-bold text-slate-400 uppercase">Horário:</span>
                            <span id="upcoming-horario" class="font-black text-slate-900 dark:text-white text-sm">--:--</span>
                        </div>
                        <div>
                            <span class="block text-[10px] font-bold text-slate-400 uppercase">Serviço:</span>
                            <span id="upcoming-servico" class="font-bold text-amber-600 dark:text-amber-400 truncate block">Serviço</span>
                        </div>
                    </div>
                </div>

                <div class="flex flex-col sm:flex-row items-center gap-2.5 pt-1">
                    <button type="button" id="btn-upcoming-start" class="w-full sm:flex-1 py-3.5 rounded-2xl text-xs font-black text-white bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-lg shadow-emerald-600/25 transition-all flex items-center justify-center gap-2">
                        <i class="fa-solid fa-play text-xs"></i>
                        <span>Iniciar Atendimento Agora</span>
                    </button>
                    <button type="button" id="btn-upcoming-close" class="w-full sm:w-auto px-5 py-3.5 rounded-2xl text-xs font-bold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
                        Entendido
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    const clienteNome = agendamento.clientes?.nome || agendamento.clienteNome || 'Cliente';
    const phone = cleanPhone(agendamento.clientes?.whatsapp || agendamento.clientePhone || '');
    const servicoNome = agendamento.servicos?.nome || agendamento.servicoNome || 'Serviço';
    const duracao = agendamento.servicos?.duracao_minutos || 30;
    
    const d = new Date(agendamento.data_hora_inicio);
    const horaInicio = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    const titleEl = document.getElementById('upcoming-modal-title');
    if (titleEl) {
        titleEl.textContent = alertMinutes === 1 ? `Falta 1 Minuto!` : `Faltam ${alertMinutes} Minutos!`;
    }

    document.getElementById('upcoming-avatar').textContent = clienteNome.charAt(0).toUpperCase();
    document.getElementById('upcoming-cliente-nome').textContent = clienteNome;
    document.getElementById('upcoming-phone').textContent = phone ? phone : 'Sem WhatsApp';
    document.getElementById('upcoming-horario').textContent = `${horaInicio} (${duracao} min)`;
    document.getElementById('upcoming-servico').textContent = servicoNome;

    const startBtn = document.getElementById('btn-upcoming-start');
    const closeBtn = document.getElementById('btn-upcoming-close');

    modal.classList.remove('hidden');

    const closeModal = () => modal.classList.add('hidden');

    closeBtn.onclick = closeModal;

    startBtn.onclick = async () => {
        closeModal();
        if (onStartAtendimento) {
            await onStartAtendimento(agendamento);
        }
    };
}

export async function checkUpcoming5MinAppointments() {
    if (!isUpcomingAlertEnabled()) return;

    const alertMinutes = getUpcomingAlertMinutes();

    try {
        await ensureActiveProfessionalFromSession();
        const { data: agendamentos, error } = await supabase
            .from('agendamentos')
            .select(`
                id,
                cliente_id,
                servico_id,
                subservico_id,
                profissional_id,
                data_hora_inicio,
                status,
                tipo_atendimento,
                endereco_atendimento,
                is_manutencao,
                clientes ( id, nome, whatsapp ),
                servicos ( id, nome, duracao_minutos )
            `)
            .neq('status', 'cancelado')
            .neq('status', 'concluido')
            .neq('status', 'atendido')
            .order('data_hora_inicio', { ascending: true });

        if (error || !agendamentos) return;
        await fetchActiveProfessionalServiceIds();
        await fetchActiveProfessionalExternalAcceptance();
        await fetchActiveProfessionalHorarioConfig();
        const visibleAgendamentos = filterAppointmentsForActiveProfessional(agendamentos);

        const nowMs = Date.now();

        for (const ag of visibleAgendamentos) {
            if (notifiedUpcomingIds.has(ag.id)) continue;

            const startMs = new Date(ag.data_hora_inicio).getTime();
            const diffMs = startMs - nowMs;
            const diffMinutes = diffMs / (1000 * 60);

            // Alerta quando o agendamento estiver na janela de antecedência configurada (ex: entre 0 e alertMinutes + 0.5)
            if (diffMinutes >= -1 && diffMinutes <= (alertMinutes + 0.5)) {
                notifiedUpcomingIds.add(ag.id);
                try {
                    localStorage.setItem('notified_5min_ids', JSON.stringify(Array.from(notifiedUpcomingIds)));
                } catch (e) {}

                const upcomingPayload = buildAppointmentNotificationPayload(ag, 'upcoming');
                triggerSystemNotification({
                    ...upcomingPayload,
                    title: `Atendimento em ${alertMinutes} min: ${upcomingPayload.data.clienteNome}`
                });

                showUpcomingAppointmentModal({
                    agendamento: ag,
                    alertMinutes,
                    onStartAtendimento: async (item) => {
                        try {
                            await updateAgendamentoStatus(item.id, 'em_atendimento');
                            showToast('Atendimento iniciado com sucesso!', 'success');
                            if (typeof window.refreshAgenda === 'function') {
                                window.refreshAgenda(true);
                            }
                        } catch (err) {
                            showToast('Erro ao iniciar atendimento: ' + err.message, 'error');
                        }
                    }
                });
                break;
            }
        }
    } catch (e) {
        console.warn("Erro ao checar agendamentos próximos:", e);
    }
}

let isUpcomingCheckerStarted = false;
export function startUpcoming5MinChecker() {
    if (isUpcomingCheckerStarted) return;
    isUpcomingCheckerStarted = true;
    checkUpcoming5MinAppointments();
    setInterval(checkUpcoming5MinAppointments, 25000);
}

export function getServicePrice(servico) {
    if (!servico) return 0;
    if (typeof servico.preco === 'number' && !isNaN(servico.preco)) return servico.preco;
    if (typeof servico.preco === 'string' && !isNaN(parseFloat(servico.preco))) return parseFloat(servico.preco);
    if (Array.isArray(servico.tabela_precos) && servico.tabela_precos.length > 0) {
        const val = parseFloat(servico.tabela_precos[0].valor);
        if (!isNaN(val)) return val;
    }
    if (servico.tabela_precos && typeof servico.tabela_precos === 'object' && servico.tabela_precos.valor) {
        const val = parseFloat(servico.tabela_precos.valor);
        if (!isNaN(val)) return val;
    }
    return 0;
}

// --- RENDERIZAÇÃO DE AGENDAMENTOS COM FALLBACK DE SEGURANÇA VIA RPC (EVITA ERRO DE RLS PERMISSION DENIED) ---
function mapPanelAppointment(a) {
    return {
        id: a.id,
        cliente_id: a.cliente_id,
        servico_id: a.servico_id,
        subservico_id: a.subservico_id || null,
        profissional_id: a.profissional_id || null,
        data_hora_inicio: a.data_hora_inicio,
        data_hora_fim: a.data_hora_fim,
        status: a.status,
        observacoes: a.observacoes,
        tipo_atendimento: a.tipo_atendimento || 'salao',
        endereco_atendimento: a.endereco_atendimento || null,
        latitude_atendimento: a.latitude_atendimento || null,
        longitude_atendimento: a.longitude_atendimento || null,
        is_manutencao: a.is_manutencao,
        agendamento_pai_id: a.agendamento_pai_id,
        periodicidade_dias: a.periodicidade_dias,
        clientes: a.clientes || { id: a.cliente_id, nome: a.cliente_nome, whatsapp: a.cliente_whatsapp },
        servicos: a.servicos || {
            id: a.servico_id,
            nome: a.servico_nome,
            duracao_minutos: a.servico_duracao_minutos,
            tabela_precos: [{ valor: a.servico_preco || 0 }]
        },
        profissionais: a.profissionais || (a.profissional_id ? {
            id: a.profissional_id,
            nome: a.profissional_nome,
            cor_identificadora: a.profissional_cor
        } : null)
    };
}

export async function fetchAndRenderAgendamentos(containerId, filterDate = null, filterStatus = null, silent = false) {
    const container = document.getElementById(containerId);
    if (!container) return;
    await ensureActiveProfessionalFromSession();

    if (!silent) {
        container.innerHTML = `
            <div class="flex items-center justify-center py-12">
                <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
        `;
    }

    let agendamentos = [];
    let fetchSuccess = false;

    // A RPC inclui as solicitacoes publicas sem profissional. Ela precisa ser a
    // fonte principal porque a RLS pode devolver uma lista parcial sem erro.
    try {
        const rpcRes = await supabase.rpc('listar_agendamentos_painel');
        if (!rpcRes.error && Array.isArray(rpcRes.data)) {
            agendamentos = rpcRes.data.map(mapPanelAppointment);
            fetchSuccess = true;
        } else if (rpcRes.error) {
            console.warn('Fonte compartilhada indisponivel. Tentando consulta direta...', rpcRes.error);
        }
    } catch (rpcErr) {
        console.warn('Erro na fonte compartilhada de agendamentos:', rpcErr);
    }

    // Fallback para instalacoes que ainda nao possuem a RPC.
    if (!fetchSuccess) try {
        const res = await supabase
            .from('agendamentos')
            .select(`
                id,
                cliente_id,
                servico_id,
                subservico_id,
                profissional_id,
                data_hora_inicio,
                data_hora_fim,
                status,
                observacoes,
                tipo_atendimento,
                endereco_atendimento,
                latitude_atendimento,
                longitude_atendimento,
                is_manutencao,
                agendamento_pai_id,
                periodicidade_dias,
                clientes (
                    id,
                    nome,
                    whatsapp
                ),
                servicos (
                    id,
                    nome,
                    duracao_minutos,
                    tabela_precos (
                        valor
                    )
                ),
                profissionais (
                    id,
                    nome,
                    cor_identificadora
                )
            `)
            .order('data_hora_inicio', { ascending: true });

        if (!res.error && res.data) {
            agendamentos = res.data.map(mapPanelAppointment);
            fetchSuccess = true;
        } else if (res.error) {
            console.warn("Busca direta em agendamentos bloqueada por RLS. Tentando RPC...", res.error);
        }
    } catch (e) {
        console.warn("Erro na busca direta:", e);
    }

    // Tentativa 2: Fallback via RPC SECURITY DEFINER (Infalível contra permission denied no iOS/Android PWA)
    if (!fetchSuccess) {
        try {
            const rpcRes = await supabase.rpc('listar_agendamentos_painel');
            if (!rpcRes.error && rpcRes.data) {
                agendamentos = rpcRes.data.map(a => ({
                    id: a.id,
                    cliente_id: a.cliente_id,
                    servico_id: a.servico_id,
                    subservico_id: a.subservico_id || null,
                    profissional_id: a.profissional_id || null,
                    data_hora_inicio: a.data_hora_inicio,
                    data_hora_fim: a.data_hora_fim,
                    status: a.status,
                    observacoes: a.observacoes,
                    tipo_atendimento: a.tipo_atendimento || 'salao',
                    endereco_atendimento: a.endereco_atendimento || null,
                    latitude_atendimento: a.latitude_atendimento || null,
                    longitude_atendimento: a.longitude_atendimento || null,
                    is_manutencao: a.is_manutencao,
                    agendamento_pai_id: a.agendamento_pai_id,
                    periodicidade_dias: a.periodicidade_dias,
                    clientes: { id: a.cliente_id, nome: a.cliente_nome, whatsapp: a.cliente_whatsapp },
                    servicos: { 
                        id: a.servico_id, 
                        nome: a.servico_nome, 
                        duracao_minutos: a.servico_duracao_minutos,
                        tabela_precos: [{ valor: a.servico_preco || 0 }]
                    },
                    profissionais: a.profissional_id ? {
                        id: a.profissional_id,
                        nome: a.profissional_nome,
                        cor_identificadora: a.profissional_cor
                    } : null
                }));
                fetchSuccess = true;
            }
        } catch (rpcErr) {
            console.warn("RPC fallback falhou:", rpcErr);
        }
    }

    // Tentativa 3: Fallback via LocalStorage (Segurança total para PWA offline/isolado)
    if (!fetchSuccess) {
        try {
            const localAg = JSON.parse(localStorage.getItem('agendamentos_data') || '[]');
            if (localAg && localAg.length > 0) {
                agendamentos = localAg;
                fetchSuccess = true;
            }
        } catch (e) {}
    }

    // Atualizar LocalStorage cache se obteve dados do servidor
    if (fetchSuccess && agendamentos.length > 0) {
        try {
            localStorage.setItem('agendamentos_data', JSON.stringify(agendamentos));
        } catch (e) {}
    }

    // REGRAS DE PRIVACIDADE DO AUXILIAR:
    // Se um auxiliar estiver logado (cargo === 'auxiliar'), ele vê apenas:
    // 1. Solicitações pendentes/sem profissional atribuído (para poder aceitar).
    // 2. Os agendamentos que foram atribuídos especificamente a ele mesmo!
    const activeProf = getActiveProfessional();
    if (activeProf && activeProf.cargo === 'auxiliar') {
        const myProfId = activeProf.id;
        agendamentos = agendamentos.filter(a => {
            const profIdStr = a.profissional_id || a.profissionais?.id;

            // Solicitação pendente não atribuída -> fica visível para todos os auxiliares aceitarem
            if (isUnassignedRequest(a)) {
                return true;
            }

            // Agendamento confirmado/em atendimento/concluído -> visível APENAS para o profissional responsável
            return profIdStr === myProfId;
        });
    }

    agendamentos = filterAppointmentsForActiveProfessional(agendamentos);

    // DETECÇÃO DE NOVO AGENDAMENTO PARA DISPARAR SOM DE ALARME
    // O alerta usa a mesma lista filtrada da agenda, evitando avisar profissionais com conflito.
    if (isInitialLoadDone && fetchSuccess) {
        const newBooking = agendamentos.find(ag => !knownAgendamentoIds.has(ag.id) && isAppointmentRequest(ag));
        if (newBooking) {
            triggerSystemNotification(buildAppointmentNotificationPayload(newBooking, 'new'));
        }
    }

    if (fetchSuccess) {
        knownAgendamentoIds = new Set(agendamentos.map(a => a.id));
        isInitialLoadDone = true;
    }

    if (filterDate) {
        agendamentos = agendamentos.filter(a => a.data_hora_inicio && a.data_hora_inicio.startsWith(filterDate));
    }

    if (filterStatus) {
        if (filterStatus.toLowerCase() === 'manutencao') {
            agendamentos = agendamentos.filter(a => a.is_manutencao === true);
        } else {
            const normalizedFilter = filterStatus.toLowerCase();
            agendamentos = agendamentos.filter(a => normalizedFilter === 'aguardando_confirmacao'
                ? isAppointmentRequest(a)
                : (a.status || 'aguardando_confirmacao').toLowerCase() === normalizedFilter);
        }
    }

    renderAgendamentosList(container, agendamentos);
}

function renderAgendamentosList(container, agendamentos) {
    if (!agendamentos || agendamentos.length === 0) {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-14 px-4 text-center">
                <div class="h-14 w-14 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mb-4 dark:bg-slate-800/80 dark:text-slate-500">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/><line x1="10" x2="14" y1="14" y2="18"/><line x1="14" x2="10" y1="14" y2="18"/></svg>
                </div>
                <h3 class="text-base font-semibold text-slate-800 dark:text-slate-200">Nenhum agendamento encontrado</h3>
                <p class="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-xs">Clique no botão de novo agendamento para registrar um compromisso.</p>
            </div>
        `;
        if (window.lucide) window.lucide.createIcons();
        return;
    }

    container.innerHTML = '';
    
    agendamentos.forEach(ag => {
        const clienteNome = ag.clientes?.nome || 'Cliente não identificado';
        const clienteWhatsapp = ag.clientes?.whatsapp || '';
        const servicoNome = ag.servicos?.nome || 'Serviço';
        const duracao = ag.servicos?.duracao_minutos || 30;

        const dataInicio = new Date(ag.data_hora_inicio);
        const dataFormatada = dataInicio.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const horaInicio = dataInicio.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        
        let horaFim = '';
        if (ag.data_hora_fim) {
            const df = new Date(ag.data_hora_fim);
            horaFim = ' - ' + df.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        }

        const isManutencao = ag.is_manutencao === true;
        const statusLower = (ag.status || 'aguardando_confirmacao').toLowerCase();
        const isSolicitacao = isAppointmentRequest(ag);
        const isAguardando = isSolicitacao;

        const statusClass = isManutencao
            ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20'
            : isSolicitacao
            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
            : statusLower === 'concluido' || statusLower === 'atendido'
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
            : statusLower === 'em_atendimento'
            ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20'
            : statusLower === 'cancelado'
            ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20'
            : 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20';

        const statusLabel = isManutencao
            ? `🔧 MANUTENÇÃO${ag.periodicidade_dias ? ' (' + ag.periodicidade_dias + 'D)' : ''}`
            : isSolicitacao
            ? 'AGUARDANDO CONFIRMAÇÃO'
            : statusLower === 'pendente'
            ? 'CONFIRMADO'
            : statusLower === 'em_atendimento' 
            ? 'EM ATENDIMENTO' 
            : statusLower === 'concluido' || statusLower === 'atendido'
            ? 'JÁ ATENDIDO' 
            : statusLower.toUpperCase();

        const clienteIdStr = ag.cliente_id || ag.clientes?.id || '';
        const servicoIdStr = ag.servico_id || ag.servicos?.id || '';
        const precoStr = getServicePrice(ag.servicos);
        const waMsgStatus = isManutencao ? 'true' : 'false';
        const showManutencaoBtn = !isSolicitacao && statusLower !== 'cancelado';
        const agendamentoJson = escapeHtml(JSON.stringify(ag));
        const profNome = ag.profissional_nome || ag.profissionais?.nome || '';
        const profCor = ag.profissional_cor || ag.profissionais?.cor_identificadora || '#8b5cf6';
        const tipoAtendimento = (ag.tipo_atendimento || 'salao').toLowerCase();
        const isAtendimentoExterno = tipoAtendimento === 'cliente' || tipoAtendimento === 'externo';
        const enderecoAtendimento = ag.endereco_atendimento || '';
        const observacoesAtendimento = String(ag.observacoes || '').trim();
        const notesButtonClass = observacoesAtendimento
            ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-500/20 border border-amber-200 dark:border-amber-500/20 shadow-sm shadow-amber-500/10'
            : 'bg-amber-50/90 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-400/20 border border-amber-200/80 dark:border-amber-300/20 shadow-lg shadow-amber-400/10 backdrop-blur-sm';
        const localBadgeHtml = isAtendimentoExterno
            ? `<span class="inline-flex items-center gap-1 text-[9px] font-extrabold px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-600 dark:text-orange-300 border border-orange-500/20"><i class="fa-solid fa-location-dot text-[9px]"></i> No local do cliente</span>`
            : `<span class="inline-flex items-center gap-1 text-[9px] font-extrabold px-2 py-0.5 rounded-full bg-slate-500/10 text-slate-500 dark:text-slate-300 border border-slate-500/20"><i class="fa-solid fa-store text-[9px]"></i> No salao</span>`;
        const profBadgeHtml = profNome 
            ? `<span class="inline-flex items-center gap-1 text-[9px] font-extrabold px-2 py-0.5 rounded-full text-white shadow-sm shrink-0" style="background-color: ${profCor}">
                <i class="fa-solid fa-user-check text-[9px]"></i> ${escapeHtml(profNome)}
               </span>`
            : '';

        const item = document.createElement('div');
        item.className = `group p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 border border-white/80 dark:border-slate-800/60 bg-white/72 dark:bg-slate-950/20 hover:bg-white/90 dark:hover:bg-slate-800/30 shadow-[0_14px_36px_rgba(15,23,42,0.08)] hover:shadow-[0_18px_44px_rgba(37,99,235,0.12)] backdrop-blur-sm transition-all rounded-3xl animate-fade-in ${
            isManutencao ? 'ring-1 ring-purple-200/70 dark:ring-purple-500/15' : ''
        }`;
        
        item.innerHTML = `
            <div class="flex items-start gap-3 flex-1 min-w-0">
                <div class="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-2xl ${
                    isManutencao 
                        ? 'bg-purple-50 text-purple-600 dark:bg-purple-950/40 dark:text-purple-400 border border-purple-100 dark:border-purple-900/40' 
                        : 'bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400 border border-blue-100 dark:border-blue-900/40'
                } font-bold">
                    <span class="text-[10px] font-semibold uppercase">${dataInicio.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}</span>
                    <span class="text-sm font-extrabold leading-none">${dataInicio.getDate()}</span>
                </div>
                <div class="space-y-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <h4 class="font-semibold text-slate-900 dark:text-white text-sm sm:text-base truncate max-w-[140px] sm:max-w-none">${escapeHtml(clienteNome)}</h4>
                        <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-extrabold border ${statusClass} shrink-0">
                            ${statusLabel}
                        </span>
                        ${profBadgeHtml}
                        ${localBadgeHtml}
                        ${isManutencao ? `
                            <span class="inline-flex items-center gap-1 text-[9px] font-extrabold px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-600 dark:text-purple-300 border border-purple-500/20">
                                <i class="fa-solid fa-wrench text-[10px]"></i> Retorno de Manutenção
                            </span>
                        ` : ''}
                    </div>
                    <p class="text-xs text-slate-600 dark:text-slate-300 font-medium flex items-center gap-1.5">
                        <i class="fa-solid fa-scissors ${isManutencao ? 'text-purple-500' : 'text-blue-500'} shrink-0 text-xs"></i>
                        <span class="truncate max-w-[200px] sm:max-w-none">${escapeHtml(servicoNome)} (${duracao} min)</span>
                    </p>
                    <div class="flex items-center gap-2.5 text-[11px] text-slate-400 dark:text-slate-500 flex-wrap">
                        <span class="flex items-center gap-1">
                            <i class="fa-regular fa-clock text-xs"></i>
                            ${horaInicio}${horaFim}
                        </span>
                        <span class="flex items-center gap-1">
                            <i class="fa-regular fa-calendar-check text-xs"></i>
                            ${dataFormatada}
                        </span>
                        ${isAtendimentoExterno && enderecoAtendimento ? `<span class="flex items-center gap-1 text-orange-500 dark:text-orange-300 max-w-[220px] truncate" title="${escapeHtml(enderecoAtendimento)}"><i class="fa-solid fa-map-location-dot text-xs"></i>${escapeHtml(enderecoAtendimento)}</span>` : ''}
                    </div>
                </div>
            </div>

            <!-- Ações do agendamento -->
            <div class="w-full sm:w-auto sm:min-w-[250px] shrink-0 pt-3 sm:pt-0 border-t sm:border-t-0 border-slate-200/45 dark:border-slate-800/40">
                ${isAguardando ? `
                    <div class="grid grid-cols-2 gap-2 mb-2">
                        <button type="button" class="btn-aceitar-agendamento btn-animated flex items-center justify-center gap-2 h-10 rounded-2xl bg-emerald-600 text-white font-extrabold border border-emerald-500 shadow-sm shadow-emerald-500/20 shrink-0"
                            title="Aceitar Agendamento"
                            data-id="${ag.id}"
                            data-cliente-id="${clienteIdStr}"
                            data-servico-id="${servicoIdStr}"
                            data-cliente-nome="${escapeHtml(clienteNome)}"
                            data-servico-nome="${escapeHtml(servicoNome)}"
                            data-whatsapp="${cleanPhone(clienteWhatsapp)}"
                            data-data-formatada="${dataFormatada}"
                            data-hora-inicio="${horaInicio}"
                            data-data-iso="${ag.data_hora_inicio}">
                            <i class="fa-solid fa-check text-sm"></i>
                            <span class="text-xs">Aceitar</span>
                        </button>

                        <button type="button" class="btn-recusar-agendamento btn-animated flex items-center justify-center gap-2 h-10 rounded-2xl bg-rose-50 hover:bg-rose-100 text-rose-600 dark:bg-rose-500/10 dark:hover:bg-rose-500/20 dark:text-rose-400 font-extrabold border border-rose-200 dark:border-rose-500/20 shrink-0"
                            title="Recusar Agendamento"
                            data-id="${ag.id}">
                            <i class="fa-solid fa-xmark text-sm"></i>
                            <span class="text-xs">Recusar</span>
                        </button>
                    </div>
                ` : `
                    <button type="button" class="btn-open-status-modal btn-animated flex w-full items-center justify-between gap-3 min-h-11 px-3 rounded-2xl text-left border ${statusClass} shadow-sm mb-2"
                        data-id="${ag.id}"
                        data-cliente-id="${clienteIdStr}"
                        data-servico-id="${servicoIdStr}"
                        data-status="${statusLower}"
                        data-cliente-nome="${escapeHtml(clienteNome)}"
                        data-servico-nome="${escapeHtml(servicoNome)}"
                        data-data-iso="${ag.data_hora_inicio}">
                        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/70 dark:bg-slate-950/30">
                            <i class="fa-solid fa-arrows-rotate text-xs"></i>
                        </span>
                        <span class="min-w-0 flex-1 leading-tight">
                            <span class="block text-[9px] font-black uppercase tracking-wide opacity-70">Alterar status</span>
                            <span class="block truncate text-xs font-black">${statusLabel}</span>
                        </span>
                        <i class="fa-solid fa-chevron-down text-xs opacity-70 shrink-0"></i>
                    </button>
                `}

                <div class="grid grid-cols-5 gap-1.5 sm:flex sm:flex-wrap sm:justify-end sm:gap-1.5">
                <button type="button" class="btn-open-notes-modal btn-animated relative flex items-center justify-center h-10 rounded-2xl sm:h-9 sm:w-9 ${notesButtonClass} shrink-0"
                    title="${observacoesAtendimento ? 'Ver e editar observacoes' : 'Adicionar observacao'}"
                    data-agendamento='${agendamentoJson}'>
                    <i class="fa-solid fa-note-sticky text-xs"></i>
                    ${observacoesAtendimento ? '<span class="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-white dark:ring-slate-900"></span>' : ''}
                </button>

                ${clienteWhatsapp ? `
                    <button type="button" class="btn-send-wa-agendamento btn-animated flex items-center justify-center h-10 rounded-2xl sm:h-9 sm:w-9 ${
                        isManutencao 
                            ? 'bg-purple-50 text-purple-700 dark:bg-purple-500/10 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-500/20 border border-purple-200 dark:border-purple-500/20'
                            : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 border border-emerald-200 dark:border-emerald-500/20'
                    } shrink-0" 
                        title="${isManutencao ? 'Enviar Lembrete de Manutenção no WhatsApp' : 'Conversar no WhatsApp'}"
                        data-whatsapp="${cleanPhone(clienteWhatsapp)}"
                        data-cliente-nome="${escapeHtml(clienteNome)}"
                        data-servico-nome="${escapeHtml(servicoNome)}"
                        data-data-formatada="${dataFormatada}"
                        data-hora-inicio="${horaInicio}"
                        data-is-manutencao="${waMsgStatus}">
                        <i class="fa-brands fa-whatsapp text-sm"></i>
                    </button>
                ` : ''}

                ${showManutencaoBtn ? `
                    <button type="button" class="btn-schedule-manutencao btn-animated flex items-center justify-center h-10 rounded-2xl sm:h-9 sm:w-9 bg-purple-50 hover:bg-purple-100 text-purple-700 dark:bg-purple-500/10 dark:hover:bg-purple-500/20 dark:text-purple-400 font-extrabold border border-purple-200 dark:border-purple-500/20 shrink-0"
                        title="Agendar Retorno de Manutenção"
                        data-id="${ag.id}"
                        data-cliente-id="${clienteIdStr}"
                        data-servico-id="${servicoIdStr}"
                        data-cliente-nome="${escapeHtml(clienteNome)}"
                        data-servico-nome="${escapeHtml(servicoNome)}"
                        data-data-iso="${ag.data_hora_inicio}">
                        <i class="fa-solid fa-wrench text-xs"></i>
                    </button>
                ` : ''}

                <button type="button" class="btn-open-payment-modal btn-animated flex items-center justify-center h-10 rounded-2xl sm:h-9 sm:w-9 bg-teal-50 hover:bg-teal-100 text-teal-700 dark:bg-emerald-500/10 dark:hover:bg-emerald-500/20 dark:text-emerald-400 font-extrabold border border-teal-200 dark:border-emerald-500/20 shrink-0"
                    title="Registrar / Ver Pagamento (Caixa)"
                    data-agendamento-id="${ag.id}"
                    data-cliente-id="${clienteIdStr}"
                    data-servico-id="${servicoIdStr}"
                    data-cliente-nome="${escapeHtml(clienteNome)}"
                    data-servico-nome="${escapeHtml(servicoNome)}"
                    data-preco="${precoStr}">
                    <i class="fa-solid fa-dollar-sign text-xs"></i>
                </button>

                ${!isSolicitacao && statusLower !== 'cancelado' ? `
                    <button class="btn-transfer-agendamento btn-animated flex items-center justify-center h-10 rounded-2xl sm:h-9 sm:w-9 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 border border-indigo-200 dark:border-indigo-500/20 shrink-0" data-id="${ag.id}" data-agendamento='${agendamentoJson}' title="Transferir para outro profissional">
                        <i class="fa-solid fa-right-left text-xs"></i>
                    </button>
                ` : ''}

                <button class="btn-edit-agendamento btn-animated flex items-center justify-center h-10 rounded-2xl sm:h-9 sm:w-9 bg-sky-50 dark:bg-slate-800 text-sky-700 dark:text-slate-300 hover:text-blue-700 dark:hover:text-blue-400 hover:bg-sky-100 dark:hover:bg-blue-950/40 border border-sky-200 dark:border-slate-800 shrink-0" data-agendamento='${agendamentoJson}' title="Editar Agendamento">
                    <i class="fa-solid fa-pen-to-square text-xs"></i>
                </button>

                <button class="btn-delete-agendamento btn-animated flex items-center justify-center h-10 rounded-2xl sm:h-9 sm:w-9 bg-rose-50 dark:bg-slate-800 text-rose-700 dark:text-slate-300 hover:text-rose-700 dark:hover:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-950/40 border border-rose-200 dark:border-slate-800 shrink-0" data-id="${ag.id}" title="Excluir Agendamento">
                    <i class="fa-solid fa-trash-can text-xs"></i>
                </button>
                </div>
            </div>
        `;

        container.appendChild(item);
    });

    if (window.lucide) window.lucide.createIcons();
}

// --- CRUD DE CLIENTES ---
export async function createCliente({ nome, whatsapp }) {
    const activeProf = getActiveProfessional() || await ensureActiveProfessionalFromSession();
    const payload = {
        nome,
        whatsapp: cleanPhone(whatsapp),
        profissional_id: activeProf?.id || null
    };

    let { error } = await supabase.from('clientes').insert([payload]);
    if (error && String(error.message || '').includes('profissional_id')) {
        const { profissional_id, ...fallbackPayload } = payload;
        const fallback = await supabase.from('clientes').insert([fallbackPayload]);
        error = fallback.error;
    }

    if (error) throw error;
    return true;
}

export async function updateCliente(id, { nome, whatsapp }) {
    const { error } = await supabase
        .from('clientes')
        .update({ nome, whatsapp: cleanPhone(whatsapp) })
        .eq('id', id);

    if (error) throw error;
    return true;
}

export async function deleteCliente(id) {
    // 1. Buscar todos os agendamentos vinculados a este cliente
    const { data: agendamentos, error: fetchErr } = await supabase
        .from('agendamentos')
        .select('id, status')
        .eq('cliente_id', id);

    if (fetchErr) throw fetchErr;

    if (agendamentos && agendamentos.length > 0) {
        // Filtrar agendamentos que NÃO estão cancelados
        const agendamentosAtivos = agendamentos.filter(a => {
            const st = (a.status || '').toLowerCase();
            return st !== 'cancelado';
        });

        // Se o cliente possuir agendamentos ativos (solicitações, confirmados, atendimento, concluídos ou manutenção)
        if (agendamentosAtivos.length > 0) {
            throw new Error('Este cliente possui agendamentos em aberto, confirmados, em atendimento, concluídos ou de manutenção. Para conseguir excluí-lo, é necessário primeiro cancelar todos os compromissos dele.');
        }

        // Se tiver apenas agendamentos cancelados, exclui os registros de agendamentos cancelados para não violar a chave estrangeira (FK)
        const { error: delAgErr } = await supabase
            .from('agendamentos')
            .delete()
            .eq('cliente_id', id);

        if (delAgErr) throw delAgErr;
    }

    // 2. Excluir o cliente
    const { error: delClientErr } = await supabase
        .from('clientes')
        .delete()
        .eq('id', id);

    if (delClientErr) throw delClientErr;
    return true;
}

export async function fetchClientesDoProfissional() {
    await ensureActiveProfessionalFromSession();

    const { data, error } = await supabase
        .from('clientes')
        .select('*')
        .order('nome', { ascending: true });

    if (error) throw error;
    return filterRecordsForActiveProfessional(data || []);
}

export async function fetchAndRenderClientes(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    await ensureActiveProfessionalFromSession();

    container.innerHTML = `
        <div class="flex items-center justify-center py-12">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
        </div>
    `;

    try {
        const clientes = await fetchClientesDoProfissional();

        if (clientes.length === 0) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center py-14 px-4 text-center">
                    <div class="h-14 w-14 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mb-4 dark:bg-slate-800/80 dark:text-slate-500">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    </div>
                    <h3 class="text-base font-semibold text-slate-800 dark:text-slate-200">Nenhum cliente cadastrado</h3>
                    <p class="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-xs">Os clientes cadastrados via agendamento aparecerão aqui.</p>
                </div>
            `;
            if (window.lucide) window.lucide.createIcons();
            return;
        }

        container.innerHTML = '';
        clientes.forEach(cliente => {
            const item = document.createElement('div');
            item.className = 'p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 border-b border-slate-100 dark:border-slate-800/60 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all animate-fade-in rounded-2xl';
            item.innerHTML = `
                <div class="flex items-center gap-3 min-w-0">
                    <div class="h-10 w-10 shrink-0 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 font-bold flex items-center justify-center text-sm border border-slate-200 dark:border-slate-700">
                        ${cliente.nome.charAt(0).toUpperCase()}
                    </div>
                    <div class="min-w-0 space-y-0.5">
                        <h4 class="font-bold text-slate-900 dark:text-white text-sm sm:text-base truncate">${escapeHtml(cliente.nome)}</h4>
                        <p class="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5 font-medium">
                            <i class="fa-solid fa-phone text-[10px] text-slate-400"></i>
                            <span>${cleanPhone(cliente.whatsapp)}</span>
                        </p>
                    </div>
                </div>
                
                <!-- BOTÕES CLIENTES: LINHA INFERIOR NO MOBILE / DIREITA NO DESKTOP -->
                <div class="flex flex-row items-center justify-end gap-2 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-100 dark:border-slate-800/40">
                    <button class="btn-cliente-financeiro btn-animated flex items-center justify-center gap-1 h-9 px-3 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs font-black border border-emerald-500/20 shrink-0" 
                        data-cliente-id="${cliente.id}" 
                        data-cliente-nome="${escapeHtml(cliente.nome)}" 
                        data-cliente-whatsapp="${cleanPhone(cliente.whatsapp)}" 
                        title="Ver Histórico Financeiro e Baixa de Pendências">
                        <i class="fa-solid fa-dollar-sign text-xs"></i>
                        <span class="text-[11px] font-bold sm:hidden">Caixa</span>
                    </button>
                    <a href="https://wa.me/55${cleanPhone(cliente.whatsapp)}" target="_blank" rel="noopener noreferrer" 
                        class="btn-animated flex items-center justify-center h-9 w-9 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 shrink-0" title="Conversar no WhatsApp">
                        <i class="fa-brands fa-whatsapp text-sm"></i>
                    </a>
                    <button class="btn-replicar-cliente btn-animated flex items-center justify-center h-9 w-9 rounded-xl bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 border border-indigo-500/20 shrink-0" data-id="${cliente.id}" data-nome="${escapeHtml(cliente.nome)}" title="Replicar para outro profissional">
                        <i class="fa-solid fa-user-plus text-xs"></i>
                    </button>
                    <button class="btn-edit-cliente btn-animated flex items-center justify-center h-9 w-9 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 border border-slate-200/50 dark:border-slate-800 shrink-0" data-cliente='${JSON.stringify(cliente)}' title="Editar Cliente">
                        <i class="fa-solid fa-pen-to-square text-xs"></i>
                    </button>
                    <button class="btn-delete-cliente btn-animated flex items-center justify-center h-9 w-9 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 border border-slate-200/50 dark:border-slate-800 shrink-0" data-id="${cliente.id}" title="Excluir Cliente">
                        <i class="fa-solid fa-trash-can text-xs"></i>
                    </button>
                </div>
            `;
            container.appendChild(item);
        });

        if (window.lucide) window.lucide.createIcons();
    } catch (err) {
        console.error("Erro ao buscar clientes:", err);
        container.innerHTML = `
            <div class="py-12 px-4 text-center">
                <p class="text-sm font-semibold text-rose-500">Erro ao carregar clientes do Supabase.</p>
                <p class="text-xs text-slate-400 mt-1">${escapeHtml(err.message)}</p>
            </div>
        `;
    }
}

// --- CRUD DE SERVIÇOS ---
export async function updateServico(id, { nome, descricao, duracao_minutos, ativo }, valor) {
    const payload = { nome, descricao, duracao_minutos, ativo };

    const { error: sErr } = await supabase
        .from('servicos')
        .update(payload)
        .eq('id', id);

    if (sErr) throw sErr;

    if (valor !== undefined && !isNaN(valor)) {
        await supabase
            .from('tabela_precos')
            .insert([{ servico_id: id, valor }]);
    }

    return true;
}

export async function deleteServico(id) {
    // 1. Verificar agendamentos vinculados ao serviço
    const { data: agendamentos, error: fetchErr } = await supabase
        .from('agendamentos')
        .select('id, status')
        .eq('servico_id', id);

    if (fetchErr) throw fetchErr;

    if (agendamentos && agendamentos.length > 0) {
        const agendamentosAtivos = agendamentos.filter(a => (a.status || '').toLowerCase() !== 'cancelado');
        if (agendamentosAtivos.length > 0) {
            throw new Error('Este serviço possui agendamento(s) vinculado(s). Para excluir este serviço, cancele primeiro os compromissos vinculados a ele.');
        }

        // Se tiver apenas agendamentos cancelados, exclui os agendamentos cancelados vinculados a este serviço
        await supabase
            .from('agendamentos')
            .delete()
            .eq('servico_id', id);
    }

    // Apagar tabela de preços
    await supabase.from('tabela_precos').delete().eq('servico_id', id);

    // Apagar o serviço
    const { error } = await supabase
        .from('servicos')
        .delete()
        .eq('id', id);

    if (error) throw error;
    return true;
}

// --- CRUD DE SUBSERVIÇOS / VARIAÇÕES (1 IMAGEM POR SUBSERVIÇO) ---
export async function fetchSubservicosByServicoId(servicoId) {
    if (!servicoId) return [];

    const { data, error } = await supabase
        .from('subservicos')
        .select('*')
        .eq('servico_id', servicoId)
        .eq('ativo', true)
        .order('created_at', { ascending: true });

    if (error) throw error;
    try { localStorage.removeItem('subservicos_data'); } catch (e) {}

    const subservicos = data || [];
    const activeProfId = getActiveProfessionalId();
    if (!activeProfId || subservicos.length === 0) return subservicos;

    try {
        const { data: habilitados, error: habilitadosErr } = await supabase
            .from('profissional_subservicos')
            .select('subservico_id, ativo')
            .eq('profissional_id', activeProfId)
            .in('subservico_id', subservicos.map(sub => sub.id));

        if (habilitadosErr) throw habilitadosErr;
        const explicitRows = new Map((habilitados || []).map(row => [row.subservico_id, row.ativo !== false]));
        const enabledIds = new Set((habilitados || []).filter(row => row.ativo !== false).map(row => row.subservico_id));
        activeProfessionalSubserviceIdsCache = enabledIds;
        activeProfessionalSubserviceRuleIdsCache = new Set((habilitados || []).map(row => row.subservico_id).filter(Boolean));
        activeProfessionalDisabledSubserviceIdsCache = new Set((habilitados || []).filter(row => row.ativo === false).map(row => row.subservico_id).filter(Boolean));
        return subservicos.map(sub => ({
            ...sub,
            habilitado_profissional: explicitRows.has(sub.id) ? explicitRows.get(sub.id) : true
        }));
    } catch (err) {
        return subservicos.map(sub => ({ ...sub, habilitado_profissional: true }));
    }
}

export async function saveSubservico({ id, servico_id, nome, descricao, preco_adicional, duracao_adicional_minutos, imagem_url }) {
    const payload = {
        servico_id,
        nome,
        descricao: descricao || null,
        preco_adicional: parseFloat(preco_adicional || 0),
        duracao_adicional_minutos: parseInt(duracao_adicional_minutos || 0),
        imagem_url: imagem_url || null,
        ativo: true
    };

    let savedId = id || null;
    let error = null;
    if (id && !id.startsWith('sub-')) {
        const res = await supabase
            .from('subservicos')
            .update(payload)
            .eq('id', id);
        error = res.error;
    } else {
        const res = await supabase
            .from('subservicos')
            .insert([payload])
            .select('id')
            .single();
        error = res.error;
        savedId = res.data?.id || null;
    }

    if (error) throw error;
    if (savedId) {
        try { await setProfessionalSubservicoEnabled(savedId, true); } catch (e) {}
    }
    try { localStorage.removeItem('subservicos_data'); } catch (e) {}
    return true;
}

export async function deleteSubservico(id) {
    try {
        if (id && !id.startsWith('sub-')) {
            // Marca como inativo no Supabase (para ocultar instantaneamente da visão do cliente)
            await supabase
                .from('subservicos')
                .update({ ativo: false })
                .eq('id', id);

            // Tenta deletar fisicamente
            const { error } = await supabase
                .from('subservicos')
                .delete()
                .eq('id', id);

            if (error) {
                console.warn("Hard delete do subserviço mantido como ativo=false:", error.message);
            }
        }
    } catch (e) {
        console.warn("Erro ao deletar subserviço no Supabase:", e);
    }

    try {
        let all = JSON.parse(localStorage.getItem('subservicos_data') || '[]');
        all = all.filter(s => s.id !== id);
        localStorage.setItem('subservicos_data', JSON.stringify(all));
    } catch (e) {}

    return true;
}

// --- FLUXO DE CAIXA & FINANCEIRO ---
export async function fetchPagamentoByAgendamentoId(agendamentoId) {
    if (!agendamentoId) return null;
    try {
        const { data, error } = await supabase
            .from('fluxo_caixa')
            .select('*')
            .eq('agendamento_id', agendamentoId)
            .single();

        if (!error && data) return data;
    } catch (e) {}

    try {
        const all = JSON.parse(localStorage.getItem('fluxo_caixa_data') || '[]');
        return all.find(p => p.agendamento_id === agendamentoId) || null;
    } catch (e) {
        return null;
    }
}

export async function savePagamentoFluxoCaixa(payload) {
    const isVirtual = payload.id && typeof payload.id === 'string' && payload.id.startsWith('virtual-');
    const realId = isVirtual ? null : payload.id;
    const activeProf = getActiveProfessional() || await ensureActiveProfessionalFromSession();

    const dataToSave = {
        agendamento_id: payload.agendamento_id || null,
        cliente_id: payload.cliente_id || null,
        servico_id: payload.servico_id || null,
        profissional_id: payload.profissional_id || activeProf?.id || null,
        valor_bruto: parseFloat(payload.valor_bruto || 0),
        desconto: parseFloat(payload.desconto || 0),
        valor_final: parseFloat(payload.valor_final || 0),
        condicao_pagamento: payload.condicao_pagamento || 'a_vista',
        forma_pagamento: payload.forma_pagamento || 'pix',
        status_pagamento: payload.status_pagamento || 'pago',
        data_pagamento: payload.data_pagamento || new Date().toISOString(),
        data_vencimento: payload.data_vencimento || new Date().toISOString(),
        observacoes: payload.observacoes || null
    };

    let savedRemote = false;

    try {
        if (realId && !realId.startsWith('cx-')) {
                let { error } = await supabase
                    .from('fluxo_caixa')
                    .update(dataToSave)
                    .eq('id', realId);
                if (error && String(error.message || '').includes('profissional_id')) {
                    const { profissional_id, ...fallbackData } = dataToSave;
                    const fallback = await supabase
                        .from('fluxo_caixa')
                        .update(fallbackData)
                        .eq('id', realId);
                    error = fallback.error;
                }
                if (!error) savedRemote = true;
        } else {
            if (payload.agendamento_id) {
                const existing = await fetchPagamentoByAgendamentoId(payload.agendamento_id);
                if (existing && existing.id && !existing.id.startsWith('cx-') && !existing.id.startsWith('virtual-')) {
                    let { error } = await supabase
                        .from('fluxo_caixa')
                        .update(dataToSave)
                        .eq('id', existing.id);
                    if (error && String(error.message || '').includes('profissional_id')) {
                        const { profissional_id, ...fallbackData } = dataToSave;
                        const fallback = await supabase
                            .from('fluxo_caixa')
                            .update(fallbackData)
                            .eq('id', existing.id);
                        error = fallback.error;
                    }
                    if (!error) savedRemote = true;
                }
            }
            if (!savedRemote) {
                    let { error } = await supabase
                        .from('fluxo_caixa')
                        .insert([dataToSave]);
                    if (error && String(error.message || '').includes('profissional_id')) {
                        const { profissional_id, ...fallbackData } = dataToSave;
                        const fallback = await supabase
                            .from('fluxo_caixa')
                            .insert([fallbackData]);
                        error = fallback.error;
                    }
                    if (!error) savedRemote = true;
            }
        }
    } catch (e) {
        console.warn("Erro ao salvar no Supabase, mantendo LocalStorage.", e);
    }

    try {
        let all = JSON.parse(localStorage.getItem('fluxo_caixa_data') || '[]');
        const idToUse = realId || (payload.agendamento_id ? 'cx-ag-' + payload.agendamento_id : 'cx-' + Date.now());
        
        const existingIdx = all.findIndex(p => p.id === idToUse || (payload.agendamento_id && p.agendamento_id === payload.agendamento_id));
        if (existingIdx >= 0) {
            all[existingIdx] = { ...all[existingIdx], ...dataToSave, id: all[existingIdx].id };
        } else {
            all.push({ ...dataToSave, id: idToUse, criado_em: new Date().toISOString() });
        }

        localStorage.setItem('fluxo_caixa_data', JSON.stringify(all));
    } catch (e) {}

    return true;
}

export async function fetchTodosPagamentosFluxoCaixa() {
    await ensureActiveProfessionalFromSession();
    let explicitPagamentos = [];
    let deletedAgendamentoIds = [];
    try {
        deletedAgendamentoIds = JSON.parse(localStorage.getItem('fluxo_caixa_deleted_ids') || '[]');
    } catch (e) {}

    try {
        const { data, error } = await supabase
            .from('fluxo_caixa')
            .select(`
                *,
                clientes ( id, nome, whatsapp ),
                servicos ( id, nome ),
                agendamentos ( id, data_hora_inicio, status, profissional_id )
            `)
            .order('criado_em', { ascending: false });

        if (!error && data) explicitPagamentos = data;
    } catch (e) {
        console.warn("Consulta fluxo_caixa via Supabase falhou, utilizando fallback.", e);
    }

    if (explicitPagamentos.length === 0) {
        try {
            explicitPagamentos = JSON.parse(localStorage.getItem('fluxo_caixa_data') || '[]');
        } catch (e) {
            explicitPagamentos = [];
        }
    }

    explicitPagamentos = filterRecordsForActiveProfessional(explicitPagamentos);

    const agendamentosProcessados = new Set();
    explicitPagamentos.forEach(p => {
        if (p.agendamento_id) agendamentosProcessados.add(p.agendamento_id);
    });
    deletedAgendamentoIds.forEach(id => agendamentosProcessados.add(id));

    let agendamentosSemCaixa = [];
    try {
        const { data: agendamentos, error } = await supabase
            .from('agendamentos')
            .select(`
                id,
                cliente_id,
                servico_id,
                profissional_id,
                data_hora_inicio,
                status,
                criado_em,
                clientes ( id, nome, whatsapp ),
                servicos ( id, nome, tabela_precos ( valor ) )
            `)
            .neq('status', 'cancelado')
            .neq('status', 'aguardando_confirmacao')
            .order('data_hora_inicio', { ascending: false });

        if (!error && agendamentos) {
            agendamentosSemCaixa = filterAppointmentsForActiveProfessional(agendamentos)
                .filter(ag => !agendamentosProcessados.has(ag.id));
        }
    } catch (e) {
        console.warn("Erro ao buscar agendamentos para fluxo de caixa:", e);
    }

    if (agendamentosSemCaixa.length === 0 && agendamentosProcessados.size === 0) {
        try {
            const localAg = JSON.parse(localStorage.getItem('agendamentos_data') || '[]');
            agendamentosSemCaixa = localAg.filter(ag => 
                ag.status !== 'cancelado' && 
                ag.status !== 'aguardando_confirmacao' && 
                ag.status !== 'solicitado' &&
                belongsToActiveProfessional(ag) &&
                !agendamentosProcessados.has(ag.id)
            );
        } catch (e) {}
    }

    const now = new Date();
    const pagamentosSintetizados = agendamentosSemCaixa.map(ag => {
        const precoServico = getServicePrice(ag.servicos);
        const dataInicio = new Date(ag.data_hora_inicio || ag.criado_em || Date.now());
        
        const isPastOrDone = ag.status === 'concluido' || ag.status === 'finalizado' || dataInicio <= now;
        const statusPag = isPastOrDone ? 'pago' : 'a_receber';

        return {
            id: `virtual-${ag.id}`,
            agendamento_id: ag.id,
            cliente_id: ag.cliente_id,
            servico_id: ag.servico_id,
            profissional_id: getAppointmentProfessionalId(ag),
            valor_bruto: precoServico,
            desconto: 0.00,
            valor_final: precoServico,
            condicao_pagamento: 'a_vista',
            forma_pagamento: 'pix',
            status_pagamento: statusPag,
            data_pagamento: ag.data_hora_inicio || ag.criado_em,
            data_vencimento: ag.data_hora_inicio || ag.criado_em,
            observacoes: 'Lançamento automático de agendamento',
            criado_em: ag.data_hora_inicio || ag.criado_em || new Date().toISOString(),
            clientes: ag.clientes,
            servicos: ag.servicos,
            agendamentos: { id: ag.id, data_hora_inicio: ag.data_hora_inicio, status: ag.status },
            is_virtual: true
        };
    });

    const resultadoFinal = [...explicitPagamentos, ...pagamentosSintetizados];
    resultadoFinal.sort((a, b) => {
        const dateA = new Date(a.criado_em || a.data_pagamento || Date.now());
        const dateB = new Date(b.criado_em || b.data_pagamento || Date.now());
        return dateB - dateA;
    });

    return resultadoFinal;
}

export async function updateStatusPagamentoFluxoCaixa(id, novoStatus) {
    let realAgendamentoId = null;
    let isVirtual = false;

    if (id && typeof id === 'string' && id.startsWith('virtual-')) {
        isVirtual = true;
        realAgendamentoId = id.replace('virtual-', '');
    }

    try {
        if (!isVirtual && id && !id.startsWith('cx-')) {
            await supabase
                .from('fluxo_caixa')
                .update({ status_pagamento: novoStatus, data_pagamento: new Date().toISOString() })
                .eq('id', id);
        } else if (realAgendamentoId) {
            const existing = await fetchPagamentoByAgendamentoId(realAgendamentoId);
            if (existing && existing.id && !existing.id.startsWith('cx-') && !existing.id.startsWith('virtual-')) {
                await supabase
                    .from('fluxo_caixa')
                    .update({ status_pagamento: novoStatus, data_pagamento: new Date().toISOString() })
                    .eq('id', existing.id);
            } else {
                const { data: ag } = await supabase
                    .from('agendamentos')
                    .select('*, servicos(id, nome, tabela_precos(valor))')
                    .eq('id', realAgendamentoId)
                    .single();

                const preco = getServicePrice(ag?.servicos);

                await supabase.from('fluxo_caixa').insert([{
                    agendamento_id: realAgendamentoId,
                    cliente_id: ag?.cliente_id || null,
                    servico_id: ag?.servico_id || null,
                    profissional_id: ag?.profissional_id || getActiveProfessionalId() || null,
                    valor_bruto: preco,
                    desconto: 0.00,
                    valor_final: preco,
                    condicao_pagamento: 'a_vista',
                    forma_pagamento: 'pix',
                    status_pagamento: novoStatus,
                    data_pagamento: new Date().toISOString(),
                    observacoes: 'Lançamento confirmado no caixa'
                }]);
            }
        }
    } catch (e) {
        console.warn("Erro ao atualizar status do pagamento no Supabase:", e);
    }

    try {
        let all = JSON.parse(localStorage.getItem('fluxo_caixa_data') || '[]');
        const targetId = realAgendamentoId ? `cx-ag-${realAgendamentoId}` : id;
        
        const idx = all.findIndex(p => p.id === id || p.agendamento_id === realAgendamentoId);
        if (idx >= 0) {
            all[idx] = { ...all[idx], status_pagamento: novoStatus, data_pagamento: new Date().toISOString() };
        } else if (realAgendamentoId) {
            all.push({
                id: targetId,
                agendamento_id: realAgendamentoId,
                status_pagamento: novoStatus,
                data_pagamento: new Date().toISOString(),
                criado_em: new Date().toISOString()
            });
        }
        localStorage.setItem('fluxo_caixa_data', JSON.stringify(all));
    } catch (e) {}

    return true;
}

export async function deletePagamentoFluxoCaixa(id) {
    let realAgendamentoId = null;
    if (id && typeof id === 'string' && id.startsWith('virtual-')) {
        realAgendamentoId = id.replace('virtual-', '');
    }

    try {
        if (id && !id.startsWith('cx-') && !id.startsWith('virtual-')) {
            await supabase
                .from('fluxo_caixa')
                .delete()
                .eq('id', id);
        }
    } catch (e) {}

    try {
        const agId = realAgendamentoId || id;
        if (agId) {
            let deletedIds = JSON.parse(localStorage.getItem('fluxo_caixa_deleted_ids') || '[]');
            if (!deletedIds.includes(agId)) deletedIds.push(agId);
            localStorage.setItem('fluxo_caixa_deleted_ids', JSON.stringify(deletedIds));
        }

        let all = JSON.parse(localStorage.getItem('fluxo_caixa_data') || '[]');
        all = all.filter(p => p.id !== id && p.agendamento_id !== realAgendamentoId);
        localStorage.setItem('fluxo_caixa_data', JSON.stringify(all));
    } catch (e) {}

    return true;
}
