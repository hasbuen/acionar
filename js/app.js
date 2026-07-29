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

function escapeHtml(str) {
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

// --- BUSCA DIRETA DE SERVIÇOS ATIVOS NA TABELA 'servicos' DO SUPABASE ---
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
        .eq('ativo', true)
        .order('nome');

    if (error) {
        console.error("Erro ao buscar serviços:", error);
        throw error;
    }

    return data || [];
}

// --- POPULAR DROPDOWN DE SERVIÇOS NO MODAL ---
export async function populateServicosDropdown(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;

    select.innerHTML = '<option value="">Carregando serviços...</option>';
    try {
        const servicos = await fetchServicosAtivos();

        if (!servicos || servicos.length === 0) {
            select.innerHTML = '<option value="" disabled selected>Nenhum serviço cadastrado</option>';
            return;
        }

        select.innerHTML = '<option value="" disabled selected>Selecione um serviço...</option>';
        servicos.forEach(servico => {
            const preco = servico.tabela_precos && servico.tabela_precos[0] 
                ? ` - R$ ${parseFloat(servico.tabela_precos[0].valor).toFixed(2)}` 
                : '';
            const option = document.createElement('option');
            option.value = servico.id;
            option.textContent = `${servico.nome} (${servico.duracao_minutos} min)${preco}`;
            select.appendChild(option);
        });
    } catch (err) {
        select.innerHTML = '<option value="" disabled selected>Erro ao carregar serviços</option>';
        showToast('Erro ao carregar lista de serviços do Supabase', 'error');
    }
}

// --- SUBMISSÃO EXCLUSIVA VIA RPC 'criar_agendamento_cliente' DO SUPABASE ---
export async function criarAgendamentoCliente({ nomeCliente, whatsappCliente, servicoIdSelecionado, dataHoraInicioISO, observacoesCliente }) {
    const { data, error } = await supabase.rpc('criar_agendamento_cliente', {
        p_nome: nomeCliente,
        p_whatsapp: cleanPhone(whatsappCliente),
        p_servico_id: servicoIdSelecionado,
        p_data_hora_inicio: dataHoraInicioISO,
        p_observacoes: observacoesCliente || null
    });

    if (error) {
        console.error("Erro na RPC criar_agendamento_cliente:", error);
        throw error;
    }

    return data;
}

// --- BUSCAR E RENDERIZAR AGENDAMENTOS DIRETAMENTE DO SUPABASE ---
export async function fetchAndRenderAgendamentos(containerId, filterDate = null) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `
        <div class="flex items-center justify-center py-12">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
        </div>
    `;

    try {
        let query = supabase
            .from('agendamentos')
            .select(`
                id,
                data_hora_inicio,
                data_hora_fim,
                status,
                observacoes,
                clientes (
                    nome,
                    whatsapp
                ),
                servicos (
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

        renderAgendamentosList(container, agendamentos);
    } catch (err) {
        console.error("Erro ao buscar agendamentos:", err);
        container.innerHTML = `
            <div class="py-12 px-4 text-center">
                <p class="text-sm font-semibold text-rose-500">Erro ao carregar agendamentos do Supabase.</p>
                <p class="text-xs text-slate-400 mt-1">${escapeHtml(err.message)}</p>
            </div>
        `;
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

        const statusClass = ag.status === 'concluido' || ag.status === 'confirmado'
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
            : ag.status === 'cancelado'
            ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20'
            : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20';

        const statusText = (ag.status || 'Pendente').toUpperCase();

        const item = document.createElement('div');
        item.className = 'group p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800/60 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors rounded-2xl';
        
        item.innerHTML = `
            <div class="flex items-start gap-4">
                <div class="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-2xl bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400 font-bold border border-blue-100 dark:border-blue-900/40">
                    <span class="text-xs font-semibold uppercase">${dataInicio.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}</span>
                    <span class="text-base font-extrabold leading-none">${dataInicio.getDate()}</span>
                </div>
                <div class="space-y-1">
                    <div class="flex items-center gap-2 flex-wrap">
                        <h4 class="font-semibold text-slate-900 dark:text-white text-base">${escapeHtml(clienteNome)}</h4>
                        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold border ${statusClass}">
                            ${statusText}
                        </span>
                    </div>
                    <p class="text-xs text-slate-600 dark:text-slate-300 font-medium flex items-center gap-1.5">
                        <i data-lucide="scissors" class="h-3.5 w-3.5 text-blue-500"></i>
                        ${escapeHtml(servicoNome)} (${duracao} min)
                    </p>
                    <div class="flex items-center gap-3 text-[11px] text-slate-400 dark:text-slate-500 flex-wrap">
                        <span class="flex items-center gap-1">
                            <i data-lucide="clock" class="h-3 w-3"></i>
                            ${horaInicio}${horaFim}
                        </span>
                        <span class="flex items-center gap-1">
                            <i data-lucide="calendar" class="h-3 w-3"></i>
                            ${dataFormatada}
                        </span>
                        ${ag.observacoes ? `<span class="italic text-slate-400 dark:text-slate-500 max-w-xs truncate" title="${escapeHtml(ag.observacoes)}">Obs: ${escapeHtml(ag.observacoes)}</span>` : ''}
                    </div>
                </div>
            </div>

            <div class="flex items-center gap-2 self-end sm:self-center">
                ${clienteWhatsapp ? `
                    <a href="https://wa.me/55${cleanPhone(clienteWhatsapp)}" target="_blank" rel="noopener noreferrer" 
                        class="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 transition-all">
                        <i data-lucide="message-circle" class="h-4 w-4"></i>
                        <span>WhatsApp</span>
                    </a>
                ` : ''}
            </div>
        `;

        container.appendChild(item);
    });

    if (window.lucide) window.lucide.createIcons();
}

// --- BUSCAR E RENDERIZAR CLIENTES DIRETAMENTE DO SUPABASE ---
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
                <div class="flex items-center gap-3">
                    <div class="h-10 w-10 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 font-semibold flex items-center justify-center text-sm border border-slate-200 dark:border-slate-700">
                        ${cliente.nome.charAt(0).toUpperCase()}
                    </div>
                    <div>
                        <h4 class="font-semibold text-slate-900 dark:text-white text-sm sm:text-base">${escapeHtml(cliente.nome)}</h4>
                        <p class="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1">
                            <i data-lucide="phone" class="h-3 w-3"></i>
                            ${cleanPhone(cliente.whatsapp)}
                        </p>
                    </div>
                </div>
                <a href="https://wa.me/55${cleanPhone(cliente.whatsapp)}" target="_blank" rel="noopener noreferrer" 
                    class="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 transition-all">
                    <i data-lucide="message-circle" class="h-4 w-4"></i>
                    <span class="hidden sm:inline">Conversar</span>
                </a>
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
