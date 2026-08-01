from __future__ import annotations

from pathlib import Path

from PIL import Image as PILImage
from reportlab.graphics.shapes import Drawing, Line, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


BASE_DIR = Path(__file__).resolve().parent
SCREEN_DIR = BASE_DIR / "screenshots_hi"
OUT_PDF = BASE_DIR / "Nota_Tecnica_Informativa_Release_Julio_Cesar_Bueno.pdf"

PAGE_W, PAGE_H = letter
MARGIN = 0.55 * inch
CONTENT_W = PAGE_W - 2 * MARGIN

BLUE = colors.HexColor("#2563EB")
DARK = colors.HexColor("#0F172A")
MUTED = colors.HexColor("#64748B")
LIGHT = colors.HexColor("#E8EEF5")
SOFT = colors.HexColor("#F8FAFC")
GREEN = colors.HexColor("#059669")
AMBER = colors.HexColor("#D97706")
BORDER = colors.HexColor("#D9E2EC")


TABLES = [
    ("profissionais", "id PK; nome; email UQ; senha_hash; cargo; cor_identificadora; ativo; criado_em; atualizado_em"),
    ("clientes", "id PK; nome; whatsapp; profissional_id FK; criado_em; atualizado_em"),
    ("servicos", "id PK; nome; descricao; duracao_minutos; ativo; criado_em; atualizado_em"),
    ("subservicos", "id PK; servico_id FK; nome; descricao; preco_adicional; duracao_adicional_minutos; imagem_url; ativo"),
    ("tabela_precos", "id PK; servico_id FK; valor; data_vigencia_inicio; data_vigencia_fim; criado_em"),
    ("agendamentos", "id PK; cliente_id FK; servico_id FK; profissional_id FK; data_hora_inicio; data_hora_fim; status; observacoes; is_manutencao; agendamento_pai_id FK; periodicidade_dias; criado_em; atualizado_em"),
    ("fluxo_caixa", "id PK; agendamento_id FK; cliente_id FK; servico_id FK; profissional_id FK; valor_bruto; desconto; valor_final; condicao_pagamento; forma_pagamento; status_pagamento; data_pagamento; observacoes; criado_em"),
    ("configuracoes", "id PK; chave UQ; valor JSONB; descricao; atualizado_em"),
    ("parametros", "id PK; nome UQ; valor; tipo; descricao; atualizado_em"),
]

RELATIONSHIPS = [
    ("profissionais", "1:N", "agendamentos", "agenda confirmada/manual por profissional"),
    ("profissionais", "1:N", "clientes", "carteira individual de clientes"),
    ("profissionais", "1:N", "fluxo_caixa", "recebimentos individuais"),
    ("clientes", "1:N", "agendamentos", "cliente pode ter vários atendimentos"),
    ("servicos", "1:N", "agendamentos", "atendimento sempre aponta para um serviço"),
    ("servicos", "1:N", "subservicos", "opções/variações do serviço"),
    ("servicos", "1:N", "tabela_precos", "histórico de preço vigente"),
    ("agendamentos", "1:N", "fluxo_caixa", "pagamentos vinculados ao atendimento"),
    ("agendamentos", "1:N", "agendamentos", "retornos/manutenções pelo agendamento pai"),
]


def make_styles():
    base = getSampleStyleSheet()
    base.add(ParagraphStyle("TitleX", parent=base["Title"], fontName="Helvetica-Bold", fontSize=22, leading=25, textColor=DARK, alignment=TA_LEFT, spaceAfter=4))
    base.add(ParagraphStyle("SubtitleX", parent=base["Normal"], fontName="Helvetica", fontSize=11.5, leading=14, textColor=colors.HexColor("#1F4D78"), spaceAfter=10))
    base.add(ParagraphStyle("H1X", parent=base["Heading1"], fontName="Helvetica-Bold", fontSize=13.5, leading=16, textColor=BLUE, spaceBefore=8, spaceAfter=5))
    base.add(ParagraphStyle("H2X", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=10.2, leading=12, textColor=colors.HexColor("#1F4D78"), spaceBefore=0, spaceAfter=3))
    base.add(ParagraphStyle("BodyX", parent=base["BodyText"], fontName="Helvetica", fontSize=8.9, leading=10.7, textColor=DARK, spaceAfter=4))
    base.add(ParagraphStyle("SmallX", parent=base["BodyText"], fontName="Helvetica", fontSize=7.6, leading=9.2, textColor=MUTED, spaceAfter=2))
    base.add(ParagraphStyle("CellH", parent=base["BodyText"], fontName="Helvetica-Bold", fontSize=7.4, leading=8.8, textColor=colors.HexColor("#1F4D78")))
    base.add(ParagraphStyle("CellB", parent=base["BodyText"], fontName="Helvetica", fontSize=7.15, leading=8.4, textColor=DARK))
    base.add(ParagraphStyle("BulletX", parent=base["BodyText"], fontName="Helvetica", fontSize=8.2, leading=9.9, textColor=DARK, leftIndent=10, firstLineIndent=-7, spaceAfter=2.2))
    base.add(ParagraphStyle("CaptionX", parent=base["BodyText"], fontName="Helvetica", fontSize=7.2, leading=8.4, textColor=MUTED, alignment=TA_CENTER, spaceBefore=3))
    return base


S = make_styles()


def P(text: str, style="BodyX") -> Paragraph:
    return Paragraph(text, S[style])


def bullet(text: str) -> Paragraph:
    return Paragraph("• " + text, S["BulletX"])


def table(data, widths, header=True):
    t = Table(data, colWidths=[w * inch for w in widths], hAlign="LEFT", repeatRows=1 if header else 0)
    cmds = [
        ("BOX", (0, 0), (-1, -1), 0.45, BORDER),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, BORDER),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4.5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4.5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    if header:
        cmds.append(("BACKGROUND", (0, 0), (-1, 0), LIGHT))
    t.setStyle(TableStyle(cmds))
    return t


def callout(title, body, fill=SOFT, accent=BLUE):
    data = [[Paragraph(f"<b><font color='#{accent.hexval()[2:]}'>{title}</font></b>", S["CellB"])], [P(body, "CellB")]]
    t = Table(data, colWidths=[CONTENT_W], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fill),
        ("BOX", (0, 0), (-1, -1), 0.45, BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


def img(filename, max_w, max_h):
    path = SCREEN_DIR / filename
    with PILImage.open(path) as im:
        w, h = im.size
    scale = min(max_w / w, max_h / h)
    return Image(str(path), width=w * scale, height=h * scale)


def screenshots_row(items):
    cells = []
    caps = []
    for filename, caption in items:
        cells.append(img(filename, 1.75 * inch, 3.8 * inch))
        caps.append(P(caption, "CaptionX"))
    t = Table([cells, caps], colWidths=[CONTENT_W / len(items)] * len(items), hAlign="CENTER")
    t.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
    ]))
    return t


def der_drawing():
    d = Drawing(CONTENT_W, 4.72 * inch)
    node_w = 128
    node_h = 46
    boxes = {
        "profissionais": (15, 255),
        "clientes": (190, 255),
        "servicos": (365, 255),
        "agendamentos": (190, 160),
        "fluxo_caixa": (15, 70),
        "subservicos": (365, 160),
        "tabela_precos": (365, 70),
        "configuracoes": (190, 70),
        "parametros": (190, 15),
    }
    links = [
        ("profissionais", "clientes"),
        ("profissionais", "agendamentos"),
        ("profissionais", "fluxo_caixa"),
        ("clientes", "agendamentos"),
        ("servicos", "agendamentos"),
        ("servicos", "subservicos"),
        ("servicos", "tabela_precos"),
        ("agendamentos", "fluxo_caixa"),
        ("agendamentos", "agendamentos"),
    ]
    for a, b in links:
        ax, ay = boxes[a]
        bx, by = boxes[b]
        d.add(Line(ax + node_w / 2, ay + node_h / 2, bx + node_w / 2, by + node_h / 2, strokeColor=colors.HexColor("#94A3B8"), strokeWidth=1.0))
    for name, (x, y) in boxes.items():
        fill = colors.HexColor("#EFF6FF") if name in ("agendamentos", "clientes", "profissionais") else colors.white
        d.add(Rect(x, y, node_w, node_h, rx=7, ry=7, fillColor=fill, strokeColor=colors.HexColor("#CBD5E1"), strokeWidth=1))
        d.add(String(x + 8, y + 29, name, fontName="Helvetica-Bold", fontSize=8.5, fillColor=DARK))
        subtitle = "PK id"
        if name in ("agendamentos", "fluxo_caixa"):
            subtitle = "PK id + FKs"
        elif name in ("configuracoes", "parametros"):
            subtitle = "chave/valor"
        d.add(String(x + 8, y + 14, subtitle, fontName="Helvetica", fontSize=7, fillColor=MUTED))
    d.add(String(15, 330, "DER lógico - entidades, cardinalidade 1:N e pontos de isolamento", fontName="Helvetica-Bold", fontSize=10, fillColor=BLUE))
    return d


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(MUTED)
    canvas.drawCentredString(PAGE_W / 2, 0.33 * inch, f"Nota técnica informativa de release | Julio Cesar Bueno | Página {doc.page}")
    canvas.restoreState()


def build():
    doc = SimpleDocTemplate(
        str(OUT_PDF),
        pagesize=letter,
        rightMargin=MARGIN,
        leftMargin=MARGIN,
        topMargin=0.5 * inch,
        bottomMargin=0.58 * inch,
        title="Nota Técnica Informativa de Release - Julio Cesar Bueno",
        author="Julio Cesar Bueno",
        subject="Aplicativos de agendamento e banco PostgreSQL",
    )
    story = []

    story += [
        P("Nota Técnica Informativa de Release", "TitleX"),
        P("Ecossistema de agendamento | Painel operacional + aplicativo público", "SubtitleX"),
        table(
            [
                [P("Elaborado por", "CellH"), P("Julio Cesar Bueno", "CellB"), P("Data", "CellH"), P("31/07/2026", "CellB")],
                [P("Escopo", "CellH"), P("Aplicativos de agendamento conectados ao mesmo banco PostgreSQL", "CellB"), P("Entrega", "CellH"), P("Nota técnica em PDF", "CellB")],
            ],
            [1.0, 3.1, 0.65, 1.15],
        ),
        Spacer(1, 6),
        callout(
            "Resumo executivo",
            "A release organiza o produto para operação com equipe. O painel operacional controla agenda, clientes, serviços, caixa, horários, mensagens, notificações e profissionais. O aplicativo público recebe solicitações de clientes. O banco central mantém a regra principal: solicitação pendente é comum; após aceite, pertence somente ao profissional que confirmou.",
        ),
        P("1. Mapa funcional completo", "H1X"),
        table(
            [
                [P("Módulo", "CellH"), P("Funcionalidades", "CellH"), P("Regra de negócio", "CellH")],
                [P("Agenda", "CellB"), P("Solicitações públicas, confirmação, edição, cancelamento, atendimento, conclusão, manutenção, filtros por status e agendamento manual.", "CellB"), P("Aceite fixa o profissional responsável; demais usuários não visualizam como agenda ativa.", "CellB")],
                [P("Clientes", "CellB"), P("Cadastro, edição, exclusão controlada, WhatsApp, seleção no agendamento manual e histórico financeiro.", "CellB"), P("Carteira individual por profissional; cliente público permanece separado até aceite.", "CellB")],
                [P("Serviços", "CellB"), P("Serviços ativos, duração, preço vigente, descrição, subserviços/opções, imagem, acréscimo de preço e tempo.", "CellB"), P("Aplicativo público mostra apenas serviços ativos e preços vigentes.", "CellB")],
                [P("Caixa", "CellB"), P("Recebimentos, pendências, descontos, valor final, forma, condição, status, indicadores e baixa de pagamento.", "CellB"), P("Lançamento acompanha agendamento, cliente, serviço e profissional.", "CellB")],
                [P("Horários", "CellB"), P("Múltiplos turnos por dia, intervalo, mensagens, endereço, alarme sonoro e alerta de atendimento próximo.", "CellB"), P("Configuração pode ser individual para profissional ou auxiliar.", "CellB")],
                [P("Equipe", "CellB"), P("Cadastro de profissional/auxiliar, e-mail, cargo, cor, status ativo/inativo e permissões operacionais.", "CellB"), P("Cada membro opera agenda, clientes, caixa e horários próprios.", "CellB")],
                [P("Aplicativo público", "CellB"), P("Nome, WhatsApp, serviço, opção, data, horário, observações, conflitos, sugestões e confirmação enviada.", "CellB"), P("Criação ocorre por RPC com validações e status inicial aguardando confirmação.", "CellB")],
            ],
            [1.0, 3.25, 1.65],
        ),
    ]

    story.append(PageBreak())
    story += [
        P("2. Modelo de dados e relacionamentos", "H1X"),
        der_drawing(),
        Spacer(1, 5),
        table(
            [[P("Origem", "CellH"), P("Card.", "CellH"), P("Destino", "CellH"), P("Uso", "CellH")]]
            + [[P(a, "CellB"), P(c, "CellB"), P(b, "CellB"), P(u, "CellB")] for a, c, b, u in RELATIONSHIPS],
            [1.35, 0.45, 1.35, 2.75],
        ),
        Spacer(1, 5),
        callout(
            "Leitura do DER",
            "As FKs de profissional em clientes, agendamentos e caixa são o eixo do isolamento. A solicitação pública entra sem profissional; a confirmação preenche o responsável e fecha a visibilidade para os demais.",
            fill=colors.HexColor("#F0FDF4"),
            accent=GREEN,
        ),
    ]

    story.append(PageBreak())
    story += [P("3. Dicionário de dados - tabelas e colunas", "H1X")]
    story.append(
        table(
            [[P("Tabela", "CellH"), P("Colunas principais", "CellH")]]
            + [[P(name, "CellB"), P(cols, "CellB")] for name, cols in TABLES[:5]],
            [1.35, 4.55],
        )
    )
    story.append(Spacer(1, 7))
    story.append(
        table(
            [[P("Tabela", "CellH"), P("Colunas principais", "CellH")]]
            + [[P(name, "CellB"), P(cols, "CellB")] for name, cols in TABLES[5:]],
            [1.35, 4.55],
        )
    )

    story.append(PageBreak())
    story += [
        P("4. Regras críticas da release", "H1X"),
        table(
            [
                [P("Regra", "CellH"), P("Comportamento esperado", "CellH"), P("Persistência", "CellH")],
                [P("Solicitação pública", "CellB"), P("Aparece para todos enquanto está aguardando confirmação.", "CellB"), P("agendamentos.profissional_id = NULL", "CellB")],
                [P("Aceite", "CellB"), P("Quem confirma vira responsável; os demais deixam de visualizar como agenda própria.", "CellB"), P("agendamentos.profissional_id", "CellB")],
                [P("Cliente público", "CellB"), P("Registro criado pela solicitação pública permanece neutro até ser associado a uma carteira individual.", "CellB"), P("clientes.profissional_id", "CellB")],
                [P("Agenda manual", "CellB"), P("Usa serviço, duração, expediente e conflitos do profissional autenticado.", "CellB"), P("agendamentos + clientes", "CellB")],
                [P("Horário disponível", "CellB"), P("Horário só bloqueia quando atinge a capacidade de profissionais ativos ou conflito do próprio profissional.", "CellB"), P("profissionais + agendamentos", "CellB")],
                [P("Recebimento", "CellB"), P("Pagamento pode nascer do atendimento ou de baixa manual, mantendo vínculo operacional.", "CellB"), P("fluxo_caixa", "CellB")],
            ],
            [1.35, 3.2, 1.35],
        ),
        Spacer(1, 8),
        P("5. Segurança e operação", "H1X"),
    ]
    for item in [
        "Acesso público restrito a serviços ativos, preços vigentes, horários ocupados e configurações públicas necessárias.",
        "Criação pública de agendamento por função transacional com validação de nome, WhatsApp, data futura, serviço ativo e conflito.",
        "Painel operacional exige sessão ou profissional ativo cadastrado.",
        "Backfill preserva dados antigos, associa registros legados ao profissional padrão e mantém solicitações públicas sem responsável até aceite.",
        "Índices por profissional e unicidade de WhatsApp por contexto reduzem conflito entre carteiras independentes.",
    ]:
        story.append(bullet(item))

    story.append(PageBreak())
    story += [
        P("6. Evidências de interface - painel operacional", "H1X"),
        P("Capturas em alta resolução reduzidas no PDF para preservar nitidez.", "SmallX"),
        screenshots_row(
            [
                ("01_painel_login.png", "Login do painel"),
                ("02_painel_agenda.png", "Agenda e filtros"),
                ("03_painel_novo_agendamento.png", "Agendamento manual"),
            ]
        ),
        Spacer(1, 8),
        screenshots_row(
            [
                ("04_painel_buscar_cliente.png", "Busca de cliente cadastrado"),
                ("05_painel_configuracoes.png", "Horários e alertas"),
                ("06_painel_caixa.png", "Fluxo de caixa"),
            ]
        ),
    ]

    story.append(PageBreak())
    public_checks = [
        ("Solicitação pública", "Visível para a equipe enquanto está pendente."),
        ("Aceite por auxiliar", "A agenda passa a aparecer somente para quem confirmou."),
        ("Agenda manual", "Busca cliente cadastrado e valida o horário individual."),
        ("Clientes", "Carteira separada por profissional."),
        ("Caixa", "Recebimentos ligados ao responsável correto."),
        ("Horários", "Turnos e bloqueios separados por usuário."),
        ("Conflito público", "Criação bloqueia conflito real e sugere próximos horários."),
    ]
    checklist_flow = [
        P("Checklist funcional", "H2X"),
        P("Critérios de validação usados como referência da release.", "SmallX"),
        Spacer(1, 6),
        table(
            [[P("Item", "CellH"), P("Resultado esperado", "CellH")]]
            + [[P(k, "CellB"), P(v, "CellB")] for k, v in public_checks],
            [1.25, 2.9],
        ),
    ]
    story += [
        P("7. Evidência pública e checklist de homologação", "H1X"),
        P("O fluxo externo fica simples para o cliente final e mantém a regra de aceite compartilhado apenas até a confirmação.", "SmallX"),
        Spacer(1, 6),
        Table(
            [[img("07_app_publico_agendamento.png", 2.55 * inch, 4.95 * inch), checklist_flow]],
            colWidths=[2.85 * inch, CONTENT_W - 2.85 * inch],
            style=[
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ],
        ),
        Spacer(1, 8),
        callout(
            "Conclusão",
            "O conjunto está preparado para operação com equipe: agenda, clientes, horários e caixa são individuais; solicitações públicas continuam compartilhadas apenas até o primeiro aceite; e o cliente final mantém um fluxo simples de agendamento online.",
            fill=colors.HexColor("#FFF7ED"),
            accent=AMBER,
        ),
    ]

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(OUT_PDF)


if __name__ == "__main__":
    build()
