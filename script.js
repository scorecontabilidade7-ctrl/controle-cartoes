/**
 * Score Cards • Controle Transacional & Projeção com IA
 * Frontend: Projeção Dinâmica, Persistência Supabase e Visão Ano a Ano
 */

// ============================================================================
// 1. ESTADO GLOBAL
// ============================================================================
const obterStorage = (chave, padrao = '') => {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem(chave)) || padrao;
  } catch (_) {
    return padrao;
  }
};

const ESTADO = {
  provedorIA: obterStorage('score_provedor_ia', 'gemini'),
  apiKeys: {
    gemini: obterStorage('score_api_key_gemini', ''),
    groq: obterStorage('score_api_key_groq', '')
  },
  dadosAtuais: null,
  excelId: null,
  faturasSalvas: [],
  faturaSelecionadaId: null,
  mesFiltroFaturas: '',
  resumoAnual: []
};

const formatadorMoeda = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL'
});

function removerAcentos(str) {
  if (str === null || str === undefined) return '';
  if (typeof str !== 'string') return String(str);
  return str
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\ufffd/g, '') // Remove caractere corrompido / diamante
    .trim();
}

function sanitizarObjetoSemAcentos(obj) {
  if (typeof obj === 'string') {
    return removerAcentos(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizarObjetoSemAcentos);
  }
  if (obj && typeof obj === 'object') {
    const novo = {};
    for (const [k, v] of Object.entries(obj)) {
      novo[removerAcentos(k)] = sanitizarObjetoSemAcentos(v);
    }
    return novo;
  }
  return obj;
}

// ============================================================================
// 1.1 CONFIGURAÇÃO DO SUPABASE AUTH
// ============================================================================
const SUPABASE_AUTH_CONFIG = {
  url: 'https://lunsyufvxkiivnrhpxpj.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1bnN5dWZ2eGtpaXZucmhweHBqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4MTI0MTYsImV4cCI6MjA5NzM4ODQxNn0.kzDEPVhEe0reqsWLiGOfQ6V-YK0rgRXJFvYlWDglivA'
};

let supabaseClient = null;
if (typeof window !== 'undefined' && window.supabase && typeof window.supabase.createClient === 'function') {
  try {
    supabaseClient = window.supabase.createClient(SUPABASE_AUTH_CONFIG.url, SUPABASE_AUTH_CONFIG.anonKey);
  } catch (e) {
    console.error('Falha ao instanciar Supabase Client:', e);
  }
}

// ============================================================================
// 2. INICIALIZAÇÃO & AUTENTICAÇÃO
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  inicializarConfiguracoes();
  configurarDragAndDrop();
  atualizarStatusApiKeyBadge();
  await inicializarAutenticacao();
});

async function inicializarAutenticacao() {
  if (!supabaseClient) {
    console.warn('Supabase SDK não disponível, liberando acesso local.');
    exibirInterfacePrincipal(true);
    carregarListaFaturasNuvem();
    carregarResumoAnual();
    return;
  }

  // 1. Escuta mudanças de sessão em tempo real (login, logout, refresh de token)
  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (session && session.user) {
      definirUsuarioAutenticado(session.user);
    } else {
      definirUsuarioDeslogado();
    }
  });

  // 2. Verifica se já existe sessão salva no localStorage do Supabase
  try {
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (session && session.user) {
      definirUsuarioAutenticado(session.user);
    } else {
      definirUsuarioDeslogado();
    }
  } catch (err) {
    console.error('Erro ao verificar sessão do Supabase:', err);
    definirUsuarioDeslogado();
  }
}

function definirUsuarioAutenticado(user) {
  ESTADO.usuarioAtual = user;
  exibirInterfacePrincipal(true);

  // Atualiza badge de perfil no header
  const profileBadge = document.getElementById('userProfileBadge');
  const emailDisplay = document.getElementById('userEmailDisplay');
  const avatarEl = document.getElementById('userAvatar');

  if (profileBadge) profileBadge.style.display = 'flex';
  if (emailDisplay) emailDisplay.textContent = user.email || 'Usuário Score';
  if (avatarEl) {
    const letra = (user.email || 'U').charAt(0).toUpperCase();
    avatarEl.textContent = letra;
  }

  // Carrega dados da nuvem protegidos
  carregarListaFaturasNuvem();
  carregarResumoAnual();
}

function definirUsuarioDeslogado() {
  ESTADO.usuarioAtual = null;
  exibirInterfacePrincipal(false);

  const profileBadge = document.getElementById('userProfileBadge');
  if (profileBadge) profileBadge.style.display = 'none';

  const authAlert = document.getElementById('authAlert');
  if (authAlert) authAlert.style.display = 'none';
}

function exibirInterfacePrincipal(autenticado) {
  const authSection = document.getElementById('authSection');
  const mainContent = document.getElementById('appMainContent');
  const appHeader = document.getElementById('appHeader') || document.querySelector('.app-header');
  const headerControls = document.querySelector('.header-controls');

  if (authSection) {
    authSection.style.display = autenticado ? 'none' : 'flex';
  }
  if (mainContent) {
    mainContent.style.display = autenticado ? 'block' : 'none';
  }
  if (appHeader) {
    appHeader.style.display = autenticado ? 'block' : 'none';
  }
  if (headerControls) {
    headerControls.style.display = autenticado ? 'flex' : 'none';
  }
}

function toggleVisibilidadeSenhaAuth() {
  const input = document.getElementById('authPassword');
  if (input) {
    input.type = input.type === 'password' ? 'text' : 'password';
  }
}

async function solicitarRecuperacaoSenha(event) {
  if (event) event.preventDefault();
  const emailInput = document.getElementById('authEmail');
  const email = emailInput ? emailInput.value.trim() : '';

  if (!email) {
    exibirAlertaAuth('Por favor, informe seu e-mail no campo acima para enviarmos o link de recuperação de senha.', 'error');
    if (emailInput) emailInput.focus();
    return;
  }

  if (!supabaseClient) {
    exibirAlertaAuth('Cliente Supabase não inicializado.', 'error');
    return;
  }

  try {
    exibirAlertaAuth('Enviando link de recuperação...', 'info');
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email);
    if (error) throw error;
    exibirAlertaAuth(`Link de recuperação de senha enviado com sucesso para ${email}! Verifique sua caixa de entrada.`, 'success');
  } catch (err) {
    console.error('Erro na recuperação de senha:', err);
    exibirAlertaAuth(err.message || 'Erro ao solicitar link de redefinição de senha.', 'error');
  }
}

function exibirAlertaAuth(mensagem, tipo = 'error') {
  const alertEl = document.getElementById('authAlert');
  if (!alertEl) return;
  alertEl.className = `auth-alert ${tipo}`;
  const icon = tipo === 'error' ? '⚠️ ' : (tipo === 'success' ? '✅ ' : 'ℹ️ ');
  alertEl.textContent = icon + mensagem;
  alertEl.style.display = 'flex';
}

async function submeterAuth(event) {
  event.preventDefault();
  if (!supabaseClient) {
    showToast('Cliente Supabase não inicializado.', 'error');
    return;
  }

  const emailInput = document.getElementById('authEmail');
  const passInput = document.getElementById('authPassword');
  const btnSubmit = document.getElementById('btnAuthSubmit');
  const btnText = document.getElementById('btnAuthText');

  const email = emailInput ? emailInput.value.trim() : '';
  const senha = passInput ? passInput.value : '';

  if (!email || !senha) {
    exibirAlertaAuth('Por favor, informe e-mail e senha.');
    return;
  }

  if (btnSubmit) btnSubmit.disabled = true;
  if (btnText) btnText.textContent = 'Autenticando...';

  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email,
      password: senha
    });

    if (error) throw error;
    showToast(`Bem-vindo, ${data.user.email}!`, 'success');
    definirUsuarioAutenticado(data.user);
  } catch (err) {
    console.error('Erro na autenticação:', err);
    let msg = err.message || 'Erro ao processar autenticação.';
    if (msg.includes('Invalid login credentials')) {
      msg = 'E-mail ou senha incorretos.';
    }
    exibirAlertaAuth(msg, 'error');
  } finally {
    if (btnSubmit) btnSubmit.disabled = false;
    if (btnText) btnText.textContent = 'Entrar no Sistema';
  }
}

async function fazerLogout() {
  const confirma = confirm('Deseja realmente sair do sistema?');
  if (!confirma) return;

  try {
    if (supabaseClient) {
      await supabaseClient.auth.signOut();
    }
  } catch (e) {
    console.warn('Erro ao sair do Supabase:', e);
  }
  definirUsuarioDeslogado();
  limparAnalise();
  showToast('Sessão encerrada com sucesso.', 'info');
}

function inicializarConfiguracoes() {
  const selProvedor = document.getElementById('selectProvedorIA');
  if (selProvedor) selProvedor.value = ESTADO.provedorIA;

  atualizarBadgeMotor();
}

function alterarProvedorIA() {
  const sel = document.getElementById('selectProvedorIA');
  ESTADO.provedorIA = sel.value;
  localStorage.setItem('score_provedor_ia', ESTADO.provedorIA);
  atualizarBadgeMotor();
  atualizarStatusApiKeyBadge();
  showToast(`Motor de análise alterado para: ${sel.options[sel.selectedIndex].text}`, 'info');
}

function atualizarBadgeMotor() {
  const badge = document.getElementById('engineBadgeStatus');
  if (!badge) return;

  if (ESTADO.provedorIA === 'gemini') {
    badge.textContent = '🤖 Motor: Google Gemini (gemini-2.5-flash)';
    badge.className = 'engine-badge';
  } else if (ESTADO.provedorIA === 'groq') {
    badge.textContent = '⚡ Motor: Groq Cloud AI';
    badge.className = 'engine-badge';
  } else {
    badge.textContent = '💻 Motor: Local (Offline Heurístico)';
    badge.className = 'engine-badge info';
  }
}

// ============================================================================
// 3. PERSISTÊNCIA EM NUVEM (SUPABASE) & HISTÓRICO
// ============================================================================
async function carregarListaFaturasNuvem() {
  const select = document.getElementById('selectFaturaNuvem');
  if (!select) return;

  try {
    const resp = await fetch('/api/faturas-salvas');
    const data = await resp.json();

    if (data.sucesso && Array.isArray(data.faturas)) {
      ESTADO.faturasSalvas = data.faturas;

      // 1. Atualiza as opções do filtro por mês (ex: SET/2026, AGO/2026...)
      atualizarOpcoesFiltroMes();

      // 2. Renderiza as faturas no dropdown aplicando o filtro de mês ativo
      renderizarOpcoesFaturasNuvem();
    }
  } catch (err) {
    console.error('Erro ao listar faturas da nuvem:', err);
    select.innerHTML = '<option value="">Erro ao conectar na nuvem</option>';
  }
}

/**
 * Preenche o seletor de filtro por mês com base nas faturas salvas existentes
 */
function atualizarOpcoesFiltroMes() {
  const selectFiltroMes = document.getElementById('selectFiltroMesFatura');
  if (!selectFiltroMes) return;

  const faturas = ESTADO.faturasSalvas || [];
  
  // Agrupa os meses distintos abreviados (ex: SET/2026, AGO/2026)
  const mesesMap = new Map();
  faturas.forEach(f => {
    const rotulo = formatarMesAnoLabel(f.mes_referencia);
    if (!rotulo) return;
    if (!mesesMap.has(rotulo)) {
      mesesMap.set(rotulo, { rotulo, mesRef: f.mes_referencia || '', qtd: 1 });
    } else {
      mesesMap.get(rotulo).qtd += 1;
    }
  });

  // Ordena cronologicamente do mais recente para o mais antigo (ex: SET/2026 antes de AGO/2026)
  const mesesOrdenados = Array.from(mesesMap.values()).sort((a, b) => {
    return (b.mesRef || '').localeCompare(a.mesRef || '');
  });

  const mesAtual = ESTADO.mesFiltroFaturas || '';
  selectFiltroMes.innerHTML = '';

  const optTodos = document.createElement('option');
  optTodos.value = '';
  optTodos.textContent = `Todos os Meses (${faturas.length})`;
  if (!mesAtual) optTodos.selected = true;
  selectFiltroMes.appendChild(optTodos);

  mesesOrdenados.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.rotulo;
    opt.textContent = `${m.rotulo} (${m.qtd})`;
    if (m.rotulo === mesAtual) {
      opt.selected = true;
    }
    selectFiltroMes.appendChild(opt);
  });
}

/**
 * Renderiza as opções de faturas no select respeitando o filtro de mês ativo
 */
function renderizarOpcoesFaturasNuvem() {
  const select = document.getElementById('selectFaturaNuvem');
  if (!select) return;

  const faturas = ESTADO.faturasSalvas || [];
  const mesFiltro = ESTADO.mesFiltroFaturas || '';

  select.innerHTML = '';

  if (faturas.length === 0) {
    select.innerHTML = '<option value="">☁️ Nenhuma fatura salva</option>';
    return;
  }

  // Filtra as faturas caso um mês específico esteja selecionado
  const faturasFiltradas = mesFiltro
    ? faturas.filter(f => formatarMesAnoLabel(f.mes_referencia) === mesFiltro)
    : faturas;

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = mesFiltro
    ? `☁️ Faturas ${mesFiltro} (${faturasFiltradas.length})`
    : `☁️ Faturas Salvas (${faturas.length})`;
  select.appendChild(defaultOpt);

  if (faturasFiltradas.length === 0) {
    const optVazio = document.createElement('option');
    optVazio.value = '';
    optVazio.textContent = `Nenhuma fatura em ${mesFiltro}`;
    optVazio.disabled = true;
    select.appendChild(optVazio);
    return;
  }

  faturasFiltradas.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.id;
    const totalFmt = formatadorMoeda.format(f.total_fatura || 0);
    opt.textContent = `${removerAcentos(f.banco)} • ${formatarMesAnoLabel(f.mes_referencia)} (${totalFmt})`;
    if (ESTADO.faturaSelecionadaId === f.id) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
}

/**
 * Evento disparado quando o usuário escolhe um mês no filtro
 */
function aoFiltrarMesFaturas() {
  const selectFiltroMes = document.getElementById('selectFiltroMesFatura');
  const mesEscolhido = selectFiltroMes ? selectFiltroMes.value : '';
  ESTADO.mesFiltroFaturas = mesEscolhido;

  renderizarOpcoesFaturasNuvem();

  // Se a fatura atualmente carregada na tela não pertencer a este mês filtrado, reseta a seleção visual no dropdown
  const selectFatura = document.getElementById('selectFaturaNuvem');
  if (selectFatura && !Array.from(selectFatura.options).some(o => o.value === ESTADO.faturaSelecionadaId)) {
    selectFatura.value = '';
  }
}

async function aoSelecionarFaturaNuvem() {
  const select = document.getElementById('selectFaturaNuvem');
  const faturaId = select ? select.value : '';

  if (!faturaId) {
    ESTADO.faturaSelecionadaId = null;
    return;
  }

  exibirCarregando(true, 'Carregando fatura da nuvem...', 'Buscando projeção e histórico armazenados no Supabase');

  try {
    const resp = await fetch(`/api/faturas-salvas?id=${encodeURIComponent(faturaId)}`);
    const data = await resp.json();
    exibirCarregando(false);

    if (data.sucesso && data.fatura && data.fatura.dados_completos) {
      ESTADO.faturaSelecionadaId = faturaId;
      const dadosCompletos = sanitizarObjetoSemAcentos(data.fatura.dados_completos);
      ESTADO.dadosAtuais = dadosCompletos;
      ESTADO.excelId = null; // Fatura histórica

      renderizarResultados(dadosCompletos);
      showToast(`Fatura ${removerAcentos(data.fatura.banco)} (${formatarMesAnoLabel(data.fatura.mes_referencia)}) carregada da nuvem!`, 'success');
    } else {
      showToast('Não foi possível carregar os dados desta fatura.', 'error');
    }
  } catch (err) {
    exibirCarregando(false);
    console.error('Erro ao carregar fatura da nuvem:', err);
    showToast('Erro ao comunicar com a nuvem.', 'error');
  }
}

async function excluirFaturaAtualNuvem() {
  if (!ESTADO.faturaSelecionadaId) {
    showToast('Nenhuma fatura da nuvem selecionada para exclusão.', 'info');
    return;
  }

  const confirma = confirm('Tem certeza que deseja excluir esta fatura armazenada na nuvem? Esta ação não pode ser desfeita.');
  if (!confirma) return;

  try {
    const resp = await fetch(`/api/faturas-salvas?id=${encodeURIComponent(ESTADO.faturaSelecionadaId)}`, {
      method: 'DELETE'
    });
    const resJson = await resp.json();

    if (resJson.sucesso) {
      showToast('Fatura excluída da nuvem com sucesso.', 'success');
      ESTADO.faturaSelecionadaId = null;
      limparAnalise();
      await carregarListaFaturasNuvem();
      await carregarResumoAnual();
    } else {
      showToast(`Erro ao excluir: ${resJson.erro}`, 'error');
    }
  } catch (err) {
    console.error('Erro ao excluir fatura:', err);
    showToast('Erro ao excluir fatura da nuvem.', 'error');
  }
}

// ============================================================================
// 4. RESULTADOS E GASTOS DE ANO A ANO
// ============================================================================
async function carregarResumoAnual(forcarToast = false) {
  try {
    const resp = await fetch('/api/resumo-anual');
    const data = await resp.json();

    if (data.sucesso && Array.isArray(data.resumo_anual)) {
      ESTADO.resumoAnual = data.resumo_anual;
      renderizarCardsResumoAnual(data.resumo_anual);
      if (forcarToast) {
        showToast('Dados anuais atualizados com sucesso!', 'info');
      }
    }
  } catch (err) {
    console.error('Erro ao carregar resumo anual:', err);
  }
}

function alternarVisaoResumoAnual() {
  const secao = document.getElementById('secaoResumoAnual');
  if (!secao) return;

  const estaVisivel = secao.style.display !== 'none';
  if (estaVisivel) {
    secao.style.display = 'none';
  } else {
    secao.style.display = 'block';
    secao.scrollIntoView({ behavior: 'smooth', block: 'start' });
    carregarResumoAnual();
  }
}

function renderizarCardsResumoAnual(listaAnos) {
  const grid = document.getElementById('gridCardsAnuais');
  if (!grid) return;

  if (!listaAnos || listaAnos.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 2rem; text-align: center; color: var(--text-dim); background: rgba(255,255,255,0.02); border-radius: var(--radius-md); border: 1px dashed var(--border-color);">
        <span style="font-size: 2rem; display: block; margin-bottom: 0.5rem;">☁️</span>
        <strong>Nenhuma fatura armazenada na nuvem ainda.</strong>
        <p style="font-size: 0.85rem; margin-top: 0.25rem;">Envie faturas no dropzone abaixo para começar a acompanhar o histórico e a evolução anual de gastos.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = listaAnos.map(item => {
    let badgeYoYHtml = '';
    if (item.variacao_yoy_pct !== null && item.variacao_yoy_pct !== undefined) {
      if (item.variacao_yoy_pct > 0) {
        badgeYoYHtml = `<span class="anual-card-badge-yoy up" title="Aumento de gastos em relação ao ano anterior">▲ +${item.variacao_yoy_pct.toFixed(1)}% YoY</span>`;
      } else if (item.variacao_yoy_pct < 0) {
        badgeYoYHtml = `<span class="anual-card-badge-yoy down" title="Redução de gastos em relação ao ano anterior">▼ ${item.variacao_yoy_pct.toFixed(1)}% YoY</span>`;
      } else {
        badgeYoYHtml = `<span class="anual-card-badge-yoy neutral">0.0% YoY</span>`;
      }
    }

    const bancosChipsHtml = (item.bancos || []).map(b => `
      <span class="anual-banco-chip">${removerAcentos(b)}</span>
    `).join('');

    return `
      <div class="anual-card">
        <div class="anual-card-top">
          <div class="anual-card-year">
            <span>📅</span> ${item.ano}
          </div>
          ${badgeYoYHtml}
        </div>

        <div class="anual-card-val">${formatadorMoeda.format(item.total_gasto)}</div>
        <div class="anual-card-label">Total Gasto no Ano</div>

        <div class="anual-card-stats">
          <div class="anual-stat-item">
            <span class="anual-stat-label">Média Mensal:</span>
            <span class="anual-stat-val">${formatadorMoeda.format(item.media_mensal)}</span>
          </div>
          <div class="anual-stat-item">
            <span class="anual-stat-label">Faturas / Meses:</span>
            <span class="anual-stat-val">${item.qtd_faturas} fat. (${item.qtd_meses} meses)</span>
          </div>
        </div>

        ${bancosChipsHtml ? `<div class="anual-bancos-chips">${bancosChipsHtml}</div>` : ''}
      </div>
    `;
  }).join('');
}

// ============================================================================
// 5. UPLOAD & DRAG AND DROP
// ============================================================================
function configurarDragAndDrop() {
  const dropzone = document.getElementById('pdfDropzone');
  if (!dropzone) return;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, e => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, e => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('drag-over');
    });
  });

  dropzone.addEventListener('drop', e => {
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      processarArquivos(Array.from(files));
    }
  });
}

function handleFileSelect(event) {
  const files = event.target.files;
  if (files && files.length > 0) {
    processarArquivos(Array.from(files));
  }
}

// ============================================================================
// 6. PROCESSAMENTO COM O BACKEND / IA & AUTO-SALVAR NUVEM
// ============================================================================
async function processarArquivos(files) {
  const pdfFiles = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
  if (pdfFiles.length === 0) {
    showToast('Por favor, selecione arquivos no formato PDF.', 'error');
    return;
  }

  const chaveAtual = ESTADO.apiKeys[ESTADO.provedorIA] || '';
  let provedorEfetivo = ESTADO.provedorIA;
  if (ESTADO.provedorIA !== 'local' && !chaveAtual.trim()) {
    provedorEfetivo = 'local';
    showToast(`Sem chave de API: analisando em Modo Local. Para ativar a IA, configure o ${ESTADO.provedorIA.toUpperCase()} no botão acima.`, 'info');
  }

  exibirCarregando(true, `Analisando fatura com IA...`, 'Calculando parcelamentos futuros até a última parcela e salvando no Supabase');

  try {
    const file = pdfFiles[0];
    const formData = new FormData();
    formData.append('pdf', file);

    const headers = {
      'x-ai-provider': provedorEfetivo,
      'x-ai-key': chaveAtual
    };

    const response = await fetch('/api/analisar-fatura-ia', {
      method: 'POST',
      headers: headers,
      body: formData
    });

    const dataRaw = await response.json();
    const data = sanitizarObjetoSemAcentos(dataRaw);
    exibirCarregando(false);

    if (data.sucesso) {
      ESTADO.dadosAtuais = data;
      ESTADO.excelId = data.excel_id || null;
      ESTADO.faturaSelecionadaId = data.nuvem_id || null;

      renderizarResultados(data);
      showToast(`Fatura do ${removerAcentos(data.fatura.banco)} analisada com sucesso!`, 'success');

      if (data.salvo_nuvem) {
        showToast('☁️ Fatura salva e atualizada com sucesso no Supabase!', 'info');
      }

      // Atualiza lista de faturas e histórico anual em nuvem
      carregarListaFaturasNuvem();
      carregarResumoAnual();

      if (data.fatura.aviso_ia) {
        setTimeout(() => showToast(removerAcentos(data.fatura.aviso_ia), 'info'), 1500);
      }
    } else {
      showToast(removerAcentos(data.erro) || 'Não foi possível analisar a fatura.', 'error');
    }
  } catch (err) {
    exibirCarregando(false);
    console.error('Erro no upload/análise:', err);
    showToast('Erro de comunicação com o servidor local.', 'error');
  }
}

function exibirCarregando(mostrar, titulo = '', subtitulo = '') {
  const indicator = document.getElementById('loadingIndicator');
  const titleEl = document.getElementById('loadingTitle');
  const subEl = document.getElementById('loadingSub');

  if (indicator) {
    indicator.style.display = mostrar ? 'flex' : 'none';
    if (titulo && titleEl) titleEl.textContent = titulo;
    if (subtitulo && subEl) subEl.textContent = subtitulo;
  }

  if (mostrar) {
    const results = document.getElementById('resultsArea');
    if (results) results.style.display = 'none';
  }
}

// ============================================================================
// 7. RENDERIZAÇÃO DA MATRIZ E RESULTADOS
// ============================================================================
function formatarMesAnoLabel(anoMes) {
  if (!anoMes) return '';
  try {
    const [ano, mes] = anoMes.split('-');
    const d = new Date(parseInt(ano, 10), parseInt(mes, 10) - 1, 1);
    const mesNome = d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
    return `${removerAcentos(mesNome).toUpperCase()}/${ano}`;
  } catch (_) {
    return removerAcentos(anoMes);
  }
}

function renderizarResultados(dados) {
  const resultsArea = document.getElementById('resultsArea');
  if (!resultsArea) return;
  resultsArea.style.display = 'block';

  const proj = dados.projecao;
  const fat = dados.fatura;
  const meses = proj.meses_colunas || [];

  // 1. KPIs Executivos
  const proximoMesChave = meses[0] || '';
  const valorProximoMes = proximoMesChave ? (proj.totais_por_mes[proximoMesChave] || 0.0) : 0.0;

  document.getElementById('kpiProximoMes').textContent = formatadorMoeda.format(valorProximoMes);
  document.getElementById('kpiProximoMesLabel').textContent = proximoMesChave ? `Impacto em ${formatarMesAnoLabel(proximoMesChave)}` : 'Próximo ciclo';

  document.getElementById('kpiComprometimentoTotal').textContent = formatadorMoeda.format(proj.total_comprometimento_futuro || 0.0);
  document.getElementById('kpiTotalCartoes').textContent = proj.matriz_cartoes.length;
  document.getElementById('kpiBancoNome').textContent = removerAcentos(fat.banco) || 'Banco identificado';

  document.getElementById('kpiTotalParcelas').textContent = proj.detalhes_parcelas.length;
  document.getElementById('detalhesQtdParcelas').textContent = proj.detalhes_parcelas.length;

  // 2. Subtotais de Comprometimento por Ano Civil
  const containerAnos = document.getElementById('containerComprometimentoAnos');
  if (containerAnos) {
    const totaisAno = proj.totais_por_ano || {};
    const anosKeys = Object.keys(totaisAno).sort();
    if (anosKeys.length > 0) {
      containerAnos.innerHTML = anosKeys.map(ano => `
        <div class="comprometimento-ano-pill">
          <span>📅 Ano ${ano}:</span>
          <strong>${formatadorMoeda.format(totaisAno[ano])}</strong>
        </div>
      `).join('');
    } else {
      containerAnos.innerHTML = '';
    }
  }

  // 3. Status da Nuvem & Botão de Excluir
  const badgeNuvem = document.getElementById('badgeNuvemStatus');
  if (badgeNuvem) {
    badgeNuvem.textContent = '☁️ Salvo no Supabase';
    badgeNuvem.className = 'badge-nuvem-status';
  }

  const btnExcluir = document.getElementById('btnExcluirFaturaNuvem');
  if (btnExcluir) {
    btnExcluir.style.display = ESTADO.faturaSelecionadaId ? 'inline-flex' : 'none';
  }

  // 4. Cabeçalho da Tabela Matriz (Dinâmico até a última parcela!)
  const headRow = document.getElementById('matrixTableHeadRow');
  headRow.innerHTML = `
    <th style="min-width: 260px;">Portador / Cartão</th>
    <th style="text-align: center; width: 100px;">Compras</th>
    ${meses.map(m => `<th class="col-num">${formatarMesAnoLabel(m)}</th>`).join('')}
    <th class="col-num" style="color: var(--primary);">Total Futuro</th>
  `;

  // 5. Corpo da Tabela Matriz
  const tbody = document.getElementById('matrixTableBody');
  tbody.innerHTML = '';

  proj.matriz_cartoes.forEach((card, idx) => {
    const rowId = `matrixRow_${idx}`;

    // Linha Pai (Cartão / Portador)
    const trParent = document.createElement('tr');
    trParent.className = 'matrix-row-parent';
    trParent.id = rowId;
    trParent.onclick = () => alternarSubLinhas(idx);

    trParent.innerHTML = `
      <td>
        <div class="card-title-cell">
          <span class="card-expand-icon" id="expandIcon_${idx}">▶</span>
          <span>${removerAcentos(card.identificador_cartao)}</span>
          ${card.titular && card.titular !== 'Titular' ? `<span class="card-tag-badge">${removerAcentos(card.titular)}</span>` : ''}
        </div>
      </td>
      <td style="text-align: center;">
        <span class="card-tag-badge">${card.qtd_parcelamentos}</span>
      </td>
      ${meses.map(m => {
        const val = card.desembolso_meses[m] || 0.0;
        return `<td class="col-num" style="${val > 0 ? 'color: var(--text-main);' : 'color: var(--text-dim);'}">${val > 0 ? formatadorMoeda.format(val) : '-'}</td>`;
      }).join('')}
      <td class="col-num" style="color: #34d399; font-weight: 700;">
        ${formatadorMoeda.format(card.total_cartao_futuro)}
      </td>
    `;
    tbody.appendChild(trParent);

    // Linhas Filhas (Compras parceladas individuais deste cartão)
    card.itens.forEach(item => {
      const trChild = document.createElement('tr');
      trChild.className = `matrix-row-child child-of-${idx}`;
      trChild.style.display = 'none';

      trChild.innerHTML = `
        <td>
          <div class="child-indent">
            <span>•</span>
            <strong>${removerAcentos(item.estabelecimento)}</strong>
            <span class="child-tag-cat">${removerAcentos(item.categoria)}</span>
            <span style="font-size: 0.725rem; color: #60a5fa;">(${item.parcela_atual}/${item.parcela_total})</span>
          </div>
        </td>
        <td style="text-align: center; font-size: 0.75rem; color: var(--text-dim);">
          ${item.parcelas_restantes} rest.
        </td>
        ${meses.map(m => {
          const dadosCron = item.cronograma[m];
          if (dadosCron) {
            return `
              <td class="col-num" style="color: var(--text-main);">
                <div style="display: flex; flex-direction: column; align-items: flex-end;">
                  <span>${formatadorMoeda.format(dadosCron.valor)}</span>
                  <span style="font-size: 0.65rem; color: var(--text-dim);">${dadosCron.parcela_label}</span>
                </div>
              </td>
            `;
          } else {
            return `<td class="col-num" style="color: rgba(255,255,255,0.05);">-</td>`;
          }
        }).join('')}
        <td class="col-num" style="color: var(--text-muted); font-size: 0.8rem;">
          ${formatadorMoeda.format(item.saldo_restante)}
        </td>
      `;
      tbody.appendChild(trChild);
    });
  });

  // 6. Rodapé da Tabela Matriz com Totais
  const tfoot = document.getElementById('matrixTableFoot');
  tfoot.innerHTML = `
    <tr>
      <td>TOTAL GERAL POR MÊS</td>
      <td style="text-align: center;">${proj.detalhes_parcelas.length}</td>
      ${meses.map(m => {
        const totalMes = proj.totais_por_mes[m] || 0.0;
        return `<td class="col-num">${formatadorMoeda.format(totalMes)}</td>`;
      }).join('')}
      <td class="col-num" style="color: #34d399; font-size: 1rem;">
        ${formatadorMoeda.format(proj.total_comprometimento_futuro)}
      </td>
    </tr>
  `;

  // 7. Tabela de Detalhes Completa
  renderizarTabelaDetalhes(proj.detalhes_parcelas);
}

function alternarSubLinhas(idx) {
  const rowParent = document.getElementById(`matrixRow_${idx}`);
  const icon = document.getElementById(`expandIcon_${idx}`);
  const children = document.querySelectorAll(`.child-of-${idx}`);

  const estaExpandido = rowParent.classList.contains('expanded');
  if (estaExpandido) {
    rowParent.classList.remove('expanded');
    if (icon) icon.style.transform = 'rotate(0deg)';
    children.forEach(c => c.style.display = 'none');
  } else {
    rowParent.classList.add('expanded');
    if (icon) icon.style.transform = 'rotate(90deg)';
    children.forEach(c => c.style.display = 'table-row');
  }
}

function renderizarTabelaDetalhes(itens) {
  const tbody = document.getElementById('detailsTableBody');
  if (!tbody) return;

  tbody.innerHTML = itens.map(item => `
    <tr>
      <td><strong>${removerAcentos(item.banco)}</strong></td>
      <td>${removerAcentos(item.cartao)}</td>
      <td><strong>${removerAcentos(item.estabelecimento)}</strong></td>
      <td><span class="child-tag-cat">${removerAcentos(item.categoria)}</span></td>
      <td>${item.data_compra || '-'}</td>
      <td>${item.parcela_atual}</td>
      <td>${item.parcela_total}</td>
      <td style="color: #60a5fa; font-weight: 700;">${item.parcelas_restantes}</td>
      <td>${formatadorMoeda.format(item.valor_parcela)}</td>
      <td style="color: #34d399;">${formatadorMoeda.format(item.saldo_restante)}</td>
    </tr>
  `).join('');
}

function toggleSecaoDetalhes() {
  const section = document.querySelector('.details-section');
  if (section) section.classList.toggle('collapsed');
}

// ============================================================================
// 8. EXPORTAÇÃO EXCEL (.XLSX)
// ============================================================================
function baixarExcelProjecao() {
  // 1. Download instantâneo se tiver base64 (gerado na hora, zero latência)
  if (ESTADO.dadosAtuais && ESTADO.dadosAtuais.excel_base64) {
    try {
      const byteCharacters = atob(ESTADO.dadosAtuais.excel_base64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const banco = (ESTADO.dadosAtuais.fatura && ESTADO.dadosAtuais.fatura.banco) || 'cartoes';
      a.download = `projecao_${banco.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Download da planilha de projeção iniciado!', 'success');
      return;
    } catch (e) {
      console.warn('Erro ao processar base64, tentando rota de download:', e);
    }
  }

  // 2. Download via endpoint com excelId
  if (ESTADO.excelId) {
    window.location.href = `/api/download-excel?id=${encodeURIComponent(ESTADO.excelId)}`;
    showToast('Download da planilha de projeção iniciado!', 'success');
    return;
  }

  // 3. Download para fatura histórica do Supabase
  if (ESTADO.faturaSelecionadaId) {
    window.location.href = `/api/download-excel?fatura_id=${encodeURIComponent(ESTADO.faturaSelecionadaId)}`;
    showToast('Gerando e baixando planilha da fatura histórica...', 'info');
    return;
  }

  showToast('Planilha não disponível para download imediato.', 'info');
}

function limparAnalise() {
  ESTADO.dadosAtuais = null;
  ESTADO.excelId = null;
  ESTADO.faturaSelecionadaId = null;

  const results = document.getElementById('resultsArea');
  if (results) results.style.display = 'none';

  const fileInput = document.getElementById('pdfInput');
  if (fileInput) fileInput.value = '';

  const selectNuvem = document.getElementById('selectFaturaNuvem');
  if (selectNuvem) selectNuvem.value = '';

  showToast('Área limpa. Você pode carregar uma nova fatura.', 'info');
}

// ============================================================================
// 9. MODAL DE CONFIGURAÇÃO DE CHAVE DE API
// ============================================================================
function abrirModalApiKey() {
  const modal = document.getElementById('modalApiKey');
  const selProv = document.getElementById('inputProvedorModal');
  const inputKey = document.getElementById('inputApiKeyValor');

  if (selProv) selProv.value = ESTADO.provedorIA;
  atualizarInstrucoesProvedor();

  const chaveAtual = ESTADO.apiKeys[ESTADO.provedorIA] || '';
  if (inputKey) inputKey.value = chaveAtual;

  modal.classList.add('active');
}

function fecharModalApiKey() {
  const modal = document.getElementById('modalApiKey');
  modal.classList.remove('active');
}

function atualizarInstrucoesProvedor() {
  const sel = document.getElementById('inputProvedorModal');
  const label = document.getElementById('labelNomeProvedor');
  const helpLink = document.getElementById('helpLinkProvedor');
  const groupKey = document.getElementById('groupApiKeyInput');
  const inputKey = document.getElementById('inputApiKeyValor');

  const prov = sel.value;
  if (label) label.textContent = prov.toUpperCase();

  if (prov === 'gemini') {
    if (groupKey) groupKey.style.display = 'flex';
    if (helpLink) helpLink.innerHTML = 'Obtenha sua chave gratuita em: <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Google AI Studio (aistudio.google.com)</a>';
    if (inputKey) inputKey.value = ESTADO.apiKeys.gemini || '';
  } else if (prov === 'groq') {
    if (groupKey) groupKey.style.display = 'flex';
    if (helpLink) helpLink.innerHTML = 'Obtenha sua chave gratuita em: <a href="https://console.groq.com/keys" target="_blank" rel="noopener">Groq Console (console.groq.com)</a>';
    if (inputKey) inputKey.value = ESTADO.apiKeys.groq || '';
  } else {
    if (groupKey) groupKey.style.display = 'none';
  }
}

function toggleExibirApiKey() {
  const input = document.getElementById('inputApiKeyValor');
  if (input) {
    input.type = input.type === 'password' ? 'text' : 'password';
  }
}

function salvarConfiguracaoApiKey() {
  const selProv = document.getElementById('inputProvedorModal');
  const inputKey = document.getElementById('inputApiKeyValor');
  const prov = selProv.value;
  const key = inputKey ? inputKey.value.trim() : '';

  ESTADO.provedorIA = prov;
  localStorage.setItem('score_provedor_ia', prov);

  if (prov !== 'local') {
    ESTADO.apiKeys[prov] = key;
    localStorage.setItem(`score_api_key_${prov}`, key);
  }

  const selMain = document.getElementById('selectProvedorIA');
  if (selMain) selMain.value = prov;

  atualizarBadgeMotor();
  atualizarStatusApiKeyBadge();
  fecharModalApiKey();

  showToast('Configurações de IA salvas com sucesso!', 'success');
}

function atualizarStatusApiKeyBadge() {
  const icon = document.getElementById('apiKeyStatusIcon');
  const text = document.getElementById('apiKeyStatusText');
  const btn = document.getElementById('btnConfigApiKey');

  const prov = ESTADO.provedorIA;
  const key = ESTADO.apiKeys[prov] || '';

  if (prov === 'local') {
    if (icon) icon.textContent = '💻';
    if (text) text.textContent = 'Modo Local';
    if (btn) btn.className = 'btn btn-secondary btn-sm';
  } else if (key && key.trim()) {
    if (icon) icon.textContent = '✅';
    if (text) text.textContent = `${prov.toUpperCase()} Configurado`;
    if (btn) btn.className = 'btn btn-secondary btn-sm';
  } else {
    if (icon) icon.textContent = '🔑';
    if (text) text.textContent = `Configurar ${prov.toUpperCase()}`;
    if (btn) btn.className = 'btn btn-secondary btn-sm';
  }
}

// ============================================================================
// 10. TOAST NOTIFICATIONS
// ============================================================================
function showToast(mensagem, tipo = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${tipo}`;
  toast.textContent = mensagem;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}
