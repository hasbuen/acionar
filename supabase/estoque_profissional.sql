-- ============================================================================
-- ACIONAR · ESTOQUE INDIVIDUAL POR PROFISSIONAL
-- Execute no SQL Editor do Supabase/Lovable.
-- Idempotente: pode ser executado novamente com segurança.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Resolve o profissional da sessão sem confiar em IDs enviados pelo navegador.
CREATE OR REPLACE FUNCTION public.profissional_logado_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT p.id
      FROM public.profissionais p
     WHERE lower(p.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
       AND p.ativo = true
     LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.profissional_logado_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profissional_logado_id() TO authenticated, service_role;

-- Cada linha representa a ficha e o saldo de UM profissional.
-- catalogo_chave identifica cópias da mesma ficha entre profissionais.
CREATE TABLE IF NOT EXISTS public.estoque_produtos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profissional_id uuid NOT NULL REFERENCES public.profissionais(id) ON DELETE CASCADE,
    catalogo_chave uuid NOT NULL DEFAULT gen_random_uuid(),
    produto_origem_id uuid REFERENCES public.estoque_produtos(id) ON DELETE SET NULL,
    tipo varchar(20) NOT NULL DEFAULT 'consumo'
        CHECK (tipo IN ('consumo', 'ferramenta')),
    nome varchar(160) NOT NULL,
    codigo varchar(60),
    categoria varchar(80),
    unidade varchar(20) NOT NULL DEFAULT 'un',
    saldo_atual numeric(14,3) NOT NULL DEFAULT 0 CHECK (saldo_atual >= 0),
    estoque_minimo numeric(14,3) NOT NULL DEFAULT 0 CHECK (estoque_minimo >= 0),
    custo_unitario numeric(14,2) NOT NULL DEFAULT 0 CHECK (custo_unitario >= 0),
    localizacao varchar(120),
    imagem_url text,
    ativo boolean NOT NULL DEFAULT true,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    UNIQUE (profissional_id, catalogo_chave)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_estoque_produto_codigo_profissional
    ON public.estoque_produtos (profissional_id, lower(codigo))
    WHERE codigo IS NOT NULL AND btrim(codigo) <> '' AND ativo = true;
CREATE INDEX IF NOT EXISTS idx_estoque_produtos_profissional
    ON public.estoque_produtos (profissional_id, ativo, nome);

CREATE TABLE IF NOT EXISTS public.estoque_transferencias (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profissional_origem_id uuid NOT NULL REFERENCES public.profissionais(id) ON DELETE RESTRICT,
    profissional_destino_id uuid NOT NULL REFERENCES public.profissionais(id) ON DELETE RESTRICT,
    produto_origem_id uuid NOT NULL REFERENCES public.estoque_produtos(id) ON DELETE RESTRICT,
    produto_destino_id uuid NOT NULL REFERENCES public.estoque_produtos(id) ON DELETE RESTRICT,
    quantidade numeric(14,3) NOT NULL CHECK (quantidade > 0),
    acerto_financeiro varchar(20) NOT NULL DEFAULT 'sem_acerto'
        CHECK (acerto_financeiro IN ('sem_acerto', 'imediato', 'pendente')),
    valor_unitario numeric(14,2) NOT NULL DEFAULT 0 CHECK (valor_unitario >= 0),
    observacoes text,
    criado_em timestamptz NOT NULL DEFAULT now(),
    CHECK (profissional_origem_id <> profissional_destino_id)
);

CREATE INDEX IF NOT EXISTS idx_estoque_transferencias_origem
    ON public.estoque_transferencias (profissional_origem_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_estoque_transferencias_destino
    ON public.estoque_transferencias (profissional_destino_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS public.estoque_movimentacoes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profissional_id uuid NOT NULL REFERENCES public.profissionais(id) ON DELETE CASCADE,
    produto_id uuid NOT NULL REFERENCES public.estoque_produtos(id) ON DELETE RESTRICT,
    tipo varchar(30) NOT NULL CHECK (tipo IN (
        'entrada', 'saida', 'inventario', 'transferencia_entrada',
        'transferencia_saida', 'consumo_servico'
    )),
    quantidade numeric(14,3) NOT NULL CHECK (quantidade <> 0),
    saldo_anterior numeric(14,3) NOT NULL,
    saldo_posterior numeric(14,3) NOT NULL CHECK (saldo_posterior >= 0),
    motivo varchar(180) NOT NULL,
    referencia varchar(100),
    transferencia_id uuid REFERENCES public.estoque_transferencias(id) ON DELETE SET NULL,
    agendamento_id uuid REFERENCES public.agendamentos(id) ON DELETE SET NULL,
    profissional_contraparte_id uuid REFERENCES public.profissionais(id) ON DELETE SET NULL,
    criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_estoque_movimentos_produto
    ON public.estoque_movimentacoes (produto_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_estoque_movimentos_profissional
    ON public.estoque_movimentacoes (profissional_id, criado_em DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_estoque_consumo_agendamento_produto
    ON public.estoque_movimentacoes (agendamento_id, produto_id)
    WHERE tipo = 'consumo_servico' AND agendamento_id IS NOT NULL;

-- Produtos necessários por serviço são parametrizados por profissional.
CREATE TABLE IF NOT EXISTS public.servico_produtos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    servico_id uuid NOT NULL REFERENCES public.servicos(id) ON DELETE CASCADE,
    profissional_id uuid NOT NULL REFERENCES public.profissionais(id) ON DELETE CASCADE,
    produto_id uuid NOT NULL REFERENCES public.estoque_produtos(id) ON DELETE CASCADE,
    quantidade numeric(14,3) NOT NULL DEFAULT 1 CHECK (quantidade > 0),
    cobrar_separado boolean NOT NULL DEFAULT false,
    preco_unitario_cliente numeric(14,2) NOT NULL DEFAULT 0
        CHECK (preco_unitario_cliente >= 0),
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    UNIQUE (servico_id, profissional_id, produto_id)
);

CREATE INDEX IF NOT EXISTS idx_servico_produtos_profissional_servico
    ON public.servico_produtos (profissional_id, servico_id);

-- Esta tabela é a trava de idempotência: um atendimento só pode baixar uma vez.
CREATE TABLE IF NOT EXISTS public.estoque_baixas_agendamento (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agendamento_id uuid NOT NULL UNIQUE REFERENCES public.agendamentos(id) ON DELETE RESTRICT,
    profissional_id uuid NOT NULL REFERENCES public.profissionais(id) ON DELETE RESTRICT,
    valor_servico numeric(14,2) NOT NULL DEFAULT 0,
    valor_adicionais numeric(14,2) NOT NULL DEFAULT 0,
    valor_total_cliente numeric(14,2) NOT NULL DEFAULT 0,
    processado_em timestamptz NOT NULL DEFAULT now()
);

-- Garante uma estrutura mínima de caixa compatível com o frontend existente.
CREATE TABLE IF NOT EXISTS public.fluxo_caixa (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agendamento_id uuid REFERENCES public.agendamentos(id) ON DELETE SET NULL,
    cliente_id uuid REFERENCES public.clientes(id) ON DELETE SET NULL,
    servico_id uuid REFERENCES public.servicos(id) ON DELETE SET NULL,
    profissional_id uuid REFERENCES public.profissionais(id) ON DELETE SET NULL,
    valor_bruto numeric(14,2) NOT NULL DEFAULT 0,
    desconto numeric(14,2) NOT NULL DEFAULT 0,
    valor_final numeric(14,2) NOT NULL DEFAULT 0,
    condicao_pagamento varchar(30) DEFAULT 'a_vista',
    forma_pagamento varchar(30) DEFAULT 'pix',
    status_pagamento varchar(30) DEFAULT 'a_receber',
    data_pagamento timestamptz,
    data_vencimento timestamptz,
    observacoes text,
    criado_em timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.fluxo_caixa ADD COLUMN IF NOT EXISTS tipo_movimento varchar(10) NOT NULL DEFAULT 'entrada';
ALTER TABLE public.fluxo_caixa ADD COLUMN IF NOT EXISTS categoria varchar(40) NOT NULL DEFAULT 'servico';
ALTER TABLE public.fluxo_caixa ADD COLUMN IF NOT EXISTS estoque_produto_id uuid REFERENCES public.estoque_produtos(id) ON DELETE SET NULL;
ALTER TABLE public.fluxo_caixa ADD COLUMN IF NOT EXISTS transferencia_id uuid REFERENCES public.estoque_transferencias(id) ON DELETE SET NULL;
ALTER TABLE public.fluxo_caixa ADD COLUMN IF NOT EXISTS profissional_contraparte_id uuid REFERENCES public.profissionais(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fluxo_caixa_tipo_movimento_check'
          AND conrelid = 'public.fluxo_caixa'::regclass
    ) THEN
        ALTER TABLE public.fluxo_caixa
            ADD CONSTRAINT fluxo_caixa_tipo_movimento_check
            CHECK (tipo_movimento IN ('entrada', 'saida'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fluxo_caixa_profissional_data
    ON public.fluxo_caixa (profissional_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_fluxo_caixa_agendamento
    ON public.fluxo_caixa (agendamento_id)
    WHERE agendamento_id IS NOT NULL AND categoria = 'servico';

CREATE OR REPLACE FUNCTION public.estoque_set_atualizado_em()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    NEW.atualizado_em = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_estoque_produtos_atualizado ON public.estoque_produtos;
CREATE TRIGGER trg_estoque_produtos_atualizado
BEFORE UPDATE ON public.estoque_produtos
FOR EACH ROW EXECUTE FUNCTION public.estoque_set_atualizado_em();

DROP TRIGGER IF EXISTS trg_servico_produtos_atualizado ON public.servico_produtos;
CREATE TRIGGER trg_servico_produtos_atualizado
BEFORE UPDATE ON public.servico_produtos
FOR EACH ROW EXECUTE FUNCTION public.estoque_set_atualizado_em();

-- Entrada, saída ou inventário manual. Opcionalmente lança a compra no caixa.
CREATE OR REPLACE FUNCTION public.registrar_movimento_estoque(
    p_produto_id uuid,
    p_tipo varchar,
    p_quantidade numeric DEFAULT NULL,
    p_novo_saldo numeric DEFAULT NULL,
    p_motivo varchar DEFAULT NULL,
    p_referencia varchar DEFAULT NULL,
    p_gerar_caixa boolean DEFAULT false,
    p_valor_unitario numeric DEFAULT NULL,
    p_status_pagamento varchar DEFAULT 'pago'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_prod public.estoque_produtos%ROWTYPE;
    v_delta numeric(14,3);
    v_novo numeric(14,3);
    v_mov_id uuid;
    v_prof_logado uuid := public.profissional_logado_id();
    v_cargo text;
BEGIN
    SELECT * INTO v_prod FROM public.estoque_produtos WHERE id = p_produto_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Produto não encontrado'; END IF;

    SELECT cargo INTO v_cargo FROM public.profissionais WHERE id = v_prof_logado;
    IF v_prof_logado IS NULL OR (v_prod.profissional_id <> v_prof_logado AND v_cargo <> 'proprietario') THEN
        RAISE EXCEPTION 'Você não pode movimentar o estoque deste profissional';
    END IF;

    IF p_tipo = 'inventario' THEN
        IF p_novo_saldo IS NULL OR p_novo_saldo < 0 THEN RAISE EXCEPTION 'Saldo contado inválido'; END IF;
        v_novo := p_novo_saldo;
        v_delta := v_novo - v_prod.saldo_atual;
    ELSIF p_tipo = 'entrada' THEN
        IF coalesce(p_quantidade, 0) <= 0 THEN RAISE EXCEPTION 'Quantidade inválida'; END IF;
        v_delta := p_quantidade;
        v_novo := v_prod.saldo_atual + v_delta;
    ELSIF p_tipo = 'saida' THEN
        IF coalesce(p_quantidade, 0) <= 0 THEN RAISE EXCEPTION 'Quantidade inválida'; END IF;
        v_delta := -p_quantidade;
        v_novo := v_prod.saldo_atual + v_delta;
    ELSE
        RAISE EXCEPTION 'Tipo de movimento inválido';
    END IF;

    IF v_novo < 0 THEN RAISE EXCEPTION 'Saldo insuficiente'; END IF;
    IF v_delta = 0 THEN RAISE EXCEPTION 'A contagem não alterou o saldo'; END IF;

    UPDATE public.estoque_produtos SET saldo_atual = v_novo WHERE id = v_prod.id;
    INSERT INTO public.estoque_movimentacoes
        (profissional_id, produto_id, tipo, quantidade, saldo_anterior, saldo_posterior, motivo, referencia)
    VALUES
        (v_prod.profissional_id, v_prod.id, p_tipo, v_delta, v_prod.saldo_atual, v_novo,
         coalesce(nullif(btrim(p_motivo), ''), CASE WHEN p_tipo = 'inventario' THEN 'Contagem de inventário' ELSE 'Movimento manual' END),
         nullif(btrim(p_referencia), ''))
    RETURNING id INTO v_mov_id;

    IF p_gerar_caixa AND p_tipo = 'entrada' THEN
        INSERT INTO public.fluxo_caixa
            (profissional_id, tipo_movimento, categoria, estoque_produto_id,
             valor_bruto, valor_final, status_pagamento, data_pagamento,
             data_vencimento, observacoes)
        VALUES
            (v_prod.profissional_id, 'saida', 'compra_material', v_prod.id,
             p_quantidade * coalesce(p_valor_unitario, v_prod.custo_unitario),
             p_quantidade * coalesce(p_valor_unitario, v_prod.custo_unitario),
             coalesce(p_status_pagamento, 'pago'),
             CASE WHEN coalesce(p_status_pagamento, 'pago') = 'pago' THEN now() END,
             now(), concat('Compra de material · ', v_prod.nome,
             CASE WHEN p_referencia IS NOT NULL THEN ' · ' || p_referencia ELSE '' END));
    END IF;

    RETURN jsonb_build_object('movimentacao_id', v_mov_id, 'saldo_anterior', v_prod.saldo_atual, 'saldo_atual', v_novo);
END;
$$;

-- Substitui os vínculos de um serviço em uma única transação. O cadastro de
-- produtos continua independente e nenhum vínculo é criado automaticamente.
CREATE OR REPLACE FUNCTION public.salvar_produtos_servico(
    p_servico_id uuid,
    p_itens jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_prof uuid := public.profissional_logado_id();
    v_total integer := 0;
BEGIN
    IF v_prof IS NULL THEN RAISE EXCEPTION 'Profissional da sessão não identificado'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servicos WHERE id = p_servico_id) THEN
        RAISE EXCEPTION 'Serviço não encontrado';
    END IF;
    IF jsonb_typeof(coalesce(p_itens, '[]'::jsonb)) <> 'array' THEN
        RAISE EXCEPTION 'Lista de produtos inválida';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) item
          LEFT JOIN public.estoque_produtos p
            ON p.id = (item ->> 'produto_id')::uuid
           AND p.profissional_id = v_prof
           AND p.ativo = true
         WHERE p.id IS NULL
    ) THEN
        RAISE EXCEPTION 'Um dos produtos não pertence ao profissional da sessão';
    END IF;

    DELETE FROM public.servico_produtos
     WHERE servico_id = p_servico_id AND profissional_id = v_prof;

    INSERT INTO public.servico_produtos
        (servico_id, profissional_id, produto_id, quantidade,
         cobrar_separado, preco_unitario_cliente)
    SELECT p_servico_id,
           v_prof,
           (item ->> 'produto_id')::uuid,
           (item ->> 'quantidade')::numeric,
           coalesce((item ->> 'cobrar_separado')::boolean, false),
           coalesce((item ->> 'preco_unitario_cliente')::numeric, 0)
      FROM jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) item;

    GET DIAGNOSTICS v_total = ROW_COUNT;
    RETURN jsonb_build_object('salvos', v_total);
END;
$$;

-- Copia a ficha se necessário e transfere somente o saldo.
CREATE OR REPLACE FUNCTION public.transferir_estoque(
    p_produto_origem_id uuid,
    p_profissional_destino_id uuid,
    p_quantidade numeric,
    p_acerto_financeiro varchar DEFAULT 'sem_acerto',
    p_valor_unitario numeric DEFAULT 0,
    p_observacoes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_origem public.estoque_produtos%ROWTYPE;
    v_destino public.estoque_produtos%ROWTYPE;
    v_transferencia_id uuid := gen_random_uuid();
    v_prof_logado uuid := public.profissional_logado_id();
    v_cargo text;
    v_status varchar(30);
    v_ficha_copiada boolean := false;
BEGIN
    IF coalesce(p_quantidade, 0) <= 0 THEN RAISE EXCEPTION 'Quantidade inválida'; END IF;
    IF p_acerto_financeiro NOT IN ('sem_acerto', 'imediato', 'pendente') THEN RAISE EXCEPTION 'Acerto financeiro inválido'; END IF;

    SELECT * INTO v_origem FROM public.estoque_produtos WHERE id = p_produto_origem_id FOR UPDATE;
    IF NOT FOUND OR NOT v_origem.ativo THEN RAISE EXCEPTION 'Produto de origem não encontrado'; END IF;
    SELECT cargo INTO v_cargo FROM public.profissionais WHERE id = v_prof_logado;
    IF v_prof_logado IS NULL OR (v_origem.profissional_id <> v_prof_logado AND v_cargo <> 'proprietario') THEN
        RAISE EXCEPTION 'Você não pode transferir este produto';
    END IF;
    IF v_origem.profissional_id = p_profissional_destino_id THEN RAISE EXCEPTION 'Escolha outro profissional'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profissionais WHERE id = p_profissional_destino_id AND ativo = true) THEN
        RAISE EXCEPTION 'Profissional de destino inválido';
    END IF;
    IF v_origem.saldo_atual < p_quantidade THEN RAISE EXCEPTION 'Saldo insuficiente para a transferência'; END IF;

    SELECT * INTO v_destino
      FROM public.estoque_produtos
     WHERE profissional_id = p_profissional_destino_id
       AND catalogo_chave = v_origem.catalogo_chave
     FOR UPDATE;

    -- Um código já existente no destino também identifica a mesma ficha e evita
    -- colisão com o índice de código do profissional.
    IF NOT FOUND AND nullif(btrim(v_origem.codigo), '') IS NOT NULL THEN
        SELECT * INTO v_destino
          FROM public.estoque_produtos
         WHERE profissional_id = p_profissional_destino_id
           AND ativo = true
           AND lower(codigo) = lower(v_origem.codigo)
         LIMIT 1
         FOR UPDATE;
    END IF;

    IF NOT FOUND THEN
        INSERT INTO public.estoque_produtos
            (profissional_id, catalogo_chave, produto_origem_id, tipo, nome, codigo,
             categoria, unidade, saldo_atual, estoque_minimo, custo_unitario,
             localizacao, imagem_url, ativo)
        VALUES
            (p_profissional_destino_id, v_origem.catalogo_chave, v_origem.id,
             v_origem.tipo, v_origem.nome, v_origem.codigo, v_origem.categoria,
             v_origem.unidade, 0, v_origem.estoque_minimo, v_origem.custo_unitario,
             NULL, v_origem.imagem_url, true)
        RETURNING * INTO v_destino;
        v_ficha_copiada := true;
    END IF;

    UPDATE public.estoque_produtos SET saldo_atual = saldo_atual - p_quantidade WHERE id = v_origem.id;
    UPDATE public.estoque_produtos SET saldo_atual = saldo_atual + p_quantidade WHERE id = v_destino.id;

    INSERT INTO public.estoque_transferencias
        (id, profissional_origem_id, profissional_destino_id, produto_origem_id,
         produto_destino_id, quantidade, acerto_financeiro, valor_unitario, observacoes)
    VALUES
        (v_transferencia_id, v_origem.profissional_id, p_profissional_destino_id,
         v_origem.id, v_destino.id, p_quantidade, p_acerto_financeiro,
         coalesce(p_valor_unitario, 0), p_observacoes);

    INSERT INTO public.estoque_movimentacoes
        (profissional_id, produto_id, tipo, quantidade, saldo_anterior, saldo_posterior,
         motivo, referencia, transferencia_id, profissional_contraparte_id)
    VALUES
        (v_origem.profissional_id, v_origem.id, 'transferencia_saida', -p_quantidade,
         v_origem.saldo_atual, v_origem.saldo_atual - p_quantidade, 'Enviado para outro profissional',
         'TRF-' || right(v_transferencia_id::text, 8), v_transferencia_id, p_profissional_destino_id),
        (p_profissional_destino_id, v_destino.id, 'transferencia_entrada', p_quantidade,
         v_destino.saldo_atual, v_destino.saldo_atual + p_quantidade, 'Recebido de outro profissional',
         'TRF-' || right(v_transferencia_id::text, 8), v_transferencia_id, v_origem.profissional_id);

    IF p_acerto_financeiro <> 'sem_acerto' AND coalesce(p_valor_unitario, 0) > 0 THEN
        v_status := CASE WHEN p_acerto_financeiro = 'imediato' THEN 'pago' ELSE 'a_receber' END;
        INSERT INTO public.fluxo_caixa
            (profissional_id, profissional_contraparte_id, tipo_movimento, categoria,
             estoque_produto_id, transferencia_id, valor_bruto, valor_final,
             status_pagamento, data_pagamento, data_vencimento, observacoes)
        VALUES
            (v_origem.profissional_id, p_profissional_destino_id, 'entrada', 'acerto_estoque',
             v_origem.id, v_transferencia_id, p_quantidade * p_valor_unitario,
             p_quantidade * p_valor_unitario, v_status,
             CASE WHEN v_status = 'pago' THEN now() END, now(), 'Material enviado · ' || v_origem.nome),
            (p_profissional_destino_id, v_origem.profissional_id, 'saida', 'acerto_estoque',
             v_destino.id, v_transferencia_id, p_quantidade * p_valor_unitario,
             p_quantidade * p_valor_unitario, v_status,
             CASE WHEN v_status = 'pago' THEN now() END, now(), 'Material recebido · ' || v_origem.nome);
    END IF;

    RETURN jsonb_build_object(
        'transferencia_id', v_transferencia_id,
        'produto_destino_id', v_destino.id,
        'ficha_copiada', v_ficha_copiada,
        'saldo_origem', v_origem.saldo_atual - p_quantidade,
        'saldo_destino', v_destino.saldo_atual + p_quantidade
    );
END;
$$;

-- Núcleo chamado pelo trigger. Ferramentas são validadas, mas não consumidas.
CREATE OR REPLACE FUNCTION public.processar_baixa_estoque_agendamento(p_agendamento_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_ag public.agendamentos%ROWTYPE;
    v_item record;
    v_valor_servico numeric(14,2) := 0;
    v_adicionais numeric(14,2) := 0;
    v_total numeric(14,2) := 0;
    v_caixa_atualizado integer := 0;
BEGIN
    IF EXISTS (SELECT 1 FROM public.estoque_baixas_agendamento WHERE agendamento_id = p_agendamento_id) THEN
        SELECT valor_total_cliente INTO v_total FROM public.estoque_baixas_agendamento WHERE agendamento_id = p_agendamento_id;
        RETURN jsonb_build_object('processado', false, 'ja_processado', true, 'valor_total_cliente', v_total);
    END IF;

    SELECT * INTO v_ag FROM public.agendamentos WHERE id = p_agendamento_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Agendamento não encontrado'; END IF;
    IF v_ag.profissional_id IS NULL THEN RAISE EXCEPTION 'Defina o profissional antes de concluir o atendimento'; END IF;

    -- Bloqueia e valida todos os produtos necessários antes de alterar qualquer saldo.
    FOR v_item IN
        SELECT sp.*, p.nome AS produto_nome, p.tipo AS produto_tipo,
               p.saldo_atual, p.unidade
          FROM public.servico_produtos sp
          JOIN public.estoque_produtos p ON p.id = sp.produto_id
         WHERE sp.servico_id = v_ag.servico_id
           AND sp.profissional_id = v_ag.profissional_id
         ORDER BY p.id
         FOR UPDATE OF p
    LOOP
        IF v_item.saldo_atual < v_item.quantidade THEN
            RAISE EXCEPTION 'Estoque insuficiente de %: disponível % %, necessário % %',
                v_item.produto_nome, v_item.saldo_atual, v_item.unidade,
                v_item.quantidade, v_item.unidade;
        END IF;
    END LOOP;

    SELECT coalesce(tp.valor, 0) INTO v_valor_servico
      FROM public.tabela_precos tp
     WHERE tp.servico_id = v_ag.servico_id
       AND tp.data_vigencia_inicio <= current_date
       AND (tp.data_vigencia_fim IS NULL OR tp.data_vigencia_fim >= current_date)
     ORDER BY tp.data_vigencia_inicio DESC, tp.criado_em DESC
     LIMIT 1;

    SELECT coalesce(sum(sp.quantidade * sp.preco_unitario_cliente) FILTER (WHERE sp.cobrar_separado), 0)
      INTO v_adicionais
      FROM public.servico_produtos sp
     WHERE sp.servico_id = v_ag.servico_id
       AND sp.profissional_id = v_ag.profissional_id;
    v_total := coalesce(v_valor_servico, 0) + coalesce(v_adicionais, 0);

    FOR v_item IN
        SELECT sp.*, p.nome AS produto_nome, p.tipo AS produto_tipo,
               p.saldo_atual, p.unidade
          FROM public.servico_produtos sp
          JOIN public.estoque_produtos p ON p.id = sp.produto_id
         WHERE sp.servico_id = v_ag.servico_id
           AND sp.profissional_id = v_ag.profissional_id
    LOOP
        IF v_item.produto_tipo = 'consumo' THEN
            UPDATE public.estoque_produtos
               SET saldo_atual = saldo_atual - v_item.quantidade
             WHERE id = v_item.produto_id;

            INSERT INTO public.estoque_movimentacoes
                (profissional_id, produto_id, tipo, quantidade, saldo_anterior,
                 saldo_posterior, motivo, referencia, agendamento_id)
            VALUES
                (v_ag.profissional_id, v_item.produto_id, 'consumo_servico',
                 -v_item.quantidade, v_item.saldo_atual,
                 v_item.saldo_atual - v_item.quantidade,
                 'Consumo no atendimento', 'AG-' || right(v_ag.id::text, 8), v_ag.id);
        END IF;
    END LOOP;

    INSERT INTO public.estoque_baixas_agendamento
        (agendamento_id, profissional_id, valor_servico, valor_adicionais, valor_total_cliente)
    VALUES
        (v_ag.id, v_ag.profissional_id, coalesce(v_valor_servico, 0), coalesce(v_adicionais, 0), v_total);

    -- Se o caixa já tiver sido parametrizado antes do atendimento, reaproveita a
    -- linha existente. Isso mantém forma, condição, desconto e status escolhidos.
    UPDATE public.fluxo_caixa
       SET tipo_movimento = 'entrada',
           categoria = 'servico',
           valor_bruto = v_total,
           valor_final = greatest(v_total - coalesce(desconto, 0), 0),
           observacoes = CASE WHEN v_adicionais > 0
               THEN 'Serviço com produtos cobrados à parte'
               ELSE coalesce(observacoes, 'Valor do serviço') END
     WHERE agendamento_id = v_ag.id;
    GET DIAGNOSTICS v_caixa_atualizado = ROW_COUNT;

    IF v_caixa_atualizado = 0 THEN
        INSERT INTO public.fluxo_caixa
        (agendamento_id, cliente_id, servico_id, profissional_id, tipo_movimento,
         categoria, valor_bruto, desconto, valor_final, condicao_pagamento,
         forma_pagamento, status_pagamento, data_vencimento, observacoes)
        VALUES
        (v_ag.id, v_ag.cliente_id, v_ag.servico_id, v_ag.profissional_id,
         'entrada', 'servico', v_total, 0, v_total, 'a_vista', 'pix',
         'a_receber', v_ag.data_hora_inicio,
         CASE WHEN v_adicionais > 0 THEN 'Serviço com produtos cobrados à parte' ELSE 'Valor do serviço' END);
    END IF;

    RETURN jsonb_build_object('processado', true, 'ja_processado', false,
        'valor_servico', v_valor_servico, 'valor_adicionais', v_adicionais,
        'valor_total_cliente', v_total);
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_baixar_estoque_ao_atender()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF lower(coalesce(NEW.status, '')) IN ('atendido', 'concluido', 'finalizado')
       AND lower(coalesce(OLD.status, '')) NOT IN ('atendido', 'concluido', 'finalizado') THEN
        PERFORM public.processar_baixa_estoque_agendamento(NEW.id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agendamento_baixa_estoque ON public.agendamentos;
CREATE TRIGGER trg_agendamento_baixa_estoque
AFTER UPDATE OF status ON public.agendamentos
FOR EACH ROW EXECUTE FUNCTION public.trg_baixar_estoque_ao_atender();

CREATE OR REPLACE FUNCTION public.finalizar_atendimento_com_estoque(
    p_agendamento_id uuid,
    p_novo_status varchar DEFAULT 'atendido'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_prof uuid;
    v_logado uuid := public.profissional_logado_id();
    v_cargo text;
    v_result jsonb;
BEGIN
    IF lower(coalesce(p_novo_status, '')) NOT IN ('atendido', 'concluido', 'finalizado') THEN
        RAISE EXCEPTION 'Status final inválido';
    END IF;
    SELECT profissional_id INTO v_prof FROM public.agendamentos WHERE id = p_agendamento_id;
    SELECT cargo INTO v_cargo FROM public.profissionais WHERE id = v_logado;
    IF v_logado IS NULL OR (v_prof IS DISTINCT FROM v_logado AND v_cargo <> 'proprietario') THEN
        RAISE EXCEPTION 'Você não pode concluir este atendimento';
    END IF;

    UPDATE public.agendamentos SET status = lower(p_novo_status), atualizado_em = now()
     WHERE id = p_agendamento_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Agendamento não encontrado'; END IF;

    SELECT jsonb_build_object(
        'processado', true,
        'ja_processado', true,
        'valor_servico', valor_servico,
        'valor_adicionais', valor_adicionais,
        'valor_total_cliente', valor_total_cliente
    ) INTO v_result
    FROM public.estoque_baixas_agendamento
    WHERE agendamento_id = p_agendamento_id;

    RETURN coalesce(v_result, jsonb_build_object('processado', true, 'valor_total_cliente', 0));
END;
$$;

-- RLS: cada profissional acessa diretamente apenas o próprio estoque.
ALTER TABLE public.estoque_produtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estoque_movimentacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estoque_transferencias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.servico_produtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estoque_baixas_agendamento ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fluxo_caixa ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS estoque_produtos_do_profissional ON public.estoque_produtos;
CREATE POLICY estoque_produtos_do_profissional ON public.estoque_produtos
FOR ALL TO authenticated
USING (profissional_id = public.profissional_logado_id())
WITH CHECK (profissional_id = public.profissional_logado_id());

DROP POLICY IF EXISTS estoque_movimentos_do_profissional ON public.estoque_movimentacoes;
CREATE POLICY estoque_movimentos_do_profissional ON public.estoque_movimentacoes
FOR SELECT TO authenticated USING (profissional_id = public.profissional_logado_id());

DROP POLICY IF EXISTS estoque_transferencias_participante ON public.estoque_transferencias;
CREATE POLICY estoque_transferencias_participante ON public.estoque_transferencias
FOR SELECT TO authenticated USING (
    profissional_origem_id = public.profissional_logado_id()
    OR profissional_destino_id = public.profissional_logado_id()
);

DROP POLICY IF EXISTS servico_produtos_do_profissional ON public.servico_produtos;
CREATE POLICY servico_produtos_do_profissional ON public.servico_produtos
FOR ALL TO authenticated
USING (profissional_id = public.profissional_logado_id())
WITH CHECK (profissional_id = public.profissional_logado_id());

DROP POLICY IF EXISTS estoque_baixas_do_profissional ON public.estoque_baixas_agendamento;
CREATE POLICY estoque_baixas_do_profissional ON public.estoque_baixas_agendamento
FOR SELECT TO authenticated USING (profissional_id = public.profissional_logado_id());

-- Mantém políticas existentes do caixa; adiciona uma política específica se não houver.
DROP POLICY IF EXISTS fluxo_caixa_estoque_profissional ON public.fluxo_caixa;
CREATE POLICY fluxo_caixa_estoque_profissional ON public.fluxo_caixa
FOR ALL TO authenticated
USING (profissional_id = public.profissional_logado_id())
WITH CHECK (profissional_id = public.profissional_logado_id());

GRANT SELECT, INSERT, UPDATE ON public.estoque_produtos TO authenticated;
GRANT SELECT ON public.estoque_movimentacoes, public.estoque_transferencias, public.estoque_baixas_agendamento TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.servico_produtos TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fluxo_caixa TO authenticated;
GRANT ALL ON public.estoque_produtos, public.estoque_movimentacoes,
    public.estoque_transferencias, public.servico_produtos,
    public.estoque_baixas_agendamento, public.fluxo_caixa TO service_role;

REVOKE ALL ON FUNCTION public.registrar_movimento_estoque(uuid, varchar, numeric, numeric, varchar, varchar, boolean, numeric, varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.salvar_produtos_servico(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transferir_estoque(uuid, uuid, numeric, varchar, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalizar_atendimento_com_estoque(uuid, varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.processar_baixa_estoque_agendamento(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_movimento_estoque(uuid, varchar, numeric, numeric, varchar, varchar, boolean, numeric, varchar) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.salvar_produtos_servico(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.transferir_estoque(uuid, uuid, numeric, varchar, numeric, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalizar_atendimento_com_estoque(uuid, varchar) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.processar_baixa_estoque_agendamento(uuid) TO authenticated, service_role;

-- Bucket de fotos. O caminho deve começar por <profissional_id>/.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('produtos-estoque', 'produtos-estoque', true, 5242880, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 5242880;

DROP POLICY IF EXISTS estoque_imagem_upload ON storage.objects;
CREATE POLICY estoque_imagem_upload ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
    bucket_id = 'produtos-estoque'
    AND split_part(name, '/', 1) = public.profissional_logado_id()::text
);

DROP POLICY IF EXISTS estoque_imagem_update ON storage.objects;
CREATE POLICY estoque_imagem_update ON storage.objects
FOR UPDATE TO authenticated
USING (
    bucket_id = 'produtos-estoque'
    AND split_part(name, '/', 1) = public.profissional_logado_id()::text
);

DROP POLICY IF EXISTS estoque_imagem_delete ON storage.objects;
CREATE POLICY estoque_imagem_delete ON storage.objects
FOR DELETE TO authenticated
USING (
    bucket_id = 'produtos-estoque'
    AND split_part(name, '/', 1) = public.profissional_logado_id()::text
);

NOTIFY pgrst, 'reload schema';
