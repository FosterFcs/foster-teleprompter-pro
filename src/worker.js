/**
 * Foster Teleprompter PRO — Worker Cloudflare
 * Foster Tech Soluções · Wilson Foster
 *
 * Rotas:
 *   GET  /api/plans               → planos e preços (vêm das variáveis do Worker)
 *   POST /api/subscribe           → cria cliente + assinatura no Asaas e devolve o link de pagamento
 *   GET  /api/status              → status da licença (Authorization: Bearer <token>)
 *   POST /api/restore             → recupera a licença em outro aparelho (e-mail + CPF)
 *   POST /api/webhook/asaas       → recebe eventos do Asaas (valida header asaas-access-token)
 *   Demais caminhos               → arquivos estáticos da pasta /public
 *
 * Segredos (wrangler secret put):  ASAAS_API_KEY, ASAAS_WEBHOOK_TOKEN
 * Variáveis (wrangler.toml):        ASAAS_ENV, PRICE_MONTHLY, PRICE_YEARLY, GRACE_DAYS
 * KV:                               SUBS
 *
 * Chaves no KV:
 *   lic:<token>     → { token, name, email, cpf, plan, customerId, subscriptionId, status, paidUntil, invoiceUrl, updatedAt }
 *   sub:<subId>     → token
 *   mail:<email>    → token
 *   evt:<eventId>   → "1" (evita processar o mesmo evento duas vezes; expira em 14 dias)
 */

const ASAAS_URL = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3',
};

const PLAN_DAYS = { monthly: 31, yearly: 366 };
const PLAN_CYCLE = { monthly: 'MONTHLY', yearly: 'YEARLY' };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    try {
      const route = `${request.method} ${url.pathname}`;
      switch (route) {
        case 'GET /api/plans': return json(plans(env));
        case 'POST /api/subscribe': return await subscribe(request, env);
        case 'GET /api/status': return await status(request, env);
        case 'POST /api/restore': return await restore(request, env);
        case 'POST /api/webhook/asaas': return await webhook(request, env);
        default: return json({ error: 'Rota não encontrada.' }, 404);
      }
    } catch (err) {
      if (!err.publicMessage || (err.status || 500) >= 500) console.error("Erro na API:", err?.stack || err);
      return json({ error: err.publicMessage || 'Erro interno. Tente novamente em instantes.' }, err.status || 500);
    }
  },
};

/* ---------------- Planos ---------------- */

function plans(env) {
  return {
    env: env.ASAAS_ENV === 'production' ? 'production' : 'sandbox',
    plans: [
      { id: 'monthly', name: 'PRO Mensal', price: Number(env.PRICE_MONTHLY), period: 'mês' },
      { id: 'yearly', name: 'PRO Anual', price: Number(env.PRICE_YEARLY), period: 'ano' },
    ],
  };
}

/* ---------------- Assinar ---------------- */

async function subscribe(request, env) {
  const body = await readJson(request);
  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 160);
  const cpf = onlyDigits(body.cpf);
  const plan = body.plan;

  if (name.length < 3) throw publicError('Informe seu nome completo.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw publicError('Informe um e-mail válido.');
  if (!validCpfCnpj(cpf)) throw publicError('CPF ou CNPJ inválido.');
  if (!PLAN_CYCLE[plan]) throw publicError('Plano inválido.');

  // Se já existe licença ativa para este e-mail, não cria outra cobrança.
  const existingToken = await env.SUBS.get(`mail:${email}`);
  if (existingToken) {
    const lic = await getLicense(env, existingToken);
    if (lic && lic.cpf === cpf && isActive(lic, env)) {
      return json({ token: lic.token, alreadyActive: true, license: publicLicense(lic, env) });
    }
  }

  // 1) Cliente no Asaas (reaproveita se já existir pelo CPF/CNPJ)
  const found = await asaas(env, 'GET', `/customers?cpfCnpj=${cpf}&limit=1`);
  let customerId = found?.data?.[0]?.id;
  if (!customerId) {
    const created = await asaas(env, 'POST', '/customers', {
      name, email, cpfCnpj: cpf, notificationDisabled: false,
    });
    customerId = created.id;
  }

  // 2) Assinatura — UNDEFINED deixa o cliente escolher Pix, boleto ou cartão na fatura
  const token = randomToken();
  const value = Number(plan === 'monthly' ? env.PRICE_MONTHLY : env.PRICE_YEARLY);
  const sub = await asaas(env, 'POST', '/subscriptions', {
    customer: customerId,
    billingType: 'UNDEFINED',
    value,
    nextDueDate: todayBR(),
    cycle: PLAN_CYCLE[plan],
    description: `Foster Teleprompter PRO — ${plan === 'monthly' ? 'Mensal' : 'Anual'}`,
    externalReference: `ftp:${token.slice(0, 16)}`,
  });

  // 3) Primeira cobrança gerada pela assinatura → link da fatura
  const pays = await asaas(env, 'GET', `/subscriptions/${sub.id}/payments?limit=1`);
  const invoiceUrl = pays?.data?.[0]?.invoiceUrl || null;

  const lic = {
    token, name, email, cpf, plan, customerId,
    subscriptionId: sub.id, status: 'pending', paidUntil: null,
    invoiceUrl, updatedAt: new Date().toISOString(),
  };
  await saveLicense(env, lic);
  await env.SUBS.put(`sub:${sub.id}`, token);
  await env.SUBS.put(`mail:${email}`, token);

  return json({ token, invoiceUrl, license: publicLicense(lic, env) });
}

/* ---------------- Status ---------------- */

async function status(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!/^[a-f0-9]{48}$/.test(token)) return json({ pro: false, status: 'none' });
  const lic = await getLicense(env, token);
  if (!lic) return json({ pro: false, status: 'none' });
  return json(publicLicense(lic, env));
}

/* ---------------- Recuperar acesso ---------------- */

async function restore(request, env) {
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  const cpf = onlyDigits(body.cpf);
  const token = email ? await env.SUBS.get(`mail:${email}`) : null;
  const lic = token ? await getLicense(env, token) : null;
  // Mesma resposta para "não existe" e "CPF não confere", para não revelar cadastros.
  if (!lic || lic.cpf !== cpf) throw publicError('Não encontramos assinatura com esses dados.', 404);
  return json({ token: lic.token, license: publicLicense(lic, env) });
}

/* ---------------- Webhook Asaas ---------------- */

async function webhook(request, env) {
  const expected = env.ASAAS_WEBHOOK_TOKEN;
  if (!expected) return json({ error: 'Webhook não configurado.' }, 500); // falha fechada
  const received = request.headers.get('asaas-access-token') || '';
  if (!(await safeEqual(received, expected))) return json({ error: 'Não autorizado.' }, 401);

  const evt = await readJson(request);
  if (evt.id) {
    if (await env.SUBS.get(`evt:${evt.id}`)) return json({ received: true, duplicate: true });
  }

  const subId = evt.payment?.subscription || evt.subscription?.id;
  const token = subId ? await env.SUBS.get(`sub:${subId}`) : null;
  const lic = token ? await getLicense(env, token) : null;

  if (lic) {
    switch (evt.event) {
      case 'PAYMENT_CONFIRMED':
      case 'PAYMENT_RECEIVED': {
        const base = evt.payment.dueDate || todayBR();
        const until = addDays(base, PLAN_DAYS[lic.plan] || 31);
        if (!lic.paidUntil || until > lic.paidUntil) lic.paidUntil = until;
        lic.status = 'active';
        if (evt.payment.invoiceUrl) lic.invoiceUrl = evt.payment.invoiceUrl;
        break;
      }
      case 'PAYMENT_CREATED':
        // Nova cobrança da recorrência: guarda o link para o cliente pagar.
        if (evt.payment.invoiceUrl) lic.invoiceUrl = evt.payment.invoiceUrl;
        break;
      case 'PAYMENT_OVERDUE':
        lic.status = 'overdue';
        if (evt.payment.invoiceUrl) lic.invoiceUrl = evt.payment.invoiceUrl;
        break;
      case 'PAYMENT_REFUNDED':
      case 'PAYMENT_CHARGEBACK_REQUESTED':
        lic.status = 'blocked';
        lic.paidUntil = null;
        break;
      case 'SUBSCRIPTION_DELETED':
      case 'SUBSCRIPTION_INACTIVATED':
        // Cancelada: mantém o acesso até o fim do período já pago.
        lic.status = 'cancelled';
        break;
      default:
        break;
    }
    lic.updatedAt = new Date().toISOString();
    lic.lastEvent = evt.event;
    await saveLicense(env, lic);
  }

  if (evt.id) await env.SUBS.put(`evt:${evt.id}`, '1', { expirationTtl: 60 * 60 * 24 * 14 });
  return json({ received: true });
}

/* ---------------- Regras de acesso ---------------- */

function isActive(lic, env) {
  if (!lic.paidUntil) return false;
  if (lic.status === 'blocked' || lic.status === 'overdue') return false;
  const grace = Number(env.GRACE_DAYS || 0);
  return addDays(lic.paidUntil, grace) >= todayBR();
}

function publicLicense(lic, env) {
  return {
    pro: isActive(lic, env),
    status: lic.status,
    plan: lic.plan,
    name: lic.name.split(' ')[0],
    email: maskEmail(lic.email),
    paidUntil: lic.paidUntil,
    invoiceUrl: lic.status === 'active' ? null : lic.invoiceUrl,
  };
}

/* ---------------- Asaas ---------------- */

async function asaas(env, method, path, body) {
  if (!env.ASAAS_API_KEY) throw publicError('Pagamentos ainda não configurados.', 503);
  const base = ASAAS_URL[env.ASAAS_ENV === 'production' ? 'production' : 'sandbox'];
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'FosterTeleprompterPRO/0.3',
      access_token: env.ASAAS_API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.errors?.[0]?.description;
    console.error('Asaas', method, path, res.status, JSON.stringify(data));
    throw publicError(msg ? `Asaas: ${msg}` : 'Falha ao comunicar com o sistema de pagamento.', 502);
  }
  return data;
}

/* ---------------- KV ---------------- */

async function getLicense(env, token) {
  return env.SUBS.get(`lic:${token}`, 'json');
}
async function saveLicense(env, lic) {
  await env.SUBS.put(`lic:${lic.token}`, JSON.stringify(lic));
}

/* ---------------- Utilitários ---------------- */

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  }));
}
function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return res;
}
async function readJson(request) {
  try { return await request.json(); } catch { throw publicError('Requisição inválida.'); }
}
function publicError(message, status = 400) {
  const e = new Error(message); e.publicMessage = message; e.status = status; return e;
}
function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }
function randomToken() {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0; for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
function todayBR() {
  // Data de hoje no fuso de Brasília (YYYY-MM-DD)
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function addDays(ymd, days) {
  const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function maskEmail(e) {
  const [u, d] = e.split('@'); return `${u.slice(0, 2)}***@${d}`;
}
function validCpfCnpj(v) {
  if (v.length === 11) {
    if (/^(\d)\1+$/.test(v)) return false;
    const calc = n => {
      let s = 0; for (let i = 0; i < n; i++) s += Number(v[i]) * (n + 1 - i);
      const r = (s * 10) % 11; return r === 10 ? 0 : r;
    };
    return calc(9) === Number(v[9]) && calc(10) === Number(v[10]);
  }
  if (v.length === 14) {
    if (/^(\d)\1+$/.test(v)) return false;
    const calc = n => {
      const w = n === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
      let s = 0; for (let i = 0; i < n; i++) s += Number(v[i]) * w[i];
      const r = s % 11; return r < 2 ? 0 : 11 - r;
    };
    return calc(12) === Number(v[12]) && calc(13) === Number(v[13]);
  }
  return false;
}
