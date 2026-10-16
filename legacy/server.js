const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

let port = parseInt(process.env.PORT, 10) || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// Configurações do Supabase (Score Tech - ProjectsGerais)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lunsyufvxkiivnrhpxpj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1bnN5dWZ2eGtpaXZucmhweHBqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4MTI0MTYsImV4cCI6MjA5NzM4ODQxNn0.kzDEPVhEe0reqsWLiGOfQ6V-YK0rgRXJFvYlWDglivA';

// Armazenamento em memória de arquivos Excel gerados temporariamente para download
const arquivosExcelTemporarios = new Map();

// ============================================================================
// HELPER FUNCTIONS: SUPABASE (Nuvem)
// ============================================================================

async function salvarFaturaNoSupabase(faturaData, projecaoData) {
  try {
    const banco = (faturaData?.banco || projecaoData?.banco || 'CARTAO').toUpperCase().trim();
    const mesReferencia = faturaData?.mes_referencia || projecaoData?.mes_referencia_base || new Date().toISOString().slice(0, 7);
    const dataVencimento = faturaData?.data_vencimento || faturaData?.vencimento || '';
    const titularPrincipal = faturaData?.titular || (faturaData?.cartoes && faturaData.cartoes[0] ? faturaData.cartoes[0].titular : 'TITULAR');
    const totalFatura = parseFloat(faturaData?.valor_total || faturaData?.total || 0) || 0;
    const totalComprometimento = parseFloat(projecaoData?.total_comprometimento_futuro || 0) || 0;
    const qtdCartoes = (projecaoData?.matriz_cartoes || []).length || (faturaData?.cartoes || []).length || 1;
    const qtdParcelas = (projecaoData?.detalhes_parcelas || []).length;

    const payload = {
      banco,
      mes_referencia: mesReferencia,
      data_vencimento: dataVencimento,
      titular_principal: titularPrincipal,
      total_fatura: totalFatura,
      total_comprometimento: totalComprometimento,
      qtd_cartoes: qtdCartoes,
      qtd_parcelamentos: qtdParcelas,
      dados_completos: {
        fatura: faturaData,
        projecao: projecaoData
      },
      updated_at: new Date().toISOString()
    };

    // UPSERT com a regra da Opção 1: UNIQUE(banco, mes_referencia)
    const url = `${SUPABASE_URL}/rest/v1/score_cartoes_faturas?on_conflict=banco,mes_referencia`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Erro ao salvar no Supabase:', resp.status, errText);
      return { sucesso: false, erro: errText };
    }

    const data = await resp.json();
    return { sucesso: true, registro: data[0] || null };
  } catch (err) {
    console.error('Exceção ao salvar no Supabase:', err);
    return { sucesso: false, erro: err.message };
  }
}

async function listarFaturasDoSupabase() {
  const url = `${SUPABASE_URL}/rest/v1/score_cartoes_faturas?select=id,mes_referencia,banco,data_vencimento,titular_principal,total_fatura,total_comprometimento,qtd_cartoes,qtd_parcelamentos,updated_at&order=mes_referencia.desc,banco.asc`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  if (!resp.ok) {
    throw new Error(await resp.text());
  }
  return await resp.json();
}

async function obterFaturaDoSupabase(id) {
  const url = `${SUPABASE_URL}/rest/v1/score_cartoes_faturas?id=eq.${encodeURIComponent(id)}&select=*`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  if (!resp.ok) {
    throw new Error(await resp.text());
  }
  const rows = await resp.json();
  return rows[0] || null;
}

async function excluirFaturaDoSupabase(id) {
  const url = `${SUPABASE_URL}/rest/v1/score_cartoes_faturas?id=eq.${encodeURIComponent(id)}`;
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=representation'
    }
  });
  if (!resp.ok) {
    throw new Error(await resp.text());
  }
  return await resp.json();
}

async function obterResumoAnualDoSupabase() {
  const url = `${SUPABASE_URL}/rest/v1/score_cartoes_faturas?select=id,mes_referencia,banco,total_fatura,total_comprometimento,qtd_parcelamentos&order=mes_referencia.asc`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  if (!resp.ok) {
    throw new Error(await resp.text());
  }
  const faturas = await resp.json();

  const anosMap = {};
  faturas.forEach(f => {
    const ano = (f.mes_referencia || '').slice(0, 4) || 'OUTROS';
    if (!anosMap[ano]) {
      anosMap[ano] = {
        ano,
        total_gasto: 0,
        qtd_faturas: 0,
        qtd_parcelamentos: 0,
        meses_contabilizados: new Set(),
        bancos: new Set(),
        faturas: []
      };
    }
    const val = parseFloat(f.total_fatura) || 0;
    anosMap[ano].total_gasto += val;
    anosMap[ano].qtd_faturas += 1;
    anosMap[ano].qtd_parcelamentos += parseInt(f.qtd_parcelamentos || 0, 10);
    if (f.mes_referencia) anosMap[ano].meses_contabilizados.add(f.mes_referencia);
    if (f.banco) anosMap[ano].bancos.add(f.banco);
    anosMap[ano].faturas.push({
      id: f.id,
      banco: f.banco,
      mes_referencia: f.mes_referencia,
      total_fatura: val
    });
  });

  const anosLista = Object.values(anosMap).map(a => ({
    ano: a.ano,
    total_gasto: Math.round(a.total_gasto * 100) / 100,
    qtd_faturas: a.qtd_faturas,
    qtd_meses: a.meses_contabilizados.size,
    media_mensal: a.meses_contabilizados.size > 0 ? Math.round((a.total_gasto / a.meses_contabilizados.size) * 100) / 100 : 0,
    bancos: Array.from(a.bancos),
    faturas: a.faturas
  })).sort((a, b) => b.ano.localeCompare(a.ano));

  // Calcula variação YoY (%)
  for (let i = 0; i < anosLista.length; i++) {
    const atual = anosLista[i];
    const anterior = anosLista[i + 1]; // Anterior cronologicamente
    if (anterior && anterior.total_gasto > 0) {
      const diff = atual.total_gasto - anterior.total_gasto;
      const pct = (diff / anterior.total_gasto) * 100;
      atual.variacao_yoy_pct = Math.round(pct * 10) / 10;
      atual.variacao_yoy_diff = Math.round(diff * 100) / 100;
    } else {
      atual.variacao_yoy_pct = null;
      atual.variacao_yoy_diff = null;
    }
  }

  return anosLista;
}

// ============================================================================
// SERVIDOR PRINCIPAL HTTP
// ============================================================================

function startServer(currentPort) {
  const server = http.createServer(async (req, res) => {
    // -----------------------------------------------------------------
    // Endpoint: GET /api/download-excel?id=...
    // -----------------------------------------------------------------
    if (req.method === 'GET' && req.url.startsWith('/api/download-excel')) {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const fileId = urlObj.searchParams.get('id');

      if (!fileId || !arquivosExcelTemporarios.has(fileId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ erro: 'Arquivo Excel não encontrado ou expirado.' }));
      }

      const filePath = arquivosExcelTemporarios.get(fileId);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ erro: 'Arquivo físico não encontrado.' }));
      }

      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES['.xlsx'],
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="projecao_cartoes_${Date.now()}.xlsx"`
      });

      const readStream = fs.createReadStream(filePath);
      readStream.pipe(res);
      readStream.on('end', () => {
        setTimeout(() => {
          try { fs.unlinkSync(filePath); } catch (_) {}
          arquivosExcelTemporarios.delete(fileId);
        }, 5000);
      });
      return;
    }

    // -----------------------------------------------------------------
    // Endpoint: GET /api/faturas-salvas (Listar ou obter por ID)
    // -----------------------------------------------------------------
    if (req.method === 'GET' && req.url.startsWith('/api/faturas-salvas')) {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const faturaId = urlObj.searchParams.get('id');

      try {
        if (faturaId) {
          const fatura = await obterFaturaDoSupabase(faturaId);
          if (!fatura) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ sucesso: false, erro: 'Fatura não encontrada' }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ sucesso: true, fatura }));
        } else {
          const lista = await listarFaturasDoSupabase();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ sucesso: true, faturas: lista }));
        }
      } catch (err) {
        console.error('Erro na rota /api/faturas-salvas:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ sucesso: false, erro: err.message }));
      }
    }

    // -----------------------------------------------------------------
    // Endpoint: DELETE /api/faturas-salvas?id=...
    // -----------------------------------------------------------------
    if (req.method === 'DELETE' && req.url.startsWith('/api/faturas-salvas')) {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const faturaId = urlObj.searchParams.get('id');

      if (!faturaId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ sucesso: false, erro: 'ID não informado' }));
      }

      try {
        await excluirFaturaDoSupabase(faturaId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ sucesso: true, mensagem: 'Fatura excluída com sucesso' }));
      } catch (err) {
        console.error('Erro ao excluir fatura:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ sucesso: false, erro: err.message }));
      }
    }

    // -----------------------------------------------------------------
    // Endpoint: GET /api/resumo-anual
    // -----------------------------------------------------------------
    if (req.method === 'GET' && req.url.startsWith('/api/resumo-anual')) {
      try {
        const resumo = await obterResumoAnualDoSupabase();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ sucesso: true, resumo_anual: resumo }));
      } catch (err) {
        console.error('Erro ao obter resumo anual:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ sucesso: false, erro: err.message }));
      }
    }

    // -----------------------------------------------------------------
    // Endpoint: POST /api/analisar-pdf ou POST /api/analisar-fatura-ia
    // -----------------------------------------------------------------
    if (req.method === 'POST' && (req.url.startsWith('/api/analisar-pdf') || req.url.startsWith('/api/analisar-fatura-ia'))) {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const buffer = Buffer.concat(chunks);

        // Extrai parâmetros dos headers
        const provedor = (req.headers['x-ai-provider'] || 'auto').toLowerCase();
        const apiKey = req.headers['x-ai-key'] || '';
        const contentType = req.headers['content-type'] || '';

        // Se for multipart form-data, extrai o arquivo PDF binário
        let pdfBuffer = buffer;
        if (contentType.includes('multipart/form-data')) {
          const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
          if (boundaryMatch) {
            const boundary = boundaryMatch[1] || boundaryMatch[2];
            const parts = buffer.toString('binary').split('--' + boundary);
            for (const part of parts) {
              if (part.includes('filename=') || part.includes('application/pdf') || part.includes('%PDF')) {
                const headerEnd = part.indexOf('\r\n\r\n');
                if (headerEnd !== -1) {
                  const bodyBinary = part.substring(headerEnd + 4, part.lastIndexOf('\r\n'));
                  pdfBuffer = Buffer.from(bodyBinary, 'binary');
                  break;
                }
              }
            }
          }
        }

        const tempId = `fatura_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const tempPdfPath = path.join(os.tmpdir(), `${tempId}.pdf`);
        const tempExcelPath = path.join(os.tmpdir(), `${tempId}.xlsx`);

        fs.writeFile(tempPdfPath, pdfBuffer, (writeErr) => {
          if (writeErr) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
            return res.end(JSON.stringify({ sucesso: false, erro: 'Erro ao salvar arquivo temporário' }));
          }

          // Executa o motor motor_ia_faturas.py com --meses 0 (dinâmico até a última fatura)
          const scriptPath = path.join(__dirname, 'motor_ia_faturas.py');
          const args = [scriptPath, tempPdfPath, '--provedor', provedor, '--meses', '0', '--excel', tempExcelPath];
          
          if (apiKey && apiKey.trim()) {
            args.push('--api-key', apiKey.trim());
          }

          execFile('python', args, { 
            maxBuffer: 25 * 1024 * 1024,
            encoding: 'utf8',
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
          }, async (execErr, stdout, stderr) => {
            // Remove o arquivo PDF temporário
            fs.unlink(tempPdfPath, () => {});

            if (execErr) {
              console.error('Erro na execução do motor Python IA:', execErr, stderr);
              res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
              return res.end(JSON.stringify({
                sucesso: false,
                erro: 'Erro no motor Python: ' + (stderr || execErr.message)
              }));
            }

            try {
              const parsed = JSON.parse(stdout);

              // Se gerou Excel, guarda o ID para download
              let excelId = null;
              if (fs.existsSync(tempExcelPath)) {
                excelId = `excel_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
                arquivosExcelTemporarios.set(excelId, tempExcelPath);
                parsed.excel_id = excelId;
              }

              // Salva / Sobrescreve automaticamente no Supabase
              if (parsed.sucesso && parsed.fatura && parsed.projecao) {
                const resSupabase = await salvarFaturaNoSupabase(parsed.fatura, parsed.projecao);
                parsed.salvo_nuvem = resSupabase.sucesso;
                parsed.nuvem_id = resSupabase.registro?.id || null;
                parsed.nuvem_erro = resSupabase.sucesso ? null : resSupabase.erro;
              }

              res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
              res.end(JSON.stringify(parsed));
            } catch (jsonErr) {
              console.error('Erro ao interpretar saída JSON:', stdout);
              res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
              res.end(JSON.stringify({ sucesso: false, erro: 'Resposta inválida do motor de IA: ' + stdout.slice(0, 300) }));
            }
          });
        });
      });
      return;
    }

    // -----------------------------------------------------------------
    // Servir arquivos estáticos do Frontend
    // -----------------------------------------------------------------
    let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
          res.end('404 Não Encontrado');
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8' });
          res.end(`Erro interno: ${err.code}`);
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
      }
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`⚠️  A porta ${currentPort} já está ocupada. Tentando a porta ${currentPort + 1}...`);
      startServer(currentPort + 1);
    } else {
      console.error('Erro no servidor:', err);
    }
  });

  server.listen(currentPort, () => {
    console.log(`\n=================================================`);
    console.log(`🚀 Servidor Score Tech rodando em: http://localhost:${currentPort}`);
    console.log(`💳 Sistema de Projeção Transacional de Cartões`);
    console.log(`☁️  Persistência em Nuvem: Supabase Ativo`);
    console.log(`🤖 Motor IA ativo: Google Gemini / Groq / Local`);
    console.log(`=================================================\n`);
  });
}

startServer(port);
