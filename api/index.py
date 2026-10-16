#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Score Cards • API Serverless em Python (Compatível com Vercel)
Substitui o server.js para permitir execução nativa na infraestrutura serverless da Vercel.
"""

import sys
import os
import io
import time
import uuid
import base64
from typing import Optional, Dict, Any, List

# Adiciona o diretório raiz ao sys.path para importar motor_ia_faturas e parser_faturas
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(CURRENT_DIR)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

from fastapi import FastAPI, UploadFile, File, Header, Query, HTTPException, Response
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import requests

from motor_ia_faturas import (
    AnalisadorFaturasIA,
    ProjetorFinanceiro,
    gerar_planilha_excel,
    sanitizar_estrutura_sem_acentos,
    remover_acentos
)

app = FastAPI(title="Score Cards API", description="API de Análise e Projeção de Faturas de Cartões")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configurações do Supabase (Score Tech - ProjectsGerais)
SUPABASE_URL = os.environ.get('SUPABASE_URL', 'https://lunsyufvxkiivnrhpxpj.supabase.co')
SUPABASE_KEY = os.environ.get('SUPABASE_ANON_KEY', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1bnN5dWZ2eGtpaXZucmhweHBqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4MTI0MTYsImV4cCI6MjA5NzM4ODQxNn0.kzDEPVhEe0reqsWLiGOfQ6V-YK0rgRXJFvYlWDglivA')

# Cache em memória temporário para downloads de arquivos gerados nesta instância
EXCEL_CACHE: Dict[str, bytes] = {}

# ============================================================================
# HELPER FUNCTIONS: SUPABASE
# ============================================================================

def salvar_fatura_no_supabase(fatura_data: Dict[str, Any], projecao_data: Dict[str, Any]) -> Dict[str, Any]:
    try:
        banco = (fatura_data.get('banco') or projecao_data.get('banco') or 'CARTAO').upper().strip()
        mes_referencia = fatura_data.get('mes_referencia') or projecao_data.get('mes_referencia_base') or time.strftime('%Y-%m')
        data_vencimento = fatura_data.get('data_vencimento') or fatura_data.get('vencimento') or ''
        
        titular_principal = fatura_data.get('titular')
        if not titular_principal and fatura_data.get('cartoes'):
            titular_principal = fatura_data['cartoes'][0].get('titular', 'TITULAR')
        if not titular_principal:
            titular_principal = 'TITULAR'

        total_fatura = float(fatura_data.get('valor_total') or fatura_data.get('total_fatura') or fatura_data.get('total') or 0.0)
        total_comprometimento = float(projecao_data.get('total_comprometimento_futuro') or 0.0)
        qtd_cartoes = len(projecao_data.get('matriz_cartoes') or fatura_data.get('cartoes') or []) or 1
        qtd_parcelas = len(projecao_data.get('detalhes_parcelas') or [])

        payload = {
            'banco': banco,
            'mes_referencia': mes_referencia,
            'data_vencimento': data_vencimento,
            'titular_principal': titular_principal,
            'total_fatura': total_fatura,
            'total_comprometimento': total_comprometimento,
            'qtd_cartoes': qtd_cartoes,
            'qtd_parcelamentos': qtd_parcelas,
            'dados_completos': {
                'fatura': fatura_data,
                'projecao': projecao_data
            },
            'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        }

        url = f"{SUPABASE_URL}/rest/v1/score_cartoes_faturas?on_conflict=banco,mes_referencia"
        headers = {
            'apikey': SUPABASE_KEY,
            'Authorization': f'Bearer {SUPABASE_KEY}',
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=representation'
        }

        resp = requests.post(url, json=payload, headers=headers, timeout=15)
        if not resp.ok:
            return {'sucesso': False, 'erro': resp.text}

        data = resp.json()
        registro = data[0] if isinstance(data, list) and len(data) > 0 else None
        return {'sucesso': True, 'registro': registro}
    except Exception as e:
        return {'sucesso': False, 'erro': str(e)}


def listar_faturas_do_supabase() -> List[Dict[str, Any]]:
    url = f"{SUPABASE_URL}/rest/v1/score_cartoes_faturas?select=id,mes_referencia,banco,data_vencimento,titular_principal,total_fatura,total_comprometimento,qtd_cartoes,qtd_parcelamentos,updated_at&order=mes_referencia.desc,banco.asc"
    headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}'
    }
    resp = requests.get(url, headers=headers, timeout=15)
    if not resp.ok:
        raise Exception(resp.text)
    return resp.json()


def obter_fatura_do_supabase(fatura_id: str) -> Optional[Dict[str, Any]]:
    url = f"{SUPABASE_URL}/rest/v1/score_cartoes_faturas?id=eq.{fatura_id}&select=*"
    headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}'
    }
    resp = requests.get(url, headers=headers, timeout=15)
    if not resp.ok:
        raise Exception(resp.text)
    rows = resp.json()
    return rows[0] if rows else None


def excluir_fatura_do_supabase(fatura_id: str) -> Any:
    url = f"{SUPABASE_URL}/rest/v1/score_cartoes_faturas?id=eq.{fatura_id}"
    headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Prefer': 'return=representation'
    }
    resp = requests.delete(url, headers=headers, timeout=15)
    if not resp.ok:
        raise Exception(resp.text)
    return resp.json()


def obter_resumo_anual_do_supabase() -> List[Dict[str, Any]]:
    url = f"{SUPABASE_URL}/rest/v1/score_cartoes_faturas?select=id,mes_referencia,banco,total_fatura,total_comprometimento,qtd_parcelamentos&order=mes_referencia.asc"
    headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}'
    }
    resp = requests.get(url, headers=headers, timeout=15)
    if not resp.ok:
        raise Exception(resp.text)
    faturas = resp.json()

    anos_map: Dict[str, Dict[str, Any]] = {}
    for f in faturas:
        ano = (f.get('mes_referencia') or '')[:4] or 'OUTROS'
        if ano not in anos_map:
            anos_map[ano] = {
                'ano': ano,
                'total_gasto': 0.0,
                'qtd_faturas': 0,
                'qtd_parcelamentos': 0,
                'meses_contabilizados': set(),
                'bancos': set(),
                'faturas': []
            }
        val = float(f.get('total_fatura') or 0.0)
        anos_map[ano]['total_gasto'] += val
        anos_map[ano]['qtd_faturas'] += 1
        anos_map[ano]['qtd_parcelamentos'] += int(f.get('qtd_parcelamentos') or 0)
        if f.get('mes_referencia'):
            anos_map[ano]['meses_contabilizados'].add(f['mes_referencia'])
        if f.get('banco'):
            anos_map[ano]['bancos'].add(f['banco'])
        anos_map[ano]['faturas'].append({
            'id': f.get('id'),
            'banco': f.get('banco'),
            'mes_referencia': f.get('mes_referencia'),
            'total_fatura': val
        })

    anos_lista = []
    for a in anos_map.values():
        qtd_meses = len(a['meses_contabilizados'])
        total_gasto = round(a['total_gasto'], 2)
        media_mensal = round(total_gasto / qtd_meses, 2) if qtd_meses > 0 else 0.0
        anos_lista.append({
            'ano': a['ano'],
            'total_gasto': total_gasto,
            'qtd_faturas': a['qtd_faturas'],
            'qtd_meses': qtd_meses,
            'media_mensal': media_mensal,
            'bancos': sorted(list(a['bancos'])),
            'faturas': a['faturas']
        })

    anos_lista.sort(key=lambda x: x['ano'], reverse=True)

    # Variação YoY (%)
    for i in range(len(anos_lista)):
        atual = anos_lista[i]
        anterior = anos_lista[i + 1] if i + 1 < len(anos_lista) else None
        if anterior and anterior['total_gasto'] > 0:
            diff = atual['total_gasto'] - anterior['total_gasto']
            pct = (diff / anterior['total_gasto']) * 100
            atual['variacao_yoy_pct'] = round(pct, 1)
            atual['variacao_yoy_diff'] = round(diff, 2)
        else:
            atual['variacao_yoy_pct'] = None
            atual['variacao_yoy_diff'] = None

    return anos_lista


# ============================================================================
# ROTAS DA API (com suporte a prefixo /api e raiz para flexibilidade na Vercel)
# ============================================================================

@app.get("/health")
@app.get("/api")
@app.get("/api/health")
def health_check():
    return {
        "status": "ok",
        "app": "Score Cards • Controle Inteligente de Cartões",
        "runtime": "Vercel Python Serverless"
    }


@app.get("/", response_class=FileResponse)
def serve_index():
    index_path = os.path.join(ROOT_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return FileResponse("index.html")


@app.get("/style.css", response_class=FileResponse)
def serve_css():
    css_path = os.path.join(ROOT_DIR, "style.css")
    return FileResponse(css_path if os.path.exists(css_path) else "style.css", media_type="text/css")


@app.get("/script.js", response_class=FileResponse)
def serve_js():
    js_path = os.path.join(ROOT_DIR, "script.js")
    return FileResponse(js_path if os.path.exists(js_path) else "script.js", media_type="application/javascript")


@app.get("/faturas-salvas")
@app.get("/api/faturas-salvas")
def get_faturas_salvas(id: Optional[str] = Query(None)):
    try:
        if id:
            fatura = obter_fatura_do_supabase(id)
            if not fatura:
                return JSONResponse(status_code=404, content={"sucesso": False, "erro": "Fatura não encontrada"})
            return {"sucesso": True, "fatura": fatura}
        else:
            lista = listar_faturas_do_supabase()
            return {"sucesso": True, "faturas": lista}
    except Exception as e:
        return JSONResponse(status_code=500, content={"sucesso": False, "erro": str(e)})


@app.delete("/faturas-salvas")
@app.delete("/api/faturas-salvas")
def delete_fatura_salva(id: Optional[str] = Query(None)):
    if not id:
        return JSONResponse(status_code=400, content={"sucesso": False, "erro": "ID não informado"})
    try:
        excluir_fatura_do_supabase(id)
        return {"sucesso": True, "mensagem": "Fatura excluída com sucesso"}
    except Exception as e:
        return JSONResponse(status_code=500, content={"sucesso": False, "erro": str(e)})


@app.get("/resumo-anual")
@app.get("/api/resumo-anual")
def get_resumo_anual():
    try:
        resumo = obter_resumo_anual_do_supabase()
        return {"sucesso": True, "resumo_anual": resumo}
    except Exception as e:
        return JSONResponse(status_code=500, content={"sucesso": False, "erro": str(e)})


@app.post("/analisar-fatura-ia")
@app.post("/api/analisar-fatura-ia")
@app.post("/analisar-pdf")
@app.post("/api/analisar-pdf")
async def analisar_fatura(
    pdf: UploadFile = File(...),
    x_ai_provider: Optional[str] = Header("auto", alias="x-ai-provider"),
    x_ai_key: Optional[str] = Header("", alias="x-ai-key")
):
    temp_id = f"fatura_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    temp_dir = os.environ.get("TMPDIR") or "/tmp" if os.name != 'nt' else os.environ.get("TEMP", ".")
    temp_pdf_path = os.path.join(temp_dir, f"{temp_id}.pdf")
    temp_excel_path = os.path.join(temp_dir, f"{temp_id}.xlsx")

    try:
        content = await pdf.read()
        with open(temp_pdf_path, "wb") as f:
            f.write(content)

        provedor = (x_ai_provider or "auto").lower()
        api_key = (x_ai_key or "").strip()

        # Executa análise direta com o motor Python
        analisador = AnalisadorFaturasIA(temp_pdf_path, provedor=provedor, api_key=api_key or None)
        dados_fatura = analisador.analisar()
        projecao = ProjetorFinanceiro.projetar(dados_fatura, qtd_meses=0)

        # Gera Excel e armazena em Base64
        gerar_planilha_excel(projecao, temp_excel_path)
        excel_base64 = ""
        if os.path.exists(temp_excel_path):
            with open(temp_excel_path, "rb") as ef:
                excel_bytes = ef.read()
                excel_base64 = base64.b64encode(excel_bytes).decode("utf-8")
                EXCEL_CACHE[temp_id] = excel_bytes

        # Salva / Upsert no Supabase
        res_supabase = salvar_fatura_no_supabase(dados_fatura, projecao)

        resultado = {
            "sucesso": True,
            "fatura": dados_fatura,
            "projecao": projecao,
            "excel_id": temp_id,
            "excel_base64": excel_base64,
            "salvo_nuvem": res_supabase.get("sucesso", False),
            "nuvem_id": res_supabase.get("registro", {}).get("id") if res_supabase.get("registro") else None,
            "nuvem_erro": res_supabase.get("erro") if not res_supabase.get("sucesso") else None
        }

        return sanitizar_estrutura_sem_acentos(resultado)
    except Exception as e:
        return JSONResponse(status_code=500, content=sanitizar_estrutura_sem_acentos({
            "sucesso": False,
            "erro": str(e)
        }))
    finally:
        # Limpa arquivo PDF temporário
        if os.path.exists(temp_pdf_path):
            try:
                os.remove(temp_pdf_path)
            except Exception:
                pass


@app.get("/download-excel")
@app.get("/api/download-excel")
def download_excel(id: Optional[str] = Query(None), fatura_id: Optional[str] = Query(None)):
    excel_bytes = None
    file_id = id or fatura_id

    # 1. Verifica cache em memória
    if file_id and file_id in EXCEL_CACHE:
        excel_bytes = EXCEL_CACHE[file_id]

    # 2. Verifica arquivo físico temporário
    if not excel_bytes and file_id:
        temp_dir = os.environ.get("TMPDIR") or "/tmp" if os.name != 'nt' else os.environ.get("TEMP", ".")
        candidate = os.path.join(temp_dir, f"{file_id}.xlsx")
        if os.path.exists(candidate):
            with open(candidate, "rb") as f:
                excel_bytes = f.read()

    # 3. Se não encontrou mas foi passado um ID da nuvem, regenera a partir dos dados do Supabase
    if not excel_bytes and file_id:
        try:
            fatura_reg = obter_fatura_do_supabase(file_id)
            if fatura_reg and fatura_reg.get('dados_completos') and fatura_reg['dados_completos'].get('projecao'):
                temp_dir = os.environ.get("TMPDIR") or "/tmp" if os.name != 'nt' else os.environ.get("TEMP", ".")
                out_path = os.path.join(temp_dir, f"regen_{file_id}.xlsx")
                gerar_planilha_excel(fatura_reg['dados_completos']['projecao'], out_path)
                if os.path.exists(out_path):
                    with open(out_path, "rb") as f:
                        excel_bytes = f.read()
                    try:
                        os.remove(out_path)
                    except Exception:
                        pass
        except Exception:
            pass

    if not excel_bytes:
        return JSONResponse(status_code=404, content={"sucesso": False, "erro": "Arquivo Excel não encontrado ou expirado."})

    return Response(
        content=excel_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="projecao_cartoes_{int(time.time())}.xlsx"'
        }
    )

