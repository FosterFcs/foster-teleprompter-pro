# Foster Studio — Teleprompter e gravação · V0.3 (comercial)
*(antigo Foster Teleprompter PRO)*
**Apresente suas ideias com profissionalismo.** · Um produto Foster Tech Soluções

Teleprompter com prévia de câmera, gravação local e plano PRO por assinatura (Asaas), rodando em um Worker da Cloudflare.

> A V0.2 continua intacta na branch `main` (e no `re.zip`). Esta versão usa um Worker **novo** (`foster-studio-sandbox`), então o endereço que já está no ar não é alterado.

## Estrutura
```
public/index.html   → app (teleprompter, câmera, gravação, planos)
src/worker.js       → API: planos, assinatura, status, recuperação e webhook Asaas
wrangler.toml       → configuração do Worker (KV, variáveis, preços)
```

## Grátis x PRO
| Recurso | Grátis | PRO |
|---|---|---|
| Teleprompter, espelhamento, linha-guia, tela cheia | ✓ | ✓ |
| Câmera frontal/traseira | ✓ | ✓ |
| Gravação | até 1 minuto | sem limite |
| Takes guardados na sessão | só o último | todos |
| Roteiros salvos | até 3 | ilimitados |
| Contagem regressiva 3s | — | ✓ |
| Divulgação Foster Engenharia na página | aparece | não aparece |

## Ativar no Sandbox (passo a passo)
1. **Conta Sandbox Asaas**: crie em https://sandbox.asaas.com e gere a chave em *Integrações → Chave de API*.
2. **Instalar e entrar na Cloudflare**
   ```bash
   npm install
   npx wrangler login
   ```
3. **Criar o KV** e colar o `id` no `wrangler.toml`
   ```bash
   npx wrangler kv namespace create SUBS
   ```
4. **Gravar os segredos** (nunca no código)
   ```bash
   npx wrangler secret put ASAAS_API_KEY        # chave do Sandbox ($aact_...)
   npx wrangler secret put ASAAS_WEBHOOK_TOKEN  # texto aleatório de 32+ caracteres
   ```
5. **Publicar**: `npx wrangler deploy` → gera `https://foster-studio-sandbox.<conta>.workers.dev`
6. **Webhook no Asaas Sandbox**: *Integrações → Webhooks → Criar*
   - URL: `https://foster-studio-sandbox.<conta>.workers.dev/api/webhook/asaas`
   - Token de autenticação: o mesmo `ASAAS_WEBHOOK_TOKEN`
   - Eventos: `PAYMENT_CREATED`, `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `PAYMENT_REFUNDED`, `SUBSCRIPTION_DELETED`, `SUBSCRIPTION_INACTIVATED`

## Roteiro de teste (antes de ir para produção)
1. Abrir o app → **Seja PRO** → assinar com um CPF de teste válido.
2. Na fatura do Sandbox, simular o pagamento (Pix/cartão de teste).
3. Conferir: selo muda para **PRO**, gravação sem limite, divulgação some.
4. Em outro navegador: **Já sou assinante → recuperar acesso** (e-mail + CPF).
5. No painel Asaas, cancelar a assinatura → o acesso continua até o fim do período pago.
6. Simular vencimento (`PAYMENT_OVERDUE`) → o PRO é bloqueado.

## Ir para produção
- Trocar `ASAAS_ENV = "production"`, gravar a chave de produção em `ASAAS_API_KEY` e definir os preços finais (`PRICE_MONTHLY`, `PRICE_YEARLY`).
- Criar o webhook também na conta de produção (Sandbox e produção são configurados separadamente).
- Fazer uma cobrança real controlada antes de divulgar.
- Quando aprovado, trocar `name` no `wrangler.toml` para `foster-studio` (endereço definitivo) e desativar o Worker antigo `foster-teleprompter-pro` — ou apontar um domínio próprio, ex.: studio.engfoster.com.br.

## Regras de acesso
- Pagamento confirmado/recebido → PRO até o vencimento + 31 dias (mensal) ou 366 dias (anual), com tolerância de `GRACE_DAYS`.
- Cobrança vencida ou estornada → bloqueia na hora.
- Assinatura cancelada → mantém até o fim do período já pago.
- O app guarda a licença no aparelho e confere no servidor sempre que abre.

## Limitações conhecidas desta versão
- A recuperação de acesso usa e-mail + CPF (sem código por e-mail). Para a versão pública, o ideal é um código de confirmação enviado por e-mail.
- As travas do plano grátis ficam no navegador: impedem o uso comum, mas não alguém com conhecimento técnico.
- O formato do vídeo depende do navegador: MP4 quando houver suporte (Safari, Chrome recente), senão WebM.

---
Wilson Foster · Engenheiro Civil · CREA/SP — Foster Tech Soluções
