# fix_correios

**Portal Minhas Importações (Correios) — erro `HTTP 500` no botão "Pagar taxas e tributos"**

Bug report público com diagnóstico, evidências, **contorno imediato para o usuário** e correção sugerida para o backend dos Correios.

> 🌐 **English version:** [README.en.md](README.en.md)

---

## 1. Problema

No portal <https://portalimportador.correios.com.br/> (área **Minhas Importações**), ao clicar no ícone **"Pagar taxas e tributos"** de uma remessa com situação **Aguardando Pagamento**, o portal dispara um POST JSF/Mojarra via AJAX:

```
POST /pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf?cid=2
Faces-Request: partial/ajax
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
```

e o servidor responde **HTTP 500 Internal Server Error**, exibindo no corpo da resposta (ou no console do navegador):

> `Can't find bundle for base name mensagens-excecao, locale en_US`

Como o erro ocorre **antes de qualquer tela de pagamento**, o usuário fica impossibilitado de pagar taxas/tributos (boleto/PIX) e a remessa permanece parada.

## 2. Causa raiz

A aplicação é JSF (Mojarra) com **Conversation Scope** (`cid` no form) e usa o **ResourceBundle** `mensagens-excecao` para mensagens de erro:

```java
// ex. (backend do portal)
ResourceBundle.getBundle("mensagens-excecao", localeDaRequisicao);
```

- O bundle **só existe para o locale `pt_BR`** (ex.: `mensagens-excecao_pt_BR.properties`).
- Não há `mensagens-excecao_en_US.properties` nem arquivo default de fallback.
- O locale é derivado do header **`Accept-Language`** enviado pelo navegador.
- Quando o navegador está configurado em inglês (`Accept-Language: en-US,en;q=0.9`), o `ResourceBundle` lança `MissingResourceException`, o `action` do botão **aborta com HTTP 500**.
- Com `Accept-Language: pt-BR`, o mesmo clique funciona normalmente e abre a tela de formas de pagamento.

Em outras palavras: **o erro não está na lógica de pagamento — está no carregamento de mensagens de erro para o locale errado.**

## 3. Evidências

Testes reais executados em 20/08/2026 com Playwright (Google Chrome, `headless: false`, `locale: 'pt-BR'`), sessão autenticada via CAS, remessa com situação **Aguardando Pagamento**.

| # | Teste | Resultado |
|---|-------|-----------|
| A | Clique AJAX normal (`mojarra.ab`) — `Accept-Language: pt-BR` | **HTTP 200** + redirect para `exibirFormasPagamento.jsf?cid=2` (tela boleto/PIX) |
| B | POST JSF completo (`mojarra.jsfcljs`) — `Accept-Language: pt-BR` | **HTTP 302** para a mesma tela de formas de pagamento |
| C | ViewState retornado pelo `partial-response` | aplicado normalmente pelo Mojarra |

Detalhes técnicos (requests, payloads, estados JSF) em [`docs/evidencias.md`](docs/evidencias.md).

### Sobre o erro reportado como "erro de pop-up"

Os Correios costumam orientar a habilitar pop-ups, mas o `HTTP 500` acontece **no POST AJAX**, antes de qualquer janela. Pop-up não é a causa.

## 4. Contorno — para quem está com o problema agora

**1. Configure o navegador em português (pt-BR)** — isso resolve o clique normal:

- **Chrome/Edge**: Configurações → Idiomas → mover "Português (Brasil)" para o topo.
- **Firefox**: Configurações → Idioma → Português (Brasil).

**2. Ou force o header `Accept-Language` em pt-BR** (técnico — console do navegador via interceptação, extensão, ou ferramenta de automação):

```
Accept-Language: pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7
```

**3. Ou, se estiver automatizando com Playwright:**

```js
const context = await chromium.launchPersistentContext('./correios-profile', {
  headless: false,
  locale: 'pt-BR',                    // idioma da página
  args: ['--lang=pt-BR'],
});
```

Após isso, o clique em **"Pagar taxas e tributos"** abre normalmente a tela:

> "Os pagamentos podem ser feitos por meio de boleto bancário ou PIX." — valor a pagar, simulação IBS/CBS e botão **Concluir pagamento** (que direciona ao ambiente **Pague Fácil**).

> ⚠️ Se você não usa inglês no navegador, verifique extensões/proxies que alteram o `Accept-Language` (VPNs e bloqueadores às vezes forçam `en-US`).

## 5. Correção sugerida (server-side — Correios)

1. **Adicionar o locale `en_US`** ao bundle `mensagens-excecao` (ou um arquivo `mensagens-excecao.properties` como fallback default).
2. **Fixar o locale da aplicação em `pt_BR`** no `faces-config.xml`:

```xml
<application>
  <locale-config>
    <default-locale>pt_BR</default-locale>
  </locale-config>
</application>
```

3. Configurar o `ResourceBundle` com **fallback** para `pt_BR` (ou nunca permitir que `MissingResourceException` vire `HTTP 500`).
4. Idealmente, mapear exceções de negócio para mensagens de erro amigáveis em vez de resposta 500.

## 6. Como reportar aos Correios

- Canal oficial: <https://www.correios.com.br/fale-conosco>
- Anexar:
  - navegador e **idioma do navegador** (`Accept-Language`);
  - código da remessa;
  - print do console de rede com o POST e a resposta `500` (mensagem `mensagens-excecao` / `locale en_US`);
  - link para esta issue/repo como referência.

## 7. Scripts de diagnóstico

Pré-requisitos: **Node.js 18+**, **Google Chrome** instalado.

```bash
npm install
npm run login          # abre o navegador, login CAS e navega até a pesquisa
npm run diagnostico    # executa os testes AJAX / POST completo / ViewState
```

- [`scripts/login.js`](scripts/login.js) — abre o navegador visível com perfil persistente, detecta login e navega para a pesquisa.
- [`scripts/payment.js`](scripts/payment.js) — localiza a remessa (`REMESSA` via variável de ambiente ou padrão) e executa os testes A/B/C/D.

### Estrutura

```
.
├── README.md              # este documento (português)
├── README.en.md           # versão em inglês
├── docs/evidencias.md     # evidências técnicas (português)
├── docs/evidencias.en.md  # evidências técnicas (inglês)
├── scripts/
│   ├── login.js           # fluxo de login (CAS) + navegação
│   └── payment.js         # testes de diagnóstico do botão de pagamento
└── package.json
```

## 8. Licença

MIT — veja [LICENSE](LICENSE).
