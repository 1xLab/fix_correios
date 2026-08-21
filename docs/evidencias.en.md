# Technical evidence (sanitized)

All session values (cookies, `JSESSIONID`, `INGRESSCOOKIE`, `ViewState`, `cid`, cart UUIDs) have been removed or masked. No personal or financial data is exposed.

## 1. Test environment

| Item | Value |
|---|---|
| Browser | Google Chrome via Playwright (`headless: false`) |
| Locale | `pt-BR` (`locale` + `--lang=pt-BR`) |
| Actual `Accept-Language` sent | `pt-BR` |
| Shipment | status **Aguardando Pagamento** |
| Authentication | Real CAS (`cas.correios.com.br`), user session |

## 2. JSF state before the click

```js
{
  url: "https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf",
  formAction: "https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf?cid=2",
  formId: "form-pesquisarRemessas",
  cid: "2",
  viewState: "<view-state-id>"
}
```

- `cid=2` → **Conversation Scope active**; the server reuses the same `cid` in the POST and in the response.
- Real button: `form-pesquisarRemessas:j_idt107:0:iconePagamento` (the `:j_idt107:0:` suffix is Mojarra-generated and **varies** on every render).

## 3. Test A — normal AJAX click (`mojarra.ab`) with `Accept-Language: pt-BR`

**Request**

```
POST https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf?cid=2
Faces-Request: partial/ajax
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
```

URL-encoded payload:

```
form-pesquisarRemessas=form-pesquisarRemessas
javax.faces.ViewState=<view-state-id>
javax.faces.source=form-pesquisarRemessas:j_idt107:0:iconePagamento
javax.faces.partial.event=click
javax.faces.partial.execute=form-pesquisarRemessas:j_idt107:0:iconePagamento form-pesquisarRemessas
javax.faces.partial.render=form-pesquisarRemessas
javax.faces.behavior.event=action
javax.faces.partial.ajax=true
```

**Response**

```
HTTP 200
Content-Type: text/xml;charset=UTF-8
```

The `partial-response` contains a `redirect` to:

```
https://portalimportador.correios.com.br/pages/disponibilizarMeiosPagamentoDIT/exibirFormasPagamento.jsf?cid=2
```

Result: **payment-method screen shown** — boleto/PIX, amount due (masked), IBS/CBS simulation, and the **"Concluir pagamento"** button (which opens the **Pague Fácil** environment).

## 4. Test B — full JSF POST (`mojarra.jsfcljs`)

The same button submitted as a **full form POST** (non-AJAX) returns:

```
HTTP 302
Location: https://portalimportador.correios.com.br/pages/disponibilizarMeiosPagamentoDIT/exibirFormasPagamento.jsf?cid=2
```

In other words: **the payment flow itself works**; the problem is specific to the AJAX + locale path.

## 5. Test C — ViewState

- The successful `partial-response` (HTTP 200) delivers a **new `javax.faces.ViewState`** inside `<update id="j_id1:javax.faces.ViewState:0">`.
- Mojarra **applies** the new ViewState normally (standard session-fixation protection).
- An AJAX HTTP 500 (when it happens with the wrong locale) **also** returns a new ViewState in the body — a sign that the exception happens **after** ViewState validation, during `action` execution.

## 6. Error reproduction via `curl` (no session)

```
GET  https://portalimportador.correios.com.br/                -> HTTP 200 (page with meta-refresh to the search page)
GET  .../pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf -> connection reset
```

The search-page route is dropped by the server/WAF when accessed aggressively or without a session — consistent with an unhandled exception in the JSF layer.

## 7. Original error (reported by the user, English browser)

With `Accept-Language: en-US,en;q=0.9`, the same click returned:

```
HTTP 500 Internal Server Error

Can't find bundle for base name mensagens-excecao, locale en_US
```

and the AJAX body was a `partial-response` with HTTP 500 plus a new `javax.faces.ViewState`:

```xml
<?xml version='1.0' encoding='UTF-8'?>
<partial-response>
  <changes>
    <update id="javax.faces.Resource">...</update>
    <update id="j_id1:javax.faces.ViewState:0">
      <![CDATA[<new-view-state>]]>
    </update>
  </changes>
</partial-response>
```

## 8. Conclusion

- `MissingResourceException` for the `mensagens-excecao` bundle in the `en_US` locale **is the root cause** of the HTTP 500 on the "Pagar taxas e tributos" button.
- The bundle only exists for `pt_BR`; no default fallback is configured.
- With `Accept-Language: pt-BR`, the same flow completes with **HTTP 200/302** up to the payment-method screen (boleto/PIX) and the Pague Fácil environment.
- **Fix**: add the `en_US` locale to the bundle (or a default fallback) and/or pin the application locale to `pt_BR`.
