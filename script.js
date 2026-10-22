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
  filtroMesBusca: '',
  filtroAbaAno: 'TODOS',
  categoriaModoCalculo: 'fatura',
  categoriaTipoGrafico: 'doughnut',
  categoriaFiltroTabela: null,
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

function escapeJsString(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;');
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
  const profileBadge = document.getElementById('userProfileBadge');

  if (authSection) {
    if (autenticado) {
      authSection.classList.add('hidden');
      authSection.style.setProperty('display', 'none', 'important');
    } else {
      authSection.classList.remove('hidden');
      authSection.style.setProperty('display', 'flex', 'important');
    }
  }
  if (mainContent) {
    mainContent.style.setProperty('display', autenticado ? 'block' : 'none', 'important');
  }
  if (appHeader) {
    appHeader.style.setProperty('display', autenticado ? 'block' : 'none', 'important');
  }
  if (headerControls) {
    headerControls.style.setProperty('display', autenticado ? 'flex' : 'none', 'important');
  }
  if (profileBadge) {
    profileBadge.style.setProperty('display', autenticado ? 'flex' : 'none', 'important');
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
 * Extrai o ano de 4 dígitos a partir do mês de referência (ex: "2026-09", "SET/2026", "2025-12")
 */
function extrairAnoFatura(mesReferencia) {
  if (!mesReferencia) return 'Outros';
  const match = String(mesReferencia).match(/\b(20\d\d)\b/) || String(mesReferencia).match(/\d{4}/);
  return match ? match[0] : 'Outros';
}

/**
 * Controla abertura e fechamento do Popover de Filtro por Mês/Ano
 */
function togglePopoverFiltroMes(e) {
  if (e) e.stopPropagation();
  const popover = document.getElementById('popoverFiltroMes');
  const btn = document.getElementById('btnFiltroMesTrigger');
  if (!popover) return;

  const estaVisivel = popover.style.display !== 'none';
  if (estaVisivel) {
    fecharPopoverFiltroMes();
  } else {
    popover.style.display = 'block';
    if (btn) btn.classList.add('active');

    // Reseta campo de busca ao abrir para foco imediato
    const input = document.getElementById('inputBuscaFiltroMes');
    if (input) {
      input.value = '';
      ESTADO.filtroMesBusca = '';
      const btnClear = document.getElementById('btnClearBuscaFiltroMes');
      if (btnClear) btnClear.style.display = 'none';
    }

    renderizarPopoverFiltroMes();

    if (input) {
      setTimeout(() => input.focus(), 60);
    }
  }
}

function fecharPopoverFiltroMes() {
  const popover = document.getElementById('popoverFiltroMes');
  const btn = document.getElementById('btnFiltroMesTrigger');
  if (popover) popover.style.display = 'none';
  if (btn) btn.classList.remove('active');
}

// Listeners globais para fechar popover ao clicar fora ou apertar Escape
if (typeof document !== 'undefined') {
  document.addEventListener('click', e => {
    const wrapper = document.getElementById('filtroMesWrapper');
    if (wrapper && !wrapper.contains(e.target)) {
      fecharPopoverFiltroMes();
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      fecharPopoverFiltroMes();
    }
  });
}

function aoDigitarBuscaFiltroMes(valor) {
  ESTADO.filtroMesBusca = (valor || '').trim().toLowerCase();
  const btnClear = document.getElementById('btnClearBuscaFiltroMes');
  if (btnClear) {
    btnClear.style.display = ESTADO.filtroMesBusca ? 'block' : 'none';
  }
  renderizarListaAgrupadaPopover();
}

function limparBuscaFiltroMes() {
  const input = document.getElementById('inputBuscaFiltroMes');
  if (input) input.value = '';
  ESTADO.filtroMesBusca = '';
  const btnClear = document.getElementById('btnClearBuscaFiltroMes');
  if (btnClear) btnClear.style.display = 'none';
  renderizarListaAgrupadaPopover();
  if (input) input.focus();
}

function selecionarAbaAnoFiltro(ano) {
  ESTADO.filtroAbaAno = ano;
  renderizarAbasAnoPopover();
  renderizarListaAgrupadaPopover();
}

function selecionarFiltroMes(rotuloMes) {
  ESTADO.mesFiltroFaturas = rotuloMes || '';
  fecharPopoverFiltroMes();
  atualizarRotuloBotaoFiltro();
  renderizarOpcoesFaturasNuvem();

  const selectOculto = document.getElementById('selectFiltroMesFatura');
  if (selectOculto) selectOculto.value = rotuloMes || '';

  if (rotuloMes) {
    showToast(`Filtro aplicado: ${rotuloMes}`, 'info');
  } else {
    showToast('Exibindo todos os meses e anos.', 'info');
  }
}

function selecionarFiltroAno(ano) {
  if (!ano) {
    selecionarFiltroMes('');
    return;
  }
  ESTADO.mesFiltroFaturas = `ANO:${ano}`;
  fecharPopoverFiltroMes();
  atualizarRotuloBotaoFiltro();
  renderizarOpcoesFaturasNuvem();

  const selectOculto = document.getElementById('selectFiltroMesFatura');
  if (selectOculto) selectOculto.value = `ANO:${ano}`;

  showToast(`Filtro aplicado: Faturas do Ano ${ano}`, 'info');
}

function atualizarRotuloBotaoFiltro() {
  const labelEl = document.getElementById('labelFiltroMesAtivo');
  if (!labelEl) return;

  const faturas = ESTADO.faturasSalvas || [];
  const filtro = ESTADO.mesFiltroFaturas || '';

  if (!filtro) {
    labelEl.textContent = `Todos os Meses (${faturas.length})`;
    labelEl.classList.remove('has-filter');
    return;
  }

  if (filtro.startsWith('ANO:')) {
    const ano = filtro.replace('ANO:', '');
    const qtd = faturas.filter(f => extrairAnoFatura(f.mes_referencia) === ano).length;
    labelEl.textContent = `Ano ${ano} (${qtd})`;
    labelEl.classList.add('has-filter');
    return;
  }

  const qtd = faturas.filter(f => formatarMesAnoLabel(f.mes_referencia) === filtro).length;
  labelEl.textContent = `${filtro} (${qtd})`;
  labelEl.classList.add('has-filter');
}

const NOMES_MESES_EXTENSO = [
  { code: 'JAN', aliases: ['jan', 'janeiro'] },
  { code: 'FEV', aliases: ['fev', 'fevereiro'] },
  { code: 'MAR', aliases: ['mar', 'marco', 'março'] },
  { code: 'ABR', aliases: ['abr', 'abril'] },
  { code: 'MAI', aliases: ['mai', 'maio'] },
  { code: 'JUN', aliases: ['jun', 'junho'] },
  { code: 'JUL', aliases: ['jul', 'julho'] },
  { code: 'AGO', aliases: ['ago', 'agosto'] },
  { code: 'SET', aliases: ['set', 'setembro'] },
  { code: 'OUT', aliases: ['out', 'outubro'] },
  { code: 'NOV', aliases: ['nov', 'novembro'] },
  { code: 'DEZ', aliases: ['dez', 'dezembro'] }
];

function agruparFaturasPorAnoEMes() {
  const faturas = ESTADO.faturasSalvas || [];
  const anosMap = new Map();

  faturas.forEach(f => {
    const rotulo = formatarMesAnoLabel(f.mes_referencia);
    if (!rotulo) return;
    const ano = extrairAnoFatura(f.mes_referencia);

    if (!anosMap.has(ano)) {
      anosMap.set(ano, {
        ano,
        totalFaturas: 0,
        mesesMap: new Map()
      });
    }

    const anoObj = anosMap.get(ano);
    anoObj.totalFaturas += 1;

    if (!anoObj.mesesMap.has(rotulo)) {
      anoObj.mesesMap.set(rotulo, {
        rotulo,
        mesRef: f.mes_referencia || '',
        ano,
        qtd: 1,
        bancos: new Set([f.banco].filter(Boolean))
      });
    } else {
      const mesItem = anoObj.mesesMap.get(rotulo);
      mesItem.qtd += 1;
      if (f.banco) mesItem.bancos.add(f.banco);
    }
  });

  // Ordena anos decrescentes
  const anosOrdenados = Array.from(anosMap.values()).sort((a, b) => {
    return b.ano.localeCompare(a.ano);
  });

  // Ordena meses de cada ano cronologicamente decrescente
  anosOrdenados.forEach(anoObj => {
    anoObj.meses = Array.from(anoObj.mesesMap.values()).sort((a, b) => {
      return (b.mesRef || '').localeCompare(a.mesRef || '');
    });
  });

  return anosOrdenados;
}

function renderizarPopoverFiltroMes() {
  renderizarAbasAnoPopover();
  renderizarListaAgrupadaPopover();
}

function renderizarAbasAnoPopover() {
  const tabsContainer = document.getElementById('filterYearTabs');
  if (!tabsContainer) return;

  const gruposAnos = agruparFaturasPorAnoEMes();
  const faturas = ESTADO.faturasSalvas || [];
  const abaAtiva = ESTADO.filtroAbaAno || 'TODOS';

  if (gruposAnos.length <= 1) {
    tabsContainer.style.display = 'none';
    return;
  }

  tabsContainer.style.display = 'flex';
  tabsContainer.innerHTML = '';

  // Aba "Todos"
  const btnTodos = document.createElement('button');
  btnTodos.type = 'button';
  btnTodos.className = `filter-year-tab-btn ${abaAtiva === 'TODOS' ? 'active' : ''}`;
  btnTodos.innerHTML = `Todos (${faturas.length})`;
  btnTodos.onclick = () => selecionarAbaAnoFiltro('TODOS');
  tabsContainer.appendChild(btnTodos);

  gruposAnos.forEach(g => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `filter-year-tab-btn ${abaAtiva === g.ano ? 'active' : ''}`;
    btn.innerHTML = `${g.ano} (${g.totalFaturas})`;
    btn.onclick = () => selecionarAbaAnoFiltro(g.ano);
    tabsContainer.appendChild(btn);
  });
}

function renderizarListaAgrupadaPopover() {
  const container = document.getElementById('listaAgrupadaFiltroMes');
  if (!container) return;

  const faturas = ESTADO.faturasSalvas || [];
  if (faturas.length === 0) {
    container.innerHTML = `
      <div class="filter-search-empty">
        <span class="filter-search-empty-icon">☁️</span>
        <p>Nenhuma fatura salva encontrada na nuvem.</p>
      </div>
    `;
    return;
  }

  const gruposAnos = agruparFaturasPorAnoEMes();
  const busca = (ESTADO.filtroMesBusca || '').trim().toLowerCase();
  const abaAtiva = ESTADO.filtroAbaAno || 'TODOS';
  const filtroAtivo = ESTADO.mesFiltroFaturas || '';

  let html = '';
  if (!busca || 'todos os meses'.includes(busca) || 'todos'.includes(busca)) {
    const isTodosSelected = !filtroAtivo;
    html += `
      <div class="filter-item-global ${isTodosSelected ? 'selected' : ''}" onclick="selecionarFiltroMes('')" title="Visualizar todas as faturas">
        <div class="filter-item-global-left">
          <span style="font-size: 1rem;">🌐</span>
          <span class="filter-item-global-title">Todos os Meses e Anos</span>
        </div>
        <div style="display: flex; align-items: center; gap: 0.4rem;">
          <span class="filter-item-badge">${faturas.length} faturas</span>
          ${isTodosSelected ? '<span style="color: #34d399; font-weight: bold;">✓</span>' : ''}
        </div>
      </div>
    `;
  }

  let totalMesesExibidos = 0;

  gruposAnos.forEach(g => {
    if (!busca && abaAtiva !== 'TODOS' && abaAtiva !== g.ano) {
      return;
    }

    const mesesFiltrados = g.meses.filter(m => {
      if (!busca) return true;
      const rotuloNorm = removerAcentos(m.rotulo).toLowerCase();
      if (rotuloNorm.includes(busca)) return true;
      if (m.ano.includes(busca)) return true;

      const mesCode = m.rotulo.split('/')[0] || '';
      const def = NOMES_MESES_EXTENSO.find(item => item.code === mesCode);
      if (def && def.aliases.some(alias => alias.includes(busca) || busca.includes(alias))) {
        return true;
      }

      for (const banco of m.bancos) {
        if (removerAcentos(banco).toLowerCase().includes(busca)) return true;
      }

      return false;
    });

    if (mesesFiltrados.length === 0) return;
    totalMesesExibidos += mesesFiltrados.length;

    const isAnoAtivo = filtroAtivo === `ANO:${g.ano}`;

    html += `
      <div class="filter-year-section">
        <div class="filter-year-header">
          <div class="filter-year-title">
            <span>📁</span>
            <span>Ano ${g.ano}</span>
            <span class="filter-year-count">(${g.totalFaturas} ${g.totalFaturas === 1 ? 'fatura' : 'faturas'})</span>
          </div>
          <button 
            type="button" 
            class="btn-filter-year-all ${isAnoAtivo ? 'active' : ''}" 
            onclick="selecionarFiltroAno('${g.ano}')" 
            title="Filtrar todas as faturas do ano ${g.ano}"
          >
            ${isAnoAtivo ? '✓ Ano Ativo' : 'Filtrar Ano'}
          </button>
        </div>

        <div class="filter-months-grid">
          ${mesesFiltrados.map(m => {
            const isMesSelecionado = filtroAtivo === m.rotulo;
            return `
              <button 
                type="button" 
                class="filter-month-card ${isMesSelecionado ? 'selected' : ''}" 
                onclick="selecionarFiltroMes('${escapeJsString(m.rotulo)}')"
                title="Filtrar por ${m.rotulo}"
              >
                <div class="month-card-left">
                  ${isMesSelecionado ? '<span class="month-card-check">✓</span>' : ''}
                  <span>${m.rotulo}</span>
                </div>
                <span class="month-faturas-badge">${m.qtd} fat.</span>
              </button>
            `;
          }).join('')}
        </div>
      </div>
    `;
  });

  if (busca && totalMesesExibidos === 0) {
    html = `
      <div class="filter-search-empty">
        <span class="filter-search-empty-icon">🔍</span>
        <p>Nenhum mês ou ano encontrado para "<strong>${escapeJsString(busca)}</strong>"</p>
        <button type="button" class="btn-reset-filter-link" onclick="limparBuscaFiltroMes()" style="margin-top: 0.5rem;">Limpar pesquisa</button>
      </div>
    `;
  }

  container.innerHTML = html;
}

/**
 * Preenche o seletor de filtro por mês com base nas faturas salvas existentes
 */
function atualizarOpcoesFiltroMes() {
  atualizarRotuloBotaoFiltro();

  const totalFooter = document.getElementById('filterFooterTotal');
  const faturas = ESTADO.faturasSalvas || [];
  if (totalFooter) {
    const anosDistintos = new Set(faturas.map(f => extrairAnoFatura(f.mes_referencia)));
    totalFooter.textContent = `${faturas.length} faturas • ${anosDistintos.size} ${anosDistintos.size === 1 ? 'ano' : 'anos'}`;
  }

  const popover = document.getElementById('popoverFiltroMes');
  if (popover && popover.style.display !== 'none') {
    renderizarPopoverFiltroMes();
  }

  const selectFiltroMes = document.getElementById('selectFiltroMesFatura');
  if (selectFiltroMes) {
    selectFiltroMes.innerHTML = '';
    const optTodos = document.createElement('option');
    optTodos.value = '';
    optTodos.textContent = `Todos os Meses (${faturas.length})`;
    if (!ESTADO.mesFiltroFaturas) optTodos.selected = true;
    selectFiltroMes.appendChild(optTodos);
  }
}

/**
 * Renderiza as opções de faturas no select respeitando o filtro de mês/ano ativo e separando de ano em ano
 */
function renderizarOpcoesFaturasNuvem() {
  const select = document.getElementById('selectFaturaNuvem');
  if (!select) return;

  const faturas = ESTADO.faturasSalvas || [];
  const filtro = ESTADO.mesFiltroFaturas || '';

  select.innerHTML = '';

  if (faturas.length === 0) {
    select.innerHTML = '<option value="">☁️ Nenhuma fatura salva</option>';
    return;
  }

  // Filtra as faturas caso um mês específico ou ano esteja selecionado
  let faturasFiltradas = faturas;
  let tituloPadrao = `☁️ Faturas Salvas (${faturas.length})`;

  if (filtro.startsWith('ANO:')) {
    const ano = filtro.replace('ANO:', '');
    faturasFiltradas = faturas.filter(f => extrairAnoFatura(f.mes_referencia) === ano);
    tituloPadrao = `☁️ Faturas do Ano ${ano} (${faturasFiltradas.length})`;
  } else if (filtro) {
    faturasFiltradas = faturas.filter(f => formatarMesAnoLabel(f.mes_referencia) === filtro);
    tituloPadrao = `☁️ Faturas ${filtro} (${faturasFiltradas.length})`;
  }

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = tituloPadrao;
  select.appendChild(defaultOpt);

  if (faturasFiltradas.length === 0) {
    const optVazio = document.createElement('option');
    optVazio.value = '';
    optVazio.textContent = `Nenhuma fatura encontrada`;
    optVazio.disabled = true;
    select.appendChild(optVazio);
    return;
  }

  // Separa as faturas de ano em ano usando optgroups
  const faturasPorAno = new Map();
  faturasFiltradas.forEach(f => {
    const ano = extrairAnoFatura(f.mes_referencia);
    if (!faturasPorAno.has(ano)) {
      faturasPorAno.set(ano, []);
    }
    faturasPorAno.get(ano).push(f);
  });

  const anosOrdenados = Array.from(faturasPorAno.keys()).sort((a, b) => b.localeCompare(a));

  anosOrdenados.forEach(ano => {
    const listaDoAno = faturasPorAno.get(ano);
    const precisaOptgroup = anosOrdenados.length > 1 || !filtro;
    const parentContainer = precisaOptgroup ? document.createElement('optgroup') : select;

    if (precisaOptgroup && parentContainer instanceof HTMLOptGroupElement) {
      parentContainer.label = `── 📅 Ano ${ano} (${listaDoAno.length} ${listaDoAno.length === 1 ? 'fatura' : 'faturas'}) ──`;
    }

    listaDoAno.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id;
      const totalFmt = formatadorMoeda.format(f.total_fatura || 0);
      opt.textContent = `${removerAcentos(f.banco)} • ${formatarMesAnoLabel(f.mes_referencia)} (${totalFmt})`;
      if (ESTADO.faturaSelecionadaId === f.id) {
        opt.selected = true;
      }
      parentContainer.appendChild(opt);
    });

    if (precisaOptgroup) {
      select.appendChild(parentContainer);
    }
  });

  // Se a fatura atualmente carregada na tela não pertencer ao filtro ativo, reseta a seleção no dropdown
  if (ESTADO.faturaSelecionadaId && !faturasFiltradas.some(f => f.id === ESTADO.faturaSelecionadaId)) {
    select.value = '';
  }
}

/**
 * Evento disparado para sincronização de filtro de mês
 */
function aoFiltrarMesFaturas() {
  const selectFiltroMes = document.getElementById('selectFiltroMesFatura');
  const mesEscolhido = selectFiltroMes ? selectFiltroMes.value : '';
  ESTADO.mesFiltroFaturas = mesEscolhido;
  atualizarRotuloBotaoFiltro();
  renderizarOpcoesFaturasNuvem();
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
      <div class="anual-card" onclick="selecionarFiltroAno('${item.ano}')" style="cursor: pointer;" title="Clique para filtrar faturas do ano ${item.ano}">
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
            <span class="child-tag-cat" onclick="abrirModalEditarCategoria('${escapeJsString(item.estabelecimento)}', '${escapeJsString(item.categoria)}')" title="Clique para editar a categoria contábil">${removerAcentos(item.categoria)} <span class="edit-cat-icon">✏️</span></span>
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

  // 8. Gráfico e Ranking Estratégico por Categoria Contábil
  renderizarGraficoCategorias(proj.detalhes_parcelas);
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

  const filtroCat = ESTADO.categoriaFiltroTabela;
  const itensExibir = filtroCat
    ? itens.filter(it => removerAcentos(it.categoria).toLowerCase() === removerAcentos(filtroCat).toLowerCase())
    : itens;

  if (itensExibir.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align: center; padding: 2rem; color: var(--text-dim);">
          Nenhuma transação encontrada para a categoria <strong>${removerAcentos(filtroCat)}</strong>.
          <br><button type="button" class="btn btn-secondary btn-sm" onclick="filtrarTabelaPorCategoria(null)" style="margin-top: 0.65rem;">Remover Filtro de Categoria</button>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = itensExibir.map(item => `
    <tr class="${filtroCat ? 'highlight-filtered-row' : ''}">
      <td><strong>${removerAcentos(item.banco)}</strong></td>
      <td>${removerAcentos(item.cartao)}</td>
      <td><strong>${removerAcentos(item.estabelecimento)}</strong></td>
      <td><span class="child-tag-cat" onclick="abrirModalEditarCategoria('${escapeJsString(item.estabelecimento)}', '${escapeJsString(item.categoria)}')" title="Clique para editar a categoria contábil">${removerAcentos(item.categoria)} <span class="edit-cat-icon">✏️</span></span></td>
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
// 8. ANÁLISE E GRÁFICOS POR CATEGORIA CONTÁBIL
// ============================================================================
const MAPA_CORES_CATEGORIAS = {
  'Supermercado & Alimentos': { cor: '#10b981', corGlow: 'rgba(16, 185, 129, 0.4)', icone: '🛒' },
  'Restaurantes & Delivery': { cor: '#f59e0b', corGlow: 'rgba(245, 158, 11, 0.4)', icone: '🍽️' },
  'Farmacia & Saude': { cor: '#ef4444', corGlow: 'rgba(239, 68, 68, 0.4)', icone: '🏥' },
  'Transporte & Combustivel': { cor: '#06b6d4', corGlow: 'rgba(6, 182, 212, 0.4)', icone: '🚗' },
  'Viagens & Lazer': { cor: '#8b5cf6', corGlow: 'rgba(139, 92, 246, 0.4)', icone: '✈️' },
  'Vestuario & Moda': { cor: '#ec4899', corGlow: 'rgba(236, 72, 153, 0.4)', icone: '👗' },
  'Eletronicos & Informatica': { cor: '#3b82f6', corGlow: 'rgba(59, 130, 246, 0.4)', icone: '💻' },
  'Assinaturas & Streaming': { cor: '#a855f7', corGlow: 'rgba(168, 85, 247, 0.4)', icone: '📺' },
  'Servicos & Taxas': { cor: '#64748b', corGlow: 'rgba(100, 116, 139, 0.4)', icone: '⚡' },
  'Outros Lancamentos': { cor: '#94a3b8', corGlow: 'rgba(148, 163, 184, 0.4)', icone: '📦' }
};

const PALETA_CORES_EXTRAS = [
  '#0ea5e9', '#14b8a6', '#f97316', '#6366f1', '#84cc16', 
  '#d946ef', '#eab308', '#22c55e', '#06b6d4', '#f43f5e'
];

function obterInfoVisualCategoria(nomeCat, index = 0) {
  const norm = removerAcentos(nomeCat).toLowerCase();
  for (const [chave, info] of Object.entries(MAPA_CORES_CATEGORIAS)) {
    if (removerAcentos(chave).toLowerCase() === norm) {
      return info;
    }
  }
  const cor = PALETA_CORES_EXTRAS[index % PALETA_CORES_EXTRAS.length];
  return {
    cor,
    corGlow: `${cor}66`,
    icone: '🏷️'
  };
}

let _instanciaGraficoCategorias = null;

function destruirGraficoCategorias() {
  if (_instanciaGraficoCategorias) {
    try {
      _instanciaGraficoCategorias.destroy();
    } catch (_) {}
    _instanciaGraficoCategorias = null;
  }
}

function calcularTotaisPorCategoria(itens) {
  const modo = ESTADO.categoriaModoCalculo || 'fatura';
  const mapa = new Map();
  let totalGeral = 0;
  let qtdItensConsiderados = 0;

  (itens || []).forEach(item => {
    const cat = removerAcentos(item.categoria) || 'Outros Lancamentos';
    
    let val = 0;
    if (modo === 'comprometimento') {
      const saldoRest = parseFloat(item.saldo_restante);
      val = (!isNaN(saldoRest) && saldoRest > 0) ? saldoRest : 0;

      // Se a compra já foi quitada nesta fatura (ex: 3/3, saldo restante = 0),
      // ela não possui parcelas futuras e não gera comprometimento futuro
      if (val <= 0) return;
    } else {
      val = parseFloat(item.valor_parcela) || 0;
    }

    if (!mapa.has(cat)) {
      mapa.set(cat, {
        categoria: cat,
        total: 0,
        qtd: 0,
        estabelecimentos: new Set()
      });
    }
    const reg = mapa.get(cat);
    reg.total += val;
    reg.qtd += 1;
    qtdItensConsiderados += 1;
    if (item.estabelecimento) reg.estabelecimentos.add(removerAcentos(item.estabelecimento));
    totalGeral += val;
  });

  const lista = Array.from(mapa.values()).sort((a, b) => b.total - a.total);
  lista.forEach(reg => {
    reg.percentual = totalGeral > 0 ? (reg.total / totalGeral) * 100 : 0;
  });

  return { lista, totalGeral, qtdItensConsiderados };
}

function renderizarGraficoCategorias(itens) {
  const secao = document.getElementById('secaoGastosCategoria');
  if (!secao) return;

  if (!itens || itens.length === 0) {
    secao.style.display = 'none';
    return;
  }
  secao.style.display = 'block';

  const modo = ESTADO.categoriaModoCalculo || 'fatura';
  const tipoGrafico = ESTADO.categoriaTipoGrafico || 'doughnut';
  const { lista, totalGeral, qtdItensConsiderados } = calcularTotaisPorCategoria(itens);

  // 1. Atualiza Indicadores Centrais e Textos
  const labelKpi = document.getElementById('centerKpiLabel');
  const valKpi = document.getElementById('centerKpiValue');
  const subKpi = document.getElementById('centerKpiSub');
  const statRank = document.getElementById('rankingHeaderStat');

  if (labelKpi) {
    labelKpi.textContent = modo === 'comprometimento' ? 'Comprometimento' : 'Fatura Atual';
  }
  if (valKpi) {
    valKpi.textContent = formatadorMoeda.format(totalGeral);
  }
  if (subKpi) {
    subKpi.textContent = `${lista.length} ${lista.length === 1 ? 'categoria' : 'categorias'}`;
  }
  if (statRank) {
    if (modo === 'comprometimento') {
      statRank.textContent = `${qtdItensConsiderados} compras com parcelas a vencer`;
    } else {
      statRank.textContent = `${itens.length} compras na fatura`;
    }
  }

  // 2. Renderiza lista de barras no ranking lateral
  renderizarListaBarrasCategorias(lista, totalGeral);

  // 3. Renderiza Gráfico via Chart.js
  const canvas = document.getElementById('graficoCategoriasCanvas');
  const centerKpi = document.getElementById('chartCenterKpi');

  if (!canvas) return;

  destruirGraficoCategorias();

  if (typeof Chart === 'undefined') {
    if (centerKpi) centerKpi.style.display = 'none';
    return;
  }

  const labels = lista.map(item => item.categoria);
  const dataVals = lista.map(item => item.total);
  const backgroundColors = lista.map((item, idx) => obterInfoVisualCategoria(item.categoria, idx).cor);

  if (centerKpi) {
    centerKpi.style.display = tipoGrafico === 'doughnut' ? 'flex' : 'none';
  }

  const ctx = canvas.getContext('2d');

  if (tipoGrafico === 'doughnut') {
    _instanciaGraficoCategorias = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: dataVals,
          backgroundColor: backgroundColors,
          borderColor: '#111827',
          borderWidth: 3,
          hoverBorderColor: '#ffffff',
          hoverBorderWidth: 2,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '72%',
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: 'rgba(17, 24, 39, 0.95)',
            titleColor: '#f8fafc',
            bodyColor: '#34d399',
            borderColor: 'rgba(255, 255, 255, 0.12)',
            borderWidth: 1,
            padding: 12,
            boxPadding: 6,
            usePointStyle: true,
            callbacks: {
              label: function(context) {
                const val = context.raw || 0;
                const pct = totalGeral > 0 ? ((val / totalGeral) * 100).toFixed(1) : '0.0';
                return ` ${formatadorMoeda.format(val)} (${pct}%)`;
              }
            }
          }
        },
        onClick: (event, elements) => {
          if (elements && elements.length > 0) {
            const index = elements[0].index;
            const cat = labels[index];
            filtrarTabelaPorCategoria(cat);
          }
        }
      }
    });
  } else {
    // Modo Barras Horizontais
    _instanciaGraficoCategorias = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels.map(l => l.length > 18 ? l.substring(0, 16) + '...' : l),
        datasets: [{
          data: dataVals,
          backgroundColor: backgroundColors,
          borderRadius: 6,
          borderSkipped: false
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(17, 24, 39, 0.95)',
            titleColor: '#f8fafc',
            bodyColor: '#34d399',
            borderColor: 'rgba(255, 255, 255, 0.12)',
            borderWidth: 1,
            padding: 10,
            callbacks: {
              title: (items) => labels[items[0].dataIndex],
              label: (context) => {
                const val = context.raw || 0;
                const pct = totalGeral > 0 ? ((val / totalGeral) * 100).toFixed(1) : '0.0';
                return ` ${formatadorMoeda.format(val)} (${pct}%)`;
              }
            }
          }
        },
        scales: {
          x: {
            display: false,
            grid: { display: false }
          },
          y: {
            ticks: {
              color: '#94a3b8',
              font: { size: 10, weight: 'bold' }
            },
            grid: { color: 'rgba(255, 255, 255, 0.05)' }
          }
        },
        onClick: (event, elements) => {
          if (elements && elements.length > 0) {
            const index = elements[0].index;
            const cat = labels[index];
            filtrarTabelaPorCategoria(cat);
          }
        }
      }
    });
  }
}

function renderizarListaBarrasCategorias(lista, totalGeral) {
  const container = document.getElementById('listaBarrasCategorias');
  if (!container) return;

  if (!lista || lista.length === 0) {
    container.innerHTML = `
      <div class="category-analytics-empty">
        <span>📊</span>
        <p>Nenhuma compra categorizada encontrada nesta fatura.</p>
      </div>
    `;
    return;
  }

  const filtroAtivo = ESTADO.categoriaFiltroTabela;

  container.innerHTML = lista.map((item, idx) => {
    const info = obterInfoVisualCategoria(item.categoria, idx);
    const pct = item.percentual.toFixed(1);
    const isFiltered = filtroAtivo && removerAcentos(filtroAtivo).toLowerCase() === removerAcentos(item.categoria).toLowerCase();

    return `
      <div 
        class="cat-bar-item ${isFiltered ? 'filtered-active' : ''}" 
        onclick="filtrarTabelaPorCategoria('${escapeJsString(item.categoria)}')"
        title="Clique para filtrar apenas compras de ${item.categoria} na tabela detalhada"
      >
        <div class="cat-bar-header">
          <div class="cat-bar-title">
            <span class="cat-bar-icon">${info.icone}</span>
            <span>${removerAcentos(item.categoria)}</span>
          </div>
          <div class="cat-bar-values">
            <span class="cat-bar-val">${formatadorMoeda.format(item.total)}</span>
            <span class="cat-bar-pct" style="color: ${info.cor}; background: ${info.corGlow};">${pct}%</span>
          </div>
        </div>

        <div class="cat-bar-track">
          <div class="cat-bar-fill" style="width: ${pct}%; background: linear-gradient(90deg, ${info.cor}, ${info.corGlow});"></div>
        </div>

        <div class="cat-bar-sub">
          <span>${item.qtd} ${item.qtd === 1 ? 'compra' : 'compras'} parceladas</span>
          <span class="cat-bar-hint">${isFiltered ? '✓ Filtro Ativo (Clique para remover)' : 'Ver transações →'}</span>
        </div>
      </div>
    `;
  }).join('');
}

function toggleSecaoGraficoCategorias(event) {
  if (event) {
    event.stopPropagation();
  }
  const secao = document.getElementById('secaoGastosCategoria');
  if (!secao) return;

  const estaColapsado = secao.classList.toggle('collapsed');
  const iconHeader = document.getElementById('iconToggleGraficoCategorias');
  const arrowBtn = document.getElementById('btnArrowToggleGrafico');
  const textBtn = document.getElementById('btnTextToggleGrafico');
  const hintEl = document.getElementById('hintToggleGraficoCategorias');

  if (iconHeader) iconHeader.textContent = estaColapsado ? '▶' : '▼';
  if (arrowBtn) arrowBtn.textContent = estaColapsado ? '▶' : '▼';
  if (textBtn) textBtn.textContent = estaColapsado ? 'Expandir' : 'Recolher';
  if (hintEl) hintEl.textContent = estaColapsado ? 'Clique para expandir o gráfico' : 'Recolher / Expandir painel';

  // Se reabriu, ajusta o canvas do Chart.js para garantir proporções perfeitas
  if (!estaColapsado && _instanciaGraficoCategorias) {
    setTimeout(() => {
      try {
        _instanciaGraficoCategorias.resize();
        _instanciaGraficoCategorias.update();
      } catch (e) {
        console.warn('Erro ao atualizar gráfico:', e);
      }
    }, 60);
  }
}

function alternarModoCalculoCategoria(modo) {
  if (ESTADO.categoriaModoCalculo === modo) return;
  ESTADO.categoriaModoCalculo = modo;

  const btnFat = document.getElementById('btnCatModoFatura');
  const btnComp = document.getElementById('btnCatModoComprometimento');

  if (btnFat) btnFat.classList.toggle('active', modo === 'fatura');
  if (btnComp) btnComp.classList.toggle('active', modo === 'comprometimento');

  // Se estiver recolhido, expande automaticamente para exibir a nova visualização
  const secao = document.getElementById('secaoGastosCategoria');
  if (secao && secao.classList.contains('collapsed')) {
    toggleSecaoGraficoCategorias();
  }

  if (ESTADO.dadosAtuais && ESTADO.dadosAtuais.projecao && ESTADO.dadosAtuais.projecao.detalhes_parcelas) {
    renderizarGraficoCategorias(ESTADO.dadosAtuais.projecao.detalhes_parcelas);
  }
}

function alternarTipoGraficoCategoria(tipo) {
  if (ESTADO.categoriaTipoGrafico === tipo) return;
  ESTADO.categoriaTipoGrafico = tipo;

  const btnDoughnut = document.getElementById('btnCatTipoDoughnut');
  const btnBar = document.getElementById('btnCatTipoBar');

  if (btnDoughnut) btnDoughnut.classList.toggle('active', tipo === 'doughnut');
  if (btnBar) btnBar.classList.toggle('active', tipo === 'bar');

  // Se estiver recolhido, expande automaticamente
  const secao = document.getElementById('secaoGastosCategoria');
  if (secao && secao.classList.contains('collapsed')) {
    toggleSecaoGraficoCategorias();
  }

  if (ESTADO.dadosAtuais && ESTADO.dadosAtuais.projecao && ESTADO.dadosAtuais.projecao.detalhes_parcelas) {
    renderizarGraficoCategorias(ESTADO.dadosAtuais.projecao.detalhes_parcelas);
  }
}

function filtrarTabelaPorCategoria(catNome) {
  if (ESTADO.categoriaFiltroTabela === catNome) {
    ESTADO.categoriaFiltroTabela = null; // Desativa filtro
    showToast('Filtro de categoria removido da tabela.', 'info');
  } else {
    ESTADO.categoriaFiltroTabela = catNome;
    if (catNome) {
      showToast(`Exibindo compras da categoria: ${catNome}`, 'info');
    }
  }

  // Re-renderiza o ranking para marcar visualmente o item ativo
  if (ESTADO.dadosAtuais && ESTADO.dadosAtuais.projecao && ESTADO.dadosAtuais.projecao.detalhes_parcelas) {
    const { lista, totalGeral } = calcularTotaisPorCategoria(ESTADO.dadosAtuais.projecao.detalhes_parcelas);
    renderizarListaBarrasCategorias(lista, totalGeral);
    renderizarTabelaDetalhes(ESTADO.dadosAtuais.projecao.detalhes_parcelas);
  }

  // Abre a seção de detalhes se estiver oculta e rola suavemente até ela
  const content = document.getElementById('detailsContent');
  const icon = document.getElementById('detailsToggleIcon');
  if (content && content.style.display === 'none') {
    content.style.display = 'block';
    if (icon) icon.textContent = '▲';
  }

  const table = document.getElementById('detailsTableBody');
  if (table && catNome) {
    table.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
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
  ESTADO.categoriaFiltroTabela = null;

  destruirGraficoCategorias();

  const results = document.getElementById('resultsArea');
  if (results) results.style.display = 'none';

  const secaoCat = document.getElementById('secaoGastosCategoria');
  if (secaoCat) secaoCat.style.display = 'none';

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
    if (btn) btn.className = 'btn-ai-key-action key-local';
  } else if (key && key.trim()) {
    if (icon) icon.textContent = '✅';
    if (text) text.textContent = `${prov.toUpperCase()} Ativo`;
    if (btn) btn.className = 'btn-ai-key-action key-ok';
  } else {
    if (icon) icon.textContent = '🔑';
    if (text) text.textContent = `Configurar ${prov.toUpperCase()}`;
    if (btn) btn.className = 'btn-ai-key-action key-needed';
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

// ============================================================================
// 11. EDIÇÃO DE CATEGORIAS CONTÁBEIS
// ============================================================================
let _contextoEdicaoCat = {
  estabelecimento: '',
  categoriaAtual: '',
  novaCategoria: ''
};

function abrirModalEditarCategoria(estabelecimento, categoriaAtual) {
  _contextoEdicaoCat = {
    estabelecimento: estabelecimento || '',
    categoriaAtual: categoriaAtual || '',
    novaCategoria: categoriaAtual || ''
  };

  const modal = document.getElementById('modalEditarCategoria');
  const nomeEl = document.getElementById('modalCatEstabelecimento');
  const badgeEl = document.getElementById('modalCatAtualBadge');
  const inputPers = document.getElementById('inputCategoriaPersonalizada');
  const checkTodos = document.getElementById('checkAplicarMesmoEstabelecimento');

  if (nomeEl) nomeEl.textContent = estabelecimento || 'Despesa';
  if (badgeEl) badgeEl.textContent = categoriaAtual || 'Sem Categoria';
  if (inputPers) inputPers.value = '';
  if (checkTodos) checkTodos.checked = true;

  destacarChipAtivo(categoriaAtual);

  if (modal) modal.classList.add('active');
}

function fecharModalEditarCategoria() {
  const modal = document.getElementById('modalEditarCategoria');
  if (modal) modal.classList.remove('active');
}

function selecionarCategoriaChip(catNome) {
  _contextoEdicaoCat.novaCategoria = catNome;
  const inputPers = document.getElementById('inputCategoriaPersonalizada');
  if (inputPers) inputPers.value = '';
  destacarChipAtivo(catNome);
}

function aoDigitarCategoriaPersonalizada() {
  const inputPers = document.getElementById('inputCategoriaPersonalizada');
  if (inputPers && inputPers.value.trim()) {
    _contextoEdicaoCat.novaCategoria = inputPers.value.trim();
    destacarChipAtivo(null);
  }
}

function destacarChipAtivo(catNome) {
  const chips = document.querySelectorAll('#catChipsGrid .cat-chip-btn');
  chips.forEach(btn => {
    const onclickStr = btn.getAttribute('onclick') || '';
    if (catNome && onclickStr.includes(`'${catNome}'`)) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

async function confirmarEdicaoCategoria() {
  const novaCat = _contextoEdicaoCat.novaCategoria ? _contextoEdicaoCat.novaCategoria.trim() : '';
  const estab = _contextoEdicaoCat.estabelecimento;
  const checkTodos = document.getElementById('checkAplicarMesmoEstabelecimento');
  const aplicarTodos = checkTodos ? checkTodos.checked : true;

  if (!novaCat) {
    showToast('Por favor, selecione ou digite uma categoria.', 'error');
    return;
  }

  // 1. Atualiza nos dados em memória da projeção atual
  if (ESTADO.dadosAtuais) {
    // Invalida cache de excel para que o próximo download use a categoria editada
    ESTADO.dadosAtuais.excel_base64 = null;

    if (ESTADO.dadosAtuais.projecao) {
      const proj = ESTADO.dadosAtuais.projecao;

      if (proj.detalhes_parcelas) {
        proj.detalhes_parcelas.forEach(p => {
          if (aplicarTodos) {
            if ((p.estabelecimento || '').toUpperCase().trim() === (estab || '').toUpperCase().trim()) {
              p.categoria = novaCat;
            }
          } else if (p.estabelecimento === estab) {
            p.categoria = novaCat;
          }
        });
      }

      if (proj.matriz_cartoes) {
        proj.matriz_cartoes.forEach(card => {
          (card.itens || []).forEach(it => {
            if (aplicarTodos) {
              if ((it.estabelecimento || '').toUpperCase().trim() === (estab || '').toUpperCase().trim()) {
                it.categoria = novaCat;
              }
            } else if (it.estabelecimento === estab) {
              it.categoria = novaCat;
            }
          });
        });
      }

      // Re-renderiza matriz, tabelas e gráficos para refletir a nova categoria na tela
      renderizarResultados(ESTADO.dadosAtuais);
    }

    if (ESTADO.dadosAtuais.fatura) {
      const fat = ESTADO.dadosAtuais.fatura;
      const trans = fat.transacoes || fat.compras || [];
      trans.forEach(t => {
        if (aplicarTodos) {
          if ((t.estabelecimento || '').toUpperCase().trim() === (estab || '').toUpperCase().trim()) {
            t.categoria = novaCat;
          }
        } else if (t.estabelecimento === estab) {
          t.categoria = novaCat;
        }
      });
      (fat.cartoes || []).forEach(c => {
        (c.compras || []).forEach(co => {
          if (aplicarTodos) {
            if ((co.estabelecimento || '').toUpperCase().trim() === (estab || '').toUpperCase().trim()) {
              co.categoria = novaCat;
            }
          } else if (co.estabelecimento === estab) {
            co.categoria = novaCat;
          }
        });
      });
    }
  }

  // 2. Se a fatura estiver salva no Supabase, sincroniza a alteração
  const faturaId = ESTADO.faturaSelecionadaId || (ESTADO.dadosAtuais && ESTADO.dadosAtuais.id);
  if (faturaId) {
    try {
      const resp = await fetch('/api/atualizar-categoria', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fatura_id: faturaId,
          estabelecimento: estab,
          nova_categoria: novaCat,
          aplicar_em_todos: aplicarTodos
        })
      });
      const resData = await resp.json();
      if (!resp.ok || !resData.sucesso) {
        console.warn('Aviso ao sincronizar categoria no Supabase:', resData.erro);
      }
    } catch (err) {
      console.warn('Erro na requisição de atualização de categoria:', err);
    }
  }

  fecharModalEditarCategoria();
  showToast(`Categoria de "${estab}" alterada para "${novaCat}" com sucesso!`, 'success');
}
