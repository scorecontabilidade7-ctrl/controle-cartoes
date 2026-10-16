#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Score Cards • Motor de Inteligência Artificial para Faturas e Projeção Transacional
Suporta Google Gemini (google-genai) e Groq (groq).
Lê faturas em PDF de múltiplos bancos (Bradesco, Itaú, Caixa, Stone, Nubank, Santander, etc.),
identifica múltiplos cartões/portadores por fatura e projeta desembolsos mês a mês.
"""

import sys
import os
import json
import re
import unicodedata
from datetime import datetime
from typing import Dict, List, Any, Optional
import pdfplumber
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

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

PROMPT_MESTRE = """
Você é um motor contábil e financeiro especializado em faturas de cartões de crédito brasileiros (Bradesco, Itaú, Caixa, Stone, Nubank, Santander, Banco do Brasil, Inter, C6, etc.).
Sua tarefa é analisar o texto da fatura em PDF, identificar o banco, os dados da fatura e extrair com extrema precisão os cartões presentes e TODAS as compras parceladas.

Regras Estritas de Extração:
1. Uma fatura pode conter múltiplos cartões (ex: adicionais, titulares diferentes, cartões virtuais ou múltiplos portadores). Identifique cada cartão pelos 4 últimos dígitos e/ou pelo nome do portador.
2. Identifique o Mês de Referência da fatura (formato YYYY-MM) e a Data de Vencimento (formato DD/MM/YYYY). Se não houver data explícita de vencimento, deduza pelo mês das compras.
3. Capture APENAS transações que possuam parcelamento explícito no texto (ex: "06/10", "2 de 6", "(03/12)", "PARC 02/05", "1/3", "01 DE 02").
4. ATENÇÃO CRÍTICA PARA 'parcela_atual' e 'parcela_total':
   - No formato com barra (ex: '06/10', '01/02', '1/3'): o número ANTES da barra é a parcela atual cobrada nesta fatura e o número APÓS a barra é o total de parcelas (ex: em '06/10', parcela_atual = 6 e parcela_total = 10; em '01/02', parcela_atual = 1 e parcela_total = 2).
   - No formato 'XX DE YY' ou 'XX de YY' (comum na CAIXA ECONÔMICA e BANCO DO BRASIL, ex: '01 DE 02', '03 DE 04', '04 DE 04'):
     * O primeiro número é a PARCELA ATUAL cobrada nesta fatura e o segundo número é o TOTAL DE PARCELAS.
     * Exemplos obrigatórios:
       - '01 DE 02' -> parcela_atual: 1, parcela_total: 2 (RESTANTE A PAGAR: 1 parcela futura!)
       - '03 DE 04' -> parcela_atual: 3, parcela_total: 4
       - '04 DE 04' -> parcela_atual: 4, parcela_total: 4 (última parcela)
       - '02 DE 02' -> parcela_atual: 2, parcela_total: 2 (última parcela)
     * NUNCA confunda a DATA da compra no início da linha (ex: '02/02 CONFEC VI KI 01 DE 02') com a parcela! A data '02/02' é o dia 02 de fevereiro, NÃO é a parcela! A parcela deste lançamento é expressamente '01 DE 02' (parcela_atual = 1 e parcela_total = 2).
5. REGRA ANTI-DUPLICAÇÃO OBRIGATÓRIA:
   - Faturas bancárias brasileiras (especialmente Itaú, Santander, Bradesco) frequentemente repetem as mesmas compras em duas seções do PDF: uma vez no quadro de 'Próximas Faturas / Parcelamentos Futuros / Resumo' e outra vez no 'Detalhamento de Lançamentos da Fatura'.
   - NUNCA DUPLIQUE compras! Se o mesmo estabelecimento tiver o mesmo valor de parcela e mesma quantidade total de parcelas, retorne APENAS UMA VEZ no JSON.
6. IGNORE compras à vista, pagamentos de fatura anterior, juros, encargos, créditos ou saldo anterior.
7. Em 'estabelecimento', limpe o texto removendo datas, símbolos soltos (@, *, .) e o indicador de parcela (ex: "3 09/04 CLINICA CAETANO 01/03" -> "CLINICA CAETANO", "02/02 CONFEC VI KI 01 DE 02" -> "CONFEC VI KI", "FARMAFORMULA SOBRA05/06" -> "FARMAFORMULA SOBRA").
8. Padronize números no formato float (ex: 1250.50).
9. Sugira uma categoria financeira contabil SEMPRE SEM ACENTO para o estabelecimento (ex: "Alimentacao", "Saude & Farmacia", "Vestuario", "Transporte", "Viagens & Lazer", "Tecnologia", "Servicos", "Operacional/PJ", "Outros"). NUNCA use acentos ou cedilha em nenhum texto (use sempre sem acento: Saude, Farmacia, Alimentacao, Vestuario, Servicos, Outros Lancamentos, etc.).

Formato dos Principais Bancos Brasileiros (Guia de Reconhecimento):
- CAIXA ECONÔMICA: Sob a seção 'COMPRAS PARCELADAS (Cartão XXXX)', linhas com colunas 'Data | Descrição | Cidade/País | Valor | Crédito/Débito'. Linhas como '02/02 CONFEC VI KI 01 DE 02 SAO PAULO 432,00D' -> data_compra: '02/02', estabelecimento: 'CONFEC VI KI', parcela_atual: 1, parcela_total: 2, valor_parcela: 432.00. Em '01/12 BY PICLE 03 DE 04 SAO PAULO 679,75D' -> data_compra: '01/12', estabelecimento: 'BY PICLE', parcela_atual: 3, parcela_total: 4, valor_parcela: 679.75.
- ITAÚ: Pode ter a seção 'Compras parceladas - próximas faturas' ou no extrato com linhas como '@23/08 LATAM AIR 06/10 122,10' ou 'FARMAFORMULA SOBRA05/06 250,00'. Parcela atual: 6 (ou 5), Total: 10 (ou 6). Não duplique se aparecer no resumo e no extrato.
- SANTANDER: Sob o portador (ex: '@ TITULAR - 4258 XXXX XXXX 2170'), tem a seção 'Parcelamentos' com colunas 'Compra | Data | Descrição | Parcela | R$'. CUIDADO COM A COLUNA 'Compra': o número no início (1, 2, 3...) é apenas a ordem/linha da compra, NUNCA é a parcela! A parcela é SEMPRE a coluna 'Parcela' (ex: '3 27/12 JIM COM* YANA LAIS PA 06/06 50,00' -> a parcela atual é 6 e total é 6, NUNCA coloque parcela_atual: 3!).
- NUBANK: Sob 'TRANSAÇÕES', compras parceladas vêm no formato 'Nome Estabelecimento - Parcela X/Y' (ex: 'Kornet - Parcela 1/3 R$ 781,00' ou 'Drogasil - Parcela 1/3 R$ 38,68'). Ignore compras à vista sem o termo '- Parcela'.
- BRADESCO: 'PARC 02/05 LOJA ZARA R$ 150,00' ou '02/05' sob 'Demonstrativo de Gastos'.

Formato de Saída Obrigatório (JSON estrito sem acentos):
{
  "banco": "Nome do Banco sem acento (Ex: Santander, Itau, Caixa Economica, Bradesco, Nubank, Stone)",
  "mes_referencia": "YYYY-MM",
  "vencimento": "DD/MM/YYYY",
  "total_fatura": 0.0,
  "limite_total": 0.0,
  "cartoes": [
    {
      "identificador_cartao": "Final XXXX ou Nome do Portador",
      "titular": "Nome do Portador se identificado sem acentos",
      "final_4": "XXXX",
      "compras_parceladas": [
        {
          "estabelecimento": "Nome Limpo do Estabelecimento sem acento",
          "categoria": "Categoria Sugerida sem acento (Ex: Alimentacao, Saude & Farmacia, etc.)",
          "data_compra": "DD/MM se visivel",
          "parcela_atual": 6,
          "parcela_total": 10,
          "valor_parcela": 125.50
        }
      ]
    }
  ]
}
"""

class AnalisadorFaturasIA:
    def __init__(self, caminho_pdf: str, provedor: str = "gemini", api_key: Optional[str] = None):
        self.caminho_pdf = caminho_pdf
        self.provedor = (provedor or "gemini").lower()
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY" if self.provedor == "gemini" else "GROQ_API_KEY")

    def extrair_texto_pdf(self) -> str:
        texto = ""
        with pdfplumber.open(self.caminho_pdf) as pdf:
            for i, pagina in enumerate(pdf.pages):
                # Extrai texto com layout preservado
                txt_pag = pagina.extract_text(layout=True) or ""
                texto += f"\n--- PÁGINA {i+1} ---\n" + txt_pag
        return texto.strip()

    def processar_com_gemini(self, texto_bruto: str) -> Dict[str, Any]:
        if not self.api_key:
            raise ValueError("Chave de API do Google Gemini (GEMINI_API_KEY) não informada.")

        from google import genai
        from google.genai import types

        client = genai.Client(api_key=self.api_key)
        conteudo_input = f"{PROMPT_MESTRE}\n\nTexto Extraído da Fatura em PDF:\n{texto_bruto}"

        # Testamos gemini-2.5-flash ou gemini-1.5-flash
        model_name = 'gemini-2.5-flash'
        config = types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.1
        )

        try:
            response = client.models.generate_content(
                model=model_name,
                contents=conteudo_input,
                config=config
            )
            return json.loads(response.text)
        except Exception as e:
            # Fallback para gemini-1.5-flash se 2.5 não estiver liberado na chave
            try:
                response = client.models.generate_content(
                    model='gemini-1.5-flash',
                    contents=conteudo_input,
                    config=config
                )
                return json.loads(response.text)
            except Exception:
                raise e

    def processar_com_groq(self, texto_bruto: str) -> Dict[str, Any]:
        if not self.api_key:
            raise ValueError("Chave de API do Groq (GROQ_API_KEY) não informada.")

        from groq import Groq
        client = Groq(api_key=self.api_key)

        # Pré-filtra o texto para focar em transações e não estourar os limites da cota gratuita (TPM)
        linhas = []
        for l in texto_bruto.split("\n"):
            linha = l.strip()
            if not linha:
                continue
            if re.search(r'cart[aã]o|final|\d{4}\s*-\s*|vencimento|total|fatura|saldo', linha, re.I):
                linhas.append(linha)
            elif re.search(r'\d{2}/\d{2}', linha) and re.search(r'\d+[,\.]\d{2}', linha):
                linhas.append(linha)
        
        texto_otimizado = "\n".join(linhas) if len(linhas) > 10 else texto_bruto[:15000]

        # Modelos disponíveis na API do Groq
        modelos_tentativa = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]
        ultimo_erro = None

        for modelo in modelos_tentativa:
            try:
                chat_completion = client.chat.completions.create(
                    messages=[
                        {"role": "system", "content": "Você é um assistente contábil que extrai faturas e responde EXCLUSIVAMENTE em formato JSON estrito, sem markdown."},
                        {"role": "user", "content": f"{PROMPT_MESTRE}\n\nTexto da Fatura:\n{texto_otimizado}"}
                    ],
                    model=modelo,
                    max_tokens=4096,
                    temperature=0.1
                )
                conteudo = chat_completion.choices[0].message.content or ""
                clean = re.sub(r'^```json\s*', '', conteudo.strip(), flags=re.MULTILINE)
                clean = re.sub(r'```$', '', clean.strip(), flags=re.MULTILINE)
                if clean:
                    return json.loads(clean)
            except Exception as e:
                ultimo_erro = e
                continue

        if ultimo_erro:
            raise ultimo_erro
        raise ValueError("Não foi possível processar a fatura com o Groq.")

    def processar_local(self) -> Dict[str, Any]:
        from parser_faturas import AnalisadorFaturaPDF
        analisador = AnalisadorFaturaPDF(self.caminho_pdf)
        dados = analisador.processar()

        cartoes_dict = {}
        for p in dados.get("parcelas", []):
            id_c = f"Final {p.get('final_cartao', 'XXXX')}"
            if p.get("titular") and p.get("titular") != "Principal":
                id_c += f" - {p.get('titular')}"

            if id_c not in cartoes_dict:
                cartoes_dict[id_c] = {
                    "identificador_cartao": id_c,
                    "titular": p.get("titular", "Titular"),
                    "final_4": p.get("final_cartao", ""),
                    "compras_parceladas": []
                }
            cartoes_dict[id_c]["compras_parceladas"].append({
                "estabelecimento": p.get("descricao"),
                "categoria": remover_acentos(p.get("categoria", "Outros Lancamentos")),
                "data_compra": p.get("data_compra", ""),
                "parcela_atual": p.get("parcela_atual"),
                "parcela_total": p.get("total_parcelas"),
                "valor_parcela": p.get("valor_parcela")
            })

        return sanitizar_estrutura_sem_acentos({
            "banco": remover_acentos(dados.get("banco", "Cartao")),
            "mes_referencia": dados.get("mes_referencia", ""),
            "vencimento": dados.get("vencimento", ""),
            "total_fatura": dados.get("total_fatura", 0.0),
            "limite_total": dados.get("limite_total", 0.0),
            "cartoes": list(cartoes_dict.values())
        })

    def analisar(self) -> Dict[str, Any]:
        # Se o provedor for local OU se não houver chave de API informada, usa o motor local sem travar
        if self.provedor == "local" or not self.api_key:
            dados = self.processar_local()
            if not self.api_key and self.provedor != "local":
                dados["aviso_ia"] = f"Analise realizada via motor local. Para usar a IA do {self.provedor.upper()}, insira sua chave gratuita no botao acima."
            return sanitizar_estrutura_sem_acentos(dados)

        texto = self.extrair_texto_pdf()
        if not texto:
            return self.processar_local()

        try:
            if self.provedor == "groq":
                dados = self.processar_com_groq(texto)
            else:
                dados = self.processar_com_gemini(texto)
        except Exception as e:
            # Em caso de falha de cota, modelo inexistente ou erro da API externa,
            # faz fallback automático para o motor local com aviso claro ao usuário!
            dados = self.processar_local()
            msg_erro = str(e)
            if "model_not_found" in msg_erro or "does not exist" in msg_erro:
                aviso = f"Aviso Groq: o modelo antigo foi descontinuado na API gratuita. Analisado com sucesso via Motor Local!"
            elif "rate_limit_exceeded" in msg_erro or "TPM" in msg_erro or "429" in msg_erro or "413" in msg_erro:
                aviso = f"Aviso Groq: a fatura excedeu o limite por minuto da cota gratuita da Groq. Analisado com sucesso via Motor Local!"
            else:
                aviso = f"Aviso IA ({self.provedor.upper()}): {msg_erro[:100]}. Analisado com sucesso via Motor Local!"
            dados["aviso_ia"] = aviso

        # Validação cruzada com o texto original do PDF para garantir precisão absoluta das parcelas
        dados = validar_e_corrigir_com_texto_pdf(texto, dados)
        return sanitizar_estrutura_sem_acentos(dados)


def extrair_parcela_de_linha_texto(linha: str) -> Optional[tuple]:
    """
    Extrai de forma robusta e precisa a parcela atual e total de uma linha de texto do PDF,
    reconhecendo múltiplos padrões bancários e ignorando datas de compra no início da linha.
    """
    l = linha.strip()

    # 1. Procura formato explícito 'XX DE YY' (ex: Caixa Econômica, Banco do Brasil)
    m_de = re.search(r'\b(\d{1,2})\s+DE\s+(\d{1,2})\b', l, re.IGNORECASE)
    if m_de:
        p_at, p_tot = int(m_de.group(1)), int(m_de.group(2))
        if 2 <= p_tot <= 72 and 1 <= p_at <= p_tot:
            return p_at, p_tot

    # 2. Remove data de compra no início da linha (ex: '02/02', '3 04/04', '@23/08')
    # para evitar que a data seja confundida com a fração de parcelas
    l_sem_data = re.sub(r'^\s*(?:\d+\s+)?@?\d{1,2}/\d{1,2}(?:/\d{2,4})?\s+', '', l)

    # 3. Procura indicador explícito com PARC ou Parcela (ex: 'Parcela 1/3', 'PARC 02/05')
    m_parc = re.search(r'(?:PARC(?:ELA)?\.?\s*|-\s*Parcela\s*)\s*(\d{1,2})/(\d{1,2})', l_sem_data, re.IGNORECASE)
    if m_parc:
        p_at, p_tot = int(m_parc.group(1)), int(m_parc.group(2))
        if 2 <= p_tot <= 72 and 1 <= p_at <= p_tot:
            return p_at, p_tot

    # 4. Procura fração XX/YY no restante da linha (fora da data de compra inicial)
    matches = re.findall(r'(\d{1,2})/(\d{1,2})', l_sem_data)
    for at_str, tot_str in reversed(matches):
        p_at, p_tot = int(at_str), int(tot_str)
        if 2 <= p_tot <= 72 and 1 <= p_at <= p_tot:
            return p_at, p_tot

    return None


def validar_e_corrigir_com_texto_pdf(texto_pdf: str, dados_fatura: Dict[str, Any]) -> Dict[str, Any]:
    """
    Compara cada compra extraída com o texto original do PDF para validar e corrigir
    parcelas que a IA tenha lido incorretamente (ex: confundir número de linha no Santander
    ou confundir a data com a parcela).
    """
    if not texto_pdf:
        return dados_fatura
    linhas = texto_pdf.split('\n')
    
    for c in dados_fatura.get("cartoes", []):
        for compra in c.get("compras_parceladas", []):
            est = compra.get("estabelecimento", "")
            p_atual = compra.get("parcela_atual")
            p_total = compra.get("parcela_total")
            valor_raw = compra.get("valor_parcela", 0.0)
            
            try:
                valor_f = float(valor_raw)
            except Exception:
                valor_f = 0.0

            palavras = [w for w in re.split(r'\W+', est) if len(w) >= 3 and not w.isdigit()]
            if not palavras:
                continue
            termo = palavras[0].upper()
            valor_str = f"{valor_f:.2f}".replace('.', ',')
            valor_num = f"{valor_f:.2f}"

            for l in linhas:
                l_up = l.upper()
                if termo in l_up and (valor_str in l or valor_num in l):
                    res_parc = extrair_parcela_de_linha_texto(l)
                    if res_parc:
                        p_real_at, p_real_tot = res_parc
                        # Se o total de parcelas bater, atualiza com a parcela real da linha
                        if p_total and p_real_tot == p_total:
                            compra["parcela_atual"] = p_real_at
                            break
                        elif not p_total or p_total <= 1:
                            compra["parcela_atual"] = p_real_at
                            compra["parcela_total"] = p_real_tot
                            break

    return dados_fatura


def normalizar_compra_dict(compra: Dict[str, Any]) -> Dict[str, Any]:
    raw_desc = str(compra.get("estabelecimento") or compra.get("descricao") or "")
    p_atual = compra.get("parcela_atual")
    p_total = compra.get("parcela_total") or compra.get("total_parcelas")
    
    # Converte valor para float
    val_raw = compra.get("valor_parcela") or compra.get("valor") or 0.0
    if isinstance(val_raw, str):
        val_limpo = re.sub(r'[^\d,\.]', '', val_raw)
        if ',' in val_limpo:
            val_limpo = val_limpo.replace('.', '').replace(',', '.')
        try:
            valor = float(val_limpo)
        except Exception:
            valor = 0.0
    else:
        try:
            valor = float(val_raw)
        except Exception:
            valor = 0.0

    # 1. Se o nome do estabelecimento contém indicador no formato "XX DE YY" (ex: "CONFEC VI KI 01 DE 02")
    m_parc_de = re.search(r'\b(\d{1,2})\s+DE\s+(\d{1,2})\b', raw_desc, re.IGNORECASE)
    if m_parc_de:
        p_de_atual = int(m_parc_de.group(1))
        p_de_total = int(m_parc_de.group(2))
        if 2 <= p_de_total <= 72 and 1 <= p_de_atual <= p_de_total:
            p_atual = p_de_atual
            p_total = p_de_total

    # 2. Se o nome contém indicador com barra (fora de eventual data inicial)
    desc_sem_data_ini = re.sub(r'^\s*(?:\d+\s+)?@?\d{1,2}/\d{1,2}(?:/\d{2,4})?\s+', '', raw_desc)
    m_parc_nome = re.search(r'(\d{1,2})/(\d{1,2})', desc_sem_data_ini)
    if m_parc_nome and not m_parc_de:
        p_nome_atual = int(m_parc_nome.group(1))
        p_nome_total = int(m_parc_nome.group(2))
        if 2 <= p_nome_total <= 72 and 1 <= p_nome_atual <= p_nome_total:
            if not p_atual or p_atual <= 0:
                p_atual = p_nome_atual
            if not p_total or p_total <= 1:
                p_total = p_nome_total

    # 3. Se veio em formato textual em campos auxiliares como 'parcela', 'parcelas'
    for campo in ["parcela", "parcelas", "parcela_label"]:
        val_campo = str(compra.get(campo) or "")
        m_c_de = re.search(r'\b(\d{1,2})\s+DE\s+(\d{1,2})\b', val_campo, re.IGNORECASE)
        if m_c_de:
            p_atual = int(m_c_de.group(1))
            p_total = int(m_c_de.group(2))
            break
        m_c = re.search(r'(\d{1,2})/(\d{1,2})', val_campo)
        if m_c:
            p_c_atual = int(m_c.group(1))
            p_c_total = int(m_c.group(2))
            if not p_atual or p_atual <= 0:
                p_atual = p_c_atual
            if not p_total or p_total <= 1:
                p_total = p_c_total

    p_atual = int(p_atual or 1)
    p_total = int(p_total or 1)

    # 4. Limpa descrição do estabelecimento removendo prefixo de data e marcadores de parcelamento
    desc_limpa = re.sub(r'^\s*(?:\d+\s+)?@?\d{1,2}/\d{1,2}(?:/\d{2,4})?\s+', '', raw_desc)
    desc_limpa = re.sub(r'\b\d{1,2}\s+DE\s+\d{1,2}\b', '', desc_limpa, flags=re.IGNORECASE)
    desc_limpa = re.sub(r'(\d{1,2})/(\d{1,2})', '', desc_limpa)
    desc_limpa = re.sub(r'[@\*\.]+', ' ', desc_limpa)
    desc_limpa = re.sub(r'\s+', ' ', desc_limpa).strip()
    if not desc_limpa:
        desc_limpa = raw_desc.strip() or "Compra Parcelada"

    desc_limpa = remover_acentos(desc_limpa)
    categoria_limpa = remover_acentos(compra.get("categoria", "Outros Lancamentos"))

    return {
        "estabelecimento": desc_limpa,
        "categoria": categoria_limpa,
        "data_compra": compra.get("data_compra", ""),
        "parcela_atual": p_atual,
        "parcela_total": p_total,
        "valor_parcela": round(valor, 2)
    }


def sanitizar_e_deduplicar_cartoes(dados_fatura: Dict[str, Any]) -> Dict[str, Any]:
    """
    Consolida cartões com identificadores iguais e elimina transações duplicadas
    que frequentemente aparecem em faturas bancárias (Resumo x Detalhamento).
    """
    cartoes_consolidados = {}

    for c in dados_fatura.get("cartoes", []):
        id_c = (c.get("identificador_cartao") or f"Final {c.get('final_4', 'XXXX')}").strip()
        m_final = re.search(r'(\d{4})', id_c)
        chave_cartao = f"final_{m_final.group(1)}" if m_final else id_c.upper()

        if chave_cartao not in cartoes_consolidados:
            cartoes_consolidados[chave_cartao] = {
                "identificador_cartao": id_c,
                "titular": c.get("titular", "Titular"),
                "final_4": c.get("final_4") or (m_final.group(1) if m_final else ""),
                "compras_map": {}
            }

        card_target = cartoes_consolidados[chave_cartao]
        if card_target["titular"] in ["Titular", "Principal"] and c.get("titular") not in ["Titular", "Principal", ""]:
            card_target["titular"] = c.get("titular")

        for compra_raw in c.get("compras_parceladas", []):
            compra_norm = normalizar_compra_dict(compra_raw)
            if compra_norm["valor_parcela"] <= 0:
                continue

            # Assinatura única da transação para anti-duplicação:
            # (nome_limpo_curto, total_parcelas, valor_formatado)
            nome_norm = re.sub(r'\W+', '', compra_norm["estabelecimento"].upper())[:15]
            sig = (nome_norm, compra_norm["parcela_total"], f"{compra_norm['valor_parcela']:.2f}")

            if sig not in card_target["compras_map"]:
                card_target["compras_map"][sig] = compra_norm
            else:
                # Faturas como Itaú e Bradesco mostram compras em 'Lançamentos Atuais' (ex: 02/03)
                # e repetem em 'Próximas Faturas' (ex: 03/03). A parcela da fatura ATUAL é sempre a menor.
                existente = card_target["compras_map"][sig]
                if compra_norm["parcela_atual"] < existente["parcela_atual"]:
                    card_target["compras_map"][sig] = compra_norm

    lista_final_cartoes = []
    for c_info in cartoes_consolidados.values():
        lista_final_cartoes.append({
            "identificador_cartao": c_info["identificador_cartao"],
            "titular": c_info["titular"],
            "final_4": c_info["final_4"],
            "compras_parceladas": list(c_info["compras_map"].values())
        })

    dados_fatura["cartoes"] = lista_final_cartoes
    return dados_fatura


class ProjetorFinanceiro:
    @staticmethod
    def projetar(dados_fatura: Dict[str, Any], qtd_meses: int = 6) -> Dict[str, Any]:
        """
        Projeta o fluxo futuro com base no mês de referência REAL da fatura,
        distribuindo compras parceladas por Banco ➔ Cartão/Portador com deduplicação.
        """
        # Aplica sanitização e anti-duplicação imediata
        dados_fatura = sanitizar_e_deduplicar_cartoes(dados_fatura)

        banco = remover_acentos(dados_fatura.get("banco", "Cartao"))
        mes_ref_str = dados_fatura.get("mes_referencia", "")
        
        # Determina ano e mês base da fatura
        if mes_ref_str and re.match(r'^\d{4}-\d{2}$', mes_ref_str):
            ano_base, mes_base = map(int, mes_ref_str.split('-'))
        else:
            now = datetime.now()
            ano_base, mes_base = now.year, now.month

        # Determina a quantidade de meses de projeção automaticamente até a última parcela
        max_restantes = 0
        for cartao in dados_fatura.get("cartoes", []):
            for compra in cartao.get("compras_parceladas", []):
                compra_n = normalizar_compra_dict(compra)
                rest = max(0, compra_n["parcela_total"] - compra_n["parcela_atual"])
                if rest > max_restantes:
                    max_restantes = rest

        if qtd_meses is None or qtd_meses <= 0:
            qtd_meses = max(1, max_restantes)

        # Inicializa colunas dos meses de projeção
        colunas_meses = []
        for i in range(1, qtd_meses + 1):
            m_calc = mes_base + i
            a_calc = ano_base
            while m_calc > 12:
                m_calc -= 12
                a_calc += 1
            colunas_meses.append(f"{a_calc}-{m_calc:02d}")

        totais_por_mes = {mes: 0.0 for mes in colunas_meses}
        totais_por_ano = {}
        matriz_cartoes = []
        todas_parcelas_detalhadas = []
        total_comprometimento_futuro = 0.0

        for cartao in dados_fatura.get("cartoes", []):
            id_cartao = remover_acentos(cartao.get("identificador_cartao") or f"Final {cartao.get('final_4', 'XXXX')}")
            titular = remover_acentos(cartao.get("titular", "Titular"))
            compras = cartao.get("compras_parceladas", [])

            valores_mes_cartao = {mes: 0.0 for mes in colunas_meses}
            itens_compras_cartao = []

            for compra in compras:
                compra_norm = normalizar_compra_dict(compra)
                p_atual = compra_norm["parcela_atual"]
                p_total = compra_norm["parcela_total"]
                valor_parc = compra_norm["valor_parcela"]
                estabelecimento = compra_norm["estabelecimento"]
                categoria = compra_norm["categoria"]
                data_compra = compra_norm["data_compra"]

                parcelas_restantes = max(0, p_total - p_atual)
                valor_restante_total = parcelas_restantes * valor_parc
                total_comprometimento_futuro += valor_restante_total

                cronograma_compra = {}
                for i in range(1, parcelas_restantes + 1):
                    m_dest = mes_base + i
                    a_dest = ano_base
                    while m_dest > 12:
                        m_dest -= 12
                        a_dest += 1
                    chave_mes = f"{a_dest}-{m_dest:02d}"

                    if chave_mes in valores_mes_cartao:
                        valores_mes_cartao[chave_mes] += valor_parc
                        totais_por_mes[chave_mes] += valor_parc
                        cronograma_compra[chave_mes] = {
                            "parcela_num": p_atual + i,
                            "parcela_label": f"{p_atual + i}/{p_total}",
                            "valor": valor_parc
                        }

                item_detalhe = {
                    "banco": banco,
                    "cartao": id_cartao,
                    "titular": titular,
                    "estabelecimento": estabelecimento,
                    "categoria": categoria,
                    "data_compra": data_compra,
                    "parcela_atual": p_atual,
                    "parcela_total": p_total,
                    "parcelas_restantes": parcelas_restantes,
                    "valor_parcela": valor_parc,
                    "saldo_restante": round(valor_restante_total, 2),
                    "cronograma": cronograma_compra
                }
                itens_compras_cartao.append(item_detalhe)
                todas_parcelas_detalhadas.append(item_detalhe)

            matriz_cartoes.append({
                "banco": banco,
                "identificador_cartao": id_cartao,
                "titular": titular,
                "qtd_parcelamentos": len(compras),
                "desembolso_meses": {m: round(valores_mes_cartao[m], 2) for m in colunas_meses},
                "total_cartao_futuro": round(sum(valores_mes_cartao[m] for m in colunas_meses), 2),
                "itens": itens_compras_cartao
            })

        for m in colunas_meses:
            ano_col = m.split('-')[0]
            totais_por_ano[ano_col] = round(totais_por_ano.get(ano_col, 0.0) + totais_por_mes[m], 2)

        resultado_proj = {
            "banco": banco,
            "mes_referencia_base": f"{ano_base}-{mes_base:02d}",
            "meses_colunas": colunas_meses,
            "totais_por_mes": {m: round(totais_por_mes[m], 2) for m in colunas_meses},
            "totais_por_ano": totais_por_ano,
            "total_comprometimento_futuro": round(total_comprometimento_futuro, 2),
            "matriz_cartoes": matriz_cartoes,
            "detalhes_parcelas": todas_parcelas_detalhadas
        }
        return sanitizar_estrutura_sem_acentos(resultado_proj)


def gerar_planilha_excel(dados_projecao: Dict[str, Any], caminho_saida: str) -> str:
    """Gera um arquivo Excel estruturado e formatado profissionalmente."""
    pasta_dest = os.path.dirname(os.path.abspath(caminho_saida))
    if pasta_dest:
        os.makedirs(pasta_dest, exist_ok=True)
    wb = openpyxl.Workbook()
    
    # ----------------------------------------------------
    # Aba 1: Matriz Executiva de Projeção
    # ----------------------------------------------------
    ws_matriz = wb.active
    ws_matriz.title = "Projecao Mes a Mes"

    # Estilos
    header_fill = PatternFill(start_color="1E293B", end_color="1E293B", fill_type="solid")
    header_font = Font(name="Segoe UI", size=11, bold=True, color="FFFFFF")
    total_fill = PatternFill(start_color="0F172A", end_color="0F172A", fill_type="solid")
    total_font = Font(name="Segoe UI", size=11, bold=True, color="34D399")
    bold_font = Font(name="Segoe UI", size=10, bold=True)
    regular_font = Font(name="Segoe UI", size=10)
    thin_border = Border(
        left=Side(style='thin', color='E2E8F0'),
        right=Side(style='thin', color='E2E8F0'),
        top=Side(style='thin', color='E2E8F0'),
        bottom=Side(style='thin', color='E2E8F0')
    )

    # Título do Relatório
    ws_matriz.merge_cells("A1:G1")
    ws_matriz["A1"] = f"SCORE TECH • PROJECAO MENSAL DE DESEMBOLSO DE CARTOES ({dados_projecao.get('banco')})"
    ws_matriz["A1"].font = Font(name="Segoe UI", size=14, bold=True, color="0F172A")
    ws_matriz["A1"].alignment = Alignment(vertical="center")

    meses = dados_projecao.get("meses_colunas", [])
    headers = ["Banco", "Portador / Cartao", "Qtd Compras"] + [f"Mes {m}" for m in meses] + ["Total Futuro"]
    ws_matriz.append([])
    ws_matriz.append(headers)

    header_row_idx = 3
    for col_idx, h in enumerate(headers, 1):
        cell = ws_matriz.cell(row=header_row_idx, column=col_idx)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center" if col_idx > 2 else "left", vertical="center")

    # Linhas dos Cartões
    row_idx = 4
    for card in dados_projecao.get("matriz_cartoes", []):
        row_vals = [
            card["banco"],
            card["identificador_cartao"],
            card["qtd_parcelamentos"]
        ]
        for m in meses:
            row_vals.append(card["desembolso_meses"].get(m, 0.0))
        row_vals.append(card["total_cartao_futuro"])

        ws_matriz.append(row_vals)
        for col_idx in range(1, len(headers) + 1):
            c = ws_matriz.cell(row=row_idx, column=col_idx)
            c.font = regular_font
            c.border = thin_border
            if col_idx > 3:
                c.number_format = 'R$ #,##0.00'
                c.alignment = Alignment(horizontal="right")
            elif col_idx == 3:
                c.alignment = Alignment(horizontal="center")
        row_idx += 1

    # Linha Totalizadora
    total_vals = ["TOTAL GERAL", "-", sum(c["qtd_parcelamentos"] for c in dados_projecao.get("matriz_cartoes", []))]
    for m in meses:
        total_vals.append(dados_projecao.get("totais_por_mes", {}).get(m, 0.0))
    total_vals.append(dados_projecao.get("total_comprometimento_futuro", 0.0))

    ws_matriz.append(total_vals)
    for col_idx in range(1, len(headers) + 1):
        c = ws_matriz.cell(row=row_idx, column=col_idx)
        c.fill = total_fill
        c.font = total_font
        c.border = thin_border
        if col_idx > 3:
            c.number_format = 'R$ #,##0.00'
            c.alignment = Alignment(horizontal="right")
        elif col_idx == 3:
            c.alignment = Alignment(horizontal="center")

    # ----------------------------------------------------
    # Aba 2: Detalhamento Individual de Todas as Parcelas
    # ----------------------------------------------------
    ws_itens = wb.create_sheet(title="Todas as Parcelas")
    itens_headers = ["Banco", "Portador / Cartao", "Estabelecimento", "Categoria", "Data", "Parc. Atual", "Parc. Total", "Restantes", "Valor Parcela", "Saldo Restante"]
    ws_itens.append(itens_headers)

    for col_idx, h in enumerate(itens_headers, 1):
        cell = ws_itens.cell(row=1, column=col_idx)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center" if col_idx in [5, 6, 7, 8] else "left")

    row_it_idx = 2
    for item in dados_projecao.get("detalhes_parcelas", []):
        it_vals = [
            item["banco"],
            item["cartao"],
            item["estabelecimento"],
            item["categoria"],
            item["data_compra"],
            item["parcela_atual"],
            item["parcela_total"],
            item["parcelas_restantes"],
            item["valor_parcela"],
            item["saldo_restante"]
        ]
        ws_itens.append(it_vals)
        for c_idx in range(1, len(itens_headers) + 1):
            c = ws_itens.cell(row=row_it_idx, column=c_idx)
            c.font = regular_font
            c.border = thin_border
            if c_idx in [9, 10]:
                c.number_format = 'R$ #,##0.00'
                c.alignment = Alignment(horizontal="right")
            elif c_idx in [5, 6, 7, 8]:
                c.alignment = Alignment(horizontal="center")
        row_it_idx += 1

    # Ajusta largura das colunas automaticamente
    for ws in [ws_matriz, ws_itens]:
        for col in ws.columns:
            max_len = max(len(str(cell.value or '')) for cell in col)
            col_letter = get_column_letter(col[0].column)
            ws.column_dimensions[col_letter].width = max(max_len + 3, 12)

    wb.save(caminho_saida)
    return caminho_saida


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Analisador Inteligente de Faturas e Projeção")
    parser.add_argument("pdf", help="Caminho do arquivo PDF")
    parser.add_argument("--provedor", default="auto", choices=["gemini", "groq", "local", "auto"], help="Provedor de IA ou motor local")
    parser.add_argument("--api-key", default=None, help="Chave de API do provedor")
    parser.add_argument("--meses", type=int, default=0, help="Meses de projeção futura (0 = dinâmico até a última parcela)")
    parser.add_argument("--excel", default=None, help="Caminho para salvar arquivo Excel")

    args = parser.parse_args()

    if not os.path.exists(args.pdf):
        print(json.dumps({"sucesso": False, "erro": f"Arquivo não encontrado: {args.pdf}"}))
        sys.exit(1)

    try:
        analisador = AnalisadorFaturasIA(args.pdf, provedor=args.provedor, api_key=args.api_key)
        dados_fatura = analisador.analisar()
        projecao = ProjetorFinanceiro.projetar(dados_fatura, qtd_meses=args.meses)

        excel_salvo = None
        if args.excel:
            excel_salvo = gerar_planilha_excel(projecao, args.excel)

        resultado = {
            "sucesso": True,
            "fatura": dados_fatura,
            "projecao": projecao,
            "excel_path": excel_salvo
        }
        resultado_limpo = sanitizar_estrutura_sem_acentos(resultado)
        print(json.dumps(resultado_limpo, ensure_ascii=False, indent=2))
    except Exception as e:
        erro_dict = sanitizar_estrutura_sem_acentos({"sucesso": False, "erro": str(e)})
        print(json.dumps(erro_dict, ensure_ascii=False, indent=2))
        sys.exit(1)
