# Evidências técnicas (sanitizadas)

Todos os valores de sessão (cookies, `JSESSIONID`, `INGRESSCOOKIE`, `ViewState`, `cid`, UUIDs de carrinho) foram removidos ou mascarados. Nenhum dado pessoal ou financeiro real é exposto.

## 1. Ambiente de teste

| Item | Valor |
|---|---|
| Navegador | Google Chrome via Playwright (`headless: false`) |
| Locale | `pt-BR` (`locale` + `--lang=pt-BR`) |
| `Accept-Language` real enviado | `pt-BR` |
| Remessa | situação **Aguardando Pagamento** |
| Autenticação | CAS real (`cas.correios.com.br`), sessão do usuário |

## 2. Estado JSF antes do clique

```js
{
  url: "https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf",
  formAction: "https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf?cid=2",
  formId: "form-pesquisarRemessas",
  cid: "2",
  viewState: "<view-state-id>"
}
```

- `cid=2` → **Conversation Scope ativa**; o servidor reutiliza o mesmo `cid` no POST e na resposta.
- Botão real: `form-pesquisarRemessas:j_idt107:0:iconePagamento` (o sufixo `:j_idt107:0:` é gerado pelo Mojarra e **varia** a cada renderização).

## 3. Teste A — clique AJAX normal (`mojarra.ab`) com `Accept-Language: pt-BR`

**Request**

```
POST https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf?cid=2
Faces-Request: partial/ajax
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
```

Payload (URL-encoded):

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

O `partial-response` contém `redirect` para:

```
https://portalimportador.correios.com.br/pages/disponibilizarMeiosPagamentoDIT/exibirFormasPagamento.jsf?cid=2
```

Resultado: **tela de formas de pagamento exibida** — boleto/PIX, valor a pagar (mascarado), simulação IBS/CBS e botão **"Concluir pagamento"** (que abre o ambiente **Pague Fácil**).

## 4. Teste B — POST JSF completo (`mojarra.jsfcljs`)

O mesmo botão submetido como **form submit completo** (sem AJAX) retorna:

```
HTTP 302
Location: https://portalimportador.correios.com.br/pages/disponibilizarMeiosPagamentoDIT/exibirFormasPagamento.jsf?cid=2
```

Ou seja: **o fluxo de pagamento em si funciona**; o problema é específico do caminho AJAX + locale.

## 5. Teste C — ViewState

- O `partial-response` de sucesso (HTTP 200) entrega um **novo `javax.faces.ViewState`** dentro de `<update id="j_id1:javax.faces.ViewState:0">`.
- O Mojarra **aplica** o novo ViewState normalmente (mecanismo padrão de prevenção de fixação de sessão).
- Um HTTP 500 AJAX (quando ocorre com locale errado) **também** devolve um novo ViewState no corpo — sinal de que a exceção ocorre **após** a validação do ViewState, durante a execução do `action`.

## 6. Reprodução do erro por `curl` (sem sessão)

```
GET  https://portalimportador.correios.com.br/                -> HTTP 200 (página com meta-refresh para a pesquisa)
GET  .../pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf -> conexão resetada
```

A rota da página de pesquisa é derrubada pelo servidor/WAF quando acessada de forma agressiva ou sem sessão — consistente com uma exceção não tratada na camada JSF.

## 7. Erro original (reportado pelo usuário, browser em inglês)

Com `Accept-Language: en-US,en;q=0.9`, o mesmo clique retornava:

```
HTTP 500 Internal Server Error

Can't find bundle for base name mensagens-excecao, locale en_US
```

e o corpo do AJAX era um `partial-response` com HTTP 500 + novo `javax.faces.ViewState`:

```xml
<?xml version='1.0' encoding='UTF-8'?>
<partial-response>
  <changes>
    <update id="javax.faces.Resource">...</update>
    <update id="j_id1:javax.faces.ViewState:0">
      <![CDATA[<novo-view-state>]]>
    </update>
  </changes>
</partial-response>
```

## 8. Conclusão

- `MissingResourceException` para o bundle `mensagens-excecao` no locale `en_US` **é a causa raiz** do HTTP 500 no botão "Pagar taxas e tributos".
- O bundle existe apenas para `pt_BR`; o fallback default não está configurado.
- Com `Accept-Language: pt-BR`, o mesmo fluxo completa com **HTTP 200/302** até a tela de formas de pagamento (boleto/PIX) e o ambiente Pague Fácil.
- **Correção**: adicionar locale `en_US` ao bundle (ou fallback default) e/ou fixar o locale da aplicação em `pt_BR`.
