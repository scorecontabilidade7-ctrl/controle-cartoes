#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Score Cards • Motor Avançado de Análise de Faturas e Parcelamentos em Python
Suporta faturas de bancos brasileiros: Santander, Itaú, Nubank, Caixa, Bradesco, BB, Inter, C6, etc.
"""

import sys
import os
import json
import re
import unicodedata
from datetime import datetime
from typing import Dict, List, Any, Optional
import pdfplumber

if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

def remover_acentos(texto: Any) -> Any:
    """Remove todos os acentos e caracteres diacriticos para evitar erros visuais ou de codificacao."""
    if not isinstance(texto, str):
        return texto
    texto = texto.replace('\ufffd', '')
    nfkd = unicodedata.normalize('NFKD', texto)
    sem_acento = "".join(c for c in nfkd if not unicodedata.combining(c))
    return sem_acento

def sanitizar_estrutura_sem_acentos(obj: Any) -> Any:
    """Percorre recursivamente dicionarios, listas e strings, removendo todos os acentos."""
    if isinstance(obj, str):
        return remover_acentos(obj)
    elif isinstance(obj, list):
        return [sanitizar_estrutura_sem_acentos(item) for item in obj]
    elif isinstance(obj, dict):
        return {
            remover_acentos(k): sanitizar_estrutura_sem_acentos(v)
            for k, v in obj.items()
        }
    return obj

# Dicionário de Categorização Automática Inteligente (Sem Acentos)
CATEGORIAS_KEYWORDS = {
    "Supermercado & Alimentos": [
        "MERCADO", "SUPERMERCADO", "HIPERMERCADO", "CARREFOUR", "PAO DE ACUCAR", "ASSAI", "ATACADAO", 
        "BOM VIZINHO", "COMERCIAL BAHIA", "HORTOFRUTI", "PADARIA", "PANIFICADORA", "ACOUGUE", "FRIGORIFICO"
    ],
    "Restaurantes & Delivery": [
        "RESTAURANTE", "IFOOD", "UBER EATS", "RAPPI", "MCDONALDS", "BURGER KING", "OUTBACK", "PIZZARIA", 
        "CHOPP", "BAR ", "CAFE", "STARBUCKS", "LANCHONETE", "SORVETERIA", "HAMBURGUERIA", "BAHIA"
    ],
    "Farmacia & Saude": [
        "DROGARIA", "DROGASIL", "PAGUE MENOS", "DROGA RAIA", "FARMACIA", "FARMA", "LABORATORIO", "LAB ", 
        "CLINICA", "HOSPITAL", "MEDICO", "CONSULTORIO", "ODONTO", "DENTISTA", "FERTILIZA", "CLEMENTINO"
    ],
    "Transporte & Combustivel": [
        "UBER", "99APP", "POSTO", "COMBUSTIVEL", "IPIRANGA", "SHELL", "PETROBRAS", "AUTO POSTO", 
        "ESTACIONAMENTO", "PEDAGIO", "SEM PARAR", "VELOE", "CONECTCAR"
    ],
    "Viagens & Lazer": [
        "LATAM", "GOL ", "AZUL ", "AIRBNB", "HOTEL", "POUSADA", "BOOKING", "DECOLAR", "CVC", 
        "BETO CARRERO", "INGRESSO", "CINEMA", "SHOW", "PARQUE", "PASSAGEM", "TURISMO"
    ],
    "Vestuario & Moda": [
        "ZARA", "RENNER", "C&A", "CEA ", "RIACHUELO", "CENTAURO", "DECATHLON", "NIKE", "ADIDAS", 
        "AREZZO", "SCHUTZ", "CALCADOS", "CONFECCOE", "MODAS", "BOUTIQUE", "ROUPAS", "BIJOU", "JOIAS", "LIVE"
    ],
    "Eletronicos & Informatica": [
        "APPLE", "SAMSUNG", "KABUM", "PICHAU", "FAST SHOP", "DELL", "MAGAZINE LUIZA", "MAGALU", 
        "AMAZON", "MERCADOLIVRE", "MERCADO LIVRE", "SHOPEE", "ALIEXPRESS", "FRIOVIX"
    ],
    "Assinaturas & Streaming": [
        "NETFLIX", "SPOTIFY", "AMAZON PRIME", "DISNEY", "HBO", "MAX", "YOUTUBE", "GLOBOPLAY", 
        "OPENAI", "CHATGPT", "GOOGLE", "MICROSOFT", "APPLE.COM", "ICLOUD"
    ],
    "Servicos & Taxas": [
        "SEGURO", "PRUDENTIAL", "PORTO SEGURO", "IOF", "ANUIDADE", "TARIFA", "MANUTENCAO", "LIGHT", 
        "ENEL", "ENERGIA", "AGUA", "CONDOMINIO", "CLARO", "VIVO", "TIM", "OI "
    ]
}

def categorizar_descricao(descricao: str) -> str:
    desc_upper = remover_acentos(descricao).upper()
    for categoria, palavras in CATEGORIAS_KEYWORDS.items():
        for palavra in palavras:
            if palavra in desc_upper:
                return categoria
    return "Outros Lancamentos"

def parse_valor_brasileiro(valor_str: str) -> float:
    try:
        limpo = re.sub(r'[^\d,\.]', '', valor_str.strip())
        if ',' in limpo:
            limpo = limpo.replace('.', '').replace(',', '.')
        return float(limpo)
    except Exception:
        return 0.0

def formatar_mes_referencia(data_vencimento_ou_mes: str) -> str:
    """Retorna YYYY-MM a partir de data ou texto de fatura."""
    m_data = re.search(r'(\d{2})/(\d{2})/(\d{4})', data_vencimento_ou_mes)
    if m_data:
        dia, mes, ano = m_data.groups()
        return f"{ano}-{mes}"
    
    # Se já estiver no formato YYYY-MM
    m_ano_mes = re.search(r'(\d{4})-(\d{2})', data_vencimento_ou_mes)
    if m_ano_mes:
        return f"{m_ano_mes.group(1)}-{m_ano_mes.group(2)}"
    
    # Mês por extenso ou abreviado (Ex: MAIO / 2026, 27 JUL 2026)
    meses_map = {
        "JANEIRO": "01", "JAN": "01", "FEVEREIRO": "02", "FEV": "02", "MARCO": "03", "MARÇO": "03", "MAR": "03",
        "ABRIL": "04", "ABR": "04", "MAIO": "05", "MAI": "05", "JUNHO": "06", "JUN": "06",
        "JULHO": "07", "JUL": "07", "AGOSTO": "08", "AGO": "08", "SETEMBRO": "09", "SET": "09",
        "OUTUBRO": "10", "OUT": "10", "NOVEMBRO": "11", "NOV": "11", "DEZEMBRO": "12", "DEZ": "12"
    }
    texto_upper = data_vencimento_ou_mes.upper()
    for nome_mes, num_mes in meses_map.items():
        if re.search(rf'\b{nome_mes}\b', texto_upper):
            m_ano = re.search(r'\b(20\d{2})\b', texto_upper)
            ano = m_ano.group(1) if m_ano else str(datetime.now().year)
            return f"{ano}-{num_mes}"
            
    now = datetime.now()
    return f"{now.year}-{now.month:02d}"

def calcular_proximos_meses(mes_inicial: str, parcela_atual: int, total_parcelas: int, valor_parcela: float) -> List[Dict[str, Any]]:
    """Gera o cronograma futuro das parcelas restantes."""
    proximos = []
    try:
        ano, mes = map(int, mes_inicial.split('-'))
    except Exception:
        now = datetime.now()
        ano, mes = now.year, now.month

    restantes = total_parcelas - parcela_atual
    for i in range(1, restantes + 1):
        p_num = parcela_atual + i
        mes_futuro = mes + i
        ano_futuro = ano
        while mes_futuro > 12:
            mes_futuro -= 12
            ano_futuro += 1
        
        proximos.append({
            "mes": f"{ano_futuro}-{mes_futuro:02d}",
            "parcela": f"{p_num}/{total_parcelas}",
            "parcela_num": p_num,
            "total_parcelas": total_parcelas,
            "valor": valor_parcela
        })
    return proximos

def limpar_descricao_compra(desc: str) -> str:
    desc = remover_acentos(desc)
    desc = re.sub(r'^[^\w\d\*\.]+', '', desc)
    desc = re.sub(r'^\s*\d{1,2}/\d{1,2}(?:/\d{2,4})?\s+', '', desc)
    desc = re.sub(r'\b\d{1,2}\s+DE\s+\d{1,2}\b', '', desc, flags=re.IGNORECASE)
    desc = re.sub(r'(\d{1,2})/(\d{1,2})', '', desc)
    desc = re.sub(r'[@\*\.]+', ' ', desc)
    desc = re.sub(r'\s+', ' ', desc).strip()
    return desc

class AnalisadorFaturaPDF:
    def __init__(self, caminho_pdf: str):
        self.caminho_pdf = caminho_pdf
        self.texto_completo = ""
        self.paginas_texto_layout = []
        self.paginas_tabelas = []
        self._carregar_pdf()

    def _carregar_pdf(self):
        with pdfplumber.open(self.caminho_pdf) as pdf:
            for i, page in enumerate(pdf.pages):
                layout_txt = page.extract_text(layout=True) or ""
                self.paginas_texto_layout.append(layout_txt)
                self.texto_completo += f"\n--- PAGINA {i+1} ---\n" + layout_txt
                
                # Tabelas se existirem
                try:
                    tables = page.extract_tables()
                    if tables:
                        self.paginas_tabelas.extend(tables)
                except Exception:
                    pass

    def identificar_emissor(self) -> str:
        t_upper = self.texto_completo.upper()
        if "SANTANDER" in t_upper:
            return "Santander"
        if "ITAU" in t_upper or "ITAÚ" in t_upper or "PERSONNALITE" in t_upper or "CREDICARD" in t_upper:
            return "Itau"
        if "NUBANK" in t_upper or "NU PAGAMENTOS" in t_upper:
            return "Nubank"
        if "CAIXA ECONOMICA" in t_upper or "CAIXA ECONÔMICA" in t_upper or "CARTÕES CAIXA" in t_upper or "CARTÃO CAIXA" in t_upper or "CARTAO CAIXA" in t_upper or "COMPRAS PARCELADAS (CARTÃO" in t_upper or "COMPRAS PARCELADAS (CARTAO" in t_upper:
            return "Caixa Economica"
        if "BANCO DO BRASIL" in t_upper or "OUROCARD" in t_upper:
            return "Banco do Brasil"
        if "BRADESCO" in t_upper or "BRADESCARD" in t_upper:
            return "Bradesco"
        if "BANCO INTER" in t_upper or "INTER DTVM" in t_upper:
            return "Inter"
        if "C6 BANK" in t_upper or "C6 S.A." in t_upper:
            return "C6 Bank"
        if "SICOOB" in t_upper:
            return "Sicoob"
        if "SICREDI" in t_upper:
            return "Sicredi"
        if "XP INVESTIMENTOS" in t_upper or "BANCO XP" in t_upper:
            return "XP"
        if "BTG PACTUAL" in t_upper:
            return "BTG Pactual"
        return "Cartao de Credito"

    def extrair_totais_e_vencimento(self) -> Dict[str, Any]:
        emissor = self.identificar_emissor()
        vencimento = ""
        total_fatura = 0.0
        limite_total = 0.0
        
        # Suporte específico ao Itaú (linha com 3 colunas)
        m_itau_header = re.search(r'O\s*total\s*da\s*sua\s*fatura[^\n]*\n\s*(?:R\$\s*)?([\d\.,]+)\s+([0-3]?\d/[0-1]\d/\d{4})\s+(?:R\$\s*)?([\d\.,]+)', self.texto_completo, re.IGNORECASE)
        if m_itau_header:
            total_fatura = parse_valor_brasileiro(m_itau_header.group(1))
            vencimento = m_itau_header.group(2)
            limite_total = parse_valor_brasileiro(m_itau_header.group(3))

        # 1. Total a Pagar / Total da Fatura
        if total_fatura <= 0:
            patterns_total = [
                r'VALOR\s+TOTAL\s+(?:DA|DESTA)\s+FATURA[^\d\n]*\n?\s*(?:R\$\s*)?([\d\.,]+)',
                r'Total\s+a\s+Pagar[^\n]*\n\s*R\$\s*([\d\.,]+)',
                r'fatura\s+no\s+valor\s+de[^\d\n]*\n?\s*(?:R\$\s*)?([\d\.,]+)',
                r'=\s*Total\s*desta\s*fatura\s+([\d\.,]+)',
                r'Pagamento\s+Total\s+R\$\s*([\d\.,]+)',
                r'Total\s+desta\s+fatura[^\n]*\n\s*R\$\s*([\d\.,]+)',
                r'VALOR\s+TOTAL\s+DA\s+FATURA[^\d]*([\d\.,]+)',
                r'Total\s+a\s+pagar\s*:\s*R\$\s*([\d\.,]+)',
                r'Total\s+da\s+sua\s+fatura[^\n]*\n\s*R\$\s*([\d\.,]+)',
                r'Saldo\s+Desta\s+Fatura\s+([\d\.,]+)'
            ]
            for pat in patterns_total:
                m = re.search(pat, self.texto_completo, re.IGNORECASE)
                if m:
                    total_fatura = parse_valor_brasileiro(m.group(1))
                    if total_fatura > 0:
                        break

        # 2. Vencimento
        if not vencimento:
            patterns_venc = [
                r'Data\s+de\s+[Vv]encimento\s*:\s*([0-3]?\d\s+[A-Za-z]{3}\s+\d{4})',
                r'Vencimento[^\n]*\n[^\n]*?\b(\d{2}/\d{2}/\d{4})\b',
                r'Data\s+de\s+Vencimento\s*:\s*(\d{2}/\d{2}/\d{4})',
                r'Com\s*vencimento\s*em\s*:?\s*(\d{2}/\d{2}/\d{4})',
                r'Vencimento\s*:\s*(\d{2}/\d{2}/\d{4})',
                r'Vence\s+em\s*:\s*(\d{2}/\d{2}/\d{4})',
                r'VENCIMENTO\s+([0-3]\d/[0-1]\d/\d{4})'
            ]
            for pat in patterns_venc:
                m = re.search(pat, self.texto_completo, re.IGNORECASE)
                if m:
                    v_raw = m.group(1)
                    m_txt = re.search(r'([0-3]?\d)\s+([A-Za-z]{3,9})\s+(\d{4})', v_raw)
                    if m_txt:
                        meses_map = {"JAN": "01", "FEV": "02", "MAR": "03", "ABR": "04", "MAI": "05", "JUN": "06", "JUL": "07", "AGO": "08", "SET": "09", "OUT": "10", "NOV": "11", "DEZ": "12"}
                        vencimento = f"{int(m_txt.group(1)):02d}/{meses_map.get(m_txt.group(2).upper(), '01')}/{m_txt.group(3)}"
                    else:
                        vencimento = v_raw
                    break

        # 3. Limite Total
        if limite_total <= 0:
            patterns_limite = [
                r'Limite\s*total\s*(?:do\s*cart[ãa]o\s*de\s*cr[ée]dito|de\s*cr[ée]dito)?\s*:?[^\d\n]*\n?\s*(?:R\$\s*)?([\d\.,]+)',
                r'Limite\s+Total\s*[\-]+[^\d\n]*R\$\s*([\d\.,]+)',
                r'Limite\s+(?:de\s+cr[ée]dito\s+)?total[^\d\n]*R\$\s*([\d\.,]+)',
                r'Limite\s+Total\s+de\s+Cr[ée]dito\s*:\s*R\$\s*([\d\.,]+)',
                r'Limite\s+de\s+Cr[ée]dito\s+Concedido\s+R\$\s*([\d\.,]+)',
                r'Limite\s+Global[^\d\n]*R\$\s*([\d\.,]+)',
                r'Limite\s+Total[^\n]*\n[^\n]*?R\$\s*([\d\.,]+)',
                r'Limite\s+de\s+Cr[ée]dito[^\n]*?R\$\s*([\d\.,]+)'
            ]
            for pat in patterns_limite:
                m = re.search(pat, self.texto_completo, re.IGNORECASE)
                if m:
                    limite_total = parse_valor_brasileiro(m.group(1))
                    if limite_total > 0:
                        break

        mes_ref = formatar_mes_referencia(vencimento if vencimento else self.texto_completo[:1500])

        return {
            "emissor": emissor,
            "total_fatura": total_fatura,
            "limite_total": limite_total,
            "vencimento": vencimento,
            "mes_referencia": mes_ref
        }

    def extrair_titulares_e_cartoes(self) -> List[Dict[str, str]]:
        cartoes = []
        vistos = set()
        emissor = self.identificar_emissor()

        # 1. Nubank
        if "NUBANK" in emissor.upper():
            m_tit_nu = re.search(r'([A-Z\s]{3,40})\n\s*FATURA\s+\d{1,2}\s+[A-Z]{3}\s+\d{4}', self.texto_completo)
            tit_nu = m_tit_nu.group(1).strip() if m_tit_nu else "Titular Nubank"
            cartoes.append({
                "titular": tit_nu,
                "final": "NUBANK",
                "numero_mascarado": f"Nubank Mastercard - {tit_nu}"
            })
            return cartoes

        # 2. Caixa: "CAMILA MARIA S AGUIAR (Cartão 1945)"
        matches_caixa = re.findall(
            r'([A-Z\s]{3,35})\s+\((?:Cart[ãa]o|Final)\s*(\d{4})\)',
            self.texto_completo, re.IGNORECASE
        )
        for tit_raw, final_4 in matches_caixa:
            tit = tit_raw.strip()
            if len(tit) > 3 and "COMPRAS" not in tit.upper() and "TOTAL" not in tit.upper() and "PAGAMENTO" not in tit.upper():
                if (tit, final_4) not in vistos:
                    vistos.add((tit, final_4))
                    cartoes.append({
                        "titular": tit,
                        "final": final_4,
                        "numero_mascarado": f"Cartão Caixa {final_4} ({tit})"
                    })

        # 3. Santander / Itaú com número mascarado completo: "5480 XXXX XXXX 4108" ou "2233.XXXX.XXXX.6402"
        matches_mascarados = re.findall(
            r'(?:([A-Z\s]{3,35})\s*-\s*)?(?:Cart[ãa]o\s*)?(\d{4}[\s\.]+(?:XXXX[\s\.]+){2}(\d{4}))',
            self.texto_completo, re.IGNORECASE
        )
        for titular_raw, num_formatado, final_4 in matches_mascarados:
            titular = (titular_raw or "").strip()
            titular = re.sub(r'^(?:SANTANDER|CARTAO|CARTÃO|TITULAR|ITAU|ITAÚ)\s+', '', titular, flags=re.IGNORECASE).strip()
            if not titular:
                m_tit_itau = re.search(r'Titular\s+([A-Z\s]{3,35})', self.texto_completo, re.IGNORECASE)
                titular = m_tit_itau.group(1).strip() if m_tit_itau else "Titular"

            if final_4 and (titular, final_4) not in vistos:
                vistos.add((titular, final_4))
                cartoes.append({
                    "titular": titular,
                    "final": final_4,
                    "numero_mascarado": num_formatado
                })

        # 4. Outros bancos: "Final XXXX" ou "Cartão com final XXXX"
        if not cartoes:
            matches_genericos = re.findall(r'(?:final|cart[ãa]o)\s*(?:n[ºo]\.?)?\s*[:\.]?\s*(\d{4})\b', self.texto_completo, re.IGNORECASE)
            for f in matches_genericos:
                if f not in vistos:
                    vistos.add(f)
                    cartoes.append({
                        "titular": "Titular",
                        "final": f,
                        "numero_mascarado": f"XXXX XXXX XXXX {f}"
                    })

        return cartoes

    def extrair_parcelas(self, mes_referencia: str, emissor_nome: str) -> List[Dict[str, Any]]:
        parcelas_extraidas = []
        chaves_duplicatas = set()

        # Rastreia titular corrente conforme lê o texto linha por linha
        titular_atual = ""
        final_atual = ""

        linhas = self.texto_completo.split('\n')
        for linha in linhas:
            linha_strip = linha.strip()
            if not linha_strip:
                continue

            # Detecta mudança de seção de titular (Ex: "CAMILA M S AGUIAR - 5480 XXXX XXXX 4108")
            m_sec = re.search(r'([A-Z\s]{3,35})\s*-\s*\d{4}\s+XXXX\s+XXXX\s+(\d{4})', linha_strip)
            if m_sec:
                titular_atual = re.sub(r'^(?:SANTANDER|CARTAO|CARTÃO)\s+', '', m_sec.group(1), flags=re.IGNORECASE).strip()
                final_atual = m_sec.group(2)
                continue

            # Detecta titular e cartão Caixa: "CAMILA MARIA S AGUIAR (Cartão 1945)"
            m_sec_cx_tit = re.search(r'([A-Z\s]{3,35})\s+\((?:Cart[ãa]o|Final)\s*(\d{4})\)', linha_strip)
            if m_sec_cx_tit and "COMPRAS" not in linha_strip.upper() and "TOTAL" not in linha_strip.upper() and "PAGAMENTO" not in linha_strip.upper():
                titular_atual = m_sec_cx_tit.group(1).strip()
                final_atual = m_sec_cx_tit.group(2)
                continue

            # Detecta cartão Caixa/genérico: "COMPRAS PARCELADAS (Cartão 1945)" ou "(Cartão 1945)" ou "Cartão 1945"
            m_sec_cx = re.search(r'(?:Cart[ãa]o|Final)\s*(\d{4})\)?', linha_strip, re.IGNORECASE)
            if m_sec_cx and not re.search(r'TOTAL|SUBTOTAL|PAGAMENTO|FATURA', linha_strip, re.IGNORECASE):
                final_atual = m_sec_cx.group(1)

            # Detecta cartão Itaú: "Cartão 2233.XXXX.XXXX.6402"
            m_itau_c = re.search(r'\d{4}[\s\.]+(?:XXXX[\s\.]+){2}(\d{4})', linha_strip)
            if m_itau_c:
                final_atual = m_itau_c.group(1)

            # Detecta titular Itaú/outros: "CAMILA M S AGUIAR (final 4361)" ou "CAMILA M S AGUIAR - final 4361"
            m_sec_itau = re.search(r'([A-Z\s]{3,35})\s*(?:\(|\-\s*)(?:final\s+)?(\d{4})\)?', linha_strip, re.IGNORECASE)
            if m_sec_itau and "LANÇAMENTOS" not in linha_strip.upper() and "TOTAL" not in linha_strip.upper() and "COMPRAS" not in linha_strip.upper():
                titular_cand = re.sub(r'^(?:SANTANDER|CARTAO|CARTÃO|ITAU|ITAÚ)\s+', '', m_sec_itau.group(1), flags=re.IGNORECASE).strip()
                if len(titular_cand) > 3 and not re.search(r'TOTAL|SUBTOTAL|PAGAMENTO|FATURA', titular_cand, re.IGNORECASE):
                    titular_atual = titular_cand
                    final_atual = m_sec_itau.group(2)
                    continue

            # Ignora se for pagamento ou resumo
            if "PAGAMENTO DE FATURA" in linha_strip.upper() or "TOTAL DA FATURA" in linha_strip.upper() or "LANÇAMENTOS NO CARTÃO" in linha_strip.upper():
                continue

            # Regex 1: Formato com data, descrição, parcela XX/YY e valor
            # Suporta @ opcional (ex: '@23/08 LATAM AIR 06/10 122,10' ou '@15/09 FARMAFORMULA SOBRA05/06 250,00')
            regex_tabela = re.search(r'(?:^|[^\d@])@?(\d{2}/\d{2})\s+([A-Z0-9\*\.\-\s\/]{2,35}?)(?:\s+|(?<=[A-Za-z]))(\d{1,2})/(\d{1,2})\s+([\d\.,]+)', linha_strip)
            if regex_tabela:
                data_compra = regex_tabela.group(1)
                desc_raw = regex_tabela.group(2).strip()
                p_atual = int(regex_tabela.group(3))
                p_total = int(regex_tabela.group(4))
                val_raw = regex_tabela.group(5)
                valor = parse_valor_brasileiro(val_raw)

                if 2 <= p_total <= 72 and 1 <= p_atual <= p_total and valor > 0:
                    desc_limpa = limpar_descricao_compra(desc_raw)
                    desc_norm = re.sub(r'\W+', '', desc_limpa.upper())[:15]
                    sig = (desc_norm, p_total, f"{valor:.2f}")

                    if sig not in chaves_duplicatas:
                        chaves_duplicatas.add(sig)
                        categoria = categorizar_descricao(desc_limpa)
                        proximos = calcular_proximos_meses(mes_referencia, p_atual, p_total, valor)
                        
                        parcelas_extraidas.append({
                            "descricao": desc_limpa,
                            "categoria": categoria,
                            "cartao": emissor_nome,
                            "final_cartao": final_atual,
                            "titular": titular_atual or "Principal",
                            "data_compra": data_compra,
                            "parcela_atual": p_atual,
                            "total_parcelas": p_total,
                            "parcelas_restantes": p_total - p_atual,
                            "valor_parcela": valor,
                            "mes_referencia": mes_referencia,
                            "proximos_meses": proximos
                        })
                continue

            # Regex 2: Formato Caixa / BB ("XX DE YY")
            # Ex: "02/02 CONFEC VI KI 01 DE 02 SAO PAULO 432,00D" ou "COMPRA LOJA 03 DE 06 R$ 150,00"
            regex_de = re.search(
                r'\b(\d{2}/\d{2}(?:/\d{2,4})?)\s+'
                r'([A-Z0-9\*\.\-\s\/]{2,35}?)\s+'
                r'(\d{1,2})\s+DE\s+(\d{1,2})'
                r'(?:\s+[A-Z\s\/\.]{2,25})?\s+'
                r'(?:R\$\s*)?([\d\.,]+)\s*[DC]?',
                linha_strip, re.IGNORECASE
            )
            if not regex_de:
                regex_de = re.search(
                    r'([A-Z0-9\*\.\-\s\/]{3,35}?)\s+'
                    r'(\d{1,2})\s+DE\s+(\d{1,2})'
                    r'(?:\s+[A-Z\s\/\.]{2,25})?\s+'
                    r'(?:R\$\s*)?([\d\.,]+)\s*[DC]?',
                    linha_strip, re.IGNORECASE
                )
                if regex_de:
                    data_compra_de = ""
                    desc_raw = regex_de.group(1).strip()
                    p_atual = int(regex_de.group(2))
                    p_total = int(regex_de.group(3))
                    val_raw = regex_de.group(4)
                    valor = parse_valor_brasileiro(val_raw)
            else:
                data_compra_de = regex_de.group(1) or ""
                desc_raw = regex_de.group(2).strip()
                p_atual = int(regex_de.group(3))
                p_total = int(regex_de.group(4))
                val_raw = regex_de.group(5)
                valor = parse_valor_brasileiro(val_raw)

                if 2 <= p_total <= 72 and 1 <= p_atual <= p_total and valor > 0:
                    desc_limpa = limpar_descricao_compra(desc_raw)
                    desc_norm = re.sub(r'\W+', '', desc_limpa.upper())[:15]
                    sig = (desc_norm, p_total, f"{valor:.2f}")
                    if sig not in chaves_duplicatas:
                        chaves_duplicatas.add(sig)
                        categoria = categorizar_descricao(desc_limpa)
                        proximos = calcular_proximos_meses(mes_referencia, p_atual, p_total, valor)

                        parcelas_extraidas.append({
                            "descricao": desc_limpa,
                            "categoria": categoria,
                            "cartao": emissor_nome,
                            "final_cartao": final_atual,
                            "titular": titular_atual or "Principal",
                            "data_compra": data_compra_de,
                            "parcela_atual": p_atual,
                            "total_parcelas": p_total,
                            "parcelas_restantes": p_total - p_atual,
                            "valor_parcela": valor,
                            "mes_referencia": mes_referencia,
                            "proximos_meses": proximos
                        })
                continue

            # Regex 3: Formato Nubank: "19 MAI Kornet - Parcela 1/3 R$ 781,00"
            m_nubank = re.search(r'(?:(\d{1,2})\s+([A-Za-z]{3})\s+)?(.*?)\s*-\s*Parcela\s+(\d{1,2})/(\d{1,2})\s+(?:R\$\s*)?([\d\.,]+)', linha_strip, re.IGNORECASE)
            if m_nubank:
                dia_nu, mes_nu_txt, desc_raw, p_atual_str, p_total_str, val_raw = m_nubank.groups()
                p_atual = int(p_atual_str)
                p_total = int(p_total_str)
                valor = parse_valor_brasileiro(val_raw)
                
                meses_dic = {"JAN": "01", "FEV": "02", "MAR": "03", "ABR": "04", "MAI": "05", "JUN": "06", "JUL": "07", "AGO": "08", "SET": "09", "OUT": "10", "NOV": "11", "DEZ": "12"}
                data_nu = f"{dia_nu}/{meses_dic.get(mes_nu_txt.upper(), mes_nu_txt)}" if dia_nu and mes_nu_txt else ""

                if 2 <= p_total <= 72 and 1 <= p_atual <= p_total and valor > 0:
                    desc_limpa = limpar_descricao_compra(desc_raw)
                    desc_norm = re.sub(r'\W+', '', desc_limpa.upper())[:15]
                    sig = (desc_norm, p_total, f"{valor:.2f}")

                    if sig not in chaves_duplicatas:
                        chaves_duplicatas.add(sig)
                        categoria = categorizar_descricao(desc_limpa)
                        proximos = calcular_proximos_meses(mes_referencia, p_atual, p_total, valor)

                        parcelas_extraidas.append({
                            "descricao": desc_limpa,
                            "categoria": categoria,
                            "cartao": emissor_nome,
                            "final_cartao": final_atual or "NUBANK",
                            "titular": titular_atual or "Principal",
                            "data_compra": data_nu,
                            "parcela_atual": p_atual,
                            "total_parcelas": p_total,
                            "parcelas_restantes": p_total - p_atual,
                            "valor_parcela": valor,
                            "mes_referencia": mes_referencia,
                            "proximos_meses": proximos
                        })
                continue

            # Regex 4: Formato Geral ("PARC 02/05" ou "Compra em 10x - Parcela 3")
            regex_gen = re.search(r'([A-Z0-9\*\.\-\s]{3,35}?)\s+(?:PARC(?:ELA)?\.?\s*|\(?)\b(\d{1,2})/(\d{1,2})\)?\s+(?:R\$\s*)?([\d\.,]+)', linha_strip, re.IGNORECASE)
            if regex_gen:
                desc_raw = regex_gen.group(1).strip()
                p_atual = int(regex_gen.group(2))
                p_total = int(regex_gen.group(3))
                val_raw = regex_gen.group(4)
                valor = parse_valor_brasileiro(val_raw)

                if 2 <= p_total <= 72 and 1 <= p_atual <= p_total and valor > 0:
                    desc_limpa = limpar_descricao_compra(desc_raw)
                    desc_norm = re.sub(r'\W+', '', desc_limpa.upper())[:15]
                    sig = (desc_norm, p_total, f"{valor:.2f}")

                    if sig not in chaves_duplicatas:
                        chaves_duplicatas.add(sig)
                        categoria = categorizar_descricao(desc_limpa)
                        proximos = calcular_proximos_meses(mes_referencia, p_atual, p_total, valor)

                        parcelas_extraidas.append({
                            "descricao": desc_limpa,
                            "categoria": categoria,
                            "cartao": emissor_nome,
                            "final_cartao": final_atual,
                            "titular": titular_atual or "Principal",
                            "data_compra": "",
                            "parcela_atual": p_atual,
                            "total_parcelas": p_total,
                            "parcelas_restantes": p_total - p_atual,
                            "valor_parcela": valor,
                            "mes_referencia": mes_referencia,
                            "proximos_meses": proximos
                        })

        return parcelas_extraidas

    def processar(self) -> Dict[str, Any]:
        totais = self.extrair_totais_e_vencimento()
        cartoes = self.extrair_titulares_e_cartoes()
        
        final_principal = ""
        titular_principal = ""
        if cartoes:
            final_principal = cartoes[0]["final"]
            titular_principal = cartoes[0]["titular"]

        parcelas = self.extrair_parcelas(totais["mes_referencia"], totais["emissor"])
        
        # Se as parcelas não pegaram o final do cartão, preenche com o principal
        for p in parcelas:
            if not p.get("final_cartao"):
                p["final_cartao"] = final_principal

        valor_total_parcelas = sum(p["valor_parcela"] for p in parcelas)
        comprometimento_futuro = sum(p["valor_parcela"] * p["parcelas_restantes"] for p in parcelas)

        resultado_dict = {
            "sucesso": True,
            "arquivo": os.path.basename(self.caminho_pdf),
            "banco": totais["emissor"],
            "final_cartao": final_principal,
            "titular": titular_principal,
            "total_fatura": totais["total_fatura"],
            "limite_total": totais["limite_total"],
            "vencimento": totais["vencimento"],
            "mes_referencia": totais["mes_referencia"],
            "cartoes_adicionais": cartoes,
            "parcelas": parcelas,
            "resumo": {
                "qtd_parcelas": len(parcelas),
                "valor_total_parcelas_mes": round(valor_total_parcelas, 2),
                "comprometimento_futuro_total": round(comprometimento_futuro, 2)
            }
        }
        return sanitizar_estrutura_sem_acentos(resultado_dict)


def processar_arquivo_fatura(caminho_pdf: str) -> Dict[str, Any]:
    try:
        analisador = AnalisadorFaturaPDF(caminho_pdf)
        return analisador.processar()
    except Exception as e:
        return {
            "sucesso": False,
            "arquivo": os.path.basename(caminho_pdf),
            "erro": str(e)
        }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"erro": "Informe o caminho do arquivo PDF. Ex: python parser_faturas.py fatura.pdf"}))
        sys.exit(1)
        
    caminho = sys.argv[1]
    if not os.path.exists(caminho):
        print(json.dumps({"erro": f"Arquivo não encontrado: {caminho}"}))
        sys.exit(1)

    resultado = processar_arquivo_fatura(caminho)
    print(json.dumps(resultado, ensure_ascii=False, indent=2))
