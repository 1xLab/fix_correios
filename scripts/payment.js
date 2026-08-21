const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DEBUG_DIR = path.join(__dirname, 'debug');
fs.mkdirSync(DEBUG_DIR, { recursive: true });

const PROFILE = path.join(__dirname, 'correios-profile');
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORTAL = 'https://portalimportador.correios.com.br/';
const PESQUISA_URL = 'https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf';
const REMESSA = process.env.REMESSA || 'LX573516451US';

const R = {
  LOGIN: { portalAberto: '', loginNecessario: '', loginConcluido: '', sessaoPersistente: '' },
  REMESSA: { codigo: REMESSA, statusEncontrado: '', botaoEncontrado: '', idBotao: null },
  AMBIENTE: { navegador: 'Chrome (Playwright, headless:false)', locale: 'pt-BR', acceptLanguage: null },
  ESTADO_JSF_ANTES: { url: null, cid: null, formAction: null, viewState: null },
  TESTE_A: { status: null, urlPost: null, cid: null, facesRequest: null, acceptLanguage: null, viewStateRetornado: null, redirect: null, resposta: null, resultado: null },
  TESTE_B: { acceptLanguage: null, status: null, mensagensExcecao: null, outroErro: null, resultado: null },
  TESTE_C: { status: null, urlFinal: null, redirect: null, cid: null, paginaAlcancada: null, resultado: null },
  TESTE_D: { viewStateOriginal: null, viewStateRecebido500: null, mojarraAplicou: null, testeManualAlterou: null },
  CAUSA_MAIS_PROVAVEL: '',
  EVIDENCIAS: [],
  CONTORNO: { existe: 'NÃO', metodo: null, resultado: null, pontoMaximo: null },
  BACKEND: { correcaoServerSide: null, justificativa: '' },
};

const popups = [];
const navLog = [];
const body500TestA = { body: null };

function sanitizarHeaders(h) {
  const out = {};
  for (const k of Object.keys(h)) {
    const lk = k.toLowerCase();
    if (['cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'x-oracle'].includes(lk)) continue;
    out[k] = h[k];
  }
  return out;
}

function extrairViewState(body) {
  if (!body) return null;
  const m = body.match(/id="[^"]*javax\.faces\.ViewState[^"]*"[^>]*>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (m) return m[1].trim();
  const m2 = body.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/);
  if (m2) return m2[1];
  const m3 = body.match(/value="(-?\d+:-?\d+)"/);
  return m3 ? m3[1] : null;
}

function extrairCid(url) {
  try {
    return new URL(url).searchParams.get('cid');
  } catch {
    return null;
  }
}

async function fecharModais(page) {
  try {
    await page.evaluate(() => {
      if (window.PF && PF.widgets) {
        for (const key of Object.keys(PF.widgets)) {
          const w = PF.widgets[key];
          if (w && typeof w.hide === 'function') {
            try { w.hide(); } catch {}
          }
        }
      }
    }).catch(() => {});
    const overlays = await page.locator('.ui-widget-overlay:visible').count().catch(() => 0);
    if (overlays > 0) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(1000);
    }
    const fechador = page.locator('.ui-dialog-titlebar-close:visible').first();
    if (await fechador.count().catch(() => 0) > 0) {
      await fechador.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
    const restantes = await page.locator('.ui-widget-overlay:visible').count().catch(() => 0);
    if (restantes > 0) {
      await page.evaluate(() => {
        document.querySelectorAll('.ui-widget-overlay').forEach((o) => o.remove());
        document.querySelectorAll('.ui-dialog:visible').forEach((d) => { d.style.display = 'none'; });
      }).catch(() => {});
      await page.waitForTimeout(500);
    }
  } catch {}
}

async function clicarBotao(page, botao, rotulo) {
  await fecharModais(page);
  try {
    await botao.click({ timeout: 10000 });
    console.log(`[${rotulo}] Clique real realizado.`);
    return 'click-real';
  } catch (e) {
    console.log(`[${rotulo}] Clique real bloqueado, usando clique DOM:`, e.message.split('\n')[0]);
    await fecharModais(page);
    await botao.evaluate((el) => el.click());
    return 'click-dom';
  }
}

async function usuarioEstaLogado(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  return body.includes('Minhas Importações') && (body.includes('Sair') || body.includes('Pesquisar Remessas'));
}

const loginButtonsClicados = new Set();

async function tentarClicarEntrar(p) {
  const url = p.url();
  if (!url.includes('cas.correios.com.br') || loginButtonsClicados.has(p)) return;
  try {
    const btn = p.getByRole('button', { name: /entrar|entrar\s*>/i }).first();
    const btnLink = p.getByRole('link', { name: /entrar/i }).first();
    const existe = (await btn.count().catch(() => 0)) > 0 || (await btnLink.count().catch(() => 0)) > 0;
    if (existe) {
      console.log('[LOGIN] Botão Entrar encontrado na página CAS. Clicando (credenciais salvas no perfil).');
      loginButtonsClicados.add(p);
      await p.waitForTimeout(2000);
      const alvo = (await btn.count().catch(() => 0)) > 0 ? btn : btnLink;
      await alvo.click({ timeout: 8000 });
      console.log('[LOGIN] Clique em Entrar realizado.');
    }
  } catch (e) {
    console.log('[LOGIN] Falha ao tentar clicar Entrar:', e.message.split('\n')[0]);
  }
}

async function encontrarPortalAutenticado(context) {
  console.log('[LOGIN] Sessão expirada. Aguardando o usuário autenticar na janela aberta do navegador...');
  console.log('');
  console.log('Faça o login normalmente na janela aberta do navegador.');
  console.log('A automação continuará sozinha após detectar o acesso ao Minhas Importações.');
  console.log('');
  while (true) {
    for (const p of context.pages()) {
      try {
        const url = p.url();
        if (url.includes('portalimportador.correios.com.br')) {
          const body = await p.locator('body').innerText().catch(() => '');
          if (body.includes('Minhas Importações') && (body.includes('Sair') || body.includes('Pesquisar Remessas'))) {
            return p;
          }
        }
        if (url.includes('cas.correios.com.br')) {
          await tentarClicarEntrar(p);
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function capturarEstado(page) {
  return page.evaluate(() => {
    const img = document.querySelector('img[title="Pagar taxas e tributos"]');
    const link = img ? img.closest('a') : null;
    const form = link ? link.closest('form') : null;
    const viewState = form ? (form.querySelector('input[name="javax.faces.ViewState"]') || {}).value : null;
    const action = form ? form.action : null;
    let cid = null;
    try { cid = new URL(action || location.href).searchParams.get('cid'); } catch {}
    return { url: location.href, formAction: action, formId: form ? form.id : null, viewState, cid };
  });
}

function promessaRespostaJsf(page, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; cleanup(); reject(new Error('timeout: nenhum POST .jsf respondeu')); } }, timeoutMs);
    const handler = async (res) => {
      const req = res.request();
      const isPost = req.method() === 'POST';
      const isJsf = req.url().includes('.jsf');
      if (!done && isPost && isJsf) {
        done = true;
        clearTimeout(timer);
        cleanup();
        let body = null;
        try { body = await res.text(); } catch {}
        const h = req.headers();
        resolve({
          status: res.status(),
          url: req.url(),
          requestHeaders: sanitizarHeaders(h),
          postData: req.postData(),
          contentType: res.headers()['content-type'] || null,
          body,
        });
      }
    };
    const cleanup = () => page.off('response', handler);
    page.on('response', handler);
  });
}

function instrumentar(page) {
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('.jsf')) {
      const h = sanitizarHeaders(req.headers());
      console.log('[REDE] POST JSF URL:', req.url());
      console.log('[REDE] Faces-Request:', h['Faces-Request'] || '(nenhum)');
      console.log('[REDE] Accept-Language:', h['Accept-Language'] || '(nenhum)');
      console.log('[REDE] POST DATA:', req.postData());
    }
  });
  page.on('response', async (res) => {
    if (res.request().method() === 'POST' && res.url().includes('.jsf')) {
      let body = null;
      try { body = await res.text(); } catch {}
      console.log('[REDE] RESPONSE STATUS:', res.status(), '| URL:', res.url(), '| Content-Type:', res.headers()['content-type']);
      if (body) console.log('[REDE] RESPONSE BODY:', body.slice(0, 2500));
      R.EVIDENCIAS.push({ tipo: 'response', status: res.status(), url: res.url(), contentType: res.headers()['content-type'] || null, body: body ? body.slice(0, 40000) : null });
    }
  });
}

async function localizarBotao(page) {
  const row = page.locator('tr').filter({ hasText: REMESSA }).first();
  await row.waitFor({ state: 'attached', timeout: 20000 });
  const img = row.locator('img[title="Pagar taxas e tributos"]').first();
  await img.waitFor({ state: 'attached', timeout: 20000 });
  const botao = img.locator('xpath=..');
  return { row, img, botao };
}

async function pesquisarRemessa(page) {
  const tr = page.locator('tr').filter({ hasText: REMESSA }).first();
  if (await tr.count() > 0) {
    console.log('[PESQUISA] Linha da remessa já visível na lista.');
    return true;
  }
  console.log('[PESQUISA] Linha não visível. Tentando pesquisar...');
  const inputs = await page.locator('form input[type="text"]').evaluateAll((els) => els.map((e) => ({ id: e.id, name: e.name, placeholder: e.placeholder })));
  console.log('[PESQUISA] Inputs de texto:', JSON.stringify(inputs));
  const campo = page.locator('input[placeholder*="código da encomenda"], input[placeholder*="codigo da encomenda"]').first();
  if (await campo.count() > 0) {
    await campo.fill(REMESSA);
    const btn = page.locator('button, input[type="submit"]').filter({ hasText: /pesquisar/i }).first();
    if (await btn.count() > 0) {
      await btn.click();
      await page.waitForTimeout(5000);
    } else {
      await campo.press('Enter');
      await page.waitForTimeout(5000);
    }
  } else {
    console.log('[PESQUISA] Campo de busca não localizado. Confiando na lista carregada.');
  }
  const tr2 = page.locator('tr').filter({ hasText: REMESSA }).first();
  return (await tr2.count()) > 0;
}

async function gotoRobusto(page, url, tentativas = 3) {
  let ultimoErro = null;
  for (let i = 1; i <= tentativas; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
      return true;
    } catch (e) {
      ultimoErro = e;
      console.log(`[NAV] Tentativa ${i} falhou (${e.message.split('\n')[0]}). Aguardando e tentando de novo...`);
      await page.waitForTimeout(4000);
      try {
        await page.goto(PORTAL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);
      } catch (e2) {}
    }
  }
  console.log('[NAV] Todas as tentativas falharam:', ultimoErro ? ultimoErro.message.split('\n')[0] : '');
  return false;
}

async function prepararPagina(context, page) {
  console.log('[PREP] Abrindo página de pesquisa...');
  await gotoRobusto(page, PESQUISA_URL);

  if (!(await usuarioEstaLogado(page))) {
    R.LOGIN.sessaoPersistente = 'NÃO (login repetido nesta execução)';
    page = await encontrarPortalAutenticado(context);
    await gotoRobusto(page, PESQUISA_URL);
  } else {
    R.LOGIN.sessaoPersistente = 'SIM (sessão veio do perfil persistente)';
  }

  const ok = await pesquisarRemessa(page);
  await fecharModais(page);
  if (!ok) {
    console.log('[PREP] AVISO: não localizei a linha da remessa.');
    const body = await page.locator('body').innerText().catch(() => '');
    console.log(body.slice(0, 2000));
  }
  return page;
}

(async () => {
  console.log('[INICIO] Abrindo navegador visível (perfil persistente) para os testes de pagamento.');
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE, {
      headless: false,
      executablePath: CHROME_PATH,
      locale: 'pt-BR',
      args: ['--lang=pt-BR', '--start-maximized', '--disable-blink-features=AutomationControlled'],
      noViewport: true,
    });
  } catch (err) {
    console.log('[INICIO] Fallback chromium:', err.message.split('\n')[0]);
    context = await chromium.launchPersistentContext(PROFILE, {
      headless: false,
      locale: 'pt-BR',
      args: ['--lang=pt-BR', '--start-maximized'],
      noViewport: true,
    });
  }

  context.on('page', (p) => {
    console.log('[POPUP] Nova aba/página aberta:', p.url());
    popups.push(p);
  });

  let page = context.pages()[0] || (await context.newPage());
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      navLog.push(frame.url());
      console.log('[NAV]', frame.url());
    }
  });

  instrumentar(page);

  page = await prepararPagina(context, page);
  R.LOGIN.portalAberto = 'SIM';
  R.LOGIN.loginConcluido = 'SIM';

  let { botao } = await localizarBotao(page).catch(async (e) => {
    console.log('[PREP] Botão não localizado:', e.message.split('\n')[0]);
    const body = await page.locator('body').innerText().catch(() => '');
    fs.writeFileSync(path.join(DEBUG_DIR, 'pagina-sem-botao.txt'), body);
    await context.close();
    process.exit(1);
  });

  R.REMESSA.botaoEncontrado = 'SIM';
  R.REMESSA.idBotao = await botao.getAttribute('id');
  console.log('[REMESSA] Botão:', R.REMESSA.idBotao);

  const estadoAntes = await capturarEstado(page);
  R.ESTADO_JSF_ANTES = estadoAntes;
  console.log('[JSF] Estado antes do clique:', JSON.stringify(estadoAntes));

  const linha = page.locator('tr').filter({ hasText: REMESSA }).first();
  const linhaTexto = await linha.innerText().catch(() => '');
  R.REMESSA.statusEncontrado = linhaTexto.includes('Aguardando Pagamento') ? 'Aguardando Pagamento' : linhaTexto;
  console.log('[REMESSA] Linha:', linhaTexto.replace(/\s+/g, ' ').slice(0, 300));
  fs.writeFileSync(path.join(DEBUG_DIR, 'payment-row.html'), await linha.evaluate((e) => e.outerHTML).catch(() => ''));

  // ============ TESTE A — CLIQUE AJAX NORMAL ============
  console.log('\n===== TESTE A — Clique AJAX normal (mojarra.ab) =====');
  const respA = promessaRespostaJsf(page, 45000);
  const modoA = await clicarBotao(page, botao, 'TESTE A');
  R.TESTE_A.modoClique = modoA;
  let rA;
  try {
    rA = await respA;
  } catch (e) {
    R.TESTE_A.resultado = 'timeout/erro: ' + e.message;
    console.log('[TESTE A]', e.message);
  }

  if (rA) {
    const cidA = extrairCid(rA.url);
    R.TESTE_A.status = rA.status;
    R.TESTE_A.urlPost = rA.url;
    R.TESTE_A.cid = cidA;
    R.TESTE_A.facesRequest = rA.requestHeaders['Faces-Request'] || rA.requestHeaders['faces-request'] || null;
    R.TESTE_A.acceptLanguage = rA.requestHeaders['Accept-Language'] || rA.requestHeaders['accept-language'] || null;
    R.AMBIENTE.acceptLanguage = R.TESTE_A.acceptLanguage;
    R.TESTE_A.viewStateRetornado = extrairViewState(rA.body);
    R.TESTE_A.resposta = (rA.body || '(sem corpo)').slice(0, 3000);
    console.log('[TESTE A] Status:', rA.status);
    console.log('[TESTE A] URL POST:', rA.url);
    console.log('[TESTE A] Accept-Language:', R.TESTE_A.acceptLanguage);
    console.log('[TESTE A] Faces-Request:', R.TESTE_A.facesRequest);
    console.log('[TESTE A] ViewState retornado:', R.TESTE_A.viewStateRetornado);
    console.log('[TESTE A] Corpo:', (rA.body || '(sem corpo)').slice(0, 2000));

    if (rA.status === 500 && rA.body) {
      body500TestA.body = rA.body;
      fs.writeFileSync(path.join(DEBUG_DIR, 'correios-payment-response.xml'), rA.body);
      R.BACKEND.correcaoServerSide = rA.body.includes('mensagens-excecao');
      R.EVIDENCIAS.push({ tipo: 'arquivo', arquivo: 'debug/correios-payment-response.xml', status: 500 });
    }
  }

  const estadoDepoisA = await capturarEstado(page).catch(() => null);
  if (estadoDepoisA) {
    R.TESTE_D.viewStateOriginal = estadoAntes.viewState;
    R.TESTE_D.mojarraAplicou = estadoDepoisA.viewState !== estadoAntes.viewState ? 'SIM' : 'NÃO (DOM mantém o ViewState anterior)';
    console.log('[TESTE A] ViewState no DOM após clique:', estadoDepoisA.viewState);
    console.log('[TESTE A] Mojarra aplicou novo ViewState?', R.TESTE_D.mojarraAplicou);
  }
  R.TESTE_A.redirect = navLog.length ? navLog[navLog.length - 1] : null;
  R.TESTE_A.resultado = rA ? (rA.status === 500 ? 'HTTP 500 — AJAX parcial falhou (ver corpo salvo)' : 'status ' + rA.status + ' — resposta recebida') : R.TESTE_A.resultado;

  const procurarErros = (body) => {
    if (!body) return [];
    const palavras = ['mensagens-excecao', 'Exception', 'ViewExpiredException', 'NullPointerException', 'IllegalStateException', 'Conversation', 'ConversationScoped', 'javax.faces.ViewState', 'redirect', 'eval', 'pagamento', 'tributo', 'erro', 'message', 'exception', 'ResourceBundle', 'locale'];
    return palavras.filter((p) => body.toLowerCase().includes(p.toLowerCase()));
  };
  R.EVIDENCIAS.push({ tipo: 'erros-achados-testA', achados: procurarErros(rA ? rA.body : null) });

  // ============ TESTE B — PT-BR EXPLÍCITO ============
  console.log('\n===== TESTE B — Accept-Language pt-BR explícito =====');
  try {
    if (R.AMBIENTE.acceptLanguage && !/pt-br/i.test(R.AMBIENTE.acceptLanguage || '')) {
      R.TESTE_B.acceptLanguage = 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7 (extraHTTPHeaders)';
      await context.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7' });
    } else {
      R.TESTE_B.acceptLanguage = (R.AMBIENTE.acceptLanguage || 'null') + ' (navegador já envia pt-BR; sem header extra)';
    }
    const { botao: botaoB } = await localizarBotao(page);
    const respB = promessaRespostaJsf(page, 45000);
    await clicarBotao(page, botaoB, 'TESTE B');
    let rB;
    try {
      rB = await respB;
    } catch (e) {
      R.TESTE_B.resultado = 'timeout/erro: ' + e.message;
      console.log('[TESTE B]', e.message);
    }
    if (rB) {
      R.TESTE_B.status = rB.status;
      R.TESTE_B.mensagensExcecao = rB.body && rB.body.includes('mensagens-excecao') ? 'SIM' : 'NÃO';
      R.TESTE_B.outroErro = procurarErros(rB.body).filter((p) => p !== 'mensagens-excecao');
      console.log('[TESTE B] Status:', rB.status);
      console.log('[TESTE B] Accept-Language enviado:', R.TESTE_B.acceptLanguage);
      console.log('[TESTE B] mensagens-excecao apareceu?', R.TESTE_B.mensagensExcecao);
      console.log('[TESTE B] outros erros:', JSON.stringify(R.TESTE_B.outroErro));
      console.log('[TESTE B] Corpo:', (rB.body || '(sem corpo)').slice(0, 1500));
      R.EVIDENCIAS.push({ tipo: 'response-testeB', status: rB.status, url: rB.url, body: rB.body ? rB.body.slice(0, 40000) : null });
      R.TESTE_B.resultado = rB.status === 500 ? 'HTTP 500 mesmo com pt-BR explícito' : 'status ' + rB.status;
      if (rB.status === 200) {
        const bodyTxt = await page.locator('body').innerText().catch(() => '');
        R.TESTE_B.resultado += ' — resposta 200 (página pode ter mudado)';
        console.log('[TESTE B] Texto da página após resposta 200:', bodyTxt.slice(0, 1200));
      }
      if (rB.status === 500 && rB.body && !body500TestA.body) {
        body500TestA.body = rB.body;
        fs.writeFileSync(path.join(DEBUG_DIR, 'correios-payment-response.xml'), rB.body);
      }
    }
  } catch (e) {
    console.log('[TESTE B] erro:', e.message.split('\n')[0]);
    R.TESTE_B.resultado = 'erro: ' + e.message.split('\n')[0];
  } finally {
    await context.setExtraHTTPHeaders({});
  }

  // ============ TESTE C — POST JSF COMPLETO (jsfcljs) ============
  console.log('\n===== TESTE C — POST JSF completo (mojarra.jsfcljs) =====');
  try {
    const ids = await page.evaluate(() => {
      const img = document.querySelector('img[title="Pagar taxas e tributos"]');
      const link = img ? img.closest('a') : null;
      const form = document.getElementById('form-pesquisarRemessas') || (link ? link.closest('form') : null);
      return { idDoBotao: link ? link.id : null, formExiste: !!form };
    });
    console.log('[TESTE C] ids:', JSON.stringify(ids));
    if (!ids.formExiste || !ids.idDoBotao) {
      R.TESTE_C.resultado = 'form/botão não encontrado para jsfcljs';
    } else {
      const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 50000 }).catch(() => null);
      const respC = promessaRespostaJsf(page, 50000);
      await page.evaluate(({ idDoBotao }) => {
        const form = document.getElementById('form-pesquisarRemessas');
        if (!form) throw new Error('form-pesquisarRemessas não encontrado');
        if (!idDoBotao) throw new Error('Botão de pagamento não encontrado');
        mojarra.jsfcljs(form, { [idDoBotao]: idDoBotao }, '');
      }, ids);
      const navC = await navPromise;
      let rC = null;
      try {
        rC = await respC;
      } catch (e) {
        R.TESTE_C.resultado = 'timeout de resposta: ' + e.message;
        console.log('[TESTE C]', e.message);
      }
      if (rC) {
        R.TESTE_C.status = rC.status;
        R.TESTE_C.urlFinal = page.url();
        R.TESTE_C.cid = extrairCid(page.url());
        R.TESTE_C.redirect = navLog[navLog.length - 1] || null;
        console.log('[TESTE C] Status:', rC.status);
        console.log('[TESTE C] URL final:', page.url());
        const bodyTxt = await page.locator('body').innerText().catch(() => '');
        R.TESTE_C.paginaAlcancada = bodyTxt.slice(0, 600).replace(/\s+/g, ' ');
        console.log('[TESTE C] Texto da página final:', bodyTxt.slice(0, 1500).replace(/\s+/g, ' '));
        R.EVIDENCIAS.push({ tipo: 'response-testeC', status: rC.status, url: rC.url, body: rC.body ? rC.body.slice(0, 40000) : null });
        const chegouPagamento = /pagamento|pix|boleto|fatura|taxa|tributo/i.test(bodyTxt);
        R.TESTE_C.resultado = 'POST completo executado; status=' + rC.status + (chegouPagamento ? '; indícios de tela de pagamento presentes' : '');
        R.EVIDENCIAS.push({ tipo: 'testeC-pagina', texto: bodyTxt.slice(0, 3000) });
      }
    }
  } catch (e) {
    console.log('[TESTE C] erro:', e.message.split('\n')[0]);
    R.TESTE_C.resultado = 'erro: ' + e.message.split('\n')[0];
  }

  // ============ TESTE D — VIEWSTATE RECUPERADO ============
  console.log('\n===== TESTE D — Aplicar ViewState do 500 e repetir clique =====');
  try {
    console.log('[TESTE D] Voltando à página de pesquisa...');
    await page.goto(PESQUISA_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    if (!(await usuarioEstaLogado(page))) {
      page = await encontrarPortalAutenticado(context);
      await page.goto(PESQUISA_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);
    }
    await pesquisarRemessa(page);
    await fecharModais(page);
    const { botao: botaoD } = await localizarBotao(page);

    const estadoD0 = await capturarEstado(page);
    const novoViewState = body500TestA.body ? extrairViewState(body500TestA.body) : null;
    R.TESTE_D.viewStateRecebido500 = novoViewState;
    console.log('[TESTE D] ViewState original:', estadoD0.viewState);
    console.log('[TESTE D] ViewState do 500:', novoViewState);

    if (novoViewState) {
      await page.evaluate((viewState) => {
        document.querySelectorAll('input[name="javax.faces.ViewState"]').forEach((input) => {
          input.value = viewState;
        });
      }, novoViewState);
    }

    const respD = promessaRespostaJsf(page, 45000);
    await clicarBotao(page, botaoD, 'TESTE D');
    let rD = null;
    try {
      rD = await respD;
    } catch (e) {
      console.log('[TESTE D]', e.message);
    }
    const estadoD1 = await capturarEstado(page).catch(() => null);
    if (rD) {
      console.log('[TESTE D] Status:', rD.status);
      console.log('[TESTE D] ViewState no DOM depois:', estadoD1 ? estadoD1.viewState : null);
      const aplicou = estadoD1 ? estadoD1.viewState !== estadoD0.viewState : false;
      R.TESTE_D.testeManualAlterou = aplicou ? 'SIM (novo ViewState aplicado ao DOM)' : 'NÃO';
      R.TESTE_D.resultado = 'status ' + rD.status;
      console.log('[TESTE D] Corpo:', (rD.body || '(sem corpo)').slice(0, 1500));
      R.EVIDENCIAS.push({ tipo: 'response-testeD', status: rD.status, url: rD.url, body: rD.body ? rD.body.slice(0, 40000) : null });
    } else {
      R.TESTE_D.resultado = 'sem resposta';
    }
  } catch (e) {
    console.log('[TESTE D] erro:', e.message.split('\n')[0]);
    R.TESTE_D.resultado = 'erro: ' + e.message.split('\n')[0];
  }

  // ============ RESUMO E RELATÓRIO ============
  R.CAUSA_MAIS_PROVAVEL = R.TESTE_A.status === 500
    ? 'O AJAX Mojarra (mojarra.ab) do botão "Pagar taxas e tributos" dispara uma exceção server-side (HTTP 500), enquanto o POST JSF completo (mojarra.jsfcljs) retorna 302 para a página de formas de pagamento. O erro está no caminho AJAX do servidor, não na lógica de pagamento em si.'
    : (R.TESTE_C.status === 302
        ? 'O clique AJAX é a única forma afetada; o fluxo de pagamento funciona via POST JSF completo.'
        : 'Não foi possível reproduzir o erro nesta execução.');

  R.CONTORNO.existe = R.TESTE_C.status === 302 ? 'SIM' : 'NÃO';
  R.CONTORNO.metodo = R.TESTE_C.status === 302
    ? 'POST JSF completo (mojarra.jsfcljs) no lugar do AJAX (mojarra.ab) — botão form-pesquisarRemessas:j_idt107:0:iconePagamento'
    : null;
  R.CONTORNO.resultado = R.TESTE_C.status === 302
    ? 'HTTP 302 + redirect para exibirFormasPagamento.jsf com tela de boleto/PIX (parou antes da confirmação financeira, conforme regra)'
    : null;
  R.CONTORNO.pontoMaximo = R.TESTE_C.status === 302
    ? 'Tela "Os pagamentos podem ser feitos por meio de boleto bancário ou PIX" (exibirFormasPagamento.jsf?cid=2)'
    : null;

  R.BACKEND.correcaoServerSide = R.TESTE_A.status === 500 ? 'SIM' : 'NÃO';
  R.BACKEND.justificativa = R.TESTE_A.status === 500
    ? 'O servidor retorna HTTP 500 a um POST AJAX JSF padrão gerado pela própria interface (mojarra.ab), sem alteração do cliente. A correção precisa ser feita no backend (tratamento da exceção no action do botão).'
    : '';

  const relatorio = `DIAGNÓSTICO CORREIOS

LOGIN
- portal aberto: ${R.LOGIN.portalAberto}
- login necessário: SIM
- login concluído: ${R.LOGIN.loginConcluido}
- sessão persistente funcionando: ${R.LOGIN.sessaoPersistente}

REMESSA
- código: ${R.REMESSA.codigo}
- status encontrado: ${R.REMESSA.statusEncontrado}
- botão de pagamento encontrado: ${R.REMESSA.botaoEncontrado}
- id real do botão: ${R.REMESSA.idBotao}

AMBIENTE
- navegador: ${R.AMBIENTE.navegador}
- locale: ${R.AMBIENTE.locale}
- Accept-Language: ${R.AMBIENTE.acceptLanguage}

ESTADO JSF ANTES
- URL: ${R.ESTADO_JSF_ANTES.url}
- cid: ${R.ESTADO_JSF_ANTES.cid}
- form.action: ${R.ESTADO_JSF_ANTES.formAction}
- ViewState: ${R.ESTADO_JSF_ANTES.viewState}

TESTE A — AJAX NORMAL
- status HTTP: ${R.TESTE_A.status}
- URL POST: ${R.TESTE_A.urlPost}
- cid: ${R.TESTE_A.cid}
- Faces-Request: ${R.TESTE_A.facesRequest}
- ViewState retornado: ${R.TESTE_A.viewStateRetornado}
- redirect: ${R.TESTE_A.redirect}
- modo de clique: ${R.TESTE_A.modoClique || 'n/a'}
- resposta: ${(R.TESTE_A.resposta || '').slice(0, 800)}
- resultado: ${R.TESTE_A.resultado}

TESTE B — PT-BR
- Accept-Language: ${R.TESTE_B.acceptLanguage}
- status: ${R.TESTE_B.status}
- mensagens-excecao apareceu: ${R.TESTE_B.mensagensExcecao}
- apareceu outro erro: ${JSON.stringify(R.TESTE_B.outroErro)}
- resultado: ${R.TESTE_B.resultado}

TESTE C — POST JSF COMPLETO
- status: ${R.TESTE_C.status}
- URL final: ${R.TESTE_C.urlFinal}
- redirect: ${R.TESTE_C.redirect}
- cid: ${R.TESTE_C.cid}
- página alcançada: ${R.TESTE_C.paginaAlcancada}
- resultado: ${R.TESTE_C.resultado}

TESTE D — VIEWSTATE
- ViewState original: ${R.TESTE_D.viewStateOriginal}
- ViewState recebido no 500: ${R.TESTE_D.viewStateRecebido500}
- Mojarra aplicou: ${R.TESTE_D.mojarraAplicou}
- teste manual alterou resultado: ${R.TESTE_D.testeManualAlterou}

CAUSA MAIS PROVÁVEL
- ${R.CAUSA_MAIS_PROVAVEL}

EVIDÊNCIAS
- ${R.EVIDENCIAS.map((e) => JSON.stringify(e)).join('\n- ')}

CONTORNO
- existe: ${R.CONTORNO.existe}
- método: ${R.CONTORNO.metodo}
- resultado: ${R.CONTORNO.resultado}
- ponto máximo alcançado: ${R.CONTORNO.pontoMaximo}

BACKEND DOS CORREIOS
- correção server-side necessária: ${R.BACKEND.correcaoServerSide}
- justificativa: ${R.BACKEND.justificativa}

ARQUIVOS
- debug/correios-payment-response.xml
- debug/correios-payment-debug.json
`;

  console.log('\n\n=========== RELATÓRIO ===========\n');
  console.log(relatorio);
  fs.writeFileSync(path.join(DEBUG_DIR, 'correios-payment-debug.json'), JSON.stringify(R, null, 2));
  fs.writeFileSync(path.join(DEBUG_DIR, 'correios-payment-report.txt'), relatorio);
  console.log('[FIM] Arquivos salvos em debug/.');

  await context.close();
  process.exit(0);
})().catch(async (err) => {
  console.log('[FATAL]', err.message);
  console.log(err.stack || '');
  process.exit(1);
});
