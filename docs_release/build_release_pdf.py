from __future__ import annotations

from pathlib import Path

from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


BASE_DIR = Path(__file__).resolve().parent
SCREEN_DIR = BASE_DIR / "screenshots"
OUT_PDF = BASE_DIR / "Nota_Tecnica_Informativa_Release_Julio_Cesar_Bueno.pdf"

PAGE_W, PAGE_H = letter
MARGIN = 0.68 * inch
CONTENT_W = PAGE_W - 2 * MARGIN

BLUE = colors.HexColor("#2563EB")
DARK = colors.HexColor("#0F172A")
MUTED = colors.HexColor("#64748B")
LIGHT = colors.HexColor("#E8EEF5")
SOFT = colors.HexColor("#F8FAFC")
GREEN = colors.HexColor("#059669")
AMBER = colors.HexColor("#D97706")
BORDER = colors.HexColor("#D9E2EC")


def styles():
    base = getSampleStyleSheet()
    base.add(
        ParagraphStyle(
            "DocTitle",
            parent=base["Title"],
            fontName="Helvetica-Bold",
            fontSize=24,
            leading=28,
            textColor=DARK,
            alignment=TA_LEFT,
            spaceAfter=6,
        )
    )
    base.add(
        ParagraphStyle(
            "Subtitle2",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=12.5,
            leading=15,
            textColor=colors.HexColor("#1F4D78"),
            spaceAfter=14,
        )
    )
    base.add(
        ParagraphStyle(
            "H1x",
            parent=base["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=15,
            leading=18,
            textColor=BLUE,
            spaceBefore=12,
            spaceAfter=6,
        )
    )
    base.add(
        ParagraphStyle(
            "Bodyx",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9.7,
            leading=12.1,
            textColor=DARK,
            spaceAfter=5,
        )
    )
    base.add(
        ParagraphStyle(
            "Smallx",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=8.3,
            leading=10.2,
            textColor=MUTED,
            spaceAfter=3,
        )
    )
    base.add(
        ParagraphStyle(
            "Captionx",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=7.8,
            leading=9.5,
            textColor=MUTED,
            alignment=TA_CENTER,
            spaceBefore=4,
        )
    )
    base.add(
        ParagraphStyle(
            "CellHead",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=8.6,
            leading=10.2,
            textColor=colors.HexColor("#1F4D78"),
        )
    )
    base.add(
        ParagraphStyle(
            "CellBody",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=8.3,
            leading=10,
            textColor=DARK,
        )
    )
    base.add(
        ParagraphStyle(
            "Bulletx",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9.2,
            leading=11.2,
            leftIndent=12,
            firstLineIndent=-8,
            textColor=DARK,
            spaceAfter=3.2,
            bulletIndent=0,
        )
    )
    return base


S = styles()


def P(text: str, style="Bodyx") -> Paragraph:
    return Paragraph(text, S[style])


def bullet(text: str) -> Paragraph:
    return Paragraph("• " + text, S["Bulletx"])


def kv_table(rows: list[tuple[str, str]]) -> Table:
    data = [[P(k, "CellHead"), P(v, "CellBody")] for k, v in rows]
    tbl = Table(data, colWidths=[1.5 * inch, CONTENT_W - 1.5 * inch], hAlign="LEFT")
    tbl.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("BACKGROUND", (0, 0), (0, -1), LIGHT),
                ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
                ("INNERGRID", (0, 0), (-1, -1), 0.35, BORDER),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return tbl


def status_table(headers: list[str], rows: list[list[str]], widths: list[float]) -> Table:
    data = [[P(h, "CellHead") for h in headers]]
    data.extend([[P(c, "CellBody") for c in row] for row in rows])
    tbl = Table(data, colWidths=[w * inch for w in widths], hAlign="LEFT", repeatRows=1)
    tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
                ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
                ("INNERGRID", (0, 0), (-1, -1), 0.35, BORDER),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    return tbl


def callout(title: str, body: str, fill=SOFT, accent=BLUE) -> Table:
    title_p = Paragraph(f"<b><font color='#{accent.hexval()[2:]}'>{title}</font></b>", S["CellBody"])
    body_p = P(body, "CellBody")
    tbl = Table([[title_p], [body_p]], colWidths=[CONTENT_W], hAlign="LEFT")
    tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), fill),
                ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return tbl


def image_flowable(filename: str, max_w: float, max_h: float) -> Image:
    path = SCREEN_DIR / filename
    with PILImage.open(path) as img:
        w, h = img.size
    scale = min(max_w / w, max_h / h)
    return Image(str(path), width=w * scale, height=h * scale)


def screenshot_pair(left: tuple[str, str], right: tuple[str, str]) -> Table:
    max_w = 2.55 * inch
    max_h = 5.35 * inch
    data = [
        [image_flowable(left[0], max_w, max_h), image_flowable(right[0], max_w, max_h)],
        [P(left[1], "Captionx"), P(right[1], "Captionx")],
    ]
    tbl = Table(data, colWidths=[CONTENT_W / 2, CONTENT_W / 2], hAlign="CENTER")
    tbl.setStyle(
        TableStyle(
            [
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]
        )
    )
    return tbl


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawCentredString(
        PAGE_W / 2,
        0.38 * inch,
        f"Nota técnica informativa de release | Julio Cesar Bueno | Página {doc.page}",
    )
    canvas.restoreState()


def build() -> None:
    doc = SimpleDocTemplate(
        str(OUT_PDF),
        pagesize=letter,
        rightMargin=MARGIN,
        leftMargin=MARGIN,
        topMargin=0.62 * inch,
        bottomMargin=0.68 * inch,
        title="Nota Técnica Informativa de Release - Julio Cesar Bueno",
        author="Julio Cesar Bueno",
        subject="Funcionalidades e release dos aplicativos Acionar e Patrícia Beato",
    )

    story = []
    story.append(P("Nota Técnica Informativa de Release", "DocTitle"))
    story.append(P("Ecossistema Acionar | Painel operacional + Agendamento público", "Subtitle2"))
    story.append(
        kv_table(
            [
                ("Elaborado por", "Julio Cesar Bueno"),
                ("Data", "31 de julho de 2026"),
                ("Escopo", "Dois aplicativos conectados ao mesmo Supabase/PostgreSQL"),
                ("Aplicativo 1", "Acionar - PWA operacional em GitHub Pages"),
                ("Aplicativo 2", "patriciabeato.acionar - agendamento público Lovable/TanStack"),
            ]
        )
    )
    story.append(Spacer(1, 8))
    story.append(
        callout(
            "Resumo executivo",
            "A release consolida um fluxo completo para captação, confirmação, execução e recebimento de atendimentos. "
            "O painel operacional concentra agenda, clientes, serviços, caixa, configurações e equipe; o app público captura "
            "solicitações de clientes com validação de horários e gravação segura via RPC no Supabase. A evolução recente reforça "
            "isolamento por profissional, horários individuais, clientes individuais e aceite exclusivo de solicitações.",
        )
    )

    story.append(P("1. Visão geral do ecossistema", "H1x"))
    story.append(
        P(
            "Os dois aplicativos atendem papéis complementares. O Acionar é o backoffice/PWA usado por profissionais e auxiliares. "
            "O aplicativo Patrícia Beato é a experiência pública de agendamento do cliente final. Ambos compartilham o mesmo banco "
            "Supabase, mas não compartilham responsabilidades de frontend.",
        )
    )
    story.append(
        status_table(
            ["Componente", "Finalidade", "Usuário principal"],
            [
                ["Acionar", "Operar agenda, clientes, serviços, caixa, mensagens e equipe.", "Profissional, proprietário e auxiliar"],
                ["Patrícia Beato", "Receber solicitações públicas de agendamento com serviço, data e horário.", "Cliente final"],
                ["Supabase", "Centralizar dados, políticas, RPCs e regras de concorrência/isolamento.", "Aplicações e banco"],
            ],
            [1.45, 3.2, 1.35],
        )
    )

    story.append(P("2. Aplicativo Acionar - funcionalidades", "H1x"))
    for item in [
        "Autenticação por Supabase Auth e fallback para profissionais/auxiliares cadastrados.",
        "Agenda com filtros por status: todos, hoje, solicitações, confirmados, em atendimento, atendidos, manutenções e cancelados.",
        "Confirmação de solicitação respeitando o profissional que aceitou; solicitações públicas deixam de aparecer aos demais após aceite.",
        "Novo agendamento manual com validação de expediente, duração do serviço, conflitos e seletor de cliente cadastrado.",
        "Cadastro de clientes isolado por profissional, com WhatsApp, edição, exclusão controlada e histórico financeiro.",
        "Cadastro de serviços, preços, duração, descrição e subserviços/opções com imagem, acréscimo e tempo adicional.",
        "Fluxo de caixa com lançamentos vinculados a atendimentos, status pago/a receber, desconto, forma e condição de pagamento.",
        "Configurações de horários por profissional, múltiplos turnos por dia, mensagens WhatsApp e endereço do estabelecimento.",
        "Notificações internas, alarme sonoro, aviso de atendimento próximo e lembretes de manutenção periódica.",
        "Suporte PWA com instalação em celular, navegação mobile e Service Worker para notificações.",
    ]:
        story.append(bullet(item))

    story.append(P("3. Aplicativo público Patrícia Beato - funcionalidades", "H1x"))
    for item in [
        "Landing transacional de agendamento online, sem cadastro prévio do cliente.",
        "Coleta de nome completo e WhatsApp com máscara/validação de DDD.",
        "Listagem de serviços ativos e preços vigentes diretamente do Supabase.",
        "Suporte a subserviços/opções, com preço adicional, tempo adicional e imagem quando cadastrada.",
        "Seleção de data baseada na configuração de funcionamento publicada.",
        "Cálculo de horários livres considerando duração total e capacidade de profissionais ativos.",
        "Tratamento de conflito com sugestões de horários disponíveis.",
        "Resumo com serviço, duração, valor estimado, data, cliente e confirmação de solicitação enviada.",
        "Gravação via RPC criar_agendamento_cliente, mantendo status inicial aguardando_confirmacao.",
    ]:
        story.append(bullet(item))

    story.append(P("4. Banco de dados e regras compartilhadas", "H1x"))
    story.append(
        status_table(
            ["Área", "Tabelas/Funções", "Regra relevante"],
            [
                ["Agenda", "agendamentos, listar_agendamentos_painel", "Status e visibilidade por profissional após aceite."],
                ["Clientes", "clientes", "Cliente público separado de clientes individuais por profissional."],
                ["Serviços", "servicos, tabela_precos, subservicos", "Oferta pública só mostra ativos e preços vigentes."],
                ["Equipe", "profissionais", "Auxiliares possuem agenda, clientes, caixa e horários próprios."],
                ["Caixa", "fluxo_caixa", "Recebimentos vinculados ao profissional e ao agendamento."],
                ["Segurança", "RLS, grants, RPCs", "Público acessa somente o necessário para agendar; painel usa sessão autenticada."],
            ],
            [1.1, 2.25, 2.65],
        )
    )
    story.append(Spacer(1, 6))
    story.append(
        callout(
            "Regra central da release",
            "Solicitações de agendamento são comuns enquanto ainda não foram aceitas. Quando um profissional ou auxiliar confirma, "
            "o agendamento passa a pertencer a esse usuário e não deve aparecer como agenda ativa dos demais.",
            fill=colors.HexColor("#F0FDF4"),
            accent=GREEN,
        )
    )

    story.append(PageBreak())
    story.append(P("5. Evidências de interface", "H1x"))
    story.append(
        P(
            "As capturas abaixo demonstram as telas principais. Dados exibidos em algumas telas internas são exemplos de documentação, "
            "usados apenas para evidenciar o fluxo visual.",
            "Smallx",
        )
    )
    story.append(screenshot_pair(("01_acionar_login.png", "Acionar - autenticação do painel operacional"), ("02_acionar_dashboard.png", "Acionar - agenda, filtros e navegação PWA")))
    story.append(PageBreak())
    story.append(P("5. Evidências de interface (continuação)", "H1x"))
    story.append(screenshot_pair(("03_acionar_novo_agendamento.png", "Novo agendamento manual com validação de horários"), ("04_acionar_selecionar_cliente.png", "Seleção de cliente cadastrado para preencher nome e WhatsApp")))
    story.append(PageBreak())
    story.append(P("5. Evidências de interface (continuação)", "H1x"))
    story.append(screenshot_pair(("05_acionar_clientes.png", "Gestão de clientes e base individual por profissional"), ("06_acionar_servicos.png", "Catálogo de serviços, preços e subserviços")))
    story.append(PageBreak())
    story.append(P("5. Evidências de interface (continuação)", "H1x"))
    story.append(screenshot_pair(("07_acionar_caixa.png", "Fluxo de caixa e indicadores financeiros"), ("08_acionar_configuracoes.png", "Horários, mensagens, alarmes e parâmetros")))
    story.append(PageBreak())
    story.append(P("5. Evidências de interface (continuação)", "H1x"))
    img = image_flowable("09_patriciabeato_agendamento_publico.png", 3.2 * inch, 6.7 * inch)
    t = Table([[img], [P("Patrícia Beato - agendamento público com serviços, preço, data e horário", "Captionx")]], colWidths=[CONTENT_W])
    t.setStyle(TableStyle([("ALIGN", (0, 0), (-1, -1), "CENTER"), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story.append(t)

    story.append(P("6. Pontos técnicos da release", "H1x"))
    for item in [
        "Isolamento por profissional_id em agendamentos, clientes e fluxo de caixa.",
        "Backfill seguro de dados legados, preservando solicitações públicas sem profissional até o aceite.",
        "Índices para busca por profissional e unicidade de WhatsApp por contexto.",
        "RPC pública endurecida para criar agendamento com validação de nome, WhatsApp, data futura, serviço ativo e conflito de horário.",
        "Capacidade multi-profissional: o horário só é bloqueado ao atingir o número de profissionais ativos.",
        "Cache-buster do frontend atualizado para garantir entrega do JavaScript novo no GitHub Pages.",
    ]:
        story.append(bullet(item))

    story.append(P("7. Checklist de homologação", "H1x"))
    story.append(
        status_table(
            ["Item", "Resultado esperado"],
            [
                ["Solicitação pública", "Aparece para todos até alguém confirmar."],
                ["Aceite por auxiliar", "Após confirmar, fica visível para o auxiliar que aceitou e deixa de aparecer aos demais."],
                ["Agenda manual", "Usa horários do profissional autenticado e permite selecionar cliente cadastrado."],
                ["Clientes", "Cada profissional visualiza e mantém sua própria carteira."],
                ["Caixa", "Lançamentos seguem o profissional/agendamento correspondente."],
                ["Horários", "Configuração individual por usuário, incluindo auxiliares."],
                ["App público", "Cria solicitação via RPC e exibe conflitos/sugestões quando necessário."],
            ],
            [1.65, 4.35],
        )
    )
    story.append(Spacer(1, 8))
    story.append(
        callout(
            "Conclusão",
            "A release deixa o produto preparado para operação com equipe: clientes, horários, caixa e agenda são individuais; "
            "solicitações públicas continuam compartilhadas até o primeiro aceite; e o cliente final permanece com um fluxo simples "
            "de agendamento online.",
            fill=colors.HexColor("#FFF7ED"),
            accent=AMBER,
        )
    )

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(OUT_PDF)


if __name__ == "__main__":
    build()
