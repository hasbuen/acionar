// Lógica da Aplicação Principal - Acionar Agendamentos
import { supabase } from './supabase.js';

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

// --- SUPABASE REALTIME (TEMPO REAL AUTOMÁTICO) ---
export function subscribeToAgendamentos(callback) {
    try {
        const channel = supabase
            .channel('realtime_agendamentos')
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'agendamentos' },
                (payload) => {
                    console.log('⚡ Atualização em tempo real detectada:', payload);
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
            <i data-lucide="x" class="h-4 w-4"></i>
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

// --- GESTÃO DE CONFIGURAÇÕES DE HORÁRIO DE FUNCIONAMENTO (MULTIMODAL POR DIA) ---
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

// --- RENDERIZAÇÃO DE AGENDAMENTOS COM BOTÕES DE ÍCONE ULTRA-COMPACTOS ---
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
        let query = supabase
            .from('agendamentos')
            .select(`
                id,
                cliente_id,
                servico_id,
                data_hora_inicio,
                data_hora_fim,
                status,
                observacoes,
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

        const { data, error } = await query;
        if (error) throw error;

        let agendamentos = data || [];

        if (filterDate) {
            agendamentos = agendamentos.filter(a => a.data_hora_inicio && a.data_hora_inicio.startsWith(filterDate));
        }

        if (filterStatus) {
            agendamentos = agendamentos.filter(a => (a.status || 'aguardando_confirmacao').toLowerCase() === filterStatus.toLowerCase());
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
                    <i data-lucide="calendar-x" class="h-7 w-7"></i>
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

        const statusLower = (ag.status || 'aguardando_confirmacao').toLowerCase();
        const isSolicitacao = statusLower === 'aguardando_confirmacao' || statusLower === 'solicitado';

        const statusClass = isSolicitacao
            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
            : statusLower === 'concluido' || statusLower === 'atendido'
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
            : statusLower === 'em_atendimento'
            ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20'
            : statusLower === 'cancelado'
            ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20'
            : 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20';

        const statusLabel = isSolicitacao
            ? 'AGUARDANDO CONFIRMAÇÃO'
            : statusLower === 'pendente'
            ? 'CONFIRMADO'
            : statusLower === 'em_atendimento' 
            ? 'EM ATENDIMENTO' 
            : statusLower === 'concluido' || statusLower === 'atendido'
            ? 'JÁ ATENDIDO' 
            : statusLower.toUpperCase();

        let statusMenuHtml = '';
        if (statusLower === 'pendente') {
            statusMenuHtml = `
                <button type="button" class="btn-change-status w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-sky-600 dark:text-sky-400 hover:bg-sky-500/10 transition-colors" data-id="${ag.id}" data-status="em_atendimento">
                    <span class="h-2 w-2 rounded-full bg-sky-500"></span>
                    <span>Iniciar (Em Atendimento)</span>
                </button>
                <button type="button" class="btn-change-status w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 transition-colors" data-id="${ag.id}" data-status="concluido">
                    <span class="h-2 w-2 rounded-full bg-emerald-500"></span>
                    <span>Finalizar (Já Atendido)</span>
                </button>
                <button type="button" class="btn-change-status w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition-colors" data-id="${ag.id}" data-status="cancelado">
                    <span class="h-2 w-2 rounded-full bg-rose-500"></span>
                    <span>Cancelar Agendamento</span>
                </button>
            `;
        } else if (statusLower === 'em_atendimento') {
            statusMenuHtml = `
                <button type="button" class="btn-change-status w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 transition-colors" data-id="${ag.id}" data-status="concluido">
                    <span class="h-2 w-2 rounded-full bg-emerald-500"></span>
                    <span>Finalizar (Já Atendido)</span>
                </button>
                <button type="button" class="btn-change-status w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 transition-colors" data-id="${ag.id}" data-status="pendente">
                    <span class="h-2 w-2 rounded-full bg-blue-500"></span>
                    <span>Voltar p/ Confirmado</span>
                </button>
                <button type="button" class="btn-change-status w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition-colors" data-id="${ag.id}" data-status="cancelado">
                    <span class="h-2 w-2 rounded-full bg-rose-500"></span>
                    <span>Cancelar Agendamento</span>
                </button>
            `;
        } else if (statusLower === 'concluido' || statusLower === 'atendido') {
            statusMenuHtml = `
                <button type="button" class="btn-change-status w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 transition-colors" data-id="${ag.id}" data-status="pendente">
                    <span class="h-2 w-2 rounded-full bg-blue-500"></span>
                    <span>Reabrir (Confirmado)</span>
                </button>
                <button type="button" class="btn-change-status w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition-colors" data-id="${ag.id}" data-status="cancelado">
                    <span class="h-2 w-2 rounded-full bg-rose-500"></span>
                    <span>Marcar como Cancelado</span>
                </button>
            `;
        } else if (statusLower === 'cancelado') {
            statusMenuHtml = `
                <button type="button" class="btn-change-status w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 transition-colors" data-id="${ag.id}" data-status="pendente">
                    <span class="h-2 w-2 rounded-full bg-emerald-500"></span>
                    <span>Reativar (Confirmar)</span>
                </button>
            `;
        }

        const item = document.createElement('div');
        item.className = 'group p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 border-b border-slate-100 dark:border-slate-800/60 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors rounded-2xl overflow-hidden';
        
        item.innerHTML = `
            <div class="flex items-start gap-3 flex-1 min-w-0">
                <div class="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-2xl bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400 font-bold border border-blue-100 dark:border-blue-900/40">
                    <span class="text-[10px] font-semibold uppercase">${dataInicio.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}</span>
                    <span class="text-sm font-extrabold leading-none">${dataInicio.getDate()}</span>
                </div>
                <div class="space-y-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <h4 class="font-semibold text-slate-900 dark:text-white text-sm sm:text-base truncate max-w-[140px] sm:max-w-none">${escapeHtml(clienteNome)}</h4>
                        <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-extrabold border ${statusClass} shrink-0">
                            ${statusLabel}
                        </span>
                    </div>
                    <p class="text-xs text-slate-600 dark:text-slate-300 font-medium flex items-center gap-1">
                        <i data-lucide="scissors" class="h-3.5 w-3.5 text-blue-500 shrink-0"></i>
                        <span class="truncate max-w-[200px] sm:max-w-none">${escapeHtml(servicoNome)} (${duracao} min)</span>
                    </p>
                    <div class="flex items-center gap-2.5 text-[11px] text-slate-400 dark:text-slate-500 flex-wrap">
                        <span class="flex items-center gap-1">
                            <i data-lucide="clock" class="h-3 w-3"></i>
                            ${horaInicio}${horaFim}
                        </span>
                        <span class="flex items-center gap-1">
                            <i data-lucide="calendar" class="h-3 w-3"></i>
                            ${dataFormatada}
                        </span>
                        ${ag.observacoes ? `<span class="italic text-slate-400 dark:text-slate-500 max-w-[180px] truncate" title="${escapeHtml(ag.observacoes)}">Obs: ${escapeHtml(ag.observacoes)}</span>` : ''}
                    </div>
                </div>
            </div>

            <!-- BOTÕES DE AÇÃO HORIZONTAIS COMPACTOS (ÍCONES MANTENDO MESMO TAMANHO H-9 W-9) -->
            <div class="flex flex-row items-center justify-end gap-1.5 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-100 dark:border-slate-800/40">
                ${isSolicitacao ? `
                    <!-- BOTÃO ACEITAR (ÍCONE DE CONFIRMAÇÃO VERDE) -->
                    <button type="button" class="btn-aceitar-agendamento flex items-center justify-center h-9 w-9 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold shadow-md shadow-emerald-600/20 transition-transform active:scale-95 shrink-0" 
                        title="Aceitar Agendamento"
                        data-id="${ag.id}" 
                        data-cliente-nome="${escapeHtml(clienteNome)}"
                        data-servico-nome="${escapeHtml(servicoNome)}"
                        data-whatsapp="${cleanPhone(clienteWhatsapp)}"
                        data-data-formatada="${dataFormatada}"
                        data-hora-inicio="${horaInicio}">
                        <i data-lucide="check" class="h-4 w-4"></i>
                    </button>

                    <!-- BOTÃO RECUSAR (ÍCONE X VERMELHO) -->
                    <button type="button" class="btn-recusar-agendamento flex items-center justify-center h-9 w-9 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 dark:text-rose-400 font-extrabold border border-rose-500/20 transition-all shrink-0" 
                        title="Recusar Agendamento"
                        data-id="${ag.id}">
                        <i data-lucide="x" class="h-4 w-4"></i>
                    </button>
                ` : `
                    <div class="relative status-dropdown-wrapper shrink-0">
                        <button type="button" class="btn-status-trigger flex items-center justify-center h-9 px-2.5 rounded-xl text-xs font-black border transition-all ${statusClass}" data-id="${ag.id}">
                            <span class="truncate max-w-[90px] sm:max-w-none">${statusLabel}</span>
                            <i data-lucide="chevron-down" class="h-3.5 w-3.5 opacity-60 ml-1"></i>
                        </button>

                        <div class="status-menu absolute right-0 top-full mt-1.5 z-30 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl p-1.5 hidden w-48 space-y-1">
                            ${statusMenuHtml}
                        </div>
                    </div>
                `}

                ${clienteWhatsapp ? `
                    <a href="https://wa.me/55${cleanPhone(clienteWhatsapp)}" target="_blank" rel="noopener noreferrer" 
                        class="flex items-center justify-center h-9 w-9 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 transition-all shrink-0" title="Conversar no WhatsApp">
                        <i data-lucide="message-circle" class="h-4 w-4"></i>
                    </a>
                ` : ''}

                <button class="btn-edit-agendamento flex items-center justify-center h-9 w-9 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors shrink-0" data-agendamento='${JSON.stringify(ag)}' title="Editar Agendamento">
                    <i data-lucide="edit-3" class="h-4 w-4"></i>
                </button>

                <button class="btn-delete-agendamento flex items-center justify-center h-9 w-9 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors shrink-0" data-id="${ag.id}" title="Excluir Agendamento">
                    <i data-lucide="trash-2" class="h-4 w-4"></i>
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
                        <i data-lucide="users" class="h-7 w-7"></i>
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
                            <i data-lucide="phone" class="h-3 w-3"></i>
                            ${cleanPhone(cliente.whatsapp)}
                        </p>
                    </div>
                </div>
                
                <!-- BOTÕES CLIENTES NA HORIZONTAL -->
                <div class="flex flex-row items-center gap-1.5 shrink-0">
                    <a href="https://wa.me/55${cleanPhone(cliente.whatsapp)}" target="_blank" rel="noopener noreferrer" 
                        class="flex items-center justify-center h-9 w-9 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 transition-all shrink-0">
                        <i data-lucide="message-circle" class="h-4 w-4"></i>
                    </a>
                    <button class="btn-edit-cliente flex items-center justify-center h-9 w-9 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors" data-cliente='${JSON.stringify(cliente)}' title="Editar Cliente">
                        <i data-lucide="edit-3" class="h-4 w-4"></i>
                    </button>
                    <button class="btn-delete-cliente flex items-center justify-center h-9 w-9 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors" data-id="${cliente.id}" title="Excluir Cliente">
                        <i data-lucide="trash-2" class="h-4 w-4"></i>
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
