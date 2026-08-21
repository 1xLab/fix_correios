# fix_correios

**Correios "Minhas Importações" Portal — `HTTP 500` on the "Pagar taxas e tributos" (Pay fees) button**

Public bug report with diagnosis, evidence, an **immediate user-side workaround**, and a suggested server-side fix for Correios.

---

## 1. The problem

On the portal <https://portalimportador.correios.com.br/> (the **Minhas Importações** area), clicking the **"Pagar taxas e tributos"** (Pay fees and taxes) icon for a shipment with status **Aguardando Pagamento** (Awaiting Payment) triggers a JSF/Mojarra AJAX POST:

```
POST /pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf?cid=2
Faces-Request: partial/ajax
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
```

and the server answers **HTTP 500 Internal Server Error**, with the following shown in the response body (or in the browser's network console):

> `Can't find bundle for base name mensagens-excecao, locale en_US`

Because the error happens **before any payment screen**, the user cannot pay taxes/fees (boleto/PIX) and the shipment stays stuck in **Aguardando Pagamento**.

## 2. Root cause

The application is JSF (Mojarra) with **Conversation Scope** (`cid` in the form) and uses the **ResourceBundle** `mensagens-excecao` for error messages:

```java
// ex. (portal backend)
ResourceBundle.getBundle("mensagens-excecao", localeDaRequisicao);
```

- The bundle **only exists for the `pt_BR` locale** (e.g. `mensagens-excecao_pt_BR.properties`).
- There is **no `mensagens-excecao_en_US.properties` and no default fallback file**.
- The locale is derived from the **`Accept-Language`** header sent by the browser.
- When the browser is set to English (`Accept-Language: en-US,en;q=0.9`), the `ResourceBundle` throws `MissingResourceException`, the button `action` **aborts with HTTP 500**.
- With `Accept-Language: pt-BR`, the same click works fine and opens the payment-method screen.

In other words: **the error is not in the payment logic — it is in loading the error-message bundle for the wrong locale.**

## 3. Evidence

Real tests executed on 2026-08-20 with Playwright (Google Chrome, `headless: false`, `locale: 'pt-BR'`), authenticated via CAS session, shipment with status **Aguardando Pagamento**.

| # | Test | Result |
|---|------|--------|
| A | Normal AJAX click (`mojarra.ab`) — `Accept-Language: pt-BR` | **HTTP 200** + redirect to `exibirFormasPagamento.jsf?cid=2` (boleto/PIX screen) |
| B | Full JSF POST (`mojarra.jsfcljs`) — `Accept-Language: pt-BR` | **HTTP 302** to the same payment-method screen |
| C | ViewState returned by the `partial-response` | applied normally by Mojarra |

Technical details (requests, payloads, JSF state) in [`docs/evidencias.en.md`](docs/evidencias.en.md).

### About the "pop-up blocked" guidance

Correios support usually tells users to enable pop-ups, but the `HTTP 500` happens **on the AJAX POST, before any window opens**. Pop-ups are not the cause.

## 4. Workaround — if you are affected right now

**1. Set your browser to Portuguese (pt-BR)** — this makes the normal click work:

- **Chrome/Edge**: Settings → Languages → move "Português (Brasil)" to the top.
- **Firefox**: Settings → Language → Português (Brasil).

**2. Or force the `Accept-Language` header to pt-BR** (technical — via a header-overriding extension, proxy, or automation tool):

```
Accept-Language: pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7
```

**3. Or, if you automate with Playwright:**

```js
const context = await chromium.launchPersistentContext('./correios-profile', {
  headless: false,
  locale: 'pt-BR',                    // page language
  args: ['--lang=pt-BR'],
});
```

After that, clicking **"Pagar taxas e tributos"** opens the expected screen:

> "Os pagamentos podem ser feitos por meio de boleto bancário ou PIX." — amount due, IBS/CBS simulation, and the **Concluir pagamento** (Finish payment) button, which redirects to the **Pague Fácil** payment environment.

> ⚠️ If your browser is not in English but you still get the error, check extensions/proxies that rewrite `Accept-Language` (some VPNs and ad-blockers force `en-US`).

## 5. Suggested fix (server-side — Correios)

1. **Add the `en_US` locale** to the `mensagens-excecao` bundle (or a default `mensagens-excecao.properties` fallback file).
2. **Pin the application locale to `pt_BR`** in `faces-config.xml`:

```xml
<application>
  <locale-config>
    <default-locale>pt_BR</default-locale>
  </locale-config>
</application>
```

3. Configure the `ResourceBundle` with **fallback to `pt_BR`** (or never let `MissingResourceException` surface as `HTTP 500`).
4. Ideally, map business exceptions to friendly error messages instead of returning HTTP 500.

## 6. How to report this to Correios

- Official channel: <https://www.correios.com.br/fale-conosco>
- Include:
  - browser and **browser language** (`Accept-Language`);
  - shipment tracking code;
  - a screenshot of the network console with the POST and the `500` response (message `mensagens-excecao` / `locale en_US`);
  - a link to this repo as reference.

## 7. Diagnostic scripts

Requirements: **Node.js 18+**, **Google Chrome** installed.

```bash
npm install
npm run login          # opens the browser, CAS login, navigates to the search page
npm run diagnostico    # runs the AJAX / full POST / ViewState tests
```

- [`scripts/login.js`](scripts/login.js) — opens the visible browser with a persistent profile, detects login, and navigates to the search page.
- [`scripts/payment.js`](scripts/payment.js) — locates the shipment (`REMESSA` via environment variable or default) and runs tests A/B/C/D.

### Structure

```
.
├── README.en.md           # this document (English)
├── README.md              # Portuguese version
├── docs/evidencias.md     # technical evidence (Portuguese)
├── docs/evidencias.en.md  # technical evidence (English)
├── scripts/
│   ├── login.js           # CAS login flow + navigation
│   └── payment.js         # payment-button diagnostic tests
└── package.json
```

## 8. License

MIT — see [LICENSE](LICENSE).
