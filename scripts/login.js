const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DEBUG_DIR = path.join(__dirname, 'debug');
fs.mkdirSync(DEBUG_DIR, { recursive: true });

const PROFILE = path.join(__dirname, 'correios-profile');
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORTAL = 'https://portalimportador.correios.com.br/';
const PESQUISA_URL = 'https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf';

async function usuarioEstaLogado(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  return (
    body.includes('Minhas Importações') &&
    (body.includes('Sair') || body.includes('Pesquisar Remessas'))
  );
}

async function encontrarPortalAutenticado(context) {
  console.log('[LOGIN] Aguardando o usuário autenticar na janela aberta do navegador...');
  while (true) {
    for (const p of context.pages()) {
      try {
        const url = p.url();
        if (url.includes('portalimportador.correios.com.br')) {
          const body = await p.locator('body').innerText().catch(() => '');
          if (
            body.includes('Minhas Importações') &&
            (body.includes('Sair') || body.includes('Pesquisar Remessas'))
          ) {
            return p;
          }
        }
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

(async () => {
  console.log('[LOGIN] Abrindo navegador visível com perfil persistente ./correios-profile');

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
    console.log('[LOGIN] Fallback para chromium do Playwright:', err.message.split('\n')[0]);
    context = await chromium.launchPersistentContext(PROFILE, {
      headless: false,
      locale: 'pt-BR',
      args: ['--lang=pt-BR', '--start-maximized'],
      noViewport: true,
    });
  }

  context.on('page', (p) => {
    console.log('[LOGIN] Nova aba/página:', p.url());
  });

  let page = context.pages()[0] || (await context.newPage());

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      console.log('[LOGIN] Navegação:', frame.url());
    }
  });

  console.log('[LOGIN] Abrindo portal...');
  await page.goto(PORTAL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const textoInicial = await page.locator('body').innerText().catch(() => '');
  fs.writeFileSync(path.join(DEBUG_DIR, 'portal-home.txt'), textoInicial);

  let logado = await usuarioEstaLogado(page);
  console.log('[LOGIN] Já autenticado?', logado);

  if (!logado) {
    const candidatos = [
      page.getByRole('link', { name: /entrar|login|acessar/i }),
      page.getByRole('button', { name: /entrar|login|acessar/i }),
      page.locator('a', { hasText: /entrar|login|acessar/i }),
      page.locator('button', { hasText: /entrar|login|acessar/i }),
    ];

    let clicou = false;
    for (const s of candidatos) {
      const n = await s.count().catch(() => 0);
      if (n > 0) {
        try {
          await s.first().click({ timeout: 5000 });
          clicou = true;
          console.log('[LOGIN] Elemento "Entrar" clicado.');
          break;
        } catch {}
      }
    }

    if (!clicou) {
      console.log('[LOGIN] Elemento de login não localizado. Conteúdo inicial:');
      console.log(textoInicial.slice(0, 1500));
    }

    await page.waitForTimeout(2000);

    console.log('');
    console.log('Faça o login normalmente na janela aberta do navegador.');
    console.log('A automação continuará sozinha após detectar o acesso ao Minhas Importações.');
    console.log('');

    page = await encontrarPortalAutenticado(context);
    console.log('Login detectado. Continuando automaticamente.');
  } else {
    console.log('[LOGIN] Sessão válida já presente no perfil persistente.');
  }

  const urlAtual = page.url();
  const body = await page.locator('body').innerText().catch(() => '');
  const confirmado =
    urlAtual.includes('portalimportador.correios.com.br') &&
    body.includes('Minhas Importações') &&
    (body.includes('Sair') || body.includes('Pesquisar Remessas'));

  console.log('[LOGIN] Confirmação de login:', confirmado ? 'OK' : 'FALHOU');
  console.log('[LOGIN] URL:', urlAtual);

  if (!confirmado) {
    console.log('[LOGIN] Sinais de login não confirmados. Encerrando.');
    await context.close();
    process.exit(1);
  }

  console.log('[LOGIN] Navegando para a pesquisa de remessas...');
  await page.goto(PESQUISA_URL, { waitUntil: 'domcontentloaded' }).catch(async (e) => {
    console.log('[LOGIN] goto direto falhou:', e.message.split('\n')[0]);
  });
  await page.waitForTimeout(5000);

  const texto = await page.locator('body').innerText().catch(() => '');
  const urlFinal = page.url();
  console.log('[LOGIN] Página atual:', urlFinal);
  console.log('[LOGIN] Fragmento do texto da página:');
  console.log('---');
  console.log(texto.slice(0, 2500));
  console.log('---');

  fs.writeFileSync(path.join(DEBUG_DIR, 'after-login-page.txt'), texto);
  await page.screenshot({ path: path.join(DEBUG_DIR, 'after-login.png'), fullPage: true }).catch(() => {});

  const inputs = await page.locator('input').count().catch(() => 0);
  console.log('[LOGIN] Quantidade de inputs na página:', inputs);

  console.log('[LOGIN] Estado salvo em debug/. Fechando navegador; sessão persistirá no perfil.');
  await context.close();
  process.exit(0);
})().catch(async (err) => {
  console.log('[LOGIN] ERRO:', err.message);
  process.exit(1);
});
