/**
 * Foster Studio (teleprompter e gravação) — Worker Cloudflare
 * Foster Tech Soluções · Wilson Foster
 *
 * Rotas:
 *   GET  /api/plans               → planos e preços (vêm das variáveis do Worker)
 *   POST /api/subscribe           → cria cliente + assinatura no Asaas e devolve o link de pagamento
 *   GET  /api/status              → status da licença (Authorization: Bearer <token>)
 *   POST /api/restore             → recupera a licença em outro aparelho (e-mail + CPF)
 *   POST /api/webhook/asaas       → recebe eventos do Asaas (valida header asaas-access-token)
 *   POST /webhook                 → mesmo webhook (endereço já cadastrado no Asaas Sandbox)
 *   Demais caminhos               → arquivos estáticos da pasta /public
 *
 * Segredos (wrangler secret put):  ASAAS_API_KEY, ASAAS_WEBHOOK_TOKEN
 * Variáveis (wrangler.toml):        ASAAS_ENV, PRICE_MONTHLY, PRICE_YEARLY, GRACE_DAYS
 * KV:                               PAYMENTS_KV (namespace TELEPROMPTER_PRO_PAYMENTS)
 *
 * Chaves no KV:
 *   lic:<token>     → { token, name, email, cpf, plan, customerId, subscriptionId, status, paidUntil, invoiceUrl, updatedAt }
 *   sub:<subId>     → token
 *   mail:<email>    → token
 *   evt:<eventId>   → "1" (evita processar o mesmo evento duas vezes; expira em 14 dias)
 *   rl:<rota>:<ip>  → contador do limite de tentativas
 *   cron:cursor     → posição da conferência automática
 *
 * Conferência automática (cron, de hora em hora): compara cada licença com o Asaas,
 * corrige status perdidos (pagamento, vencimento, estorno, cancelamento) e remove
 * no Asaas as assinaturas abandonadas (nunca pagas) e as vencidas há muito tempo,
 * para não gerar cobranças indevidas.
 */

const OFFICIAL_URL = 'https://studio.engfoster.com.br';

const ASAAS_URL = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3',
};

const PLAN_DAYS = { monthly: 31, yearly: 366 };
const PLAN_CYCLE = { monthly: 'MONTHLY', yearly: 'YEARLY' };
const PAID = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];
const REVERSED = ['REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS', 'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL'];
const ABANDON_DAYS = 3;   // 1ª cobrança vencida há 3 dias sem pagamento → remove a assinatura
const EXPIRE_DAYS = 15;   // assinante sem pagar há 15 dias após o vencimento → remove a assinatura
const CRON_BATCH = 12;    // licenças por execução (limite de subrequisições do plano grátis)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Endereço antigo (V0.2) → endereço oficial do Foster Studio
    if (url.hostname.startsWith('foster-teleprompter-pro.')) {
      return Response.redirect(OFFICIAL_URL + url.pathname + url.search, 301);
    }
    // workers.dev → domínio próprio (menos webhook e API, que continuam respondendo aqui)
    if (url.hostname.startsWith('foster-studio.') && url.hostname.endsWith('.workers.dev') &&
        !url.pathname.startsWith('/api/') && url.pathname !== '/webhook') {
      return Response.redirect(OFFICIAL_URL + url.pathname + url.search, 301);
    }
    if (url.pathname === '/webhook' && request.method === 'POST') return await webhook(request, env).catch(e => json({ error: 'Erro interno.' }, 500));
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

  async scheduled(event, env, ctx) {
    if (env.WORKER_ROLE === 'legacy') return;
    ctx.waitUntil(reconcileBatch(env));
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
  await rateLimit(env, request, 'sub', 6, 3600);
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
  const existingToken = await env.PAYMENTS_KV.get(`mail:${email}`);
  if (existingToken) {
    const lic = await getLicense(env, existingToken);
    if (lic && lic.cpf === cpf && isActive(lic, env)) {
      return json({ token: lic.token, alreadyActive: true, license: publicLicense(lic, env) });
    }
    // Assinatura pendente do mesmo cliente: reaproveita a fatura em vez de abrir outra.
    if (lic && lic.cpf === cpf && lic.status === 'pending' && lic.subscriptionActive !== false) {
      if (lic.plan === plan && lic.invoiceUrl) {
        return json({ token: lic.token, invoiceUrl: lic.invoiceUrl, reused: true, license: publicLicense(lic, env) });
      }
      // Trocou de plano: remove a assinatura antiga antes de criar a nova.
      await removeSubscription(env, lic, 'abandoned');
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
    description: `Foster Studio PRO — ${plan === 'monthly' ? 'Mensal' : 'Anual'}`,
    externalReference: `ftp:${token.slice(0, 16)}`,
  });

  // 3) Primeira cobrança gerada pela assinatura → link da fatura
  const pays = await asaas(env, 'GET', `/subscriptions/${sub.id}/payments?limit=1`);
  const invoiceUrl = pays?.data?.[0]?.invoiceUrl || null;

  const lic = {
    env: currentEnv(env),
    token, name, email, cpf, plan, customerId,
    subscriptionId: sub.id, status: 'pending', paidUntil: null,
    invoiceUrl, updatedAt: new Date().toISOString(),
  };
  await saveLicense(env, lic);
  await env.PAYMENTS_KV.put(`sub:${sub.id}`, token);
  await env.PAYMENTS_KV.put(`mail:${email}`, token);

  return json({ token, invoiceUrl, license: publicLicense(lic, env) });
}

/* ---------------- Status ---------------- */

async function status(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!/^[a-f0-9]{48}$/.test(token)) return json({ pro: false, status: 'none' });
  const lic = await getLicense(env, token);
  if (!lic) return json({ pro: false, status: 'none' });
  await syncFromAsaas(env, lic);
  return json(publicLicense(lic, env));
}

/* Sincronização com o Asaas (fonte da verdade).
   - Pelo app (status/restore): só quando a licença não está ativa, no máximo 1 vez a cada 15 s.
   - Pela conferência automática (force): sempre, confere também se a assinatura ainda existe
     e remove assinaturas abandonadas ou vencidas há muito tempo. */
async function syncFromAsaas(env, lic, { force = false } = {}) {
  if (!lic.subscriptionId || !env.ASAAS_API_KEY) return false;
  if (!force) {
    if (isActive(lic, env)) return false;
    if (lic.subscriptionActive === false && !lic.paidUntil) return false;
    if (lic.lastSyncAt && Date.now() - lic.lastSyncAt < 15000) return false;
  }
  lic.lastSyncAt = Date.now();
  const today = todayBR();
  try {
    const res = await asaas(env, 'GET', `/subscriptions/${lic.subscriptionId}/payments?limit=50`);
    const pays = (res.data || []).filter(p => !p.deleted);
    const paid = pays.filter(p => PAID.includes(p.status));
    const reversed = pays.filter(p => REVERSED.includes(p.status));
    const open = pays.filter(p => p.status === 'PENDING' || p.status === 'OVERDUE')
      .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
    const overdue = open.find(p => p.status === 'OVERDUE');

    let until = null;
    for (const p of paid) {
      const u = addDays(p.dueDate || today, PLAN_DAYS[lic.plan] || 31);
      if (!until || u > until) until = u;
    }
    lic.paidUntil = until;
    if (open[0]?.invoiceUrl) lic.invoiceUrl = open[0].invoiceUrl;

    if (force) {
      const sub = await asaas(env, 'GET', `/subscriptions/${lic.subscriptionId}`);
      if (sub.deleted || sub.status === 'INACTIVE' || sub.status === 'EXPIRED') lic.subscriptionActive = false;
      else lic.subscriptionActive = true;
    }

    const paidValid = until && until >= today;
    if (lic.subscriptionActive === false || lic.status === 'cancelled' || lic.status === 'expired' || lic.status === 'abandoned') {
      lic.status = until ? (lic.status === 'expired' ? 'expired' : 'cancelled') : (lic.status === 'expired' ? 'expired' : 'abandoned');
    } else if (overdue && !paidValid) lic.status = 'overdue';
    else if (until) lic.status = 'active';
    else if (reversed.length) lic.status = 'blocked';
    else lic.status = 'pending';

    // Limpeza automática (só na conferência): evita cobranças indevidas.
    if (force && lic.subscriptionActive) {
      if (!paid.length && overdue && daysBetween(overdue.dueDate, today) >= ABANDON_DAYS) {
        await removeSubscription(env, lic, 'abandoned');
      } else if (lic.status === 'overdue' && until && daysBetween(until, today) >= EXPIRE_DAYS) {
        await removeSubscription(env, lic, 'expired');
      } else if (lic.status === 'blocked') {
        await removeSubscription(env, lic, 'blocked');
      }
    }
  } catch (e) {
    console.error('sync Asaas falhou', lic.subscriptionId, e?.message);
    return false;
  }
  lic.updatedAt = new Date().toISOString();
  await saveLicense(env, lic);
  return true;
}

async function removeSubscription(env, lic, newStatus) {
  try {
    await asaas(env, 'DELETE', `/subscriptions/${lic.subscriptionId}`);
  } catch (e) {
    console.error('Falha ao remover assinatura', lic.subscriptionId, e?.message);
    return;
  }
  lic.subscriptionActive = false;
  lic.status = newStatus;
  lic.removedAt = new Date().toISOString();
  lic.updatedAt = lic.removedAt;
  await saveLicense(env, lic);
  console.log('Assinatura removida no Asaas', lic.subscriptionId, newStatus);
}

/* ---------------- Conferência automática (cron) ---------------- */

async function reconcileBatch(env) {
  if (!env.ASAAS_API_KEY) return;
  const cursor = (await env.PAYMENTS_KV.get('cron:cursor')) || undefined;
  const page = await env.PAYMENTS_KV.list({ prefix: 'lic:', cursor, limit: 100 });
  let checked = 0;
  const today = todayBR();
  for (const k of page.keys) {
    if (checked >= CRON_BATCH) break;
    const lic = await getLicense(env, k.name.slice(4));
    if (!lic || !lic.subscriptionId) continue;
    // Já encerrada e sem acesso: nada a conferir.
    if (lic.subscriptionActive === false && (!lic.paidUntil || lic.paidUntil < today)) continue;
    // Ativa com bastante prazo e conferida há menos de 3 dias: pula.
    if (lic.status === 'active' && lic.paidUntil && daysBetween(today, lic.paidUntil) > 3 &&
        lic.lastSyncAt && Date.now() - lic.lastSyncAt < 3 * 86400000) continue;
    await syncFromAsaas(env, lic, { force: true });
    checked++;
  }
  // Guarda onde parou; quando chega ao fim, recomeça do início.
  if (page.list_complete && checked < CRON_BATCH) await env.PAYMENTS_KV.delete('cron:cursor');
  else if (!page.list_complete) await env.PAYMENTS_KV.put('cron:cursor', page.cursor);
  console.log(`Conferência automática: ${checked} licença(s) verificada(s).`);
}

/* ---------------- Recuperar acesso ---------------- */

async function restore(request, env) {
  await rateLimit(env, request, 'restore', 10, 3600);
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  const cpf = onlyDigits(body.cpf);
  const token = email ? await env.PAYMENTS_KV.get(`mail:${email}`) : null;
  const lic = token ? await getLicense(env, token) : null;
  // Mesma resposta para "não existe" e "CPF não confere", para não revelar cadastros.
  if (!lic || lic.cpf !== cpf) throw publicError('Não encontramos assinatura com esses dados.', 404);
  await syncFromAsaas(env, lic);
  return json({ token: lic.token, license: publicLicense(lic, env) });
}

/* ---------------- Webhook Asaas ---------------- */

async function webhook(request, env) {
  const expected = (env.ASAAS_WEBHOOK_TOKEN || '').trim();
  if (!expected) return json({ error: 'Webhook não configurado.' }, 500); // falha fechada
  const received = (request.headers.get('asaas-access-token') || '').trim();
  if (!(await safeEqual(received, expected))) return json({ error: 'Não autorizado.' }, 401);

  const evt = await readJson(request);
  if (evt.id) {
    if (await env.PAYMENTS_KV.get(`evt:${evt.id}`)) return json({ received: true, duplicate: true });
  }

  const subId = evt.payment?.subscription || evt.subscription?.id;
  const token = subId ? await env.PAYMENTS_KV.get(`sub:${subId}`) : null;
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
        lic.status = lic.paidUntil ? 'cancelled' : 'abandoned';
        lic.subscriptionActive = false;
        break;
      default:
        break;
    }
    lic.updatedAt = new Date().toISOString();
    lic.lastEvent = evt.event;
    await saveLicense(env, lic);
  }

  if (evt.id) await env.PAYMENTS_KV.put(`evt:${evt.id}`, '1', { expirationTtl: 60 * 60 * 24 * 14 });
  return json({ received: true });
}

/* ---------------- Regras de acesso ---------------- */

function isActive(lic, env) {
  if (!lic.paidUntil) return false;
  if (lic.status === 'blocked' || lic.status === 'overdue' || lic.status === 'abandoned') return false;
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
      'User-Agent': 'FosterStudio/0.3',
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

function currentEnv(env) { return env.ASAAS_ENV === 'production' ? 'production' : 'sandbox'; }
async function getLicense(env, token) {
  const lic = await env.PAYMENTS_KV.get(`lic:${token}`, 'json');
  // Licenças de teste (sandbox) não valem em produção, e vice-versa.
  if (!lic || (lic.env || 'sandbox') !== currentEnv(env)) return null;
  return lic;
}
async function saveLicense(env, lic) {
  await env.PAYMENTS_KV.put(`lic:${lic.token}`, JSON.stringify(lic));
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
function daysBetween(fromYmd, toYmd) {
  return Math.round((new Date(toYmd + 'T12:00:00Z') - new Date(fromYmd + 'T12:00:00Z')) / 86400000);
}
async function rateLimit(env, request, bucket, limit, windowSec) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const win = Math.floor(Date.now() / 1000 / windowSec);
  const key = `rl:${bucket}:${ip}:${win}`;
  const n = Number((await env.PAYMENTS_KV.get(key)) || 0);
  if (n >= limit) throw publicError('Muitas tentativas. Aguarde alguns minutos e tente novamente.', 429);
  await env.PAYMENTS_KV.put(key, String(n + 1), { expirationTtl: Math.max(60, windowSec * 2) });
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
