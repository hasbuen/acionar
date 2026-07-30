// Lógica da Aplicação Principal - Acionar Agendamentos
import { supabase } from './supabase.js';

// --- REGISTRO DE SERVICE WORKER PARA NOTIFICAÇÕES EM SEGUNDO PLANO (ANDROID & IOS PWA) ---
export async function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        try {
            const reg = await navigator.serviceWorker.register('./sw.js');
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

export function isAlarmEnabled() {
    return localStorage.getItem('alarm-enabled') !== 'false';
}

export function setAlarmEnabled(enabled) {
    localStorage.setItem('alarm-enabled', enabled ? 'true' : 'false');
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
    setAlarmEnabled(newState);

    if (newState) {
        requestNotificationPermission((granted) => {
            playNotificationSound();
            showToast('Alarme sonoro ATIVADO com sucesso!', 'success');
            if (callback) callback(true);
        });
    } else {
        showToast('Alarme sonoro DESATIVADO.', 'info');
        if (callback) callback(false);
    }
}

export function requestNotificationPermission(callback) {
    initAudioContext();
    registerServiceWorker();

    if (!('Notification' in window)) {
        if (callback) callback(true);
        return;
    }

    if (Notification.permission === 'granted') {
        if (callback) callback(true);
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

export function triggerSystemNotification(title, body) {
    playNotificationSound();

    if ('Notification' in window && Notification.permission === 'granted' && isAlarmEnabled()) {
        try {
            // Emite notificação nativa através do Service Worker (compatível com Android e iOS PWA em segundo plano)
            if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({
                    type: 'SHOW_NOTIFICATION',
                    title,
                    body
                });
            } else if ('serviceWorker' in navigator) {
                navigator.serviceWorker.ready.then((reg) => {
                    reg.showNotification(title, {
                        body,
                        icon: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f514.png',
                        badge: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f514.png',
                        vibrate: [300, 100, 300],
                        tag: 'novo-agendamento',
                        renotify: true
                    });
                }).catch(() => {
                    new Notification(title, { body });
                });
            } else {
                new Notification(title, { body });
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
                        triggerSystemNotification(
                            '🔔 NOVO AGENDAMENTO RECEBIDO!',
                            'Um novo cliente acabou de solicitar um horário na sua agenda!'
                        );
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

// --- CONFIGURAÇÃO DE MENSAGEM DO WHATSAPP E ENDEREÇO ---
export const MENSAGEM_WHATSAPP_PADRAO = `Olá, *{cliente}*! 👋

Seu agendamento para *{servico}* foi *CONFIRMADO* para o dia *{data}* às *{hora}*.

📍 *Endereço*: {endereco}

Por gentileza, informe se concorda com este horário ou se prefere realizar alguma alteração.

📌 *Lembrete importante*: Pedimos a gentileza de chegar com **15 minutos de antecedência**.

Agradecemos a preferência e aguardamos você!😊`;

export async function fetchConfiguracaoMensagemWhatsApp() {
    try {
        const { data, error } = await supabase
            .from('configuracoes')
            .select('valor')
            .eq('chave', 'mensagem_whatsapp')
            .maybeSingle();

        if (error) throw error;
        if (data && data.valor) return data.valor;
    } catch (err) {
        console.warn("Usando configuração padrão de mensagem WhatsApp:", err);
    }

    return {
        mensagem: MENSAGEM_WHATSAPP_PADRAO,
        endereco: "Rua Principal, 123 - Centro"
    };
}

export async function saveConfiguracaoMensagemWhatsApp({ mensagem, endereco }) {
    const { error } = await supabase
        .from('configuracoes')
        .upsert({
            chave: 'mensagem_whatsapp',
            valor: { mensagem, endereco },
            descricao: 'Template personalizado de mensagem no WhatsApp e endereço do estabelecimento'
        }, { onConflict: 'chave' });

    if (error) throw error;
    return true;
}

// --- GERADOR DE MENSAGEM CORDIAL DE WHATSAPP ---
export async function generateWhatsAppConfirmMessage({ clienteNome, servicoNome, dataFormatada, horaInicio }) {
    const config = await fetchConfiguracaoMensagemWhatsApp();
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
                        <button type="button" data-days="15" class="chip-periodicity p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 hover:border-purple-500 hover:bg-purple-50 dark:hover:bg-purple-950/30 text-xs font-extrabold text-slate-700 dark:text-slate-300 transition-all text-center">
                            15 Dias
                        </button>
                        <button type="button" data-days="30" class="chip-periodicity active p-2.5 rounded-xl border-2 border-purple-600 bg-purple-500/10 text-xs font-black text-purple-600 dark:text-purple-400 transition-all text-center">
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
    
    let selectedDays = 30;
    function applyDays(days) {
        selectedDays = days;
        const targetDate = new Date(baseDate.getTime());
        targetDate.setDate(targetDate.getDate() + days);
        inputData.value = targetDate.toISOString().split('T')[0];
    }
    
    applyDays(30);

    if (agendamento.data_hora_inicio) {
        const d = new Date(agendamento.data_hora_inicio);
        const hrs = String(d.getHours()).padStart(2, '0');
        const mins = String(d.getMinutes()).padStart(2, '0');
        inputHora.value = `${hrs}:${mins}`;
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
                const days = parseInt(daysAttr);
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
        const dataHoraInicioISO = `${dateVal}T${timeVal}:00.000Z`;
        const obs = inputObs.value.trim() || `Manutenção Periódica de ${servicoNome}`;

        closeModal();
        if (onSchedule) {
            onSchedule({
                periodicidadeDias: selectedDays,
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

// --- GESTÃO DE CONFIGURAÇÕES DE HORÁRIO DE FUNCIONAMENTO ---
export async function fetchConfiguracaoHorarios() {
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
    const { error } = await supabase
        .from('configuracoes')
        .upsert({
            chave: 'horario_funcionamento',
            valor: configValor,
            descricao: 'Configuração avançada de turnos e horários por dia da semana'
        }, { onConflict: 'chave' });

    if (error) throw error;
    return true;
}

// --- CÁLCULO DE HORÁRIOS DISPONÍVEIS POR DIA DA SEMANA ---
export async function getAvailableTimeSlots(dateStr, servicoDuracao = 30) {
    const config = await fetchConfiguracaoHorarios();
    
    const [year, month, day] = dateStr.split('-').map(Number);
    const dateObj = new Date(year, month - 1, day);
    const dayOfWeek = dateObj.getDay();

    const intervalo = config.intervalo_minutos || 30;

    let dayConfig = null;

    if (config.dias && config.dias[dayOfWeek.toString()]) {
        dayConfig = config.dias[dayOfWeek.toString()];
    } else if (config.dias_semana) {
        const isAtivo = config.dias_semana.includes(dayOfWeek);
        dayConfig = {
            ativo: isAtivo,
            turnos: isAtivo ? [{ inicio: config.hora_inicio || "08:00", fim: config.hora_fim || "18:00" }] : []
        };
    }

    if (!dayConfig || !dayConfig.ativo || !dayConfig.turnos || dayConfig.turnos.length === 0) {
        return { closed: true, slots: [] };
    }

    const startIso = `${dateStr}T00:00:00.000Z`;
    const endIso = `${dateStr}T23:59:59.999Z`;

    let occupiedRanges = [];
    try {
        const { data: agendamentos, error } = await supabase
            .from('agendamentos')
            .select('data_hora_inicio, data_hora_fim, status')
            .neq('status', 'cancelado')
            .gte('data_hora_inicio', startIso)
            .lte('data_hora_inicio', endIso);

        if (!error && agendamentos) {
            occupiedRanges = agendamentos.map(ag => {
                const s = new Date(ag.data_hora_inicio);
                const e = new Date(ag.data_hora_fim);
                return {
                    start: s.getHours() * 60 + s.getMinutes(),
                    end: e.getHours() * 60 + e.getMinutes()
                };
            });
        }
    } catch (err) {
        console.warn("Erro ao verificar horários ocupados:", err);
    }

    const slots = [];

    dayConfig.turnos.forEach(turno => {
        if (!turno.inicio || !turno.fim) return;
        const [startH, startM] = turno.inicio.split(':').map(Number);
        const [endH, endM] = turno.fim.split(':').map(Number);

        let currentMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;

        while (currentMinutes + servicoDuracao <= endMinutes) {
            const h = Math.floor(currentMinutes / 60).toString().padStart(2, '0');
            const m = (currentMinutes % 60).toString().padStart(2, '0');
            const timeStr = `${h}:${m}`;

            const slotStart = currentMinutes;
            const slotEnd = currentMinutes + servicoDuracao;

            const isOccupied = occupiedRanges.some(r => (slotStart < r.end && slotEnd > r.start));

            if (!slots.some(s => s.time === timeStr)) {
                slots.push({
                    time: timeStr,
                    available: !isOccupied
                });
            }

            currentMinutes += intervalo;
        }
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
    return data || [];
}

export async function populateServicosDropdown(selectId, customComboboxListId = null) {
    const select = document.getElementById(selectId);
    const customList = customComboboxListId ? document.getElementById(customComboboxListId) : null;
    
    try {
        const servicos = await fetchServicosAtivos();
        const ativos = servicos.filter(s => s.ativo !== false);

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

export async function criarAgendamentoManutencao({ clienteId, servicoId, dataHoraInicioISO, parentId, periodicidadeDias, observacoes }) {
    const { data: servico } = await supabase.from('servicos').select('duracao_minutos').eq('id', servicoId).single();
    const duracao = servico?.duracao_minutos || 30;

    const dataInicio = new Date(dataHoraInicioISO);
    const dataFim = new Date(dataInicio.getTime() + duracao * 60000);

    const payload = {
        cliente_id: clienteId,
        servico_id: servicoId,
        data_hora_inicio: dataHoraInicioISO,
        data_hora_fim: dataFim.toISOString(),
        status: 'pendente',
        is_manutencao: true,
        agendamento_pai_id: parentId || null,
        periodicidade_dias: periodicidadeDias || null,
        observacoes: observacoes || 'Manutenção Periódica'
    };

    const { data, error } = await supabase
        .from('agendamentos')
        .insert(payload)
        .select()
        .single();

    if (error) throw error;
    return data;
}

export async function updateAgendamentoStatus(id, newStatus) {
    const { error } = await supabase
        .from('agendamentos')
        .update({ status: newStatus })
        .eq('id', id);

    if (error) throw error;
    return true;
}

export async function updateAgendamento(id, { servico_id, data_hora_inicio, observacoes, status }) {
    const { data: servico } = await supabase.from('servicos').select('duracao_minutos').eq('id', servico_id).single();
    const duracao = servico?.duracao_minutos || 30;

    const dataInicio = new Date(data_hora_inicio);
    const dataFim = new Date(dataInicio.getTime() + duracao * 60000);

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

export async function deleteAgendamento(id) {
    const { error } = await supabase
        .from('agendamentos')
        .delete()
        .eq('id', id);

    if (error) throw error;
    return true;
}

// --- RENDERIZAÇÃO DE AGENDAMENTOS COM FALLBACK DE SEGURANÇA VIA RPC (EVITA ERRO DE RLS PERMISSION DENIED) ---
export async function fetchAndRenderAgendamentos(containerId, filterDate = null, filterStatus = null, silent = false) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!silent) {
        container.innerHTML = `
            <div class="flex items-center justify-center py-12">
                <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
        `;
    }

    try {
        let agendamentos = [];
        let error = null;

        // Tentativa 1: Busca direta na tabela agendamentos
        const res = await supabase
            .from('agendamentos')
            .select(`
                id,
                cliente_id,
                servico_id,
                data_hora_inicio,
                data_hora_fim,
                status,
                observacoes,
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
                    duracao_minutos
                )
            `)
            .order('data_hora_inicio', { ascending: true });

        if (res.error) {
            console.warn("Busca direta em agendamentos bloqueada por RLS. Acionando fallback RPC...", res.error);
            // Tentativa 2: Fallback via RPC SECURITY DEFINER (Infalível contra permission denied no iOS/Android)
            const rpcRes = await supabase.rpc('listar_agendamentos_painel');
            if (rpcRes.error) {
                throw rpcRes.error;
            }
            agendamentos = (rpcRes.data || []).map(a => ({
                id: a.id,
                cliente_id: a.cliente_id,
                servico_id: a.servico_id,
                data_hora_inicio: a.data_hora_inicio,
                data_hora_fim: a.data_hora_fim,
                status: a.status,
                observacoes: a.observacoes,
                is_manutencao: a.is_manutencao,
                agendamento_pai_id: a.agendamento_pai_id,
                periodicidade_dias: a.periodicidade_dias,
                clientes: { id: a.cliente_id, nome: a.cliente_nome, whatsapp: a.cliente_whatsapp },
                servicos: { id: a.servico_id, nome: a.servico_nome, duracao_minutos: a.servico_duracao_minutos }
            }));
        } else {
            agendamentos = res.data || [];
        }

        // DETECÇÃO DE NOVO AGENDAMENTO PARA DISPARAR SOM DE ALARME GARANTIDO
        if (isInitialLoadDone) {
            const hasNewBooking = agendamentos.some(ag => !knownAgendamentoIds.has(ag.id));
            if (hasNewBooking) {
                triggerSystemNotification(
                    '🔔 NOVO AGENDAMENTO RECEBIDO!',
                    'Um novo agendamento acabou de entrar no seu sistema!'
                );
            }
        }

        // Atualiza o Set de IDs conhecidos
        knownAgendamentoIds = new Set(agendamentos.map(a => a.id));
        isInitialLoadDone = true;

        if (filterDate) {
            agendamentos = agendamentos.filter(a => a.data_hora_inicio && a.data_hora_inicio.startsWith(filterDate));
        }

        if (filterStatus) {
            if (filterStatus.toLowerCase() === 'manutencao') {
                agendamentos = agendamentos.filter(a => a.is_manutencao === true);
            } else {
                agendamentos = agendamentos.filter(a => (a.status || 'aguardando_confirmacao').toLowerCase() === filterStatus.toLowerCase());
            }
        }

        renderAgendamentosList(container, agendamentos);
    } catch (err) {
        console.error("Erro ao buscar agendamentos:", err);
        if (!silent) {
            container.innerHTML = `
                <div class="py-12 px-4 text-center">
                    <p class="text-sm font-semibold text-rose-500">Erro ao carregar agendamentos do Supabase.</p>
                    <p class="text-xs text-slate-400 mt-1">${escapeHtml(err.message)}</p>
                </div>
            `;
        }
    }
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
        const isSolicitacao = statusLower === 'aguardando_confirmacao' || statusLower === 'solicitado';

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

        const item = document.createElement('div');
        item.className = `group p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 border-b border-slate-100 dark:border-slate-800/60 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors rounded-2xl ${
            isManutencao ? 'bg-purple-500/[0.02] dark:bg-purple-500/[0.04]' : ''
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
                        ${isManutencao ? `
                            <span class="inline-flex items-center gap-1 text-[9px] font-extrabold px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-600 dark:text-purple-300 border border-purple-500/20">
                                🔧 Retorno de Manutenção
                            </span>
                        ` : ''}
                    </div>
                    <p class="text-xs text-slate-600 dark:text-slate-300 font-medium flex items-center gap-1">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 ${isManutencao ? 'text-purple-500' : 'text-blue-500'} shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" x2="8.12" y1="4" y2="15.88"/><line x1="14.47" x2="20" y1="14.48" y2="20"/><line x1="8.12" x2="12" y1="8.12" y2="12"/></svg>
                        <span class="truncate max-w-[200px] sm:max-w-none">${escapeHtml(servicoNome)} (${duracao} min)</span>
                    </p>
                    <div class="flex items-center gap-2.5 text-[11px] text-slate-400 dark:text-slate-500 flex-wrap">
                        <span class="flex items-center gap-1">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                            ${horaInicio}${horaFim}
                        </span>
                        <span class="flex items-center gap-1">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
                            ${dataFormatada}
                        </span>
                        ${ag.observacoes ? `<span class="italic text-slate-400 dark:text-slate-500 max-w-[180px] truncate" title="${escapeHtml(ag.observacoes)}">Obs: ${escapeHtml(ag.observacoes)}</span>` : ''}
                    </div>
                </div>
            </div>

            <!-- BOTÕES DE AÇÃO HORIZONTAIS COMPACTOS -->
            <div class="flex flex-row items-center justify-end gap-1.5 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-100 dark:border-slate-800/40">
                ${isSolicitacao ? `
                    <!-- BOTÃO ACEITAR VERDE -->
                    <button type="button" class="btn-aceitar-agendamento flex items-center justify-center h-9 w-9 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold shadow-md shadow-emerald-600/20 transition-transform active:scale-95 shrink-0" 
                        title="Aceitar Agendamento"
                        data-id="${ag.id}" 
                        data-cliente-id="${ag.cliente_id || ag.clientes?.id || ''}"
                        data-servico-id="${ag.servico_id || ag.servicos?.id || ''}"
                        data-cliente-nome="${escapeHtml(clienteNome)}"
                        data-servico-nome="${escapeHtml(servicoNome)}"
                        data-whatsapp="${cleanPhone(clienteWhatsapp)}"
                        data-data-formatada="${dataFormatada}"
                        data-hora-inicio="${horaInicio}"
                        data-data-iso="${ag.data_hora_inicio}">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </button>

                    <!-- BOTÃO RECUSAR X VERMELHO -->
                    <button type="button" class="btn-recusar-agendamento flex items-center justify-center h-9 w-9 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 dark:text-rose-400 font-extrabold border border-rose-500/20 transition-all shrink-0" 
                        title="Recusar Agendamento"
                        data-id="${ag.id}">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
                    </button>
                ` : `
                    <!-- BADGE STATUS MODAL -->
                    <button type="button" class="btn-open-status-modal flex items-center justify-center h-9 px-3 rounded-xl text-xs font-black border transition-all ${statusClass} shrink-0" 
                        data-id="${ag.id}"
                        data-cliente-id="${ag.cliente_id || ag.clientes?.id || ''}"
                        data-servico-id="${ag.servico_id || ag.servicos?.id || ''}"
                        data-status="${statusLower}"
                        data-cliente-nome="${escapeHtml(clienteNome)}"
                        data-servico-nome="${escapeHtml(servicoNome)}"
                        data-data-iso="${ag.data_hora_inicio}">
                        <span>${statusLabel}</span>
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 opacity-70 ml-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                    </button>
                `}

                ${clienteWhatsapp ? `
                    <a href="https://wa.me/55${cleanPhone(clienteWhatsapp)}" target="_blank" rel="noopener noreferrer" 
                        class="flex items-center justify-center h-9 w-9 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 transition-all shrink-0" title="Conversar no WhatsApp">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>
                    </a>
                ` : ''}

                <button class="btn-edit-agendamento flex items-center justify-center h-9 w-9 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors shrink-0" data-agendamento='${JSON.stringify(ag)}' title="Editar Agendamento">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </button>

                <button class="btn-delete-agendamento flex items-center justify-center h-9 w-9 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors shrink-0" data-id="${ag.id}" title="Excluir Agendamento">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                </button>
            </div>
        `;

        container.appendChild(item);
    });

    if (window.lucide) window.lucide.createIcons();
}

// --- CRUD DE CLIENTES ---
export async function updateCliente(id, { nome, whatsapp }) {
    const { error } = await supabase
        .from('clientes')
        .update({ nome, whatsapp: cleanPhone(whatsapp) })
        .eq('id', id);

    if (error) throw error;
    return true;
}

export async function deleteCliente(id) {
    const { error } = await supabase
        .from('clientes')
        .delete()
        .eq('id', id);

    if (error) throw error;
    return true;
}

export async function fetchAndRenderClientes(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `
        <div class="flex items-center justify-center py-12">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
        </div>
    `;

    try {
        const { data, error } = await supabase
            .from('clientes')
            .select('*')
            .order('nome', { ascending: true });

        if (error) throw error;
        const clientes = data || [];

        if (clientes.length === 0) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center py-14 px-4 text-center">
                    <div class="h-14 w-14 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mb-4 dark:bg-slate-800/80 dark:text-slate-500">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
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
            item.className = 'p-4 sm:p-5 flex items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800/60 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors';
            item.innerHTML = `
                <div class="flex items-center gap-3 min-w-0">
                    <div class="h-10 w-10 shrink-0 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 font-semibold flex items-center justify-center text-sm border border-slate-200 dark:border-slate-700">
                        ${cliente.nome.charAt(0).toUpperCase()}
                    </div>
                    <div class="min-w-0">
                        <h4 class="font-semibold text-slate-900 dark:text-white text-sm sm:text-base truncate">${escapeHtml(cliente.nome)}</h4>
                        <p class="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                            ${cleanPhone(cliente.whatsapp)}
                        </p>
                    </div>
                </div>
                
                <!-- BOTÕES CLIENTES NA HORIZONTAL -->
                <div class="flex flex-row items-center gap-1.5 shrink-0">
                    <a href="https://wa.me/55${cleanPhone(cliente.whatsapp)}" target="_blank" rel="noopener noreferrer" 
                        class="flex items-center justify-center h-9 w-9 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 transition-all shrink-0">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>
                    </a>
                    <button class="btn-edit-cliente flex items-center justify-center h-9 w-9 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors" data-cliente='${JSON.stringify(cliente)}' title="Editar Cliente">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                    </button>
                    <button class="btn-delete-cliente flex items-center justify-center h-9 w-9 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors" data-id="${cliente.id}" title="Excluir Cliente">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
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
    const { error: sErr } = await supabase
        .from('servicos')
        .update({ nome, descricao, duracao_minutos, ativo })
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
    const { error } = await supabase
        .from('servicos')
        .delete()
        .eq('id', id);

    if (error) throw error;
    return true;
}
