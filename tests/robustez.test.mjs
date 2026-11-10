import w from '../src/worker.js';
const kv=new Map();
const KV={get:async(k,t)=>{const v=kv.get(k);return v==null?null:(t==='json'?JSON.parse(v):v)},put:async(k,v)=>kv.set(k,v),delete:async k=>kv.delete(k),
 list:async({prefix,limit=1000})=>({keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).slice(0,limit).map(name=>({name})),list_complete:true})};
const env={ASAAS_ENV:'production',PRICE_MONTHLY:'9.90',PRICE_YEARLY:'79.90',GRACE_DAYS:'3',ASAAS_API_KEY:'k',ASAAS_WEBHOOK_TOKEN:'t'.repeat(40),PAYMENTS_KV:KV,ASSETS:{}};
const today=new Date(Date.now()-3*3600e3).toISOString().slice(0,10);
const ago=d=>{const x=new Date(today+'T12:00:00Z');x.setUTCDate(x.getUTCDate()-d);return x.toISOString().slice(0,10)};
// estado simulado do Asaas
let subN=0; const subs={}; const calls=[];
globalThis.fetch=async(url,o)=>{const path=url.split('/v3')[1];calls.push(o.method+' '+path);
 if(path.startsWith('/customers?'))return Response.json({data:[]});
 if(path==='/customers')return Response.json({id:'cus'});
 if(path==='/subscriptions'&&o.method==='POST'){const id='sub_'+(++subN);subs[id]={status:'ACTIVE',deleted:false,pays:[{status:'PENDING',dueDate:today,invoiceUrl:'https://www.asaas.com/i/'+id}]};return Response.json({id})}
 const m=path.match(/^\/subscriptions\/(sub_\d+)(\/payments)?/);
 if(m){const sb=subs[m[1]];if(o.method==='DELETE'){sb.deleted=true;sb.status='INACTIVE';return Response.json({deleted:true})}
   if(m[2])return Response.json({data:sb.pays});return Response.json({status:sb.status,deleted:sb.deleted})}
 return new Response('{}',{status:404})};
const req=(m,p,b,h={},ip='1.1.1.1')=>w.fetch(new Request('https://x'+p,{method:m,headers:{'Content-Type':'application/json','CF-Connecting-IP':ip,...h},body:b?JSON.stringify(b):undefined}),env).then(async r=>[r.status,await r.json()]);
const ok=(c,msg)=>{console.log((c?'ok  ':'FALHOU')+' - '+msg);if(!c)process.exitCode=1};
const lic=t=>JSON.parse(kv.get('lic:'+t));const setLic=(t,f)=>{const l=lic(t);f(l);kv.set('lic:'+t,JSON.stringify(l))};
const cron=async()=>{kv.delete('cron:cursor');await w.scheduled({}, env, {waitUntil:p=>p}); await new Promise(r=>setTimeout(r,10))};
const runCron=async()=>{kv.delete('cron:cursor');const ps=[];await w.scheduled({},env,{waitUntil:p=>ps.push(p)});await Promise.all(ps)};

// A) reaproveitar assinatura pendente
let [s,a]=await req('POST','/api/subscribe',{name:'Ana Souza',email:'ana@x.com',cpf:'52998224725',plan:'monthly'});
let [,a2]=await req('POST','/api/subscribe',{name:'Ana Souza',email:'ana@x.com',cpf:'52998224725',plan:'monthly'});
ok(a2.reused && a2.token===a.token && calls.filter(c=>c==='POST /subscriptions').length===1,'mesma pessoa assinando 2x: reaproveita a fatura, não cria outra assinatura');
// B) troca de plano remove a antiga
let [,a3]=await req('POST','/api/subscribe',{name:'Ana Souza',email:'ana@x.com',cpf:'52998224725',plan:'yearly'});
ok(subs.sub_1.deleted && a3.token!==a.token && subN===2,'trocou de plano: assinatura antiga removida no Asaas');
// C) abandonada: 1ª cobrança vencida há 4 dias
subs.sub_2.pays=[{status:'OVERDUE',dueDate:ago(4),invoiceUrl:'u'}];
await runCron();
ok(subs.sub_2.deleted && lic(a3.token).status==='abandoned','nunca pagou e venceu há 4 dias: conferência remove a assinatura (para de cobrar)');
// D) assinante ativo cancelado no painel do Asaas (sem webhook)
let [,b]=await req('POST','/api/subscribe',{name:'Beto Lima',email:'beto@x.com',cpf:'11144477735',plan:'monthly'},{}, '2.2.2.2');
subs.sub_3.pays=[{status:'RECEIVED',dueDate:today,invoiceUrl:'u'}];
let [,st]=await req('GET','/api/status',null,{Authorization:'Bearer '+b.token}); ok(st.pro,'pagou: PRO liberado');
subs.sub_3.status='INACTIVE'; subs.sub_3.deleted=true; setLic(b.token,l=>l.lastSyncAt=0);
await runCron(); [,st]=await req('GET','/api/status',null,{Authorization:'Bearer '+b.token});
ok(st.status==='cancelled' && st.pro,'cancelado no Asaas sem aviso: app detecta e mantém PRO até o fim do período');
// E) estorno perdido (webhook falhou)
let [,c]=await req('POST','/api/subscribe',{name:'Caio Reis',email:'caio@x.com',cpf:'39053344705',plan:'monthly'},{},'3.3.3.3');
subs.sub_4.pays=[{status:'RECEIVED',dueDate:today}]; await req('GET','/api/status',null,{Authorization:'Bearer '+c.token});
subs.sub_4.pays=[{status:'REFUNDED',dueDate:today}]; setLic(c.token,l=>l.lastSyncAt=0);
await runCron(); [,st]=await req('GET','/api/status',null,{Authorization:'Bearer '+c.token});
ok(!st.pro && subs.sub_4.deleted,'estorno sem webhook: conferência bloqueia o PRO e remove a assinatura');
// F) inadimplente há 16 dias
let [,d]=await req('POST','/api/subscribe',{name:'Davi Melo',email:'davi@x.com',cpf:'15350946056',plan:'monthly'},{},'4.4.4.4');
subs.sub_5.pays=[{status:'RECEIVED',dueDate:ago(47)},{status:'OVERDUE',dueDate:ago(16)}];
await runCron(); [,st]=await req('GET','/api/status',null,{Authorization:'Bearer '+d.token});
ok(!st.pro && st.status==='expired' && subs.sub_5.deleted,'sem pagar há mais de 15 dias: PRO bloqueado e assinatura removida');
// G) vencido há poucos dias: bloqueia mas NÃO remove (ainda pode pagar)
let [,e]=await req('POST','/api/subscribe',{name:'Eva Dias',email:'eva@x.com',cpf:'86288366757',plan:'monthly'},{},'5.5.5.5');
subs.sub_6.pays=[{status:'RECEIVED',dueDate:ago(33)},{status:'OVERDUE',dueDate:ago(2),invoiceUrl:'https://www.asaas.com/i/eva'}];
await runCron(); [,st]=await req('GET','/api/status',null,{Authorization:'Bearer '+e.token});
ok(!st.pro && st.status==='overdue' && !subs.sub_6.deleted && st.invoiceUrl,'atrasou 2 dias: PRO suspenso, assinatura mantida e link da fatura disponível');
subs.sub_6.pays[1].status='RECEIVED'; setLic(e.token,l=>l.lastSyncAt=0);
[,st]=await req('GET','/api/status',null,{Authorization:'Bearer '+e.token}); ok(st.pro,'pagou a fatura atrasada: PRO volta na hora');
// H) limite de tentativas
let codes=[];for(let i=0;i<11;i++){const [sc]=await req('POST','/api/restore',{email:'x@x.com',cpf:'52998224725'},{},'9.9.9.9');codes.push(sc)}
ok(codes.slice(0,10).every(c=>c===404) && codes[10]===429,'recuperar acesso: 11ª tentativa na mesma hora é bloqueada (429)');
codes=[];for(let i=0;i<7;i++){const [sc]=await req('POST','/api/subscribe',{name:'Spam Teste',email:`s${i}@x.com`,cpf:'52998224725',plan:'monthly'},{},'8.8.8.8');codes.push(sc)}
ok(codes[6]===429,'assinar: 7ª tentativa na mesma hora é bloqueada (429)');
