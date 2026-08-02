import { supabase } from './supabase.js';
import {
    ensureActiveProfessionalFromSession,
    fetchProfissionais,
    getActiveProfessional,
    initTheme,
    showToast
} from './app.js?v=3.0';

const state = {
    profissional: null,
    produtos: [],
    movimentos: [],
    filtro: '',
    tipo: 'todos'
};

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function isMissingSchema(error) {
    const text = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
    return text.includes('pgrst205') || text.includes('could not find the table') || text.includes('does not exist');
}

function showSetupRequired() {
    document.getElementById('estoqueSetupAlert')?.classList.remove('hidden');
}

async function activeProfessional() {
    if (state.profissional?.id) return state.profissional;
    state.profissional = getActiveProfessional() || await ensureActiveProfessionalFromSession();
    if (!state.profissional?.id) throw new Error('Não foi possível identificar o profissional da sessão.');
    return state.profissional;
}

async function fetchProdutos() {
    const prof = await activeProfessional();
    const { data, error } = await supabase
        .from('estoque_produtos')
        .select('*')
        .eq('profissional_id', prof.id)
        .eq('ativo', true)
        .order('nome');
    if (error) {
        if (isMissingSchema(error)) showSetupRequired();
        throw error;
    }
    state.produtos = data || [];
    return state.produtos;
}

async function fetchMovimentos(limit = 80) {
    const prof = await activeProfessional();
    const { data, error } = await supabase
        .from('estoque_movimentacoes')
        .select('*, estoque_produtos(nome,codigo,unidade,tipo), profissional_contraparte:profissionais!estoque_movimentacoes_profissional_contraparte_id_fkey(nome)')
        .eq('profissional_id', prof.id)
        .order('criado_em', { ascending: false })
        .limit(limit);
    if (error) {
        if (isMissingSchema(error)) showSetupRequired();
        console.warn('Movimentações indisponíveis:', error.message);
        state.movimentos = [];
        return [];
    }
    state.movimentos = data || [];
    return state.movimentos;
}

async function uploadImagem(file, produtoId) {
    if (!file) return null;
    if (!file.type.startsWith('image/')) throw new Error('Selecione uma imagem válida.');
    if (file.size > 5 * 1024 * 1024) throw new Error('A imagem deve ter no máximo 5 MB.');
    const prof = await activeProfessional();
    const extension = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${prof.id}/${produtoId}/${Date.now()}.${extension}`;
    const { error } = await supabase.storage.from('produtos-estoque').upload(path, file, { upsert: true, contentType: file.type });
    if (error) throw error;
    return supabase.storage.from('produtos-estoque').getPublicUrl(path).data.publicUrl;
}

async function saveProduto(form) {
    const prof = await activeProfessional();
    const formData = new FormData(form);
    const produtoId = String(formData.get('id') || '');
    const saldoInicial = Number(formData.get('saldo_inicial') || 0);
    const payload = {
        profissional_id: prof.id,
        tipo: String(formData.get('tipo') || 'consumo'),
        nome: String(formData.get('nome') || '').trim(),
        codigo: String(formData.get('codigo') || '').trim() || null,
        categoria: String(formData.get('categoria') || '').trim() || null,
        unidade: String(formData.get('unidade') || 'un'),
        estoque_minimo: Number(formData.get('estoque_minimo') || 0),
        custo_unitario: Number(formData.get('custo_unitario') || 0),
        localizacao: String(formData.get('localizacao') || '').trim() || null
    };
    if (!payload.nome) throw new Error('Informe o nome do produto.');

    let saved;
    if (produtoId) {
        const { data, error } = await supabase
            .from('estoque_produtos')
            .update(payload)
            .eq('id', produtoId)
            .eq('profissional_id', prof.id)
            .select()
            .single();
        if (error) throw error;
        saved = data;
    } else {
        const { data, error } = await supabase
            .from('estoque_produtos')
            .insert({ ...payload, saldo_atual: saldoInicial })
            .select()
            .single();
        if (error) throw error;
        saved = data;

        if (saldoInicial > 0) {
            try {
                const gerarCaixa = formData.get('gerar_caixa') === 'on';
                const { error: rpcErr } = await supabase.rpc('registrar_movimento_estoque', {
                    p_produto_id: saved.id,
                    p_tipo: 'entrada',
                    p_quantidade: saldoInicial,
                    p_novo_saldo: null,
                    p_motivo: 'Saldo inicial do cadastro',
                    p_referencia: payload.codigo,
                    p_gerar_caixa: gerarCaixa,
                    p_valor_unitario: payload.custo_unitario,
                    p_status_pagamento: 'pago'
                });

                if (rpcErr) {
                    await supabase.from('estoque_movimentacoes').insert({
                        profissional_id: prof.id,
                        produto_id: saved.id,
                        tipo: 'entrada',
                        quantidade: saldoInicial,
                        saldo_anterior: 0,
                        saldo_posterior: saldoInicial,
                        motivo: 'Saldo inicial do cadastro',
                        referencia: payload.codigo
                    });

                    if (gerarCaixa) {
                        await supabase.from('fluxo_caixa').insert({
                            profissional_id: prof.id,
                            tipo_movimento: 'saida',
                            categoria: 'compra_material',
                            estoque_produto_id: saved.id,
                            valor_bruto: saldoInicial * payload.custo_unitario,
                            valor_final: saldoInicial * payload.custo_unitario,
                            status_pagamento: 'pago',
                            data_pagamento: new Date().toISOString(),
                            data_vencimento: new Date().toISOString(),
                            observacoes: `Compra de material · ${saved.nome}`
                        });
                    }
                }
            } catch (e) {
                console.warn('Registro de movimentação inicial via fallback:', e);
            }
        }
    }

    const file = form.querySelector('input[name="imagem"]')?.files?.[0];
    if (file) {
        try {
            const imagemUrl = await uploadImagem(file, saved.id);
            if (imagemUrl) {
                const { error } = await supabase.from('estoque_produtos').update({ imagem_url: imagemUrl }).eq('id', saved.id);
                if (error) console.warn('Erro ao salvar URL da imagem:', error);
                else saved.imagem_url = imagemUrl;
            }
        } catch (imgErr) {
            console.warn('Upload de imagem falhou:', imgErr);
        }
    }
    return saved;
}

async function deleteProduto(produtoId) {
    const prof = await activeProfessional();
    const { error } = await supabase
        .from('estoque_produtos')
        .update({ ativo: false })
        .eq('id', produtoId)
        .eq('profissional_id', prof.id);

    if (error) throw error;
    return true;
}

async function registrarMovimento(form) {
    const prof = await activeProfessional();
    const data = new FormData(form);
    const produtoId = String(data.get('produto_id'));
    const tipo = String(data.get('tipo'));
    const qtdInput = Number(data.get('quantidade') || 0);
    const motivo = String(data.get('motivo') || '').trim();
    const referencia = String(data.get('referencia') || '').trim() || null;
    const gerarCaixa = tipo === 'entrada' && data.get('gerar_caixa') === 'on';
    const valorUnitario = Number(data.get('valor_unitario') || 0);
    const statusPagamento = String(data.get('status_pagamento') || 'pago');

    if (!produtoId) throw new Error('Selecione um produto.');

    // 1. Tenta via RPC primeiro
    try {
        const { error: rpcErr } = await supabase.rpc('registrar_movimento_estoque', {
            p_produto_id: produtoId,
            p_tipo: tipo,
            p_quantidade: tipo === 'inventario' ? null : qtdInput,
            p_novo_saldo: tipo === 'inventario' ? qtdInput : null,
            p_motivo: motivo,
            p_referencia: referencia,
            p_gerar_caixa: gerarCaixa,
            p_valor_unitario: valorUnitario,
            p_status_pagamento: statusPagamento
        });

        if (!rpcErr) return true;
        console.warn('RPC registrar_movimento_estoque indisponível, executando fallback JS:', rpcErr);
    } catch (e) {
        console.warn('Executando registrarMovimento via fallback JS');
    }

    // 2. Fallback JS resiliente
    const { data: prod, error: prodErr } = await supabase
        .from('estoque_produtos')
        .select('*')
        .eq('id', produtoId)
        .single();

    if (prodErr || !prod) throw new Error('Produto não encontrado.');

    const saldoAnterior = Number(prod.saldo_atual || 0);
    let delta = 0;
    let saldoPosterior = 0;

    if (tipo === 'inventario') {
        if (qtdInput < 0) throw new Error('Saldo contado inválido.');
        saldoPosterior = qtdInput;
        delta = saldoPosterior - saldoAnterior;
    } else if (tipo === 'entrada') {
        if (qtdInput <= 0) throw new Error('Informe uma quantidade maior que zero.');
        delta = qtdInput;
        saldoPosterior = saldoAnterior + delta;
    } else if (tipo === 'saida') {
        if (qtdInput <= 0) throw new Error('Informe uma quantidade maior que zero.');
        delta = -qtdInput;
        saldoPosterior = saldoAnterior + delta;
    } else {
        throw new Error('Tipo de movimento inválido.');
    }

    if (saldoPosterior < 0) throw new Error('Saldo insuficiente para realizar esta saída.');
    if (delta === 0) throw new Error('A contagem digitada é exatamente igual ao saldo atual.');

    const { error: updErr } = await supabase
        .from('estoque_produtos')
        .update({ saldo_atual: saldoPosterior })
        .eq('id', produtoId);

    if (updErr) throw updErr;

    const motivoFinal = motivo || (tipo === 'inventario' ? 'Contagem de inventário' : (tipo === 'entrada' ? 'Entrada / Compra' : 'Saída manual'));
    await supabase.from('estoque_movimentacoes').insert({
        profissional_id: prod.profissional_id,
        produto_id: produtoId,
        tipo: tipo,
        quantidade: delta,
        saldo_anterior: saldoAnterior,
        saldo_posterior: saldoPosterior,
        motivo: motivoFinal,
        referencia: referencia
    });

    if (gerarCaixa && tipo === 'entrada') {
        const totalCompra = qtdInput * (valorUnitario || prod.custo_unitario || 0);
        await supabase.from('fluxo_caixa').insert({
            profissional_id: prod.profissional_id,
            tipo_movimento: 'saida',
            categoria: 'compra_material',
            estoque_produto_id: produtoId,
            valor_bruto: totalCompra,
            valor_final: totalCompra,
            status_pagamento: statusPagamento,
            data_pagamento: statusPagamento === 'pago' ? new Date().toISOString() : null,
            data_vencimento: new Date().toISOString(),
            observacoes: `Compra de material · ${prod.nome}${referencia ? ' · ' + referencia : ''}`
        });
    }

    return true;
}

async function transferirProduto(form) {
    const prof = await activeProfessional();
    const data = new FormData(form);
    const produtoOrigemId = String(data.get('produto_id'));
    const destinoId = String(data.get('destino_id'));
    const quantidade = Number(data.get('quantidade') || 0);
    const acertoFinanceiro = String(data.get('acerto_financeiro') || 'sem_acerto');
    const valorUnitario = Number(data.get('valor_unitario') || 0);
    const observacoes = String(data.get('observacoes') || '').trim() || null;

    if (!produtoOrigemId) throw new Error('Selecione o produto de origem.');
    if (!destinoId) throw new Error('Selecione o profissional de destino.');
    if (quantidade <= 0) throw new Error('Informe uma quantidade válida.');
    if (prof.id === destinoId) throw new Error('O profissional de destino deve ser diferente da origem.');

    try {
        const { data: result, error: rpcErr } = await supabase.rpc('transferir_estoque', {
            p_produto_origem_id: produtoOrigemId,
            p_profissional_destino_id: destinoId,
            p_quantidade: quantidade,
            p_acerto_financeiro: acertoFinanceiro,
            p_valor_unitario: valorUnitario,
            p_observacoes: observacoes
        });

        if (!rpcErr) return result;
        console.warn('RPC transferir_estoque indisponível, executando via fallback JS:', rpcErr);
    } catch (e) {
        console.warn('Executando transferência via fallback JS');
    }

    const { data: origem, error: origErr } = await supabase
        .from('estoque_produtos')
        .select('*')
        .eq('id', produtoOrigemId)
        .single();

    if (origErr || !origem) throw new Error('Produto de origem não encontrado.');
    if (Number(origem.saldo_atual) < quantidade) throw new Error('Saldo insuficiente para realizar esta transferência.');

    let { data: destino } = await supabase
        .from('estoque_produtos')
        .select('*')
        .eq('profissional_id', destinoId)
        .eq('catalogo_chave', origem.catalogo_chave)
        .maybeSingle();

    let fichaCopiada = false;
    if (!destino) {
        const { data: novoDestino, error: newErr } = await supabase
            .from('estoque_produtos')
            .insert({
                profissional_id: destinoId,
                catalogo_chave: origem.catalogo_chave,
                produto_origem_id: origem.id,
                tipo: origem.tipo,
                nome: origem.nome,
                codigo: origem.codigo,
                categoria: origem.categoria,
                unidade: origem.unidade,
                saldo_atual: 0,
                estoque_minimo: origem.estoque_minimo,
                custo_unitario: origem.custo_unitario,
                localizacao: null,
                imagem_url: origem.imagem_url,
                ativo: true
            })
            .select()
            .single();

        if (newErr) throw newErr;
        destino = novoDestino;
        fichaCopiada = true;
    }

    const saldoOrigemNovo = Number(origem.saldo_atual) - quantidade;
    const saldoDestinoNovo = Number(destino.saldo_atual) + quantidade;

    await supabase.from('estoque_produtos').update({ saldo_atual: saldoOrigemNovo }).eq('id', origem.id);
    await supabase.from('estoque_produtos').update({ saldo_atual: saldoDestinoNovo }).eq('id', destino.id);

    await supabase.from('estoque_movimentacoes').insert([
        {
            profissional_id: origem.profissional_id,
            produto_id: origem.id,
            tipo: 'transferencia_saida',
            quantidade: -quantidade,
            saldo_anterior: origem.saldo_atual,
            saldo_posterior: saldoOrigemNovo,
            motivo: 'Enviado para outro profissional',
            referencia: `Envio para ${destinoId}`,
            profissional_contraparte_id: destinoId
        },
        {
            profissional_id: destinoId,
            produto_id: destino.id,
            tipo: 'transferencia_entrada',
            quantidade: quantidade,
            saldo_anterior: destino.saldo_atual,
            saldo_posterior: saldoDestinoNovo,
            motivo: 'Recebido de outro profissional',
            referencia: `Recebido de ${origem.profissional_id}`,
            profissional_contraparte_id: origem.profissional_id
        }
    ]);

    return { ficha_copiada: fichaCopiada, saldo_origem: saldoOrigemNovo, saldo_destino: saldoDestinoNovo };
}

function productPhoto(produto, size = 'h-14 w-14') {
    if (produto.imagem_url) {
        return `<img src="${escapeHtml(produto.imagem_url)}" alt="" class="${size} rounded-2xl object-cover border border-slate-200 dark:border-slate-700">`;
    }
    const icon = produto.tipo === 'ferramenta' ? 'fa-screwdriver-wrench' : 'fa-box';
    return `<span class="${size} rounded-2xl bg-gradient-to-br from-blue-500/10 to-indigo-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center border border-blue-500/10"><i class="fa-solid ${icon}"></i></span>`;
}

function renderMetrics() {
    const produtos = state.produtos;
    // Só alerta quando estoque_minimo foi definido (> 0)
    const baixo = produtos.filter(p => Number(p.estoque_minimo) > 0 && Number(p.saldo_atual) <= Number(p.estoque_minimo));
    const valor = produtos.reduce((sum, p) => sum + Number(p.saldo_atual) * Number(p.custo_unitario), 0);
    const ferramentas = produtos.filter(p => p.tipo === 'ferramenta').length;
    const values = {
        estoqueKpiProdutos: produtos.length,
        estoqueKpiValor: money.format(valor),
        estoqueKpiBaixo: baixo.length,
        estoqueKpiFerramentas: ferramentas
    };
    Object.entries(values).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    });
}

function filteredProducts() {
    const search = state.filtro.toLocaleLowerCase('pt-BR');
    return state.produtos.filter(p => {
        const matchText = !search || `${p.nome} ${p.codigo || ''} ${p.categoria || ''}`.toLocaleLowerCase('pt-BR').includes(search);
        const matchType = state.tipo === 'todos' || p.tipo === state.tipo;
        return matchText && matchType;
    });
}

function renderProducts() {
    renderMetrics();
    const container = document.getElementById('estoqueProdutosGrid');
    if (!container) return;
    const products = filteredProducts();
    if (!products.length) {
        container.innerHTML = `<div class="col-span-full py-16 text-center bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-[2rem]">
            <span class="mx-auto h-14 w-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400"><i class="fa-solid fa-box-open text-xl"></i></span>
            <h3 class="mt-4 font-extrabold">Nenhum produto cadastrado ainda</h3>
            <p class="mt-1 text-xs text-slate-500">Clique em <strong>Novo produto</strong> para começar.</p>
        </div>`;
        return;
    }
    container.innerHTML = products.map(p => {
        const saldoAtual = Number(p.saldo_atual ?? 0);
        const estoqueMin = Number(p.estoque_minimo ?? 0);
        const low = estoqueMin > 0 && saldoAtual <= estoqueMin;
        const valorTotal = saldoAtual * Number(p.custo_unitario ?? 0);
        return `<article class="group bg-white dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800 rounded-[2rem] p-5 shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition-all">
            <div class="flex items-start gap-3">
                ${productPhoto(p)}
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="px-2 py-1 rounded-lg text-[9px] font-black uppercase ${p.tipo === 'ferramenta' ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'}">${p.tipo === 'ferramenta' ? '🛠️ Ferramenta' : '📦 Consumo'}</span>
                        ${low ? '<span class="px-2 py-1 rounded-lg text-[9px] font-black uppercase bg-rose-500/10 text-rose-600 dark:text-rose-400 animate-pulse">⚠️ Repor</span>' : ''}
                    </div>
                    <h3 class="mt-1.5 font-extrabold text-sm text-slate-900 dark:text-white truncate">${escapeHtml(p.nome)}</h3>
                    <p class="text-[10px] text-slate-400">${escapeHtml(p.codigo || 'Sem código')} · ${escapeHtml(p.categoria || 'Sem categoria')}</p>
                </div>
            </div>
            <div class="mt-4 grid grid-cols-3 gap-2">
                <div class="rounded-2xl bg-slate-50 dark:bg-slate-800/60 p-3 col-span-1">
                    <span class="block text-[9px] uppercase font-bold text-slate-400">${p.tipo === 'ferramenta' ? 'Qtd.' : 'Saldo'}</span>
                    <strong class="text-base text-slate-900 dark:text-white">${number.format(saldoAtual)} <small class="text-[10px] text-slate-400">${escapeHtml(p.unidade)}</small></strong>
                </div>
                <div class="rounded-2xl bg-slate-50 dark:bg-slate-800/60 p-3 col-span-1">
                    <span class="block text-[9px] uppercase font-bold text-slate-400">Custo unit.</span>
                    <strong class="text-xs text-slate-900 dark:text-white">${money.format(p.custo_unitario ?? 0)}</strong>
                </div>
                <div class="rounded-2xl bg-slate-50 dark:bg-slate-800/60 p-3 col-span-1">
                    <span class="block text-[9px] uppercase font-bold text-slate-400">Total</span>
                    <strong class="text-xs text-emerald-600 dark:text-emerald-400">${money.format(valorTotal)}</strong>
                </div>
            </div>
            ${p.localizacao ? `<p class="mt-2 text-[10px] text-slate-400"><i class="fa-solid fa-location-dot mr-1"></i>${escapeHtml(p.localizacao)}</p>` : ''}
            <div class="mt-3 flex items-center gap-1.5 border-t border-slate-100 dark:border-slate-800 pt-3">
                <button data-action="razao" data-id="${p.id}" title="Histórico de movimentações" class="h-9 w-9 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-blue-500 flex items-center justify-center transition-colors">
                    <i class="fa-solid fa-clock-rotate-left text-xs"></i>
                </button>
                <button data-action="movimentar" data-id="${p.id}" title="Registrar entrada ou saída" class="flex-1 h-9 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 text-[10px] font-extrabold flex items-center justify-center gap-1 transition-colors hover:bg-blue-500/20">
                    <i class="fa-solid fa-arrow-right-arrow-left text-xs"></i> Movimentar
                </button>
                <button data-action="editar" data-id="${p.id}" title="Editar produto" class="h-9 w-9 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-blue-500 flex items-center justify-center transition-colors">
                    <i class="fa-solid fa-pen text-xs"></i>
                </button>
                <button data-action="excluir" data-id="${p.id}" title="Excluir produto" class="h-9 w-9 rounded-xl bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 flex items-center justify-center transition-colors">
                    <i class="fa-solid fa-trash text-xs"></i>
                </button>
            </div>
        </article>`;
    }).join('');
}

function populateProductSelect(select, selectedId = '') {
    if (!select) return;
    select.innerHTML = state.produtos.map(p => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(p.nome)} · ${number.format(p.saldo_atual)} ${escapeHtml(p.unidade)}</option>`).join('');
}

function showModal(modal) {
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeModal(id) {
    const modal = typeof id === 'string' ? document.getElementById(id) : id;
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

// ─────────────────────────────────────────────────────────────
// WIZARD DE CADASTRO DE PRODUTO (3 PASSOS)
// ─────────────────────────────────────────────────────────────

let wizardStep = 1;

function goToWizardStep(step) {
    wizardStep = step;
    [1, 2, 3].forEach(s => {
        const tab = document.getElementById(`stepTab${s}`);
        const div = document.getElementById(`wizardStep${s}`);
        if (!tab || !div) return;
        if (s === step) {
            tab.className = 'py-2 rounded-xl bg-blue-600 text-white font-extrabold text-[11px] shadow-sm transition-all flex items-center justify-center gap-1.5';
            div.classList.remove('hidden');
        } else if (s < step) {
            tab.className = 'py-2 rounded-xl bg-emerald-500 text-white font-extrabold text-[11px] transition-all flex items-center justify-center gap-1.5';
            div.classList.add('hidden');
        } else {
            tab.className = 'py-2 rounded-xl bg-slate-200/70 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-bold text-[11px] transition-all flex items-center justify-center gap-1.5';
            div.classList.add('hidden');
        }
    });
    document.getElementById('btnWizardPrev')?.classList.toggle('hidden', step === 1);
    document.getElementById('btnWizardNext')?.classList.toggle('hidden', step === 3);
    document.getElementById('btnWizardSubmit')?.classList.toggle('hidden', step !== 3);
}

function updateTipoOpcoes(tipoSelecionado) {
    document.querySelectorAll('.btn-tipo-opcao').forEach(label => {
        const radio = label.querySelector('input[type="radio"]');
        if (!radio) return;
        if (radio.value === tipoSelecionado) {
            label.classList.add('border-blue-500', 'bg-blue-500/5');
            label.classList.remove('border-slate-200', 'dark:border-slate-800');
        } else {
            label.classList.remove('border-blue-500', 'bg-blue-500/5');
            label.classList.add('border-slate-200', 'dark:border-slate-800');
        }
    });
}

function openProductModal(produto = null) {
    const modal = document.getElementById('modalProdutoEstoque');
    const form = document.getElementById('formProdutoEstoque');
    if (!modal || !form) return;
    form.reset();
    form.elements.id.value = produto?.id || '';
    if (produto) {
        form.elements.tipo.value = produto.tipo || 'consumo';
        form.elements.nome.value = produto.nome || '';
        form.elements.codigo.value = produto.codigo || '';
        if (form.elements.categoria) form.elements.categoria.value = produto.categoria || '';
        form.elements.unidade.value = produto.unidade || 'un';
        form.elements.estoque_minimo.value = produto.estoque_minimo ?? 0;
        form.elements.custo_unitario.value = produto.custo_unitario ?? 0;
        form.elements.localizacao.value = produto.localizacao || '';
    }
    // Oculta saldo inicial ao editar
    document.querySelectorAll('[data-initial-balance]').forEach(el => el.classList.toggle('hidden', Boolean(produto)));
    document.getElementById('produtoModalTitle').textContent = produto ? 'Editar produto' : 'Novo produto';
    const preview = document.getElementById('produtoImagemPreview');
    if (preview) {
        preview.innerHTML = produto?.imagem_url
            ? `<img src="${escapeHtml(produto.imagem_url)}" class="h-full w-full object-cover">`
            : `<i class="fa-solid fa-camera text-2xl"></i><span class="text-xs font-extrabold">Fotografar / Anexar produto</span><span class="text-[10px] text-slate-400">Clique para câmera ou galeria</span>`;
    }
    updateTipoOpcoes(form.elements.tipo?.value || 'consumo');
    goToWizardStep(1);
    showModal(modal);
}

function openMovementModal(produtoId = '', type = 'entrada') {
    const modal = document.getElementById('modalMovimentoEstoque');
    const form = document.getElementById('formMovimentoEstoque');
    if (!modal || !form) return;
    form.reset();
    populateProductSelect(form.elements.produto_id, produtoId);
    form.elements.tipo.value = type;
    updateMovementForm(form);
    showModal(modal);
}

function updateMovementForm(form) {
    const type = form.elements.tipo.value;
    const selected = state.produtos.find(p => p.id === form.elements.produto_id.value);
    document.getElementById('movimentoQuantidadeLabel').textContent = type === 'inventario' ? 'Quantidade encontrada' : 'Quantidade';
    document.getElementById('movimentoSaldoAtual').textContent = selected ? `${number.format(selected.saldo_atual)} ${selected.unidade}` : '—';
    const purchase = document.getElementById('movimentoCompraFields');
    purchase?.classList.toggle('hidden', type !== 'entrada');
    if (selected && form.elements.valor_unitario) form.elements.valor_unitario.value = selected.custo_unitario || 0;
}

async function openTransferModal(produtoId = '') {
    const modal = document.getElementById('modalTransferenciaEstoque');
    const form = document.getElementById('formTransferenciaEstoque');
    if (!modal || !form) return;
    form.reset();
    populateProductSelect(form.elements.produto_id, produtoId);
    const prof = await activeProfessional();
    const profissionais = (await fetchProfissionais()).filter(p => p.ativo !== false && p.id !== prof.id);
    form.elements.destino_id.innerHTML = profissionais.map(p => `<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('');
    const selected = state.produtos.find(p => p.id === form.elements.produto_id.value);
    if (selected) form.elements.valor_unitario.value = selected.custo_unitario || 0;
    document.getElementById('transferenciaAcertoFields')?.classList.add('hidden');
    showModal(modal);
}

async function openLedger(produtoId) {
    const produto = state.produtos.find(p => p.id === produtoId);
    if (!produto) return;
    const { data, error } = await supabase
        .from('estoque_movimentacoes')
        .select('*')
        .eq('produto_id', produtoId)
        .order('criado_em', { ascending: false });
    if (error) throw error;
    document.getElementById('razaoProdutoNome').textContent = produto.nome;
    document.getElementById('razaoProdutoSaldo').textContent = `${number.format(produto.saldo_atual)} ${produto.unidade}`;
    const list = document.getElementById('razaoMovimentosLista');
    list.innerHTML = (data || []).length ? data.map(m => `
        <div class="flex items-center gap-3 py-3 border-b border-slate-100 dark:border-slate-800 last:border-0">
            <span class="h-9 w-9 rounded-xl flex items-center justify-center ${Number(m.quantidade) > 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-orange-500/10 text-orange-500'}"><i class="fa-solid ${Number(m.quantidade) > 0 ? 'fa-arrow-down' : 'fa-arrow-up'} text-xs"></i></span>
            <div class="min-w-0 flex-1"><strong class="block text-xs">${escapeHtml(m.motivo)}</strong><span class="text-[10px] text-slate-400">${escapeHtml(m.referencia || 'Sem referência')} · ${new Date(m.criado_em).toLocaleString('pt-BR')}</span></div>
            <div class="text-right"><strong class="block text-xs ${Number(m.quantidade) > 0 ? 'text-emerald-500' : 'text-orange-500'}">${Number(m.quantidade) > 0 ? '+' : ''}${number.format(m.quantidade)} ${produto.unidade}</strong><span class="text-[10px] text-slate-400">Saldo ${number.format(m.saldo_posterior)}</span></div>
        </div>`).join('') : '<p class="py-8 text-center text-xs text-slate-400">Nenhuma movimentação registrada.</p>';
    showModal(document.getElementById('modalRazaoEstoque'));
}

// ─────────────────────────────────────────────────────────────
// ASSISTENTE DE INVENTÁRIO GUIADO
// ─────────────────────────────────────────────────────────────

function openInventarioGuiado() {
    const modal = document.getElementById('modalInventarioGuiado');
    if (!modal) return;
    const searchInput = document.getElementById('inventarioGuiadoSearch');
    if (searchInput) { searchInput.value = ''; searchInput.oninput = () => renderInventarioGuiado(state.produtos, searchInput.value); }
    renderInventarioGuiado(state.produtos, '');
    showModal(modal);
}

function renderInventarioGuiado(produtos, filtro = '') {
    const container = document.getElementById('inventarioGuiadoLista');
    if (!container) return;
    const search = filtro.toLocaleLowerCase('pt-BR');
    const filtrados = produtos.filter(p => !search || `${p.nome} ${p.codigo || ''} ${p.categoria || ''}`.toLocaleLowerCase('pt-BR').includes(search));
    if (!filtrados.length) {
        container.innerHTML = `<div class="py-12 text-center"><i class="fa-solid fa-box-open text-3xl text-slate-300 dark:text-slate-600"></i><p class="mt-3 text-xs text-slate-400 font-medium">Nenhum produto encontrado.</p></div>`;
        atualizarSummaryInventario();
        return;
    }
    container.innerHTML = filtrados.map(p => {
        const saldoAtual = Number(p.saldo_atual ?? 0);
        const low = Number(p.estoque_minimo) > 0 && saldoAtual <= Number(p.estoque_minimo);
        return `<div class="rounded-2xl border ${low ? 'border-rose-500/30 bg-rose-500/5' : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40'} p-4 flex items-center gap-3" data-inventario-row data-produto-id="${p.id}" data-saldo-atual="${saldoAtual}">
            ${productPhoto(p, 'h-12 w-12 shrink-0')}
            <div class="min-w-0 flex-1">
                <strong class="block text-xs font-extrabold text-slate-900 dark:text-white truncate">${escapeHtml(p.nome)}</strong>
                <span class="text-[10px] text-slate-400">${escapeHtml(p.categoria || 'Sem categoria')} · Sistema: <strong class="text-blue-500">${number.format(saldoAtual)} ${escapeHtml(p.unidade)}</strong></span>
                <div id="diffBadge_${p.id}" class="mt-1 hidden text-[10px] font-extrabold"></div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
                <button type="button" class="btn-inv-minus h-10 w-10 rounded-xl bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 flex items-center justify-center text-lg font-bold transition-colors" data-id="${p.id}">−</button>
                <input type="number" min="0" step="0.001" value="${saldoAtual}"
                    class="inventario-input w-20 text-center rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2 py-2 text-sm font-black text-slate-900 dark:text-white focus:ring-2 focus:ring-purple-500 focus:outline-none"
                    data-id="${p.id}" data-saldo-atual="${saldoAtual}">
                <button type="button" class="btn-inv-plus h-10 w-10 rounded-xl bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 flex items-center justify-center text-lg font-bold transition-colors" data-id="${p.id}">+</button>
            </div>
        </div>`;
    }).join('');
    // Eventos
    container.querySelectorAll('.btn-inv-minus').forEach(btn => btn.addEventListener('click', () => {
        const input = container.querySelector(`.inventario-input[data-id="${btn.dataset.id}"]`);
        if (input) { input.value = Math.max(0, Number(input.value) - 1); atualizarDiffBadge(btn.dataset.id, Number(input.value), container); atualizarSummaryInventario(); }
    }));
    container.querySelectorAll('.btn-inv-plus').forEach(btn => btn.addEventListener('click', () => {
        const input = container.querySelector(`.inventario-input[data-id="${btn.dataset.id}"]`);
        if (input) { input.value = Number(input.value) + 1; atualizarDiffBadge(btn.dataset.id, Number(input.value), container); atualizarSummaryInventario(); }
    }));
    container.querySelectorAll('.inventario-input').forEach(input => input.addEventListener('input', () => {
        atualizarDiffBadge(input.dataset.id, Math.max(0, Number(input.value) || 0), container); atualizarSummaryInventario();
    }));
    atualizarSummaryInventario();
}

function atualizarDiffBadge(produtoId, novoVal, container) {
    const badge = container.querySelector(`#diffBadge_${produtoId}`);
    const input = container.querySelector(`.inventario-input[data-id="${produtoId}"]`);
    if (!badge || !input) return;
    const saldoAtual = Number(input.dataset.saldoAtual);
    const diff = novoVal - saldoAtual;
    if (diff === 0) { badge.classList.add('hidden'); return; }
    badge.classList.remove('hidden');
    badge.innerHTML = diff > 0
        ? `<span class="text-emerald-600 dark:text-emerald-400">▲ +${number.format(diff)} (sobra)</span>`
        : `<span class="text-rose-500">▼ ${number.format(diff)} (falta)</span>`;
}

function atualizarSummaryInventario() {
    const container = document.getElementById('inventarioGuiadoLista');
    const badge = document.getElementById('inventarioSummaryBadge');
    if (!container || !badge) return;
    let alteracoes = 0;
    container.querySelectorAll('.inventario-input').forEach(input => {
        if (Number(input.value) !== Number(input.dataset.saldoAtual)) alteracoes++;
    });
    badge.textContent = alteracoes === 0 ? 'Nenhuma alteração pendente' : `${alteracoes} produto${alteracoes > 1 ? 's' : ''} com ajuste pendente`;
    badge.className = `text-xs font-bold ${alteracoes > 0 ? 'text-purple-600 dark:text-purple-400' : 'text-slate-500 dark:text-slate-400'}`;
}

async function salvarInventarioGuiado(ajustes) {
    if (!ajustes || ajustes.length === 0) return 0;
    let salvos = 0;
    for (const aj of ajustes) {
        if (aj.saldoContado === aj.saldoAtual) continue;
        try {
            const { error: rpcErr } = await supabase.rpc('registrar_movimento_estoque', {
                p_produto_id: aj.produtoId, p_tipo: 'inventario', p_quantidade: null,
                p_novo_saldo: aj.saldoContado, p_motivo: aj.motivo || 'Contagem física de inventário',
                p_referencia: null, p_gerar_caixa: false, p_valor_unitario: 0, p_status_pagamento: 'pago'
            });
            if (rpcErr) {
                const delta = aj.saldoContado - aj.saldoAtual;
                await supabase.from('estoque_produtos').update({ saldo_atual: aj.saldoContado }).eq('id', aj.produtoId);
                await supabase.from('estoque_movimentacoes').insert({
                    profissional_id: state.profissional.id, produto_id: aj.produtoId, tipo: 'inventario',
                    quantidade: delta, saldo_anterior: aj.saldoAtual, saldo_posterior: aj.saldoContado,
                    motivo: aj.motivo || 'Contagem física de inventário', referencia: null
                });
            }
            salvos++;
        } catch (e) { console.warn(`Falha ao salvar inventário produto ${aj.produtoId}:`, e); }
    }
    return salvos;
}

async function refreshStock() {
    await Promise.all([fetchProdutos(), fetchMovimentos()]);
    renderProducts();
}

export function generateSKU(nome = '', categoria = '') {
    const clean = (nome || categoria || 'PROD')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .toUpperCase();
    const prefix = clean.slice(0, 3).padEnd(3, 'PRD');
    const randomDigits = Math.floor(1000 + Math.random() * 9000);
    return `SKU-${prefix}-${randomDigits}`;
}


export async function initEstoquePage() {
    initTheme();
    try {
        await refreshStock();
    } catch (error) {
        if (!isMissingSchema(error)) showToast(`Erro ao carregar estoque: ${error.message}`, 'error');
        renderProducts();
    }


    document.getElementById('btnNovoProduto')?.addEventListener('click', () => openProductModal());
    document.getElementById('btnRegistrarEntrada')?.addEventListener('click', () => openMovementModal('', 'entrada'));
    document.getElementById('btnInventario')?.addEventListener('click', () => openInventarioGuiado());
    document.getElementById('btnTransferir')?.addEventListener('click', () => openTransferModal());
    document.getElementById('estoqueSearch')?.addEventListener('input', event => { state.filtro = event.target.value; renderProducts(); });
    document.getElementById('estoqueTipoFilter')?.addEventListener('change', event => { state.tipo = event.target.value; renderProducts(); });

    document.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.closeModal)));

    // Tags de categoria (clique rápido)
    document.querySelectorAll('.btn-tag-categoria').forEach(btn => {
        btn.addEventListener('click', () => {
            const catInput = document.getElementById('inputProdutoCategoria');
            if (catInput) catInput.value = btn.textContent.trim();
        });
    });

    // Radio tipo visual
    document.querySelectorAll('.btn-tipo-opcao input[type="radio"]').forEach(radio => {
        radio.addEventListener('change', () => updateTipoOpcoes(radio.value));
    });

    // Wizard: navegação de passos
    document.getElementById('btnWizardNext')?.addEventListener('click', () => {
        const form = document.getElementById('formProdutoEstoque');
        if (wizardStep === 1 && !form?.elements?.nome?.value?.trim()) {
            showToast('Informe o nome do produto antes de continuar.', 'error');
            return;
        }
        if (wizardStep < 3) goToWizardStep(wizardStep + 1);
    });
    document.getElementById('btnWizardPrev')?.addEventListener('click', () => {
        if (wizardStep > 1) goToWizardStep(wizardStep - 1);
    });

    document.getElementById('btnGerarSku')?.addEventListener('click', () => {
        const form = document.getElementById('formProdutoEstoque');
        if (!form) return;
        const nome = form.elements.nome.value;
        const categoria = form.elements.categoria.value;
        form.elements.codigo.value = generateSKU(nome, categoria);
        showToast('Código SKU gerado com sucesso.', 'info');
    });

    document.getElementById('inputProdutoNome')?.addEventListener('blur', event => {
        const form = document.getElementById('formProdutoEstoque');
        if (form && !form.elements.codigo.value && event.target.value.trim()) {
            form.elements.codigo.value = generateSKU(event.target.value);
        }
    });

    document.getElementById('produtoImagemInput')?.addEventListener('change', event => {
        const file = event.target.files?.[0];
        if (!file) return;
        const preview = document.getElementById('produtoImagemPreview');
        const reader = new FileReader();
        reader.onload = e => {
            if (preview) preview.innerHTML = `<img src="${e.target.result}" class="h-full w-full object-cover">`;
        };
        reader.readAsDataURL(file);
    });

    document.getElementById('formProdutoEstoque')?.addEventListener('submit', async event => {
        event.preventDefault();
        const btn = document.getElementById('btnWizardSubmit') || event.target.querySelector('button[type="submit"]');
        if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }
        try {
            await saveProduto(event.target);
            closeModal('modalProdutoEstoque');
            showToast('✅ Produto salvo com sucesso!', 'success');
            await refreshStock();
        } catch (error) { showToast(error.message, 'error'); }
        finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check text-xs"></i> Salvar Produto'; } }
    });

    // Inventário Guiado – salvar
    document.getElementById('btnSalvarInventarioGuiado')?.addEventListener('click', async () => {
        const container = document.getElementById('inventarioGuiadoLista');
        if (!container) return;
        const inputs = container.querySelectorAll('.inventario-input');
        const ajustes = [];
        inputs.forEach(input => {
            const saldoAtual = Number(input.dataset.saldoAtual);
            const saldoContado = Math.max(0, Number(input.value) || 0);
            if (saldoContado !== saldoAtual) ajustes.push({ produtoId: input.dataset.id, saldoAtual, saldoContado, motivo: 'Contagem física de inventário' });
        });
        if (ajustes.length === 0) { showToast('Nenhuma quantidade foi alterada.', 'info'); return; }
        const btn = document.getElementById('btnSalvarInventarioGuiado');
        if (btn) { btn.disabled = true; btn.textContent = 'Salvando inventário...'; }
        try {
            const salvos = await salvarInventarioGuiado(ajustes);
            closeModal('modalInventarioGuiado');
            showToast(`🎉 Inventário concluído! ${salvos} produto${salvos > 1 ? 's' : ''} atualizado${salvos > 1 ? 's' : ''}.`, 'success');
            await refreshStock();
        } catch (error) { showToast('Erro ao salvar inventário: ' + error.message, 'error'); }
        finally { if (btn) { btn.disabled = false; btn.textContent = 'Concluir Inventário 🎉'; } }
    });

    document.getElementById('formMovimentoEstoque')?.addEventListener('change', event => {
        if (event.target.name === 'tipo' || event.target.name === 'produto_id') updateMovementForm(event.currentTarget);
    });
    document.getElementById('formMovimentoEstoque')?.addEventListener('submit', async event => {
        event.preventDefault();
        try {
            await registrarMovimento(event.target);
            closeModal('modalMovimentoEstoque');
            showToast('Movimentação registrada com sucesso.', 'success');
            await refreshStock();
        } catch (error) { showToast(error.message, 'error'); }
    });

    document.getElementById('formTransferenciaEstoque')?.addEventListener('change', event => {
        if (event.target.name === 'acerto_financeiro') {
            document.getElementById('transferenciaAcertoFields')?.classList.toggle('hidden', event.target.value === 'sem_acerto');
        }
        if (event.target.name === 'produto_id') {
            const selected = state.produtos.find(p => p.id === event.target.value);
            if (selected) event.currentTarget.elements.valor_unitario.value = selected.custo_unitario || 0;
        }
    });
    document.getElementById('formTransferenciaEstoque')?.addEventListener('submit', async event => {
        event.preventDefault();
        try {
            const result = await transferirProduto(event.target);
            closeModal('modalTransferenciaEstoque');
            showToast(result?.ficha_copiada ? 'Ficha copiada e saldo transferido.' : 'Saldo transferido com sucesso.', 'success');
            await refreshStock();
        } catch (error) { showToast(error.message, 'error'); }
    });

    document.getElementById('estoqueProdutosGrid')?.addEventListener('click', async event => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const produto = state.produtos.find(p => p.id === button.dataset.id);
        if (button.dataset.action === 'editar') openProductModal(produto);
        if (button.dataset.action === 'movimentar') openMovementModal(button.dataset.id, 'entrada');
        if (button.dataset.action === 'razao') {
            try { await openLedger(button.dataset.id); } catch (error) { showToast(error.message, 'error'); }
        }
        if (button.dataset.action === 'excluir') {
            if (confirm(`Tem certeza que deseja excluir o produto "${produto?.nome || ''}"?`)) {
                try {
                    await deleteProduto(button.dataset.id);
                    showToast('Produto excluído com sucesso.', 'success');
                    await refreshStock();
                } catch (error) {
                    showToast(error.message, 'error');
                }
            }
        }
    });
}

function ensureServiceProductsModal() {
    let modal = document.getElementById('modalProdutosServico');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'modalProdutosServico';
    modal.className = 'fixed inset-0 z-[70] hidden items-end sm:items-center justify-center bg-slate-950/75 backdrop-blur-sm p-0 sm:p-4';
    modal.innerHTML = `
        <div class="w-full max-w-2xl max-h-[92vh] overflow-y-auto bg-white dark:bg-slate-900 rounded-t-[2rem] sm:rounded-[2rem] border border-slate-200 dark:border-slate-800 shadow-2xl">
            <div class="sticky top-0 z-10 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl p-5 border-b border-slate-100 dark:border-slate-800 flex items-start justify-between">
                <div><span class="text-[10px] font-black uppercase tracking-widest text-blue-500">Estoque do profissional</span><h3 id="produtosServicoTitle" class="font-extrabold text-lg">Produtos do serviço</h3><p class="text-xs text-slate-500">Consumos baixam ao atender; ferramentas apenas comprovam disponibilidade.</p></div>
                <button type="button" data-close-products-service class="h-9 w-9 rounded-xl bg-slate-100 dark:bg-slate-800"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <form id="formProdutosServico" class="p-5 space-y-4">
                <input type="hidden" name="servico_id">
                <div class="rounded-2xl bg-blue-500/10 border border-blue-500/20 p-3 text-xs text-blue-700 dark:text-blue-300"><strong>Custo e preço são separados.</strong> O produto fica incluído no serviço, a menos que você marque “Cobrar à parte”.</div>
                <div id="produtosServicoList" class="space-y-2"></div>
                <div class="flex justify-end gap-2 pt-3"><button type="button" data-close-products-service class="px-5 py-3 rounded-2xl bg-slate-100 dark:bg-slate-800 text-xs font-bold">Cancelar</button><button type="submit" class="px-5 py-3 rounded-2xl bg-blue-600 text-white text-xs font-black">Salvar produtos</button></div>
            </form>
        </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll('[data-close-products-service]').forEach(btn => btn.addEventListener('click', () => { modal.classList.add('hidden'); modal.classList.remove('flex'); }));
    return modal;
}

export async function openServiceProductsDialog(servico) {
    const modal = ensureServiceProductsModal();
    const prof = await activeProfessional();
    const [{ data: products, error: productError }, { data: links, error: linkError }] = await Promise.all([
        supabase.from('estoque_produtos').select('*').eq('profissional_id', prof.id).eq('ativo', true).order('nome'),
        supabase.from('servico_produtos').select('*').eq('profissional_id', prof.id).eq('servico_id', servico.id)
    ]);
    if (productError) {
        if (isMissingSchema(productError)) showSetupRequired();
        throw productError;
    }
    if (linkError) throw linkError;
    const linked = new Map((links || []).map(link => [link.produto_id, link]));
    modal.querySelector('#produtosServicoTitle').textContent = `Produtos · ${servico.nome}`;
    modal.querySelector('[name="servico_id"]').value = servico.id;
    const list = modal.querySelector('#produtosServicoList');
    list.innerHTML = (products || []).length ? products.map(product => {
        const link = linked.get(product.id);
        return `<div class="service-product-row p-3 rounded-2xl border ${link ? 'border-blue-500/30 bg-blue-500/5' : 'border-slate-200 dark:border-slate-800'}" data-product-id="${product.id}">
            <div class="flex items-center gap-3">
                <input type="checkbox" name="selected" value="${product.id}" ${link ? 'checked' : ''} class="h-5 w-5 accent-blue-600">
                ${productPhoto(product, 'h-10 w-10')}
                <div class="min-w-0 flex-1"><strong class="block text-xs truncate">${escapeHtml(product.nome)}</strong><span class="text-[10px] ${product.tipo === 'ferramenta' ? 'text-sky-500' : 'text-amber-500'}">${product.tipo === 'ferramenta' ? 'Ferramenta · sem baixa por uso' : 'Consumo · baixa ao atender'} · saldo ${number.format(product.saldo_atual)} ${escapeHtml(product.unidade)}</span></div>
                <label class="text-[10px] font-bold text-slate-500">Qtd.<input name="quantidade" type="number" min="0.001" step="0.001" value="${link?.quantidade ?? 1}" class="block mt-1 w-20 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2 py-2 text-xs"></label>
            </div>
            <div class="mt-3 pl-8 flex flex-wrap items-center gap-3">
                <label class="flex items-center gap-2 text-[10px] font-bold text-slate-600 dark:text-slate-300"><input name="cobrar" type="checkbox" ${link?.cobrar_separado ? 'checked' : ''} class="h-4 w-4 accent-blue-600"> Cobrar à parte do cliente</label>
                <label class="price-field ${link?.cobrar_separado ? '' : 'hidden'} text-[10px] font-bold text-slate-500">Preço unitário R$ <input name="preco" type="number" min="0" step="0.01" value="${link?.preco_unitario_cliente ?? 0}" class="ml-1 w-24 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2 py-2 text-xs"></label>
            </div>
        </div>`;
    }).join('') : '<div class="py-8 text-center text-xs text-slate-400">Cadastre produtos no Controle de estoque antes de vinculá-los.<br><a href="./estoque.html" class="text-blue-500 font-bold">Abrir estoque</a></div>';

    list.querySelectorAll('[name="cobrar"]').forEach(input => input.addEventListener('change', () => input.closest('.service-product-row').querySelector('.price-field').classList.toggle('hidden', !input.checked)));
    const form = modal.querySelector('#formProdutosServico');
    form.onsubmit = async event => {
        event.preventDefault();
        const rows = [...list.querySelectorAll('.service-product-row')];
        const payload = rows.filter(row => row.querySelector('[name="selected"]').checked).map(row => ({
            servico_id: servico.id,
            profissional_id: prof.id,
            produto_id: row.dataset.productId,
            quantidade: Number(row.querySelector('[name="quantidade"]').value || 1),
            cobrar_separado: row.querySelector('[name="cobrar"]').checked,
            preco_unitario_cliente: Number(row.querySelector('[name="preco"]').value || 0)
        }));
        const itens = payload.map(({ produto_id, quantidade, cobrar_separado, preco_unitario_cliente }) => ({
            produto_id, quantidade, cobrar_separado, preco_unitario_cliente
        }));
        // Tenta via RPC, fallback para operações diretas
        const { error: saveError } = await supabase.rpc('salvar_produtos_servico', { p_servico_id: servico.id, p_itens: itens });
        if (saveError) {
            console.warn('RPC salvar_produtos_servico indisponível, fallback JS:', saveError);
            try {
                await supabase.from('servico_produtos').delete().eq('servico_id', servico.id).eq('profissional_id', prof.id);
                if (payload.length > 0) {
                    const { error: insErr } = await supabase.from('servico_produtos').insert(payload);
                    if (insErr) throw insErr;
                }
            } catch (fbErr) { showToast('Erro ao salvar produtos: ' + fbErr.message, 'error'); return; }
        }
        modal.classList.add('hidden'); modal.classList.remove('flex');
        showToast('Produtos do serviço atualizados!', 'success');
    };
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}
