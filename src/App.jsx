import React, { useCallback, useEffect, useState } from 'react';


const ACC={
  amber:'#f5b731',amberSoft:'rgba(245,183,49,.12)',
  profit:'#3dd68c',profitBg:'rgba(61,214,140,.10)',
  loss:'#f46a5a',lossBg:'rgba(244,106,90,.10)',
  blue:'#4fa3e0',blueBg:'rgba(79,163,224,.10)',
  purple:'#a78bfa',purpleBg:'rgba(167,139,250,.10)',
  teal:'#2dd4bf',tealBg:'rgba(45,212,191,.10)',
};
const V=(n)=>`var(--${n})`;
const fmt=(n,d=2)=>n==null?'—':Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtM=(n)=>n==null?'—':(n>=0?'+$':'-$')+Math.abs(n).toFixed(2);
const fmtA=(n)=>n==null?'—':(n>=0?'+':'')+n.toFixed(1)+'%';
const daysBetween=(a,b)=>Math.round((new Date(b)-new Date(a))/86400000);
const today=()=>new Date().toISOString().slice(0,10);
const calcAnnual=(profit,capital,days)=>{
  if(!capital||!days||days<=0)return null;
  return(profit/capital)*(365/days)*100;
};

const DEFAULT_COMM=0.65;
const SK={
  POS:'whl-pos-v2',CLOSED:'whl-closed-v1',STOCKS:'whl-stocks-v1',SGOV:'whl-sgov-v3',CFG:'whl-cfg-v2',
  CN_POS:'whl-cn-pos-v1',CN_CLOSED:'whl-cn-closed-v1',CN_STOCKS:'whl-cn-stocks-v1',
  KEY:'whl-api-key',FH_KEY:'whl-finnhub-key',THEME:'whl-theme',
};
const US_ACCOUNT_TABS=['active','stocks','closed','sgov'];
const CLOSED_GRID='3px minmax(104px,.7fr) minmax(78px,.55fr) minmax(118px,.8fr) minmax(128px,.85fr) minmax(230px,1.35fr) minmax(148px,.95fr) minmax(112px,.75fr) minmax(112px,.75fr) 32px';

/* ── 本地缓存（localStorage）：仅作本设备快速启动用，云端为主 ── */
const ls=(k,fb=null)=>{try{const s=localStorage.getItem(k);return s?JSON.parse(s):fb}catch{return fb}};
const lss=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch{}};

/* ── 云端存储配置 ──
   URL 内置一个默认值方便开箱访问公开的行情代理（/api/quote /api/cboe，
   这两个接口本身不需要密码）。但密码不再内置：云端同步和富途接口都需要
   密码鉴权，必须由用户在"云端设置"里手动填入自己在 Vercel 环境变量里
   设置的 ACCESS_PASSWORD，否则任何拿到这份公开源码的人都能读写你的数据。 */
const DEFAULT_CLOUD_URL = ['localhost','127.0.0.1',''].includes(window.location.hostname)
  ? window.location.origin
  : 'https://wheel-data.vercel.app';
// 首次打开时只写入 URL，不再自动写入任何密码
if (!localStorage.getItem('whl-cloud-url')) {
  localStorage.setItem('whl-cloud-url', DEFAULT_CLOUD_URL);
}
const CLOUD_URL = localStorage.getItem('whl-cloud-url') || DEFAULT_CLOUD_URL;

async function cloudGet(password) {
  const url = localStorage.getItem('whl-cloud-url') || DEFAULT_CLOUD_URL;
  if (!url || !password) return null;
  try {
    const res = await fetch(`${url}/api/data`, {
      headers: { Authorization: `Bearer ${password}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    let data = await res.json();
    // 自动解码：处理多重 JSON 编码（兼容历史脏数据）
    let guard = 0;
    while (typeof data === 'string' && guard < 5) {
      try { data = JSON.parse(data); guard++; }
      catch { break; }
    }
    if (data && typeof data === 'object' && !data.error) return data;
    return null;
  } catch(e) { console.warn('cloudGet error:', e); return null; }
}

/* 所有 /api/futu/* 请求统一走这里，自动带上云端密码
   （后端现在要求鉴权，不带密码会 401） */
async function futuFetch(path, opts={}){
  const proxyBase=localStorage.getItem('whl-cloud-url')||DEFAULT_CLOUD_URL;
  const pwd=localStorage.getItem('whl-cloud-pwd')||'';
  const headers={...(opts.headers||{}), Authorization:`Bearer ${pwd}`};
  return fetch(proxyBase+path, {...opts, headers});
}

async function cnOptionFetch(symbol,month='',opts={}){
  const proxyBase=localStorage.getItem('whl-cloud-url')||DEFAULT_CLOUD_URL;
  const params=new URLSearchParams({symbol});
  if(month)params.set('month',month);
  return fetch(`${proxyBase}/api/cn-options?${params.toString()}`,{
    ...opts,
    signal:opts.signal||AbortSignal.timeout(20000),
  });
}

async function cnIndexFetch(opts={}){
  const proxyBase=localStorage.getItem('whl-cloud-url')||DEFAULT_CLOUD_URL;
  return fetch(`${proxyBase}/api/cn-options?indexOnly=1`,{
    ...opts,
    signal:opts.signal||AbortSignal.timeout(3500),
  });
}

const CSI500_LOCAL_CACHE='whl-csi500-index-v1';
const HKD_CNY_LOCAL_CACHE='whl-hkd-cny-v1';
const DEFAULT_HKD_CNY_RATE=.92;
function readCsi500Cache(maxAge=24*60*60*1000){
  try{
    const saved=JSON.parse(localStorage.getItem(CSI500_LOCAL_CACHE)||'null');
    return saved?.payload?.price>0&&Date.now()-(saved.savedAt||0)<maxAge?saved.payload:null;
  }catch{return null;}
}
function saveCsi500Cache(payload){
  if(!(payload?.price>0))return;
  try{localStorage.setItem(CSI500_LOCAL_CACHE,JSON.stringify({savedAt:Date.now(),payload}));}catch{}
}
let csi500IndexPending=null;
async function loadCsi500Index(force=false){
  const fresh=readCsi500Cache(5*60*1000);
  if(!force&&fresh)return fresh;
  if(csi500IndexPending)return csi500IndexPending;
  csi500IndexPending=(async()=>{
    try{
      const response=await cnIndexFetch();
      if(!response.ok)return readCsi500Cache();
      const payload=await response.json();
      if(payload?.price>0){saveCsi500Cache(payload);return payload;}
    }catch{}
    return readCsi500Cache();
  })().finally(()=>{csi500IndexPending=null;});
  return csi500IndexPending;
}
function readHkdCnyCache(maxAge=24*60*60*1000){
  try{
    const saved=JSON.parse(localStorage.getItem(HKD_CNY_LOCAL_CACHE)||'null');
    return saved?.payload?.rate>0&&Date.now()-(saved.savedAt||0)<maxAge?saved.payload:null;
  }catch{return null;}
}
function saveHkdCnyCache(payload){
  if(!(payload?.rate>0))return;
  try{localStorage.setItem(HKD_CNY_LOCAL_CACHE,JSON.stringify({savedAt:Date.now(),payload}));}catch{}
}
let hkdCnyPending=null;
async function loadHkdCnyRate(force=false){
  const fresh=readHkdCnyCache(6*60*60*1000);
  if(!force&&fresh)return fresh;
  if(hkdCnyPending)return hkdCnyPending;
  hkdCnyPending=(async()=>{
    const fallback=readHkdCnyCache(30*24*60*60*1000)||{rate:DEFAULT_HKD_CNY_RATE,source:'fallback'};
    try{
      const proxyBase=localStorage.getItem('whl-cloud-url')||DEFAULT_CLOUD_URL;
      const response=await fetch(`${proxyBase}/api/quote/${encodeURIComponent('HKDCNY=X')}`,{signal:AbortSignal.timeout(6000)});
      if(!response.ok)return fallback;
      const payload=await response.json();
      const rate=Number(payload?.price);
      if(rate>0){const next={rate,source:payload?.source||'Yahoo',updatedAt:Date.now()};saveHkdCnyCache(next);return next;}
    }catch{}
    return fallback;
  })().finally(()=>{hkdCnyPending=null;});
  return hkdCnyPending;
}

async function cloudPut(data, password) {
  const url = localStorage.getItem('whl-cloud-url') || DEFAULT_CLOUD_URL;
  if (!url || !password) return false;
  try {
    const res = await fetch(`${url}/api/data`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${password}`,
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch(e) { console.warn('cloudPut error:', e); return false; }
}

/* ── 云端配置弹层 ── */
function CloudSetupModal({onSave, onClose}) {
  const [url, setUrl] = useState(localStorage.getItem('whl-cloud-url') || '');
  const [pwd, setPwd] = useState(localStorage.getItem('whl-cloud-pwd') || '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const testConnection = async () => {
    if (!url.trim() || !pwd.trim()) { setTestResult('请先填写 URL 和密码'); return; }
    setTesting(true); setTestResult(null);
    try {
      const res = await fetch(`${url.trim()}/api/health`, {
        headers: { Authorization: `Bearer ${pwd.trim()}` },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) setTestResult('✓ 连接成功！');
      else if (res.status === 401) setTestResult('✗ 密码错误');
      else setTestResult(`✗ 连接失败 (${res.status})`);
    } catch (e) { setTestResult('✗ 网络错误：' + e.message); }
    setTesting(false);
  };

  const save = () => {
    const u = url.trim(), p = pwd.trim();
    if (!u || !p) return;
    localStorage.setItem('whl-cloud-url', u);
    localStorage.setItem('whl-cloud-pwd', p);
    onSave(u, p);
  };

  return (
    <Modal title="☁ 云端同步设置" onClose={onClose} maxW={540}>
      <div style={{background:`${ACC.teal}10`,border:`1px solid ${ACC.teal}33`,borderRadius:10,padding:'12px 14px',marginBottom:18,fontSize:12,color:V('dim'),lineHeight:1.8}}>
        <div style={{color:ACC.teal,fontWeight:700,marginBottom:6}}>部署步骤（5分钟，永久免费）</div>
        <div>1. 登录 <a href="https://dash.cloudflare.com" target="_blank" rel="noopener" style={{color:ACC.amber}}>dash.cloudflare.com</a> → Workers & Pages → Create Worker</div>
        <div>2. 把 <b style={{color:V('ink')}}>worker.js</b> 的代码粘贴进去 → Deploy</div>
        <div>3. Settings → Variables 添加：<b style={{color:V('ink')}}>ACCESS_PASSWORD</b> = 你的密码</div>
        <div>4. Settings → KV Bindings → 新建 KV namespace → 变量名填 <b style={{color:V('ink')}}>KV</b></div>
        <div>5. 把 Worker URL 填到下方 → 保存</div>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:12,marginBottom:14}}>
        <Field label="Worker URL" value={url} onChange={setUrl} placeholder="https://wheel-data.yourname.workers.dev"/>
        <Field label="访问密码" type="password" value={pwd} onChange={setPwd} placeholder="你在 Worker 里设定的密码"/>
      </div>
      {testResult && (
        <div style={{fontSize:12,marginBottom:12,color:testResult.startsWith('✓')?ACC.profit:ACC.loss,fontFamily:'IBM Plex Mono,monospace'}}>
          {testResult}
        </div>
      )}
      <div style={{display:'flex',gap:8}}>
        <button onClick={save} className="btn btn-primary" disabled={!url.trim()||!pwd.trim()}>保存并启用</button>
        <button onClick={testConnection} disabled={testing} className="btn btn-ghost">{testing?'测试中…':'测试连接'}</button>
        <button onClick={onClose} className="btn btn-ghost">取消</button>
      </div>
    </Modal>
  );
}
/* ═══════════════════════════════════════════════════
   股价拉取：走 Vercel 代理（服务端请求 Yahoo，无 CORS 问题）
   路由：/api/quote/:ticker → 服务端返回 {ticker, price}
═══════════════════════════════════════════════════ */
async function fetchStockPrices(tickers){
  const proxyBase=localStorage.getItem('whl-cloud-url')||DEFAULT_CLOUD_URL;
  const uniq=[...new Set(tickers)];
  const results={};
  await Promise.all(uniq.map(async ticker=>{
    try{
      const res=await fetch(`${proxyBase}/api/quote/${encodeURIComponent(ticker)}`,{signal:AbortSignal.timeout(8000)});
      const data=await res.json();
      results[ticker]=data?.price??null;
    }catch{results[ticker]=null;}
  }));
  return results;
}

function cnStockQuoteSymbol(market,ticker){
  const code=String(ticker||'').trim().toUpperCase();
  if(!code)return'';
  if(market==='HK'){
    const digits=code.replace(/\D/g,'');
    return digits?`${String(Number(digits)).padStart(4,'0')}.HK`:'';
  }
  if(/\.(SS|SZ)$/.test(code))return code;
  return `${code}.${/^[569]/.test(code)?'SS':'SZ'}`;
}

async function fetchCnStockQuote(market,ticker){
  const quoteSymbol=cnStockQuoteSymbol(market,ticker);
  if(!quoteSymbol)return{quoteSymbol:'',price:null,name:null};
  const proxyBase=localStorage.getItem('whl-cloud-url')||DEFAULT_CLOUD_URL;
  try{
    const response=await fetch(`${proxyBase}/api/quote/${encodeURIComponent(quoteSymbol)}`,{signal:AbortSignal.timeout(8000)});
    const data=await response.json();
    return{quoteSymbol,price:data?.price??null,name:data?.name||null};
  }catch{return{quoteSymbol,price:null,name:null};}
}

async function fetchStockCloseOnDate(ticker,date){
  const proxyBase=localStorage.getItem('whl-cloud-url')||DEFAULT_CLOUD_URL;
  try{
    const res=await fetch(`${proxyBase}/api/history/${encodeURIComponent(ticker)}?date=${encodeURIComponent(date)}`,{signal:AbortSignal.timeout(10000)});
    if(!res.ok)return null;
    const data=await res.json();
    const price=Number(data?.price);
    if(!Number.isFinite(price))return null;
    return{price,date:data?.date||date,requestedDate:data?.requestedDate||date,source:data?.source||'History'};
  }catch(e){
    console.warn(`history fetch ${ticker} ${date}:`,e.message);
    return null;
  }
}

/* ═══════════════════════════════════════════════════
   OCC 合约代码解析（从 CBOE 返回的 option 字段解析）
   格式：MRVL  260702P00190000（ticker可变长，后跟6位日期+P/C+8位行权价）
═══════════════════════════════════════════════════ */
function buildOCCSymbol(ticker, expDate, type, strike){
  const [y,m,d]=expDate.split('-');
  const yy=y.slice(2);
  const strikePad=String(Math.round(strike*1000)).padStart(8,'0');
  return `${ticker}${yy}${m}${d}${type}${strikePad}`;
}
function parseOCC(occ){
  const m=/(\d{6})([CP])(\d{8})$/.exec(occ||'');
  if(!m)return null;
  const d=m[1];
  return{
    type:m[2]==='P'?'put':'call',
    expiry:`20${d.slice(0,2)}-${d.slice(2,4)}-${d.slice(4,6)}`,
    strike:parseInt(m[3])/1000,
  };
}

/* ═══════════════════════════════════════════════════
   期权现价 - 主源：CBOE CDN 公开延迟行情
   
   URL: https://cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json
   - 完全免 Key，无 CORS 限制（CDN 直接返回）
   - 返回真实 bid/ask/last/delta/gamma/theta/iv/OI
   - 约 15 分钟延迟，数据权威
   - 一次请求拿到该 ticker 所有期权合约，然后按到期日+行权价筛选
═══════════════════════════════════════════════════ */
async function fetchOptionPriceCBOE(ticker, expDate, strike, type){
  try{
    // 优先走 Vercel 代理（解决 CORS 问题），没配置时直连 CBOE
    const proxyBase=localStorage.getItem('whl-cloud-url');
    const url=proxyBase
      ?`${proxyBase}/api/cboe/${encodeURIComponent(ticker)}`
      :`https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(ticker)}.json`;
    const res=await fetch(url,{signal:AbortSignal.timeout(12000)});
    if(!res.ok)return null;
    const data=await res.json();
    const options=data?.data?.options;
    if(!Array.isArray(options)||!options.length)return null;

    const wantType=type==='P'?'put':'call';
    let best=null, bestDiff=Infinity;
    for(const o of options){
      const parsed=parseOCC(o.option);
      if(!parsed||parsed.type!==wantType)continue;
      if(parsed.expiry!==expDate)continue;
      const diff=Math.abs(parsed.strike-strike);
      if(diff<bestDiff){bestDiff=diff;best=o;}
    }
    if(!best)return null;
    const n=v=>{const x=Number(v);return isFinite(x)&&x!==0?x:null;};
    const price=n(best.last_trade_price)||n(best.ask)||null;
    const bid=n(best.bid);
    const ask=n(best.ask);
    if(!price&&!bid&&!ask)return null;
    return{
      price:price||(bid&&ask?(bid+ask)/2:null),
      bid, ask,
      delta:n(best.delta),
      iv:n(best.iv),
      source:'CBOE',
    };
  }catch(e){
    console.warn(`CBOE option fetch ${ticker}:`,e.message);
    return null;
  }
}

async function fetchOptionChainCBOE(ticker, signal){
  const proxyBase=localStorage.getItem('whl-cloud-url')||DEFAULT_CLOUD_URL;
  const res=await fetch(`${proxyBase}/api/cboe/${encodeURIComponent(ticker)}`,{signal});
  if(!res.ok)throw new Error(`CBOE ${ticker} HTTP ${res.status}`);
  const data=await res.json();
  const dd=data?.data||{};
  const options=Array.isArray(dd.options)?dd.options:[];
  if(!options.length)throw new Error(`CBOE ${ticker} empty option chain`);
  const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null;};
  const iv30=n(dd.iv30);
  const hi=n(dd.iv30_one_year_high);
  const lo=n(dd.iv30_one_year_low);
  return{
    options,
    stockPrice:n(dd.current_price)||n(dd.close)||n(dd.prev_day_close),
    stockIV:iv30,
    stockHV:null,
    ivRank:(iv30!=null&&hi!=null&&lo!=null&&hi>lo)?Math.round((iv30-lo)/(hi-lo)*100):null,
  };
}

/* ═══════════════════════════════════════════════════
   期权现价 - 备用源1：Finnhub /quote（OCC合约代码）
═══════════════════════════════════════════════════ */
async function fetchOptionPriceFinnhub(ticker, expDate, strike, type, fhKey){
  if(!fhKey) return null;
  const symbol=buildOCCSymbol(ticker, expDate, type, strike);
  try{
    const url=`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${fhKey}`;
    const res=await fetch(url,{signal:AbortSignal.timeout(8000)});
    const data=await res.json();
    if(data?.error) return null;
    const price=data.c||data.pc||null;
    if(!price) return null;
    return{price, bid:null, ask:null, source:'Finnhub'};
  }catch(e){return null;}
}

/* ═══════════════════════════════════════════════════
   期权现价 - 备用源2：Yahoo chart（OCC合约代码）
═══════════════════════════════════════════════════ */
async function fetchOptionPriceYahooChart(ticker, expDate, strike, type){
  const symbol=buildOCCSymbol(ticker, expDate, type, strike);
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const proxy=`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
  try{
    const res=await fetch(proxy,{signal:AbortSignal.timeout(10000)});
    const outer=await res.json();
    if(!outer?.contents) return null;
    const body=JSON.parse(outer.contents);
    const meta=body?.chart?.result?.[0]?.meta;
    const price=meta?.regularMarketPrice||meta?.previousClose||null;
    if(!price) return null;
    return{price, bid:null, ask:null, source:'Yahoo'};
  }catch(e){return null;}
}

/* ── 三源瀑布：CBOE（主） → Finnhub → Yahoo ── */
async function fetchAllOptionPrices(positions, fhKey){
  const results={};
  await Promise.all(positions.map(async p=>{
    let r=await fetchOptionPriceCBOE(p.ticker,p.expDate,p.strike,p.type);
    if(!r?.price&&fhKey) r=await fetchOptionPriceFinnhub(p.ticker,p.expDate,p.strike,p.type,fhKey);
    if(!r?.price) r=await fetchOptionPriceYahooChart(p.ticker,p.expDate,p.strike,p.type);
    if(r?.price) results[p.id]=r;
  }));
  return results;
}

/* ═══════════════════════════════════════════════════
   数据源 3：Anthropic AI（备备用，需要 AI Key）
═══════════════════════════════════════════════════ */
async function fetchAIPrices(tickers,apiKey){
  const list=[...new Set(tickers)].join(', ');
  const res=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:400,
      tools:[{type:'web_search_20250305',name:'web_search'}],
      messages:[{role:'user',content:`Return ONLY a raw JSON object with current prices for: ${list}. Format: {"TICKER":number}. No markdown.`}]}),
  });
  const data=await res.json();
  if(data.error)throw new Error(data.error.message);
  const text=(data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  const m=text.replace(/```json|```/g,'').trim().match(/\{[\s\S]*\}/);
  return m?JSON.parse(m[0]):{};
}

/* ── 计算核心（活跃仓位）── */
function calc(p,comm=DEFAULT_COMM){
  const qty=p.qty||1;
  const commTotal=comm*qty*2;
  const openPrem=p.premium*100*qty;
  const capital=(p.marginType==='cash'?p.strike*100:(p.customMargin||0))*qty;
  const daysHeld=Math.max(1,daysBetween(p.openDate,today()));
  const daysTotal=Math.max(1,daysBetween(p.openDate,p.expDate));
  const daysLeft=Math.max(0,daysBetween(today(),p.expDate));
  const thetaPct=Math.min(100,Math.max(0,(daysHeld/daysTotal)*100));
  let profitNow=null,annualNow=null,capturedPct=null,yieldNow=null;
  if(p.optionPrice!=null){
    profitNow=openPrem-p.optionPrice*100*qty-commTotal;
    yieldNow=capital?(profitNow/capital)*100:null;
    annualNow=calcAnnual(profitNow,capital,daysHeld);
    capturedPct=(profitNow/(openPrem-commTotal))*100;
  }
  const commExp=comm*qty;
  const profitExp=openPrem-commExp;
  const yieldExp=capital?(profitExp/capital)*100:null;
  const annualExp=calcAnnual(profitExp,capital,daysTotal);
  let buffer=null;
  if(p.currentPrice)buffer=p.type==='P'?((p.currentPrice-p.strike)/p.currentPrice)*100:((p.strike-p.currentPrice)/p.currentPrice)*100;
  return{qty,commTotal,commExp,openPrem,capital,daysHeld,daysTotal,daysLeft,thetaPct,profitNow,yieldNow,annualNow,capturedPct,profitExp,yieldExp,annualExp,buffer};
}

function clamp(n,min,max){return Math.max(min,Math.min(max,n));}
function scoreColor(score){
  return score>=85?ACC.profit:score>=72?ACC.teal:score>=58?ACC.amber:score>=42?'#ff8a4c':ACC.loss;
}
function scoreLabel(score){
  if(score>=85)return'优秀';
  if(score>=72)return'健康';
  if(score>=58)return'观察';
  if(score>=42)return'预警';
  return'危险';
}
function scorePosition(p,r,ctx={}){
  let score=76;
  const notes=[];
  const add=(n,msg)=>{score+=n;if(msg)notes.push({delta:n,msg});};
  const delta=Math.abs(Number(p.optionDelta??p.delta));

  if(r.buffer==null)add(-8,'缺少正股价格，无法判断价外缓冲');
  else if(r.buffer<=0)add(-34,'已进入 ITM，优先处理或 Roll');
  else if(r.buffer<=3)add(-22,'距离行权价小于 3%，接近危险线');
  else if(r.buffer<=8)add(-10,'价外缓冲偏薄');
  else if(r.buffer>=18)add(7,'价外缓冲充足');
  else if(r.buffer>=12)add(4,'价外缓冲较健康');

  if(r.daysLeft<=3)add(-24,'到期 3 天内，Gamma/指派风险高');
  else if(r.daysLeft<=7)add(-17,'到期 7 天内，需要盯盘');
  else if(r.daysLeft<=14)add(-9,'到期两周内，适合准备平仓或 Roll');
  else if(r.daysLeft>=25&&r.daysLeft<=55)add(5,'DTE 位于卖方舒适区');
  else if(r.daysLeft>90)add(-4,'期限过长，资金周转偏慢');

  if(Number.isFinite(delta)){
    if(delta>0.35)add(-18,'Delta 偏高，方向敞口过大');
    else if(delta>0.25)add(-10,'Delta 已偏高');
    else if(delta>=0.08&&delta<=0.18)add(8,'Delta 落在收租甜区');
    else if(delta<0.04)add(1,'Delta 很低，安全但收益可能偏薄');
  }else add(-3,'缺少 Delta，评分保守处理');

  if(r.capturedPct!=null){
    if(r.capturedPct<0)add(-12,'当前回补为亏损');
    else if(r.capturedPct>=80)add(9,'权利金捕获超过 80%');
    else if(r.capturedPct>=50)add(6,'权利金捕获超过 50%');
    else if(r.capturedPct<25&&r.thetaPct>45)add(-5,'持仓过半但权利金捕获不足');
  }

  if(r.annualExp!=null){
    if(r.annualExp<5)add(-6,'持到到期年化偏低');
    else if(r.annualExp>=8&&r.annualExp<=45)add(5,'持到到期年化合理');
    else if(r.annualExp>90)add(-5,'年化异常偏高，通常意味着风险也高');
  }

  const marginRatio=ctx.sgov?.marketValue&&ctx.totalMargin>0?(ctx.totalMargin/ctx.sgov.marketValue)*100:null;
  if(marginRatio!=null){
    if(marginRatio>90)add(-14,'组合保证金/SGOV 超过 90%');
    else if(marginRatio>75)add(-8,'组合保证金/SGOV 偏高');
    else if(marginRatio<=45)add(4,'组合保证金压力较低');
  }

  const finalScore=Math.round(clamp(score,0,100));
  return{
    score:finalScore,
    label:scoreLabel(finalScore),
    color:scoreColor(finalScore),
    notes:notes.sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)).slice(0,4),
    marginRatio,
  };
}

/* ── 计算已平仓收益 ── */
function calcClosed(c,comm=DEFAULT_COMM){
  const qty=c.qty||1;
  const openPrem=c.premium*100*qty;
  const capital=(c.marginType==='cash'?c.strike*100:(c.customMargin||0))*qty;
  const closeType=c.closeType||'manual'; // manual | expired | assigned | roll
  const commUsed=closeType==='expired'?comm*qty:comm*qty*2;
  const closePrem=(c.closePrice||0)*100*qty;
  const profit=openPrem-closePrem-commUsed;
  const daysHeld=Math.max(1,daysBetween(c.openDate,c.closeDate||today()));
  const annual=calcAnnual(profit,capital,daysHeld);
  const yld=capital?(profit/capital)*100:null;
  return{qty,openPrem,closePrem,profit,capital,daysHeld,annual,yld,commUsed};
}

function calcExpiryReview(c,r,expiryPrice,comm=DEFAULT_COMM){
  if(expiryPrice==null)return null;
  const qty=c.qty||1;
  const intrinsicPerShare=c.type==='P'
    ?Math.max(0,c.strike-expiryPrice)
    :Math.max(0,expiryPrice-c.strike);
  const wouldAssign=intrinsicPerShare>0.005;
  const intrinsicValue=intrinsicPerShare*100*qty;
  const expiryComm=comm*qty;
  const expiryMarkProfit=r.openPrem-intrinsicValue-expiryComm;
  const netDiff=expiryMarkProfit-r.profit;
  const lostPremium=Math.max(0,r.closePrem);
  return{wouldAssign,intrinsicPerShare,intrinsicValue,expiryMarkProfit,netDiff,lostPremium};
}

function calcSgov(s){
  if(!s||!s.marketValue||!s.startDate)return null;
  const rate=s.annualRate??4.0;
  const days=Math.max(1,daysBetween(s.startDate,today()));
  const autoInt=s.marketValue*(Math.pow(1+rate/100,days/365)-1);
  const total=autoInt+(s.manualAdj??0);
  return{days,rate,autoInt,total};
}

/* ══ 通用组件 ══════════════════════════════════════ */
function ThetaBar({pct,small}){
  const h=small?3:4;
  const grad=pct>80
    ?'linear-gradient(90deg,#06b6d4,#6366f1,#f46a5a)'
    :pct>50?'linear-gradient(90deg,#06b6d4,#3b82f6,#6366f1)'
    :'linear-gradient(90deg,#06b6d4,#3b82f6)';
  const glow=pct>80?'#f46a5a':pct>50?'#6366f1':'#3b82f6';
  return(
    <div style={{background:'rgba(28,44,58,.5)',borderRadius:2,height:h,overflow:'hidden',width:'100%'}}>
      <div style={{width:pct+'%',height:'100%',borderRadius:2,background:grad,
        boxShadow:'0 0 8px '+glow+'44',transition:'width .6s cubic-bezier(.4,0,.2,1)'}}/>
    </div>
  );
}
function Stat({label,value,sub,color,sz=15,hl}){
  return(
    <div className="stat" style={hl?{borderLeft:`2px solid ${hl}`,paddingLeft:10}:{}}>
      <span className="stat-label">{label}</span>
      <span className="stat-val" style={{fontSize:sz,color:color||V('ink')}}>{value}</span>
      {sub&&<span className="stat-sub">{sub}</span>}
    </div>
  );
}

/* 文本输入 */
function Field({label,hint,value,onChange,placeholder,type='text',prefix,suffix,readOnly,color}){
  const [focused,setFocused]=useState(false);
  const prefixPadding=prefix?18+Array.from(String(prefix)).length*10:12;
  return(
    <div style={{display:'flex',flexDirection:'column',gap:5}}>
      {label&&<div style={{display:'flex',alignItems:'center',gap:5}}>
        <span className="section-label">{label}</span>
        {hint&&<span style={{fontSize:10,color:V('faint'),fontStyle:'italic'}}>{hint}</span>}
      </div>}
      <div style={{position:'relative',display:'flex',alignItems:'center'}}>
        {prefix&&<span style={{position:'absolute',left:12,color:focused?ACC.amber:V('faint'),fontSize:13,fontFamily:'IBM Plex Mono,monospace',pointerEvents:'none',transition:'color .18s',zIndex:1}}>{prefix}</span>}
        <input className="field" type={type} value={value??''} onChange={e=>onChange(e.target.value)}
          placeholder={placeholder} readOnly={readOnly}
          onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
          style={{paddingLeft:prefixPadding,paddingRight:suffix?32:12,color:color||V('ink'),cursor:readOnly?'default':'text',background:readOnly?'transparent':undefined,borderStyle:readOnly?'dashed':undefined}}/>
        {suffix&&<span style={{position:'absolute',right:11,color:V('faint'),fontSize:12,fontFamily:'IBM Plex Mono,monospace',pointerEvents:'none'}}>{suffix}</span>}
      </div>
    </div>
  );
}
function NumField({label,hint,value,onChange,placeholder,prefix,suffix,readOnly,color}){
  // 用 type=text 避免中文输入法吞小数点；内部维护 raw string，只在合法时向上传 number
  const [raw,setRaw]=useState(value!=null?String(value):'');
  // 当外部 value 变化（比如重置）时同步 raw
  React.useEffect(()=>{
    // 只有在不是 "4." / "-0." 等中间态时才同步，避免打断输入
    const ext=value!=null?String(value):'';
    const parsed=parseFloat(raw);
    if(isNaN(parsed)||Math.abs(parsed-(value??NaN))>1e-9)setRaw(ext);
  },[value]);
  const handleChange=v=>{
    setRaw(v);
    if(v===''||v==='-'){onChange('');return;}
    // 接受中间态：末尾是小数点，或小数点后带0
    if(/^-?\d*\.?\d*$/.test(v))onChange(v);
  };
  return<Field label={label} hint={hint} placeholder={placeholder} prefix={prefix} suffix={suffix}
    type="text" inputMode="decimal" readOnly={readOnly} color={color}
    value={raw} onChange={handleChange}/>;
}
/* 日期 — 恢复原生选择器，只美化样式 */
function DateField({label,value,onChange,readOnly}){
  return(
    <div style={{display:'flex',flexDirection:'column',gap:5}}>
      {label&&<span className="section-label">{label}</span>}
      <input className="field" type="date" value={value??''} onChange={e=>onChange(e.target.value)}
        readOnly={readOnly} style={{cursor:readOnly?'default':'pointer',
          colorScheme:document.documentElement.dataset.theme==='light'?'light':'dark'}}/>
    </div>
  );
}
function SelectField({label,value,onChange,options,disabled}){
  return(
    <div style={{display:'flex',flexDirection:'column',gap:5}}>
      {label&&<span className="section-label">{label}</span>}
      <div className="sel-wrap">
        <select className="field" value={value} onChange={e=>onChange(e.target.value)} disabled={disabled} style={{cursor:'pointer'}}>
          {options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    </div>
  );
}
function InlineEdit({value,onSave}){
  const [editing,setEditing]=useState(false);
  const [v,setV]=useState('');
  const confirm=()=>{const n=parseFloat(v);if(!isNaN(n))onSave(n);setEditing(false);};
  if(editing)return(
    <span style={{display:'inline-flex',alignItems:'center',gap:6}}>
      <input value={v} onChange={e=>setV(e.target.value)} type="text" inputMode="decimal" autoFocus
        style={{width:80,background:V('surface'),border:`1.5px solid ${ACC.amber}`,borderRadius:8,padding:'4px 9px',color:ACC.amber,fontSize:13,fontFamily:'IBM Plex Mono,monospace',outline:'none'}}
        onKeyDown={e=>{if(e.key==='Enter')confirm();if(e.key==='Escape')setEditing(false);}}/>
      <button onClick={confirm} className="btn btn-primary" style={{padding:'4px 10px',fontSize:12,borderRadius:7}}>✓</button>
      <button onClick={()=>setEditing(false)} className="btn btn-ghost" style={{padding:'4px 8px',fontSize:12,borderRadius:7}}>✕</button>
    </span>
  );
  return(
    <span onClick={()=>{setV(value??'');setEditing(true);}} title="点击编辑"
      style={{color:value!=null?V('ink'):V('faint'),cursor:'pointer',fontFamily:'IBM Plex Mono,monospace',
        fontSize:13,textDecoration:'underline',textDecorationStyle:'dotted',textUnderlineOffset:3}}>
      {value!=null?`$${fmt(value)}`:'点击录入'}
    </span>
  );
}

/* ══ Modal ════════════════════════════════════════ */
function Modal({title,children,onClose,maxW=460}){
  return(
    <div className="modal-bg" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="modal-box" style={{maxWidth:maxW}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:20}}>
          <span style={{fontSize:16,fontWeight:700,color:ACC.amber}}>{title}</span>
          <button onClick={onClose} className="btn btn-ghost" style={{padding:'4px 10px',borderRadius:8,fontSize:14}}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
function ApiKeyModal({onSave,onClose}){
  const [v,setV]=useState('');
  return<Modal title="Anthropic API Key" onClose={onClose}>
    <p style={{fontSize:12,color:V('dim'),marginBottom:18,lineHeight:1.7}}>用于刷新股价 AI 联网查询，Key 仅存本地浏览器。</p>
    <Field label="API Key" type="password" value={v} onChange={setV} placeholder="sk-ant-api03-..."/>
    <div style={{display:'flex',gap:8,marginTop:16}}>
      <button onClick={()=>{if(v.trim())onSave(v.trim());}} className="btn btn-primary">保存</button>
      <button onClick={onClose} className="btn btn-ghost">跳过</button>
    </div>
  </Modal>;
}
function CommModal({current,onSave,onClose}){
  const [v,setV]=useState(String(current));
  return<Modal title="手续费设置" onClose={onClose} maxW={400}>
    <p style={{fontSize:12,color:V('dim'),marginBottom:18,lineHeight:1.7}}>单边手续费（美元/张）。平仓扣双边，到期归零只扣单边开仓费。</p>
    <NumField label="单边手续费 $ / 张" value={v} onChange={setV} placeholder="0.65" prefix="$"/>
    <div style={{display:'flex',gap:8,marginTop:16}}>
      <button onClick={()=>{const n=parseFloat(v);if(!isNaN(n)&&n>=0)onSave(n);}} className="btn btn-primary">保存</button>
      <button onClick={onClose} className="btn btn-ghost">取消</button>
    </div>
  </Modal>;
}

function FinnhubModal({current,onSave,onClose}){
  const [v,setV]=useState(current||'');
  return(
    <Modal title="Finnhub API Key 设置" onClose={onClose} maxW={520}>
      {/* 说明区 */}
      <div style={{background:V('surface'),border:`1px solid ${ACC.teal}33`,borderRadius:10,padding:'12px 14px',marginBottom:18}}>
        <div style={{fontSize:12,color:ACC.teal,fontWeight:600,marginBottom:6}}>✦ 为什么推荐 Finnhub？</div>
        <div style={{fontSize:12,color:V('dim'),lineHeight:1.8}}>
          • 免费注册，秒拿 Key，无需信用卡<br/>
          • 真实时报价，60次/分钟完全够用<br/>
          • 原生支持 CORS，浏览器直接 fetch，<b style={{color:V('ink')}}>不需要代理</b><br/>
          • 比 Yahoo 稳定得多，不会被随机限速
        </div>
        <a href="https://finnhub.io/register" target="_blank" rel="noopener"
          style={{display:'inline-flex',alignItems:'center',gap:5,marginTop:10,color:ACC.amber,fontSize:12,fontWeight:600,textDecoration:'none'}}>
          → 点这里免费注册 finnhub.io ↗
        </a>
      </div>
      <Field label="Finnhub API Key" type="password" value={v} onChange={setV} placeholder="d1a2b3c4e5f6..."/>
      <div style={{fontSize:11,color:V('faint'),marginTop:6,fontFamily:'IBM Plex Mono,monospace'}}>
        Key 仅存浏览器本地，不上传任何服务器
      </div>
      <div style={{display:'flex',gap:8,marginTop:16}}>
        <button onClick={()=>{if(v.trim())onSave(v.trim());}} className="btn btn-primary">保存</button>
        <button onClick={onClose} className="btn btn-ghost">跳过</button>
      </div>
    </Modal>
  );
}

/* ══ Roll 滚仓弹层 ══════════════════════════════════════ */
function RollModal({pos,commPerSide,onConfirm,onClose}){
  const [buybackPrice,setBuybackPrice]=useState(pos.optionPrice!=null?String(pos.optionPrice):'');
  const [newExpiry,setNewExpiry]=useState('');
  const [newStrike,setNewStrike]=useState(String(pos.strike));
  const [newPremium,setNewPremium]=useState('');
  const [rollDate,setRollDate]=useState(today());
  const qty=pos.qty||1;

  // 计算
  const bbPrice=parseFloat(buybackPrice)||0;
  const bbCost=bbPrice*100*qty;
  const newPrem=parseFloat(newPremium)||0;
  const newIncome=newPrem*100*qty;
  const rollComm=commPerSide*qty*2*2; // 两次交易各双边
  const netCredit=newIncome-bbCost-rollComm;
  const valid=buybackPrice&&newExpiry&&newStrike&&newPremium;

  return(
    <Modal title="↻ Roll 滚仓" onClose={onClose} maxW={600}>
      <div style={{background:V('surface'),borderRadius:10,padding:'10px 14px',marginBottom:16,display:'flex',gap:16,flexWrap:'wrap',alignItems:'center'}}>
        <span style={{fontFamily:'IBM Plex Mono,monospace',fontWeight:700,fontSize:15,color:V('ink')}}>{pos.ticker}</span>
        <span style={{fontFamily:'IBM Plex Mono,monospace',color:ACC.amber}}>{'卖 '+(pos.type==='P'?'Put':'Call')+' $'+fmt(pos.strike,0)}</span>
        <span style={{fontFamily:'IBM Plex Mono,monospace',color:V('dim')}}>{qty+'手 · 到期 '+pos.expDate}</span>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:16}}>
        <div style={{background:V('surface'),border:'1px solid '+V('line'),borderRadius:12,padding:16}}>
          <div style={{fontSize:10,color:ACC.loss,letterSpacing:'.12em',textTransform:'uppercase',fontFamily:'IBM Plex Mono,monospace',marginBottom:12}}>{'① 买回当前合约'}</div>
          <NumField label="买回价格" prefix="$" suffix="/股" value={buybackPrice} onChange={setBuybackPrice} placeholder="4.66"/>
          <div style={{marginTop:10,fontFamily:'IBM Plex Mono,monospace',fontSize:12,color:V('dim')}}>
            {'买回成本: '}<span style={{color:ACC.loss}}>{'$'+fmt(bbCost)}</span>
          </div>
        </div>
        <div style={{background:V('surface'),border:'1px solid '+V('line'),borderRadius:12,padding:16}}>
          <div style={{fontSize:10,color:ACC.profit,letterSpacing:'.12em',textTransform:'uppercase',fontFamily:'IBM Plex Mono,monospace',marginBottom:12}}>{'② 卖出新合约'}</div>
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <DateField label="新到期日" value={newExpiry} onChange={setNewExpiry}/>
            <NumField label="新行权价" prefix="$" value={newStrike} onChange={setNewStrike} placeholder={String(pos.strike)}/>
            <NumField label="新权利金" prefix="$" suffix="/股" value={newPremium} onChange={setNewPremium} placeholder="1.50"/>
          </div>
          <div style={{marginTop:10,fontFamily:'IBM Plex Mono,monospace',fontSize:12,color:V('dim')}}>
            {'新收入: '}<span style={{color:ACC.profit}}>{'$'+fmt(newIncome)}</span>
          </div>
        </div>
      </div>

      <div style={{background:netCredit>=0?ACC.profitBg:ACC.lossBg,border:'1px solid '+(netCredit>=0?ACC.profit:ACC.loss)+'33',borderRadius:12,padding:'16px 20px',marginBottom:16}}>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:16}}>
          <Stat label="Roll 净收入" value={fmtM(netCredit)} color={netCredit>=0?ACC.profit:ACC.loss} sz={22}/>
          <Stat label="手续费 (两次)" value={'-$'+fmt(rollComm)} color={ACC.loss}/>
          <Stat label="Roll 日期" value={rollDate} color={V('dim')}/>
        </div>
        <div style={{marginTop:10,fontFamily:'IBM Plex Mono,monospace',fontSize:11,color:V('dim')}}>
          {'新收入 $'+fmt(newIncome)+' − 买回 $'+fmt(bbCost)+' − 手续费 $'+fmt(rollComm)+' = '+fmtM(netCredit)}
        </div>
      </div>

      <div style={{display:'flex',gap:8}}>
        <button disabled={!valid} onClick={()=>onConfirm({
          buybackPrice:bbPrice,rollDate,
          newExpiry,newStrike:parseFloat(newStrike),newPremium:newPrem,
          netCredit,rollComm,
        })} className="btn btn-primary" style={{minWidth:120}}>{'确认 Roll'}</button>
        <button onClick={onClose} className="btn btn-ghost">{'取消'}</button>
      </div>
    </Modal>
  );
}

/* ══ 平仓弹层 ══════════════════════════════════════ */
function CloseModal({pos,commPerSide,onConfirm,onClose}){
  const [closePrice,setClosePrice]=useState('');
  const [closeDate,setCloseDate]=useState(today());
  const [closeType,setCloseType]=useState('manual'); // manual | expired | assigned
  const qty=pos.qty||1;
  const openPrem=pos.premium*100*qty;
  const capital=(pos.marginType==='cash'?pos.strike*100:(pos.customMargin||0))*qty;
  const shares=qty*100; // 期权行权 1手 = 100股

  // 不同平仓方式的手续费和收益
  const commUsed=closeType==='expired'?commPerSide*qty
    :closeType==='assigned'?commPerSide*qty   // 接货只扣单边（到期行权）
    :commPerSide*qty*2;
  const closePrem=closeType==='expired'||closeType==='assigned'
    ?0:(parseFloat(closePrice)||0)*100*qty;
  const profit=openPrem-closePrem-commUsed;
  const daysHeld=Math.max(1,daysBetween(pos.openDate,closeDate||today()));
  const annual=calcAnnual(profit,capital,daysHeld);

  // 接货场景：股票成本 = 行权价 - 已收权利金/股（权利金摊到每股）
  const premPerShare=pos.premium-(commPerSide/100); // 每股净权利金
  const effectiveCost=pos.strike-premPerShare;      // 实际每股成本
  const assignedMarketValue=pos.strike*shares;      // 接货占用资金（从SGOV扣）

  const valid=closeType==='expired'||closeType==='assigned'
    ||(closePrice!==''&&!isNaN(parseFloat(closePrice)));

  const typeOptions=[
    {value:'manual',label:'主动平仓（买回期权）'},
    {value:'expired',label:'到期归零（价外失效）'},
    {value:'assigned',label:'被行权接货（买入股票）'},
  ];

  return(
    <Modal title="确认平仓" onClose={onClose} maxW={540}>
      {/* 仓位信息 */}
      <div style={{background:V('surface'),borderRadius:10,padding:'10px 14px',marginBottom:16,display:'flex',gap:16,flexWrap:'wrap',alignItems:'center'}}>
        <span style={{fontFamily:'IBM Plex Mono,monospace',fontWeight:700,fontSize:15,color:V('ink')}}>{pos.ticker}</span>
        <span style={{fontFamily:'IBM Plex Mono,monospace',color:ACC.amber}}>卖 {pos.type==='P'?'Put':'Call'} ${fmt(pos.strike,0)}</span>
        <span style={{fontFamily:'IBM Plex Mono,monospace',color:V('dim')}}>{qty}手 · 开仓 {pos.openDate}</span>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1.4fr 1fr',gap:12,marginBottom:14}}>
        <SelectField label="平仓方式" value={closeType} onChange={setCloseType} options={typeOptions}/>
        <DateField label="平仓 / 行权日期" value={closeDate} onChange={setCloseDate}/>
      </div>

      {closeType==='manual'&&(
        <div style={{marginBottom:14}}>
          <NumField label="买回价格（期权现价）" prefix="$" suffix="/股" value={closePrice} onChange={setClosePrice} placeholder="0.50"/>
        </div>
      )}

      {/* 接货专属信息框 */}
      {closeType==='assigned'&&(
        <div style={{background:`${ACC.amber}0f`,border:`1px solid ${ACC.amber}33`,borderRadius:10,padding:'14px 16px',marginBottom:14}}>
          <div style={{fontSize:10,color:ACC.amber,letterSpacing:'.12em',textTransform:'uppercase',fontFamily:'IBM Plex Mono,monospace',marginBottom:12}}>📦 接货详情</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14}}>
            <Stat label="接货股数" value={`${shares} 股`} color={V('ink')} sub={`${qty}手 × 100`}/>
            <Stat label="行权价（买入价）" value={`$${fmt(pos.strike,0)}`} color={ACC.amber}/>
            <Stat label="实际每股成本" value={`$${fmt(effectiveCost,2)}`} color={ACC.profit} sub="行权价 − 净权利金"/>
          </div>
          <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${ACC.amber}22`,display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
            <Stat label="接货占用资金" value={`$${fmt(assignedMarketValue,0)}`} color={ACC.loss} sub="将从 SGOV 扣减"/>
            <Stat label="期权收益（已锁定）" value={fmtM(profit)} color={ACC.profit} sub="权利金 − 手续费"/>
          </div>
        </div>
      )}

      {/* 盈亏预览（非接货） */}
      {closeType!=='assigned'&&(
        <div style={{background:V('surface'),border:`1px solid ${V('line')}`,borderRadius:10,padding:'14px 16px',marginBottom:16}}>
          <div style={{fontSize:10,color:V('faint'),letterSpacing:'.12em',textTransform:'uppercase',fontFamily:'IBM Plex Mono,monospace',marginBottom:12}}>平仓预览</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14}}>
            <Stat label="开仓收入" value={`$${fmt(openPrem)}`} color={ACC.amber}/>
            <Stat label={closeType==='expired'?'到期归零':'买回成本'} value={closeType==='expired'?'$0.00':`-$${fmt(closePrem)}`} color={closeType==='expired'?ACC.profit:ACC.loss}/>
            <Stat label="手续费" value={`-$${fmt(commUsed)}`} color={ACC.loss}/>
          </div>
          <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${V('line')}`,display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
            <Stat label="净利润" value={fmtM(profit)} color={profit>=0?ACC.profit:ACC.loss} sz={18}/>
            <Stat label="年化收益率" value={fmtA(annual)} sub={`持有 ${daysHeld} 天`} color={profit>=0?ACC.profit:ACC.loss} sz={18}/>
          </div>
        </div>
      )}

      <div style={{display:'flex',gap:8}}>
        <button disabled={!valid} onClick={()=>onConfirm({
          closePrice:closeType==='assigned'||closeType==='expired'?0:parseFloat(closePrice),
          closeDate,closeType,
          // 接货额外信息
          ...(closeType==='assigned'?{
            assignedShares:shares,
            assignedCostPerShare:effectiveCost,
            assignedMarketValue,
            assignedTicker:pos.ticker,
          }:{}),
        })} className="btn btn-primary" style={{minWidth:100}}>
          {closeType==='assigned'?'确认接货':'确认平仓'}
        </button>
        <button onClick={onClose} className="btn btn-ghost">取消</button>
      </div>
    </Modal>
  );
}

/* ══ 观察列表 ══════════════════════════════════════ */
const DEFAULT_WATCHLIST = ['IBIT','SMH','MRVL','MU','IAU','QQQ','SOFI','VOO','QQQM','GLD'];
const WL_KEY = 'whl-watchlist';

function getWatchlist(){
  try{
    const s=localStorage.getItem(WL_KEY);
    return s?JSON.parse(s):DEFAULT_WATCHLIST;
  }catch{return DEFAULT_WATCHLIST;}
}
function saveWatchlist(list){
  try{localStorage.setItem(WL_KEY,JSON.stringify(list));}catch{}
}

function WatchlistPanel(){
  const [tickers,setTickers]=useState(()=>getWatchlist());
  const [newTicker,setNewTicker]=useState('');
  const [stockData,setStockData]=useState({});
  const [loading,setLoading]=useState(false);
  const proxyBase=localStorage.getItem('whl-cloud-url')||DEFAULT_CLOUD_URL;

  // ── 富途 API 管理观察列表 ──
  const fetchWatchlist=async()=>{
    try{
      const res=await futuFetch('/api/futu/watchlist',{signal:AbortSignal.timeout(8000)});
      const d=await res.json();
      if(d.status==='success'&&Array.isArray(d.data)){
        setTickers(d.data);
      }
    }catch(e){console.warn('fetchWatchlist:',e.message);}
  };

  const addTicker=async()=>{
    let t=newTicker.trim().toUpperCase();
    if(!t)return;
    if(!t.startsWith('US.')&&!t.startsWith('HK.'))t='US.'+t;
    if(tickers.includes(t))return;
    try{
      await futuFetch('/api/futu/watchlist/add',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({code:t}),signal:AbortSignal.timeout(8000)
      });
      setNewTicker('');
      await fetchWatchlist();
    }catch(e){console.warn('addTicker:',e.message);}
  };

  const removeTicker=async(t)=>{
    try{
      await futuFetch('/api/futu/watchlist/delete',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({code:t}),signal:AbortSignal.timeout(8000)
      });
      await fetchWatchlist();
    }catch(e){console.warn('removeTicker:',e.message);}
  };

  const refreshAll=async()=>{
    setLoading(true);
    let currentList=[];
    try{
      const wlRes=await futuFetch('/api/futu/watchlist',{signal:AbortSignal.timeout(8000)});
      const wlData=await wlRes.json();
      currentList=wlData.data||[];
      setTickers(currentList);
    }catch{currentList=tickers;}
    currentList=currentList.map(c=>(c.startsWith('US.')||c.startsWith('HK.'))?c:'US.'+c);
    const results={};
    const today=new Date();

    for(const code of currentList){
      const display=code.replace(/^US\./,'').replace(/^HK\./,'');
      try{
        // ── 1. 富途：股价 ──
        const sumRes=await futuFetch('/api/futu/stock-option-summary?code='+encodeURIComponent(code),{signal:AbortSignal.timeout(10000)});
        const sumData=await sumRes.json();
        const price=(sumData.status==='success'&&sumData.data)?sumData.data.stock_price||sumData.data.last_price:null;
        results[code]={price:price};

        // ── 2. CBOE：IV30 / IV Rank ──
        try{
          const cboeRes=await fetch(proxyBase+'/api/cboe/'+display,{signal:AbortSignal.timeout(10000)});
          if(cboeRes.ok){
            const cboe=await cboeRes.json();
            const dd=cboe&&cboe.data;
            if(dd){
              const iv30=dd.iv30?Number(dd.iv30):null;
              const hi=dd.iv30_one_year_high?Number(dd.iv30_one_year_high):null;
              const lo=dd.iv30_one_year_low?Number(dd.iv30_one_year_low):null;
              const ivRank=(iv30!=null&&hi!=null&&lo!=null&&hi>lo)?Math.round((iv30-lo)/(hi-lo)*100):null;
              Object.assign(results[code],{iv30:iv30,ivRank:ivRank});
            }
          }
        }catch{}

        // ── 3. 富途：最优 Put 合约（25-50 DTE）──
        const daysRes=await futuFetch('/api/futu/option-days?code='+encodeURIComponent(code),{signal:AbortSignal.timeout(8000)});
        const daysData=await daysRes.json();
        if(daysData.status==='success'&&Array.isArray(daysData.data)){
          let bestDate=null;let bestDte=999;
          for(const dd of daysData.data){
            const exp=new Date(dd.strike_time);
            const dte=Math.round((exp-today)/86400000);
            if(dte>=25&&dte<=50&&dte<bestDte){bestDte=dte;bestDate=dd.strike_time.split(' ')[0];}
          }
          if(bestDate){
            results[code].bestExpiry=bestDate;
            results[code].bestDte=bestDte;
            const chainRes=await futuFetch('/api/futu/option-chain?code='+encodeURIComponent(code)+'&date='+bestDate+'&option_type=PUT',{signal:AbortSignal.timeout(12000)});
            const chainData=await chainRes.json();
            if(chainData.status==='success'&&Array.isArray(chainData.data)&&chainData.data.length){
              // 有 delta 时用 delta 筛，没有时用行权价距离
              let bestOpt=null;
              const hasDelta=chainData.data.some(o=>o.delta!=null&&Math.abs(o.delta)>0.01);
              if(hasDelta){
                for(const opt of chainData.data){
                  const d2=Math.abs(opt.delta||0);
                  if(d2<0.06||d2>0.18||!opt.mid_price||opt.mid_price<=0)continue;
                  if(!bestOpt||(opt.seller_annual_return||0)>(bestOpt.seller_annual_return||0))bestOpt=opt;
                }
              }
              if(!bestOpt&&price){
                let bestAR=0;
                for(const opt of chainData.data){
                  if(!opt.mid_price||opt.mid_price<=0)continue;
                  const strike=opt.strike_price||0;
                  const otm=(price-strike)/price;
                  if(otm<0.05||otm>0.25)continue;
                  if((opt.seller_annual_return||0)>bestAR){bestAR=opt.seller_annual_return;bestOpt=opt;}
                }
              }
              if(!bestOpt){
                let bestAR=0;
                for(const opt of chainData.data){
                  if(!opt.mid_price||opt.mid_price<=0)continue;
                  if((opt.seller_annual_return||0)>bestAR){bestAR=opt.seller_annual_return;bestOpt=opt;}
                }
              }
              if(bestOpt){
                Object.assign(results[code],{
                  bestStrike:bestOpt.strike_price,bestMid:bestOpt.mid_price,
                  bestBid:bestOpt.bid_price,bestAsk:bestOpt.ask_price,
                  bestDelta:bestOpt.delta,bestAnnual:bestOpt.seller_annual_return,
                  bestIV:bestOpt.implied_volatility,bestProb:bestOpt.profit_probability,
                });
              }
            }
          }
        }
      }catch(e){console.warn('refresh '+code+':',e.message);}
    }
    setStockData(results);setLoading(false);
  };


  useEffect(()=>{if(tickers.length)refreshAll();},[]);

  const fmt2=(v,d)=>v==null?'--':Number(v).toFixed(d==null?2:d);
  const cellStyle={padding:'10px 12px',fontFamily:'IBM Plex Mono,monospace',fontSize:13};

  return(
    <div>
      <div style={{marginBottom:16,display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:10}}>
        <div>
          <div style={{fontSize:17,fontWeight:700,color:V('ink')}}>{'观察列表'}</div>
          <div style={{fontSize:12,color:V('faint'),marginTop:2}}>{'管理标的池，筛选器将从此列表扫描'}</div>
        </div>
        <button onClick={refreshAll} disabled={loading} className="btn" style={{background:loading?V('line'):ACC.blueBg,color:loading?V('faint'):ACC.blue,border:'1.5px solid '+(loading?V('line'):ACC.blue+'44'),fontWeight:500,padding:'8px 16px'}}>
          {loading?'拉取中...':'↻ 刷新行情'}
        </button>
      </div>

      <div className="card" style={{padding:'14px 18px',marginBottom:16,display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
        <input type="text" value={newTicker} onChange={e=>setNewTicker(e.target.value.toUpperCase())}
          onKeyDown={e=>{if(e.key==='Enter')addTicker();}}
          placeholder="输入标的代码，如 AAPL"
          style={{flex:1,minWidth:140,padding:'8px 12px',background:V('surface'),border:'1px solid '+V('line'),borderRadius:8,color:V('ink'),fontSize:14,fontFamily:'IBM Plex Mono,monospace'}}/>
        <button onClick={addTicker} className="btn" style={{background:ACC.amberSoft,color:ACC.amber,border:'1.5px solid '+ACC.amber+'44',fontWeight:600,padding:'8px 16px'}}>
          {'+ 添加'}
        </button>
      </div>

      {tickers.length>0&&(
        <div className="watch-table" style={{overflowX:'auto'}}>
          <div className="watch-header" style={{display:'grid',gridTemplateColumns:'1.1fr 0.8fr 0.7fr 0.6fr 0.9fr 0.7fr 0.9fr 0.7fr 0.7fr 0.3fr',gap:0,padding:'0 0 8px',marginBottom:4}}>
            {['标的','股价','IV30','IVR','到期/DTE','行权价','Bid/Ask','中间价','年化',''].map(h=>(
              <div key={h} style={{fontSize:10,color:V('faint'),letterSpacing:'.1em',textTransform:'uppercase',fontFamily:'IBM Plex Mono,monospace',padding:'0 10px'}}>{h}</div>
            ))}
          </div>

          {tickers.map(t=>{
            const d=stockData[t]||{};
            const display=t.replace(/^US\./,'').replace(/^HK\./,'');
            const rankVal=d.ivRank!=null?d.ivRank:null;
            const rankColor=rankVal==null?V('faint'):(rankVal>=70?ACC.profit:(rankVal>=40?ACC.amber:V('dim')));
            return(
              <div key={t} className="card watch-row" style={{display:'grid',gridTemplateColumns:'1.1fr 0.8fr 0.7fr 0.6fr 0.9fr 0.7fr 0.9fr 0.7fr 0.7fr 0.3fr',gap:0,marginBottom:6,borderLeft:'3px solid '+rankColor}}>
                <div style={Object.assign({},cellStyle,{display:'flex',alignItems:'center',gap:10})}>
                  <span style={{fontWeight:700,fontSize:15,color:V('ink')}}>{display}</span>
                </div>
                <div style={cellStyle}>
                  <span style={{color:d.price?V('ink'):V('faint'),fontWeight:600}}>{d.price?('$'+fmt2(d.price)):'--'}</span>
                </div>
                <div style={cellStyle}>
                  <span style={{color:V('dim')}}>{d.iv30!=null?(d.iv30.toFixed(1)+'%'):'--'}</span>
                </div>
                <div style={Object.assign({},cellStyle,{display:'flex',alignItems:'center',gap:5})}>
                  <span style={{color:rankColor,fontWeight:600,fontSize:13}}>{rankVal!=null?rankVal:'--'}</span>
                  {rankVal!=null&&(
                    <div style={{height:4,borderRadius:2,background:V('line'),width:22,flexShrink:0}}>
                      <div style={{height:4,borderRadius:2,width:(Math.min(rankVal,100)+'%'),background:rankColor}}/>
                    </div>
                  )}
                </div>
                <div style={cellStyle}>
                  {d.bestExpiry?<span style={{color:V('dim'),fontSize:11}}>{d.bestExpiry.slice(5)+' ('+d.bestDte+'天)'}</span>:<span style={{color:V('faint')}}>{'--'}</span>}
                </div>
                <div style={cellStyle}>
                  <span style={{color:d.bestStrike?ACC.amber:V('faint'),fontWeight:600}}>{d.bestStrike?('$'+fmt2(d.bestStrike,0)):'--'}</span>
                </div>
                <div style={cellStyle}>
                  {d.bestBid!=null?(
                    <span style={{color:V('dim'),fontSize:12}}>{fmt2(d.bestBid)+' / '+fmt2(d.bestAsk)}</span>
                  ):<span style={{color:V('faint')}}>{'--'}</span>}
                </div>
                <div style={cellStyle}>
                  <span style={{color:d.bestMid?V('ink'):V('faint'),fontWeight:600}}>{d.bestMid?('$'+fmt2(d.bestMid,2)):'--'}</span>
                </div>
                <div style={cellStyle}>
                  {d.bestAnnual!=null?(
                    <span style={{color:d.bestAnnual>=15?ACC.profit:(d.bestAnnual>=8?ACC.amber:V('dim')),fontWeight:700}}>{'+'+fmt2(d.bestAnnual,1)+'%'}</span>
                  ):<span style={{color:V('faint')}}>{'--'}</span>}
                </div>
                <div style={Object.assign({},cellStyle,{display:'flex',alignItems:'center',justifyContent:'center'})}>
                  <button onClick={()=>removeTicker(t)} style={{background:'none',border:'none',color:ACC.loss,cursor:'pointer',fontSize:11,padding:'2px 6px',opacity:.6}}>{'\u2715'}</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!tickers.length&&(
        <div style={{textAlign:'center',padding:'40px 20px',color:V('faint'),border:'1.5px dashed '+V('line'),borderRadius:16}}>
          <div style={{fontSize:15,marginBottom:6,color:V('dim')}}>{'观察列表为空'}</div>
          <div style={{fontSize:12}}>{'在上方输入标的代码添加'}</div>
        </div>
      )}
    </div>
  );
}

/* ══ A 股期权数据查询 ══════════════════════════════════ */
const CN_OPTION_TARGETS=[
  {symbol:'510500',name:'南方中证500ETF',exchange:'上交所',accent:ACC.blue},
  {symbol:'159922',name:'嘉实中证500ETF',exchange:'深交所',accent:ACC.teal},
];
const CN_OPTION_NEXT_MONTH=(()=>{
  const next=new Date(new Date().getFullYear(),new Date().getMonth()+1,1);
  return `${next.getFullYear()}${String(next.getMonth()+1).padStart(2,'0')}`;
})();

function cnMonthLabel(month){
  if(!month||month.length!==6)return month||'—';
  return `${Number(month.slice(4))}月 · ${month.slice(0,4)}`;
}

function CnOptionsPanel({embedded=false}){
  const [symbol,setSymbol]=useState('159922');
  const [data,setData]=useState(null);
  const [indexQuote,setIndexQuote]=useState(()=>readCsi500Cache());
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const [typeFilter,setTypeFilter]=useState('P');
  const [query,setQuery]=useState('');
  const [lastLoaded,setLastLoaded]=useState(null);
  const cacheRef=React.useRef(new Map());

  const refreshIndex=useCallback(async(force=false)=>{
    const payload=await loadCsi500Index(force);
    if(payload?.price>0)setIndexQuote(payload);
  },[]);

  const load=useCallback(async(nextSymbol,nextMonth='',force=false)=>{
    const key=`${nextSymbol}-${nextMonth||'near'}`;
    const storageKey=`whl-cnopt-cache-${key}`;
    if(!force&&cacheRef.current.has(key)){
      setData(cacheRef.current.get(key));setError('');return;
    }
    setLoading(true);setError('');
    try{
      let payload=null,lastError=null;
      for(let attempt=0;attempt<2;attempt+=1){
        try{
          const response=await cnOptionFetch(nextSymbol,nextMonth);
          const raw=await response.text();
          let parsed;
          try{parsed=JSON.parse(raw);}catch{throw new Error('行情接口返回格式异常');}
          if(!response.ok)throw new Error(parsed.detail||parsed.error||`HTTP ${response.status}`);
          payload=parsed;break;
        }catch(fetchError){
          lastError=fetchError;
          if(attempt===0)await new Promise(resolve=>setTimeout(resolve,450));
        }
      }
      if(!payload)throw lastError||new Error('行情拉取失败');
      cacheRef.current.set(key,payload);
      cacheRef.current.set(`${nextSymbol}-${payload.selectedMonth}`,payload);
      try{localStorage.setItem(storageKey,JSON.stringify({savedAt:Date.now(),payload}));}catch{}
      setData(payload);setLastLoaded(new Date());
    }catch(e){
      let saved=null;
      try{saved=JSON.parse(localStorage.getItem(storageKey)||'null');}catch{}
      if(saved?.payload&&Date.now()-(saved.savedAt||0)<7*24*60*60*1000){
        const isSzseClose=saved.payload?.exchange==='SZSE'||saved.payload?.source==='szse-official-close';
        const quoteDate=saved.payload?.quoteTime||'最近官方收盘日';
        const fallback={...saved.payload,clientStale:true,staleReason:isSzseClose?'official-close-lag':'client-cache',
          warning:isSzseClose
            ?`深交所官方收盘数据最新可用日为 ${quoteDate}；今日收盘数据未发布前，暂展示本设备保存的该日官方数据。`
            :'行情源暂时不稳定，正在展示本设备最近一次成功快照。'};
        cacheRef.current.set(key,fallback);setData(fallback);setError('');setLastLoaded(new Date(saved.savedAt));
      }else{
        const message=/fetch failed|network|timeout|timed out|aborted/i.test(e.message||'')
          ?'行情源连接超时，系统已自动重试，请稍后再刷新'
          :(e.message||'行情拉取失败');
        setError(message);
      }
    }
    finally{setLoading(false);}
  },[]);

  useEffect(()=>{load(symbol,CN_OPTION_NEXT_MONTH);},[symbol,load]);
  useEffect(()=>{refreshIndex();},[refreshIndex]);

  const contracts=(data?.contracts||[]).filter(contract=>{
    if(typeFilter!=='ALL'&&contract.type!==typeFilter)return false;
    if(!query.trim())return true;
    const q=query.trim().toLowerCase();
    return String(contract.strike).includes(q)||String(contract.code).includes(q)||(contract.name||'').toLowerCase().includes(q);
  }).sort((a,b)=>a.strike-b.strike||(a.type==='C'?-1:1));
  const selectedTarget=CN_OPTION_TARGETS.find(item=>item.symbol===symbol)||CN_OPTION_TARGETS[0];
  const totalVolume=contracts.reduce((sum,item)=>sum+(item.volume||0),0);
  const indexPrice=indexQuote?.price??data?.indexPrice??null;
  const indexQuoteTime=indexQuote?.quoteTime??data?.indexQuoteTime??null;
  const dataNotice=data?.warning||(!data?.stale&&data?.notice)||'';
  const isOfficialCloseNotice=data?.staleReason==='official-close-lag'||(!data?.warning&&data?.exchange==='SZSE'&&data?.notice);
  const noticeKind=isOfficialCloseNotice?'info':'warning';
  const atmStrike=data?.underlyingPrice&&data?.contracts?.length
    ? data.contracts.reduce((best,item)=>Math.abs(item.strike-data.underlyingPrice)<Math.abs(best-data.underlyingPrice)?item.strike:best,data.contracts[0].strike)
    : null;

  return(
    <section className="cnopt-panel">
      {!embedded&&<div className="cnopt-hero">
        <div>
          <div className="cnopt-kicker">CN OPTIONS · LIVE QUERY</div>
          <h2>A股期权数据台</h2>
          <p>中证500 ETF 近月合约 · 实时盘口、成交持仓、IV 与 Delta 一屏查询</p>
        </div>
        <button className="btn cnopt-refresh" onClick={()=>{load(symbol,data?.selectedMonth||'',true);refreshIndex(true);}} disabled={loading}>
          {loading?'同步中…':'↻ 刷新数据'}
        </button>
      </div>}

      <div className="cnopt-targets">
        {CN_OPTION_TARGETS.map(item=>(
          <button key={item.symbol} className={`cnopt-target${symbol===item.symbol?' active':''}`}
            style={{'--target-accent':item.accent}} onClick={()=>{setSymbol(item.symbol);setTypeFilter('P');setQuery('');}}>
            <span className="cnopt-exchange">{item.exchange}</span>
            <strong>{item.symbol}</strong>
            <span>{item.name}</span>
            <i>{symbol===item.symbol?(loading?'正在查询':'当前标的'):'切换标的'} →</i>
          </button>
        ))}
      </div>

      {error&&(
        <div className="cnopt-error">
          <span>行情暂时没有返回</span><strong>{error}</strong>
          <button onClick={()=>load(symbol,data?.selectedMonth||'',true)}>重试</button>
        </div>
      )}

      {!error&&data&&(
        <>
          {dataNotice&&<div className={`cnopt-stale ${noticeKind}`}>{noticeKind==='info'?'i':'⚠'} {dataNotice}</div>}
          <div className="cnopt-snapshot">
            <div><span>标的现价</span><strong>¥ {fmt(data.underlyingPrice,3)}</strong><small>{selectedTarget.exchange} · {symbol}</small></div>
            <div className="cnopt-index"><span>中证500指数</span><strong>{indexPrice==null?'—':fmt(indexPrice,2)}</strong><small>{indexQuoteTime||(indexPrice?'本机最近快照':'独立同步中，不阻塞期权链')}</small></div>
            <div><span>合约月份</span><strong>{cnMonthLabel(data.selectedMonth)}</strong><small>{data.contracts?.[0]?.expiry||'—'} 到期</small></div>
            <div><span>合约数量</span><strong>{data.contracts?.length||0}</strong><small>Call + Put</small></div>
            <div><span>当前筛选成交量</span><strong>{fmt(totalVolume,0)}</strong><small>{contracts.length} 条结果</small></div>
            <div className="cnopt-source"><span>行情 / Greeks</span><strong>交易所官方</strong><small>{data.exchange==='SZSE'?'官方收盘价 · BS 反推':'官方实时价 · BS 反推'}</small></div>
          </div>

          <div className="cnopt-toolbar">
            <div className="cnopt-months">
              {(data.months||[]).map(month=>(
                <button key={month} className={data.selectedMonth===month?'active':''}
                  onClick={()=>load(symbol,month)} disabled={loading}>{cnMonthLabel(month)}</button>
              ))}
            </div>
            <div className="cnopt-filters">
              <div className="cnopt-segmented">
                {[['ALL','全部'],['C','Call'],['P','Put']].map(([value,label])=><button key={value} className={typeFilter===value?'active':''} onClick={()=>setTypeFilter(value)}>{label}</button>)}
              </div>
              <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="行权价 / 合约代码"/>
            </div>
          </div>

          <div className="cnopt-note"><span>i</span>{data.greekNote}<b> 指数等效 = 行权价 ÷ ETF 现价 × 中证500现点，受跟踪误差与分红影响，仅作近似参考。</b></div>

          <div className={`cnopt-chain${loading?' loading':''}`}>
            <div className="cnopt-chain-head">
              {['方向','ETF行权价','指数等效','最新','Bid / Ask','涨跌','成交量','持仓量','IV','Delta','到期','合约'].map(label=><span key={label}>{label}</span>)}
            </div>
            {contracts.map(contract=>{
              const isAtm=atmStrike!=null&&contract.strike===atmStrike;
              return(
                <div className={`cnopt-row ${contract.type==='C'?'call':'put'}${isAtm?' atm':''}`} key={contract.code}>
                  <div className="cnopt-contract-type"><strong>{contract.type==='C'?'CALL':'PUT'}</strong><small>{contract.contractStyle==='A'?'调整合约':'标准合约'}</small></div>
                  <div data-label="ETF行权价"><strong>¥ {fmt(contract.strike,3)}</strong>{isAtm&&<em>ATM</em>}</div>
                  <div data-label="指数等效"><strong>{data.underlyingPrice&&indexPrice?fmt(contract.strike/data.underlyingPrice*indexPrice,0):fmt(contract.indexStrike,0)}</strong></div>
                  <div data-label="最新"><strong>{fmt(contract.last,4)}</strong></div>
                  <div data-label="Bid / Ask"><span>{fmt(contract.bid,4)}</span><i>/</i><span>{fmt(contract.ask,4)}</span></div>
                  <div data-label="涨跌" className={(contract.changePct||0)>=0?'pos':'neg'}>{contract.changePct==null?'—':`${contract.changePct>=0?'+':''}${fmt(contract.changePct,2)}%`}</div>
                  <div data-label="成交量">{fmt(contract.volume,0)}</div>
                  <div data-label="持仓量">{fmt(contract.openInterest,0)}</div>
                  <div data-label="IV"><strong>{contract.iv==null?'—':`${fmt(contract.iv*100,2)}%`}</strong></div>
                  <div data-label="Delta"><strong>{contract.delta==null?'—':fmt(contract.delta,4)}</strong></div>
                  <div data-label="到期"><span>{contract.expiry?.slice(5)||'—'}</span><small>{contract.dte==null?'':`${contract.dte} DTE`}</small></div>
                  <div data-label="合约"><code>{contract.code}</code></div>
                </div>
              );
            })}
            {!contracts.length&&!loading&&<div className="cnopt-empty">没有匹配的合约，请调整筛选条件。</div>}
          </div>
          <div className="cnopt-foot">最后刷新：{lastLoaded?lastLoaded.toLocaleTimeString('zh-CN'):'—'} · 服务端缓存 60 秒</div>
        </>
      )}

      {!data&&!error&&<div className="cnopt-loading"><span/><strong>正在建立期权行情连接</strong><small>同步合约列表、盘口与波动率数据…</small></div>}
    </section>
  );
}

/* ══ 期权筛选器 ══════════════════════════════════════ */
// 从观察列表动态读取标的池
function getScanWatchlist(){
  return getWatchlist().map(t=>({ticker:t,name:t,sector:''}));
}

function parseOCCCode(code){
  const mm=/^([A-Z]+)(\d{6})([CP])(\d{8})$/.exec(code||'');
  if(!mm)return null;
  const d=mm[2];
  return{
    ticker:mm[1],
    expiry:'20'+d.slice(0,2)+'-'+d.slice(2,4)+'-'+d.slice(4,6),
    type:mm[3]==='P'?'put':'call',
    strike:parseInt(mm[4])/1000,
  };
}

function ScanPanel(){
  const [results,setResults]=useState([]);
  const [loading,setLoading]=useState(false);
  const [progress,setProgress]=useState('');
  const [error,setError]=useState('');
  const [sortKey,setSortKey]=useState('annualPct');
  const [filterSector,setFilterSector]=useState('全部');
  const [minDte,setMinDte]=useState('25');
  const [maxDte,setMaxDte]=useState('50');
  const [minDelta,setMinDelta]=useState('0.06');
  const [maxDelta,setMaxDelta]=useState('0.18');
  const [minAnnual,setMinAnnual]=useState('5');

  const scan=async()=>{
    setLoading(true);setResults([]);setError('');
    const today=new Date();
    const found=[];
    const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null;};
    const toPct=v=>{
      const x=n(v);
      if(x==null)return null;
      return Math.abs(x)<=3?x*100:x;
    };
    // 优先从富途获取观察列表；失败时用本地观察列表，行情扫描走 CBOE 公开延迟数据
    let watchlist=[];
    try{
      const wlRes=await futuFetch('/api/futu/watchlist',{signal:AbortSignal.timeout(8000)});
      const wlData=await wlRes.json();
      watchlist=wlData.data||[];
    }catch{watchlist=getWatchlist();}
    // 确保所有 code 带市场前缀
    watchlist=watchlist.map(c=>(c.startsWith('US.')||c.startsWith('HK.'))?c:'US.'+c);
    if(!watchlist.length){setError('观察列表为空，请先在观察列表 Tab 添加标的');setLoading(false);return;}

    for(const code of watchlist){
      const display=code.replace(/^US\./,'').replace(/^HK\./,'');
      setProgress('扫描 '+display+' CBOE…');
      try{
        const chain=await fetchOptionChainCBOE(display,AbortSignal.timeout(12000));
        console.log(display+' CBOE Put/Call 数量:',chain.options.length);

        for(const opt of chain.options){
          const parsed=parseOCC(opt.option);
          if(!parsed||parsed.type!=='put')continue;
          const dateStr=parsed.expiry;
          const exp=new Date(parsed.expiry);
          const dte=Math.round((exp-today)/86400000);
          if(dte<Number(minDte)||dte>Number(maxDte))continue;

          const rawDelta=n(opt.delta);
          if(rawDelta==null)continue;
          const delta=Math.abs(rawDelta);
          if(delta<Number(minDelta)||delta>Number(maxDelta))continue;
          const bid=n(opt.bid)||0;
          const ask=n(opt.ask)||0;
          const last=n(opt.last_trade_price);
          const mid=(bid>0&&ask>0)?(bid+ask)/2:last;
          if(!mid||mid<=0)continue;
          const annual=calcAnnual(mid*100-DEFAULT_COMM,parsed.strike*100,dte)||0;
          if(annual<Number(minAnnual))continue;

          found.push({
            ticker:display,
            code:opt.option,
            stockPrice:chain.stockPrice,
            expiry:dateStr,
            strike:parsed.strike,
            delta:delta,
            bid:bid,
            ask:ask,
            mid:mid,
            iv:toPct(opt.iv),
            theta:n(opt.theta),
            gamma:n(opt.gamma),
            openInterest:n(opt.open_interest)||0,
            annualPct:annual,
            profitProb:(1-delta)*100,
            dte:dte,
            ivRank:chain.ivRank,
            ivPct:null,
            stockIV:chain.stockIV,
            stockHV:chain.stockHV,
          });
        }
      }catch(err){
        console.warn('Scan '+code+':',err.message);
      }
    }
    // 同一标的+到期日只取年化最高的
    const best={};
    for(const r of found){
      const key=r.ticker+'-'+r.expiry;
      if(!best[key]||r.annualPct>best[key].annualPct)best[key]=r;
    }
    const sortVal=r=>{
      const x=Number(r[sortKey]);
      return Number.isFinite(x)?x:-Infinity;
    };
    const sorted=Object.values(best).sort((a,b)=>sortVal(b)-sortVal(a));
    setResults(sorted);
    setProgress('');
    if(!sorted.length)setError('未找到符合条件的 CBOE 合约，请放宽 DTE / Delta / 年化条件，或检查 CBOE 代理连接');
    setLoading(false);
  };

  const sectors=['全部'].concat([...new Set(results.map(r=>r.sector).filter(Boolean))]);
  const filtered=filterSector==='全部'?results:results.filter(r=>r.sector===filterSector);
  const fmt2=(v,d)=>v==null?'—':Number(v).toFixed(d==null?2:d);

  const inputStyle={width:55,padding:'4px 6px',background:V('surface'),border:'1px solid '+V('line'),borderRadius:6,color:V('ink'),fontSize:13,fontFamily:'IBM Plex Mono,monospace'};
  const labelStyle={fontSize:10,color:V('faint'),letterSpacing:'.1em',textTransform:'uppercase',marginBottom:6};
  const scanBtnStyle={background:loading?V('line'):ACC.amberSoft,color:loading?V('faint'):ACC.amber,border:'1.5px solid '+(loading?V('line'):ACC.amber+'44'),fontWeight:600,padding:'8px 20px'};

  return(
    <div>
      <div style={{marginBottom:16,display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:10}}>
        <div>
          <div style={{fontSize:17,fontWeight:700,color:V('ink')}}>{'期权筛选器'}</div>
          <div style={{fontSize:12,color:V('faint'),marginTop:2}}>{'卖 Put 候选 · CBOE 延迟数据（约15分钟）'}</div>
        </div>
        <button onClick={scan} disabled={loading} className="btn" style={scanBtnStyle}>
          {loading?('⟳ '+progress):'🔍 开始扫描'}
        </button>
      </div>

      <div className="card scan-controls" style={{padding:'14px 18px',marginBottom:14,display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:12}}>
        <div>
          <div style={labelStyle}>{'到期天数'}</div>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            <input type="text" inputMode="numeric" value={minDte} onChange={e=>setMinDte(e.target.value)} style={inputStyle}/>
            <span style={{color:V('faint'),fontSize:11}}>{'~'}</span>
            <input type="text" inputMode="numeric" value={maxDte} onChange={e=>setMaxDte(e.target.value)} style={inputStyle}/>
            <span style={{color:V('faint'),fontSize:11}}>{'天'}</span>
          </div>
        </div>
        <div>
          <div style={labelStyle}>{'Delta 区间'}</div>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            <input type="text" inputMode="decimal" value={minDelta} onChange={e=>setMinDelta(e.target.value)} style={inputStyle}/>
            <span style={{color:V('faint'),fontSize:11}}>{'~'}</span>
            <input type="text" inputMode="decimal" value={maxDelta} onChange={e=>setMaxDelta(e.target.value)} style={inputStyle}/>
          </div>
        </div>
        <div>
          <div style={labelStyle}>{'最低年化'}</div>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            <input type="text" inputMode="numeric" value={minAnnual} onChange={e=>setMinAnnual(e.target.value)} style={inputStyle}/>
            <span style={{color:V('faint'),fontSize:11}}>{'%'}</span>
          </div>
        </div>
        <div>
          <div style={labelStyle}>{'排序'}</div>
          <select value={sortKey} onChange={e=>setSortKey(e.target.value)} style={{padding:'4px 8px',background:V('surface'),border:'1px solid '+V('line'),borderRadius:6,color:V('ink'),fontSize:12}}>
            <option value="annualPct">{'年化收益'}</option>
            <option value="ivRank">{'IV Rank'}</option>
            <option value="delta">{'Delta'}</option>
            <option value="dte">{'到期天数'}</option>
          </select>
        </div>
      </div>

      {results.length>0&&(
        <div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap'}}>
          {sectors.map(s=>{
            const active=filterSector===s;
            const chipStyle={padding:'4px 12px',borderRadius:20,fontSize:12,cursor:'pointer',background:active?ACC.amberSoft:V('surface'),color:active?ACC.amber:V('dim'),border:'1px solid '+(active?ACC.amber+'44':V('line'))};
            return <button key={s} onClick={()=>setFilterSector(s)} style={chipStyle}>{s}</button>;
          })}
        </div>
      )}

      {error&&(
        <div style={{padding:'12px 16px',background:ACC.amber+'10',border:'1px solid '+ACC.amber+'33',borderRadius:10,fontSize:13,color:ACC.amber,marginBottom:12}}>{error}</div>
      )}

      {filtered.length>0&&(
        <div className="scan-table" style={{overflowX:'auto'}}>
          <div className="scan-header" style={{display:'grid',gridTemplateColumns:'1.2fr 1fr 0.7fr 0.7fr 0.7fr 0.7fr 0.8fr 0.7fr 0.8fr 0.7fr',gap:0,padding:'0 0 8px',marginBottom:4,minWidth:680}}>
            {['标的','行权价','DTE','Delta','Bid','Ask','中间价','IV','年化','胜率'].map(h=>(
              <div key={h} style={{fontSize:10,color:V('faint'),letterSpacing:'.1em',textTransform:'uppercase',fontFamily:'IBM Plex Mono,monospace',padding:'0 6px'}}>{h}</div>
            ))}
          </div>

          {filtered.map((r,i)=>{
            const annualColor=r.annualPct>=15?ACC.profit:(r.annualPct>=8?ACC.amber:V('dim'));
            const ivRankColor=r.ivRank==null?V('faint'):(r.ivRank>=70?ACC.profit:(r.ivRank>=40?ACC.amber:V('dim')));
            const rowBorderColor=r.ivRank>=70?ACC.profit:(r.ivRank>=40?ACC.amber:V('line'));
            const rowStyle={display:'grid',gridTemplateColumns:'1.2fr 1fr 0.7fr 0.7fr 0.7fr 0.7fr 0.8fr 0.7fr 0.8fr 0.7fr',gap:0,padding:'10px 0',marginBottom:6,borderLeft:'3px solid '+rowBorderColor};
            const cc={padding:'0 6px',display:'flex',alignItems:'center'};
            return(
              <div key={i} className="card scan-row" style={rowStyle}>
                <div style={{padding:'0 6px'}}>
                  <div style={{fontFamily:'IBM Plex Mono,monospace',fontWeight:700,fontSize:14,color:V('ink')}}>{r.ticker}</div>
                  {r.stockIV!=null&&<div style={{fontSize:10,color:V('faint'),marginTop:1}}>{'IV '+r.stockIV.toFixed(1)+'%'}</div>}
                </div>
                <div style={{padding:'0 6px',display:'flex',flexDirection:'column',justifyContent:'center'}}>
                  <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:14,color:ACC.amber,fontWeight:600}}>{'$'+fmt2(r.strike,0)}</span>
                  <span style={{fontSize:10,color:V('faint'),marginTop:1}}>{r.expiry}</span>
                </div>
                <div style={cc}><span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:13,color:r.dte<=35?ACC.profit:V('dim')}}>{r.dte+'天'}</span></div>
                <div style={cc}><span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:13,color:V('ink')}}>{'-'+fmt2(r.delta,3)}</span></div>
                <div style={cc}><span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:13,color:V('dim')}}>{'$'+fmt2(r.bid)}</span></div>
                <div style={cc}><span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:13,color:V('dim')}}>{'$'+fmt2(r.ask)}</span></div>
                <div style={cc}><span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:14,fontWeight:600,color:V('ink')}}>{'$'+fmt2(r.mid)}</span></div>
                <div style={cc}><span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:13,color:V('dim')}}>{r.iv!=null?(r.iv.toFixed(1)+'%'):'--'}</span></div>
                <div style={cc}><span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:15,fontWeight:700,color:annualColor}}>{'+'+fmt2(r.annualPct,1)+'%'}</span></div>
                <div style={cc}><span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:13,color:r.profitProb!=null&&r.profitProb>=80?ACC.profit:V('dim')}}>{r.profitProb!=null?(r.profitProb.toFixed(0)+'%'):'--'}</span></div>
              </div>
            );
          })}

          <div style={{fontSize:11,color:V('faint'),marginTop:12,lineHeight:1.8,padding:'0 4px'}}>
            <div>{'年化 = (中间价×100 − 手续费$0.65) ÷ (行权价×100) × (365÷DTE)，实际成交以券商盘口为准'}</div>
            <div>{'IVR = IV Rank，基于 CBOE iv30 过去52周高低点估算，仅供参考'}</div>
            <div style={{marginTop:4}}>
              <span style={{color:ACC.profit}}>{'■'}</span>
              <span>{' IVR≥70 高IV适合卖方   '}</span>
              <span style={{color:ACC.amber}}>{'■'}</span>
              <span>{' IVR 40-70   '}</span>
              <span style={{color:V('faint')}}>{'■'}</span>
              <span>{' IVR较低'}</span>
            </div>
          </div>
        </div>
      )}

      {!loading&&!results.length&&!error&&(
        <div style={{textAlign:'center',padding:'60px 20px',color:V('faint'),border:'1.5px dashed '+V('line'),borderRadius:16}}>
          <div style={{fontSize:36,marginBottom:12,opacity:.3}}>{'🔍'}</div>
          <div style={{fontSize:15,marginBottom:6,color:V('dim')}}>{'点击「开始扫描」'}</div>
          <div style={{fontSize:12}}>{'将从观察列表中 '+getWatchlist().length+' 个标的中筛选 Put 合约'}</div>
          <div style={{fontSize:11,marginTop:8,color:V('faint')}}>{'标的池：'+getWatchlist().join(' · ')}</div>
        </div>
      )}
    </div>
  );
}


/* ══ 期权学习 ══════════════════════════════════════ */
function LearnPanel(){
  const [section,setSection]=useState('guide');
  const ref=React.useRef(null);

  // KaTeX 渲染
  useEffect(()=>{
    if(ref.current&&window.renderMathInElement){
      window.renderMathInElement(ref.current,{
        delimiters:[
          {left:'\\[',right:'\\]',display:true},
          {left:'\\(',right:'\\)',display:false},
        ],
        throwOnError:false
      });
    }
  },[section]);

  const sections={
    guide:{label:'实战指南',icon:'📊'},
    concepts:{label:'核心概念',icon:'📖'},
    greeks:{label:'希腊字母',icon:'Δ'},
    case1:{label:'案例·牛熊震荡',icon:'🚀'},
    case2:{label:'案例·黑天鹅',icon:'🌋'},
  };

  const conceptsHTML=`
<div class="eyebrow">第一部分 / 核心概念</div>
<h2>核心名词与「等效思维」</h2>
<p class="sec-sub">在期权世界里，先把一切头寸动态拆解为「它等效于多少股股票」——这是一切推导的地基。</p>
<div class="def"><h4>权利金 Premium</h4><p>期权的价格。由<b style="color:var(--ink)">内在价值</b>（当前行权能赚到的真金白银）和<b style="color:var(--ink)">时间价值</b>（市场为未来波动支付的溢价）组成。</p></div>
<div class="def"><h4>保证金 · 卖方占用资金</h4><p>卖方为防止爆仓被券商冻结的资金。务必区分两个概念：</p><div class="sub"><p><b>初始 / 开仓保证金</b>：开仓瞬间被冻结的钱。</p><p style="margin-top:5px"><b>维持保证金 Maintenance Margin</b>：触发追加保证金的<b>下限阈值</b>，账户权益跌破它才被追保乃至强平。</p><p style="margin-top:5px;color:var(--faint)">两者都会随市场恐慌度、股价逼近行权价而<b style="color:#f5b731">动态飙升</b>。</p></div></div>
<div class="def"><h4>现金担保 Cash-Secured</h4><p>卖出 Put 时，准备好 100% 现金以应对被动接盘。公式为 <span style="font-family:IBM Plex Mono,monospace">行权价 × 100 × 手数</span>。</p></div>
`;

  const greeksHTML=`
<div class="eyebrow">第一部分 / 希腊字母</div>
<h2>四大希腊字母的物理意义</h2>
<p class="sec-sub">每一个都是一阶或二阶导数。记住卖方天生的符号组合，就掌握了卖方的生意本质。</p>
<div class="gk-grid">
  <div class="gk"><span class="big">Δ</span><div><span class="sym">Δ</span><span style="font-weight:700">Delta</span></div><div class="role">速度 · 仓位 · 概率的集合</div><div class="calc">\\(\\Delta = \\dfrac{\\partial V}{\\partial S}\\) — 标的变动 $1，期权价格变动多少</div><p><b style="color:var(--ink)">① 变化速度：</b>正股涨 $1，Call 涨 \\(\\Delta\\)，Put 跌 \\(|\\Delta|\\)。</p><p><b style="color:var(--ink)">② 动态敞口（最核心）：</b>1 手期权 \\(= 100 \\times \\Delta\\) 股正股的风险。</p><p><b style="color:var(--ink)">③ 行权概率（近似）：</b>\\(|\\Delta|\\) 近似等于到期处于实值的概率。</p><div class="chips"><span class="chip pos">买 Call +Δ 做多</span><span class="chip pos">卖 Put +Δ 做多</span></div></div>
  <div class="gk"><span class="big">Γ</span><div><span class="sym">Γ</span><span style="font-weight:700">Gamma</span></div><div class="role">加速度 · 黑天鹅放大器</div><div class="calc">\\(\\Gamma = \\dfrac{\\partial^2 V}{\\partial S^2}\\) — 标的变动 $1，Delta 变动多少</div><p><b style="color:var(--ink)">买方 +Γ：</b>有利方向走 Delta 变大（赚钱加速），不利方向走 Delta 变小。</p><p><b style="color:var(--ink)">卖方 −Γ：</b>暴跌时 Delta 绝对值被动放大，亏损呈<b>指数级非线性加速</b>。</p><div class="chips"><span class="chip pos">买方 +Γ 友好</span><span class="chip neg">卖方 −Γ 致命</span></div></div>
  <div class="gk"><span class="big">ν</span><div><span class="sym">ν</span><span style="font-weight:700">Vega</span></div><div class="role">恐慌度对冲器</div><div class="calc">\\(\\nu = \\dfrac{\\partial V}{\\partial \\mathrm{IV}}\\) — IV 每变动 1%，期权价格变动多少</div><p><b style="color:var(--ink)">买方 +ν：</b>高 IV 对买方有利。<b style="color:var(--ink)">卖方 −ν：</b>IV 暴跌时卖方躺赚 Vega 奖励。</p><p style="color:var(--faint);font-size:12px">⚠️ Vega 自身随 IV 变化（二阶量 Vomma），用恒定 Vega 乘以很大的 IV 跳动是线性近似。</p><div class="chips"><span class="chip pos">买方 +ν</span><span class="chip neg">卖方 −ν</span></div></div>
  <div class="gk"><span class="big">Θ</span><div><span class="sym">Θ</span><span style="font-weight:700">Theta</span></div><div class="role">时间这台永动印钞机</div><div class="calc">\\(\\Theta = \\dfrac{\\partial V}{\\partial t}\\) — 时间每过一天，期权价格衰减多少</div><p><b style="color:var(--ink)">买方 −Θ：</b>每天醒来先亏一截时间价值。<b style="color:var(--ink)">卖方 +Θ：</b>躺着收时间，是卖方横盘盈利的<b>根本引擎</b>。</p><p><b style="color:var(--ink)">关键非线性：</b>临近到期平值期权时间价值<b>加速衰减</b>——卖方偏好 30-45 天、末两周了结。</p><div class="chips"><span class="chip neg">买方 −Θ</span><span class="chip pos">卖方 +Θ</span></div></div>
</div>
<div class="callout note"><span class="ic">∑</span><span><b>卖方视角小结 —</b> 卖方天生是 +Θ（赚时间）、−Γ（怕急变）、−ν（怕波动率上涨）。卖方的全部生意，本质是<b>用 Gamma 与 Vega 的风险，去置换 Theta 的稳定收益</b>。</span></div>
`;

  const case1HTML=`
<div class="eyebrow">第二部分 / 案例一</div>
<h2>🚀 大牛市 vs 震荡市 vs 小熊市</h2>
<p class="sec-sub">买 ITM Call（买方思维 · 替代正股） vs 卖 OTM Put（卖方思维 · 现金担保）。正股现价 $100，账户 $10,000 现金。</p>
<div class="weap-grid"><div class="weap"><div class="tg">武器 A · 买方思维</div><h4><span class="lt">A</span> 买入 ITM Call · 行权价 $90</h4><div class="kv"><span class="k">参数</span><span class="v">Δ = 0.90 · 30 天到期</span></div><div class="kv"><span class="k">权利金</span><span class="v">$11（内在 $10 + 时间 $1）</span></div><div class="kv"><span class="k">资金占用</span><span class="v hot">$1,100</span></div><div class="kv"><span class="k">初始等效敞口</span><span class="v">+90 股正股</span></div></div><div class="weap"><div class="tg">武器 B · 卖方思维</div><h4><span class="lt">B</span> 卖出 OTM Put · 行权价 $95</h4><div class="kv"><span class="k">参数</span><span class="v">Δ = −0.30 · 30 天到期</span></div><div class="kv"><span class="k">权利金</span><span class="v">收 $2</span></div><div class="kv"><span class="k">资金占用</span><span class="v hot">$9,500（现金担保）</span></div><div class="kv"><span class="k">初始等效敞口</span><span class="v">+30 股正股</span></div><div class="kv"><span class="k">真实盈亏平衡</span><span class="v">$93（95 − 2）</span></div></div></div>
<div class="callout note"><span class="ic">≠</span><span><b>两个武器并不对等 —</b> A 等效 90 股、占用 $1,100；B 等效 30 股、占用 $9,500。<b>敞口差 3 倍、资金差约 8.6 倍</b>。它们是两种风险预算下的不同工具。</span></div>
<div class="scen"><div class="sh"><span class="nm">场景 1 · 大牛市</span><span class="mv up">正股 +20% → $120</span></div><div class="row"><div class="wlab"><b>武器 A</b> 买 ITM Call</div><div class="metric"><span class="ml">净利润</span><span class="mn pos">+$1,900</span></div><div class="metric"><span class="ml">资金收益率</span><span class="mn pos">+172%</span></div></div><div class="row"><div class="wlab"><b>武器 B</b> 卖 OTM Put</div><div class="metric"><span class="ml">净利润</span><span class="mn pos">+$200</span></div><div class="metric"><span class="ml">资金收益率</span><span class="mn pos">+2.1%</span></div></div><div class="take">大涨行情下，买 ITM Call 展现恐怖的非线性高杠杆爆发力，<b>完胜</b>。</div></div>
<div class="scen"><div class="sh"><span class="nm">场景 2 · 震荡市</span><span class="mv flat">正股 +1% → $101</span></div><div class="row"><div class="wlab"><b>武器 A</b> 买 ITM Call</div><div class="metric"><span class="ml">净利润</span><span class="mn zero">$0</span></div><div class="metric"><span class="ml">资金收益率</span><span class="mn zero">0%</span></div></div><div class="row"><div class="wlab"><b>武器 B</b> 卖 OTM Put</div><div class="metric"><span class="ml">净利润</span><span class="mn pos">+$200</span></div><div class="metric"><span class="ml">资金收益率</span><span class="mn pos">+2.1%</span></div></div><div class="take">正股微涨，买方因 $1 时间价值磨损（Theta 衰减）打平；卖方通过 +Θ <b>完胜</b>。</div></div>
<div class="scen"><div class="sh"><span class="nm">场景 3 · 小熊市</span><span class="mv down">正股 −6% → $94</span></div><div class="row"><div class="wlab"><b>武器 A</b> 买 ITM Call</div><div class="metric"><span class="ml">净利润</span><span class="mn neg">−$700</span></div><div class="metric"><span class="ml">资金收益率</span><span class="mn neg">−63.6%</span></div></div><div class="row"><div class="wlab"><b>武器 B</b> 卖 OTM Put</div><div class="metric"><span class="ml">净利润</span><span class="mn pos">+$100</span></div><div class="metric"><span class="ml">资金收益率</span><span class="mn pos">+1.05%</span></div></div><div class="take">股价跌但未破 $93 真实平衡点，卖方凭权利金安全垫<b>逆势盈利</b>。</div></div>
`;

  const case2HTML=`
<div class="eyebrow">第二部分 / 案例二</div>
<h2>🌋 复合黑天鹅压力测试</h2>
<p class="sec-sub">Delta / Gamma 惩罚 vs Vega 奖励。在 IV 飙至 80% 历史高位时，卖出 1 手 $95 OTM Put，斩获权利金 $6.0（$600）。初始 Δ = −0.30 · Γ = 0.04 · ν = 0.15</p>
<p style="margin-top:1.2rem;color:var(--ink);font-weight:700;font-size:14px">第二天突发：股价下跌 $2 + 恐慌消散（IV 暴跌 30 点）</p>
<div class="step"><div class="stt"><span class="n">01</span> Delta + Gamma 的惩罚 <span class="chip neg" style="margin-left:auto">账面 −</span></div><p>用二阶泰勒展开，价格下跌对期权价的影响：</p><div class="eq"><div class="lab">二阶泰勒展开</div>\\[ \\Delta\\cdot\\Delta S + \\tfrac{1}{2}\\Gamma\\cdot(\\Delta S)^2 = (-0.30)(-2) + \\tfrac{1}{2}(0.04)(2^2) = 0.60 + 0.08 = +0.68 \\]</div><p class="impact">作为卖方，此项让期权变贵，账面亏损约 $68。</p><div class="callout danger"><span class="ic">Γ</span><span><b>Gamma 的隐形伤害 —</b> 新 \\(\\Delta \\approx -0.30 + 0.04\\times(-2) = -0.38\\)。等效做多敞口从 <b>+30 股被动放大到 +38 股</b>——下跌中越套越多。</span></div></div>
<div class="step"><div class="stt"><span class="n">02</span> Vega 的降维打击 <span class="chip pos" style="margin-left:auto">账面 +</span></div><p>恐慌消散，IV 暴跌 30 点至 50%：</p><div class="eq"><div class="lab">Vega 贡献（线性估算）</div>\\[ \\Delta\\mathrm{IV}\\times\\mathrm{Vega} = (-30)\\times 0.15 = -4.50 \\]</div><p class="impact">作为卖方，期权费暴跌是利好，账面盈利 $450。</p></div>
<div class="eq"><div class="lab">最终结算 · 期权市场价</div><div class="flow"><span class="t">初始 $6.0</span><span class="op">+</span><span class="t" style="color:#f46a5a">Delta/Gamma +$0.68</span><span class="op">+</span><span class="t" style="color:#3dd68c">Vega −$4.50</span><span class="op">=</span><span class="res">≈ $2.18</span></div><div class="flow" style="margin-top:10px"><span class="t">最终净利润</span><span class="op">=</span><span class="t">$6.0 − $2.18</span><span class="op">=</span><span class="res" style="background:rgba(61,214,140,.1);border-color:rgba(61,214,140,.3);color:#3dd68c">+$3.82 / 手</span></div></div>
<div class="callout note"><span class="ic">!</span><span><b>核心顿悟 —</b> 在高 IV 开仓时，<b>Vega 的盈利空间以压倒性姿态，盖过了 Delta/Gamma 下跌带来的惩罚</b>。即使方向猜错，卖方依然能赢。</span></div>
  <div class="triple"><div class="th"><span class="x">✕</span><h4>但这个顿悟必须加上边界 — 卖方真正的死法</h4></div><p style="padding:12px 18px 0;color:var(--dim);font-size:13px">上述结论成立，<b style="color:var(--ink)">仅仅因为本场景是「价格小跌 + 恐慌消散」的良性场景</b>。真正让卖方爆仓的是：股指急跌时 IV 通常<b style="color:#f46a5a">飙升</b>而非消散。届时三记重击同时落下：</p><div class="kills"><div class="kill"><div class="g">Δ</div><div class="t">Delta 亏</div><p>价格向不利方向走，方向直接亏损。</p></div><div class="kill"><div class="g">Γ</div><div class="t">Gamma 加速</div><p>等效敞口被动放大，越跌套得越多。</p></div><div class="kill"><div class="g">ν</div><div class="t">Vega 亏</div><p>IV 暴涨让期权更贵，回购成本飙升。</p></div></div><div class="foot"><b style="color:#ffd2cc">三杀叠加，才是卖方真正的死法。</b> 高 IV 开仓做卖方，赢的是 Vega 顺风——只在波动率回落时存在。遇到价跌+波动率飙升的真崩盘，Δ、Γ、ν 会一起反咬。</div></div>
  `;

  const guideHTML=`
<div class="eyebrow">实战指南 / 量化底层与账户风控</div>
<h2>📊 美股期权底层量化、策略构建与账户风控</h2>
<p class="sec-sub">把公式、策略和账户风控压缩成一套可执行的交易地图：先理解期权链上的定价铁律，再决定用哪种结构暴露风险，最后用 SGOV 和现金线把账户活下来。</p>

<div class="guide-grid">
  <div class="guide-card accent">
    <div class="tg">01 · 双胞胎定律</div>
    <h4>Put-Call Parity</h4>
    <div class="eq compact">\\[ C - P = S - K e^{-rt} \\]</div>
    <p>同到期、同行权价的 Call 与 Put 是一架天平。移项后可理解为 <b>Call + 履约现金</b> 等价于 <b>正股 + Put 保险</b>。</p>
  </div>
  <div class="guide-card">
    <div class="tg">02 · 情绪温度计</div>
    <h4>Skew 与 25Δ Risk Reversal</h4>
    <div class="eq compact">\\[ RR = IV_{25\\Delta Call} - IV_{25\\Delta Put} \\]</div>
    <p>极负代表 Put 恐慌溢价很高；接近 0 或转正，说明防空险变便宜，适合检查多头尾部保护。</p>
  </div>
</div>

<div class="view-grid">
  <div class="view-card"><div class="tg">视角一</div><h4>天平模型 · 到期终点线等价</h4><p>移项为 \\(C+K=S+P\\)：左盘是看涨期权 + 履约现金，右盘是正股 + 看跌保险。无论到期暴涨还是暴跌，两边最终都清算成同一份股票或同一笔现金，所以今天组合价格必须相等。</p></div>
  <div class="view-card"><div class="tg">视角二</div><h4>代数积木法 · 同源重组</h4><p>\\(C-P\\) 就是合成多头，数学上等同于 \\(S-K\\)：正股现货减现金。把 Call、Put、正股、现金这些积木重新移项，就能拼出盒式套利等结构；它们不是孤立招式，而是同一公式的变形。</p></div>
  <div class="view-card"><div class="tg">视角三</div><h4>天平失衡 · 套利抹平</h4><p>若恐慌抢 Put 导致 \\(C-P&lt;S-K\\)，理论上出现无风险套利。量化团队会买 Call、卖 Put 合成多头，同时做空正股，毫秒级抹平差价；在高流动性标的上，这条铁律可以高度信任。</p></div>
</div>

<div class="callout note"><span class="ic">⚠</span><span><b>实战边界 —</b> 在 SPY、QQQ、VOO、SPX 等高流动性标的上，Put-Call Parity 基本可信；但在宽价差、深虚值、小成交量合约上，滑点和借券成本会吃掉理论套利。</span></div>

<h2>进阶策略：合成多头与盒式套利</h2>
<div class="strategy-grid">
  <div class="strategy-card">
    <div class="tagline">Synthetic Long</div>
    <h4>合成多头：买 ATM Call + 卖 ATM Put</h4>
    <p>核心结构是 \\(C-P\\)，到期损益几乎复制 100 股正股。好处是开仓成本低，Call 的时间损耗被 Put 的时间收入抵消，整体接近 Delta 1。</p>
    <div class="rule-list">
      <div><b>红利：</b>低成本获得正股贝塔，横盘时 Theta 更中性。</div>
      <div><b>盲区：</b>下方本质有裸 Sell Put，暴跌时 IV 上升和保证金会一起放大。</div>
      <div><b>纪律：</b>账户保留等额现金或 SGOV，不用名义杠杆把自己顶满。</div>
    </div>
  </div>
  <div class="strategy-card danger">
    <div class="tagline">Box Spread</div>
    <h4>盒式套利：低 K 合成多头 + 高 K 合成空头</h4>
    <p>四腿组合把正股方向完全抵消，到期价值固定为 \\((K_2-K_1)\\times100\\)。它不是方向交易，而是一个期权市场里的借贷工具。</p>
    <div class="rule-list">
      <div><b>Short Box：</b>今天拿到折现现金，到期支付固定面值，差额就是隐含利息。</div>
      <div><b>只选欧式：</b>优先 SPX。不要用个股或 ETF 做美式盒子，提前指派会让盒子散架。</div>
      <div><b>期限：</b>常看 DTE 180-365，流动性和手续费摊薄更友好。</div>
    </div>
  </div>
</div>

<div class="payoff-grid">
  <div class="payoff-card">
    <h4>合成多头到期损益</h4>
    <pre class="payoff">账户盈利 (+)
    ^
    |                              /
    |                            /
----|--------------------------/--------> 到期正股价格
    |                        /
    |                      /  K 附近为盈亏平衡
账户亏损 (-)</pre>
  </div>
  <div class="payoff-card">
    <h4>Short Box 到期价值</h4>
    <pre class="payoff">到期资产价值
    ^
$10k|============================== 固定清算值
    |
$9.5| - - - - - - - - - - - - -  今日收到现金
    |
  $0+-----------------------------> 到期正股价格</pre>
  </div>
</div>

<h2>Box Spread 四条筛选铁律</h2>
<div class="rule-grid">
  <div class="rule"><span>1</span><b>标的</b><p>必须使用欧式期权，例如 SPX。避开个股和 ETF 的美式提前指派风险。</p></div>
  <div class="rule"><span>2</span><b>期限</b><p>优先 6 个月到 1 年，兼顾流动性、隐含利率和交易成本。</p></div>
  <div class="rule"><span>3</span><b>间距</b><p>\\((K_2-K_1)\\times100\\) 对齐借款规模，行权价尽量包住 ATM 区域。</p></div>
  <div class="rule"><span>4</span><b>限价</b><p>净流入卡在国债折现价和券商融资折现价之间，逼近更优资金成本。</p></div>
</div>

<h2>Margin Account 与 SGOV 双线抽水</h2>
<div class="guide-grid">
  <div class="guide-card">
    <div class="tg">账户字段</div>
    <h4>先看懂券商给你的四条线</h4>
    <p><b>Account Value</b> 是真实净资产；<b>Options</b> 为负通常代表卖方未平仓负债；<b>Cash + Borrowing</b> 是购买力，不等于已经借钱；<b>SMA</b> 是历史盈利沉淀出的额外开仓和提现额度。</p>
  </div>
  <div class="guide-card accent">
    <div class="tg">SGOV 底仓</div>
    <h4>用低波动国债 ETF 做保证金地基</h4>
    <p>大额本金放在 SGOV 吃底层利息，同时因波动低、保证金折扣小，通常能释放接近期权购买力。保守打法是让所有 Sell Put 名义接货额不超过 SGOV 市值。</p>
  </div>
</div>

<div class="scen">
  <div class="sh"><span class="nm">实盘风控纪律</span><span class="mv flat">不付融资利息风格</span></div>
  <div class="row"><div class="wlab"><b>开仓上限</b></div><div class="metric"><span class="ml">名义风险</span><span class="mn zero">≤ SGOV 市值</span></div><div class="metric"><span class="ml">Delta</span><span class="mn zero">偏深虚值</span></div></div>
  <div class="row"><div class="wlab"><b>利息触发点</b></div><div class="metric"><span class="ml">只有被指派</span><span class="mn neg">Cash 变负</span></div><div class="metric"><span class="ml">未行权</span><span class="mn pos">不产生融资息</span></div></div>
  <div class="row"><div class="wlab"><b>近月危机</b></div><div class="metric"><span class="ml">DTE</span><span class="mn neg">≤ 10 天且 ITM</span></div><div class="metric"><span class="ml">动作</span><span class="mn pos">Roll 收 Net Credit</span></div></div>
  <div class="row"><div class="wlab"><b>确定接盘</b></div><div class="metric"><span class="ml">T+1</span><span class="mn zero">卖 SGOV 补现金</span></div><div class="metric"><span class="ml">目标</span><span class="mn pos">抹平负现金</span></div></div>
  <div class="take">核心不是把购买力用满，而是让 SGOV、现金线和期权名义风险始终能互相覆盖。账户先活着，Theta 才能继续工作。</div>
</div>
`;

  const htmlMap={guide:guideHTML,concepts:conceptsHTML,greeks:greeksHTML,case1:case1HTML,case2:case2HTML};

  return(
    <div className="lp" ref={ref}>
      <div style={{marginBottom:20}}>
        <div style={{fontSize:20,fontWeight:700,color:V('ink'),marginBottom:4}}>{'期权拆弹手册'}</div>
        <div style={{fontSize:12,color:V('faint'),fontFamily:'IBM Plex Mono,monospace',letterSpacing:'.08em'}}>{'Δ Γ ν Θ · 底层量化推导与实战复盘'}</div>
      </div>
      <div className="nav-pills">
        {Object.entries(sections).map(([k,v])=>(
          <button key={k} className={'nav-pill'+(section===k?' active':'')} onClick={()=>setSection(k)}>
            {v.icon+' '+v.label}
          </button>
        ))}
      </div>
      <div dangerouslySetInnerHTML={{__html:htmlMap[section]||''}}/>
    </div>
  );
}

const BOOKMARK_LINKS=[
  {
    group:'briefing',
    title:'FiNews · AI 美股盘后日报',
    url:'https://finews.elsetech.app/',
    icon:'📰',
    accent:ACC.amber,
    desc:'每日整理盘后总结、主要新闻、市场温度和核心数据，适合早晨快速了解昨夜美股概况。',
    tags:['美股','日报','AI 总结'],
  },
  {
    group:'strategy',
    title:'Option Strategy · BTC 期权策略图解',
    url:'https://option.red/',
    icon:'📈',
    accent:ACC.purple,
    desc:'期权策略图解工具，适合快速查看不同策略的收益结构和风险形态。',
    tags:['期权','策略图解','BTC'],
  },
  {
    group:'strategy',
    title:'Free Money',
    url:'https://free-money.fate.red/',
    icon:'💸',
    accent:ACC.profit,
    desc:'投资、现金流和机会线索的收藏入口，适合集中查看和后续整理。',
    tags:['投资','机会','收藏'],
  },
  {
    group:'books',
    title:'李笑来书单',
    url:'https://xiaolai.fate.red/',
    icon:'📚',
    accent:ACC.blue,
    desc:'书单与长期学习资料入口，适合沉淀阅读、认知和投资相关内容。',
    tags:['书单','学习','阅读'],
  },
  {
    group:'briefing',
    title:'AI Daily · AI 早报',
    url:'https://aidaily.wiki/',
    icon:'🤖',
    accent:ACC.teal,
    desc:'每天早上自动更新 AI 最新资讯、分析和大事件，快速掌握行业变化。',
    tags:['AI','早报','资讯'],
  },
  {
    group:'books',
    title:'Leto',
    url:'https://leto.fate.red/',
    icon:'🧭',
    accent:ACC.amber,
    desc:'书单、资料和常用阅读入口，适合作为个人知识导航页。',
    tags:['书单','导航','资料'],
  },
];

const BOOKMARK_GROUPS=[
  {key:'briefing',title:'早报资讯',desc:'每天早上先看这一组，快速同步市场和 AI 最新变化。'},
  {key:'books',title:'书单阅读',desc:'长期阅读、书单和知识导航，适合沉淀下来慢慢看。'},
  {key:'strategy',title:'策略学习',desc:'期权、投资机会和策略工具，适合做交易前后的复盘。'},
];

function LinkHubPanel(){
  return(
    <div className="link-hub anim-in">
      <div className="link-hub-head">
        <div>
          <div className="link-hub-title">收藏网站</div>
          <div className="link-hub-sub">常用行情、日报、策略工具的快速入口</div>
        </div>
        <div className="link-hub-count">{BOOKMARK_LINKS.length} 个入口</div>
      </div>

      <div className="link-sections">
        {BOOKMARK_GROUPS.map(group=>{
          const items=BOOKMARK_LINKS.filter(item=>item.group===group.key);
          if(!items.length)return null;
          return(
            <section className="link-section" key={group.key}>
              <div className="link-section-head">
                <div>
                  <div className="link-section-title">{group.title}</div>
                  <div className="link-section-desc">{group.desc}</div>
                </div>
                <div className="link-section-count">{items.length}</div>
              </div>
              <div className="link-grid">
                {items.map(item=>(
                  <a key={item.url} className="link-card" href={item.url} target="_blank" rel="noopener"
                    style={{'--link-accent':item.accent}}>
                    <div className="link-card-icon">{item.icon}</div>
                    <div className="link-card-main">
                      <div className="link-card-title">{item.title}</div>
                      <div className="link-card-desc">{item.desc}</div>
                      <div className="link-card-tags">
                        {item.tags.map(tag=><span key={tag}>{tag}</span>)}
                      </div>
                    </div>
                    <div className="link-card-arrow">↗</div>
                  </a>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/* ══ SGOV 面板 ══════════════════════════════════════ */
function SgovPanel({sgov,onUpdate,totalMarginUsed}){
  const s=sgov||{};
  const si=calcSgov(s);
  const sgovVsMargin=(si?.total&&totalMarginUsed>0)?calcAnnual(si.total,totalMarginUsed,si.days):null;
  return(
    <div className="glass-card sgov-panel anim-in" style={{borderColor:`rgba(45,212,191,.25)`,padding:'16px 20px',marginBottom:16}}>
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
        <div style={{width:3,height:16,borderRadius:2,background:ACC.teal,flexShrink:0}}/>
        <span style={{fontWeight:700,fontSize:14,color:ACC.teal}}>SGOV 保证金底仓</span>
        <span style={{fontSize:11,color:V('faint'),fontFamily:'IBM Plex Mono,monospace'}}>嘉信杠杆 · 利息来源</span>
      </div>
      <div className="sgov-form-grid" style={{display:'grid',gridTemplateColumns:'1.6fr 1fr .9fr 1.1fr',gap:12,marginBottom:si?14:0}}>
        <NumField label="当前市值" prefix="$" value={s.marketValue??''} placeholder="100000" onChange={v=>onUpdate({...s,marketValue:parseFloat(v)||null})}/>
        <DateField label="计息起始日" value={s.startDate??''} onChange={v=>onUpdate({...s,startDate:v})}/>
        <NumField label="年化利率" hint="默认4%" suffix="%" value={s.annualRate??''} placeholder="4.0" onChange={v=>onUpdate({...s,annualRate:parseFloat(v)||null})}/>
        <NumField label="手动修正" hint="可±" prefix="$" value={s.manualAdj??''} placeholder="0" onChange={v=>onUpdate({...s,manualAdj:parseFloat(v)||null})}/>
      </div>
      {si&&(
        <div className="sgov-stat-grid" style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))',gap:14,paddingTop:12,borderTop:`1px solid ${V('line')}`}}>
          <Stat label="SGOV 市值" value={`$${fmt(s.marketValue,0)}`} color={ACC.teal}/>
          <Stat label={`累计利息·${si.days}天`} value={fmtM(si.total)} color={ACC.profit} sub={`自动 $${fmt(si.autoInt)}${s.manualAdj?` + 修正 $${fmt(s.manualAdj)}`:''}`}/>
          <Stat label="SGOV 年化" value={fmtA(si.rate)} color={ACC.teal}/>
          {totalMarginUsed>0&&s.marketValue&&<Stat label="保证金占用比"
            value={`${((totalMarginUsed/s.marketValue)*100).toFixed(1)}%`}
            color={(totalMarginUsed/s.marketValue)*100>80?ACC.loss:(totalMarginUsed/s.marketValue)*100>60?ACC.amber:ACC.profit}
            sub={`$${fmt(totalMarginUsed,0)} / $${fmt(s.marketValue,0)}`}/>}
          {sgovVsMargin!=null&&<Stat label="利息÷期权保证金" value={fmtA(sgovVsMargin)} color={ACC.purple} sub="SGOV利息相对保证金年化" hl={ACC.purple}/>}
        </div>
      )}
    </div>
  );
}

/* ══ 汇总栏 ══════════════════════════════════════ */
function SummaryBar({positions,commPerSide,sgov}){
  const rs=positions.map(p=>calc(p,commPerSide));
  const totalMargin=rs.reduce((s,r)=>s+r.capital,0);
  const totalGross=rs.reduce((s,r)=>s+r.openPrem,0);
  const totalComm=rs.reduce((s,r)=>s+r.commExp,0);
  const totalNet=totalGross-totalComm;
  const withOpt=positions.filter(p=>p.optionPrice!=null);
  const totalProfitNow=withOpt.reduce((s,p)=>s+(calc(p,commPerSide).profitNow||0),0);

  // ── 年化：用总利润÷总保证金，资金加权，避免简单平均失真 ──
  // 「持到到期」：净权利金 ÷ 总保证金，天数用资金加权平均持有天数
  const avgExp=(()=>{
    if(!positions.length||totalMargin===0)return null;
    const wDays=rs.reduce((s,r)=>s+r.daysTotal*(r.capital||0),0)/totalMargin;
    return calcAnnual(totalNet,totalMargin,wDays);
  })();

  // 「现在卖出」：当前浮动利润 ÷ 总保证金（仅有期权现价的仓位参与）
  const avgNow=(()=>{
    if(!withOpt.length)return null;
    const margin=withOpt.reduce((s,p)=>s+(calc(p,commPerSide).capital||0),0);
    if(margin===0)return null;
    const wDays=withOpt.map(p=>calc(p,commPerSide)).reduce((s,r)=>s+r.daysHeld*(r.capital||0),0)/margin;
    return calcAnnual(totalProfitNow,margin,wDays);
  })();

  const sgovMV=sgov?.marketValue||null;
  const si=calcSgov(sgov);
  const marginRatio=sgovMV&&totalMargin>0?(totalMargin/sgovMV)*100:null;
  const scored=positions.map((p,i)=>({p,r:rs[i],...scorePosition(p,rs[i],{totalMargin,sgov})}));
  const avgScore=scored.length?Math.round(scored.reduce((s,x)=>s+x.score,0)/scored.length):null;
  const worstScore=scored.length?scored.reduce((w,x)=>!w||x.score<w.score?x:w,null):null;

  // 对SGOV年化：总利润 ÷ SGOV市值
  const nowVsSgov=(totalProfitNow!=null&&sgovMV&&withOpt.length)?(()=>{
    const margin=withOpt.reduce((s,p)=>s+(calc(p,commPerSide).capital||0),0);
    const wDays=withOpt.map(p=>calc(p,commPerSide)).reduce((s,r)=>s+r.daysHeld*(r.capital||0),0)/Math.max(1,margin);
    return calcAnnual(totalProfitNow,sgovMV,wDays);
  })():null;
  const expVsSgov=(avgExp!=null&&sgovMV)?(()=>{
    const wDays=rs.reduce((s,r)=>s+r.daysTotal*(r.capital||0),0)/Math.max(1,totalMargin);
    return calcAnnual(totalNet,sgovMV,wDays);
  })():null;
  const Box=({label,value,color,sub,hl,sz=22})=>(
    <div className="summary-box" style={{display:'flex',flexDirection:'column',gap:5,padding:'10px 14px',borderRadius:12,background:'rgba(28,44,58,.2)',...(hl?{borderLeft:'2px solid '+hl,paddingLeft:12}:{})}}>
      <span style={{fontSize:11,color:V('faint'),letterSpacing:'.14em',textTransform:'uppercase',fontFamily:'IBM Plex Mono,monospace'}}>{label}</span>
      <span className="summary-box-val" style={{fontSize:sz,fontWeight:700,color:color||V('ink'),fontFamily:'IBM Plex Mono,monospace',lineHeight:1,letterSpacing:'-.02em'}}>{value}</span>
      {sub&&<span className="summary-box-sub" style={{fontSize:11,color:V('dim'),fontFamily:'IBM Plex Mono,monospace'}}>{sub}</span>}
    </div>
  );
  const BigA=({label,main,mainColor,vs,sub})=>(
    <div className="summary-metric" style={{display:'flex',flexDirection:'column',gap:6}}>
      <span className="section-label">{label}</span>
      <div style={{display:'flex',alignItems:'baseline',gap:8,flexWrap:'wrap'}}>
        <span className="summary-main" style={{fontSize:28,fontWeight:700,letterSpacing:'-.03em',color:mainColor,fontFamily:'IBM Plex Mono,monospace',lineHeight:1}}>{main}</span>
        {vs!=null&&<span className="badge summary-badge" style={{color:ACC.purple,background:ACC.purpleBg,borderColor:`${ACC.purple}44`,fontSize:13}}>{fmtA(vs)} /SGOV</span>}
      </div>
      {sub&&<span className="summary-metric-sub" style={{fontSize:11,color:V('dim'),fontFamily:'IBM Plex Mono,monospace'}}>{sub}</span>}
    </div>
  );
  return(
    <div className="glass-card summary-card anim-in" style={{padding:'18px 22px',marginBottom:16}}>
      <div className="summary-grid" style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))',gap:14,marginBottom:14,paddingBottom:14,borderBottom:`1px solid ${V('line')}`}}>
        <Box label="期权总保证金" value={`$${fmt(totalMargin,0)}`} color={V('dim')} sub={`${positions.length} 个仓位`}/>
        <Box label="收入权利金" value={`$${fmt(totalGross)}`} color={ACC.amber} sub="开仓时收取的总权利金"/>
        <Box label="手续费合计" value={`-$${fmt(totalComm)}`} color={ACC.loss} sub="持到到期单边×仓位数"/>
        <Box label="净权利金（到期）" value={`$${fmt(totalNet)}`} color={ACC.profit} hl={ACC.profit}/>
        {withOpt.length>0&&<Box label="当前浮动净利" value={fmtM(totalProfitNow)} color={totalProfitNow>=0?ACC.profit:ACC.loss} sub={`${withOpt.length}/${positions.length} 已录价`}/>}
        {sgovMV&&marginRatio!=null&&<Box label="保证金/SGOV" value={`${marginRatio.toFixed(1)}%`} color={marginRatio>80?ACC.loss:marginRatio>60?ACC.amber:ACC.profit} sub={`$${fmt(totalMargin,0)}/$${fmt(sgovMV,0)}`}/>}
        {avgScore!=null&&<Box label="仓位健康分" value={`${avgScore}`} color={scoreColor(avgScore)} hl={scoreColor(avgScore)} sub={worstScore?`最低 ${worstScore.p.ticker} ${worstScore.score} · ${scoreLabel(avgScore)}`:''}/>}
      </div>
      <div className="summary-grid" style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:18}}>
        {avgNow!=null&&<BigA label="现在卖出年化" main={fmtA(avgNow)} mainColor={ACC.blue} vs={nowVsSgov} sub={nowVsSgov?`对保证金 ${fmtA(avgNow)} · 对SGOV ${fmtA(nowVsSgov)}`:'录入期权现价后计算'}/>}
        {avgExp!=null&&<BigA label="持到到期年化" main={fmtA(avgExp)} mainColor={ACC.amber} vs={expVsSgov} sub={expVsSgov?`对保证金 ${fmtA(avgExp)} · 对SGOV ${fmtA(expVsSgov)}`:'录入SGOV市值后计算'}/>}
        {si&&sgovMV&&(
          <div className="summary-metric" style={{display:'flex',flexDirection:'column',gap:6}}>
            <span className="section-label">SGOV 利息</span>
            <div style={{display:'flex',alignItems:'baseline',gap:8}}>
              <span className="summary-main" style={{fontSize:28,fontWeight:700,letterSpacing:'-.03em',color:ACC.teal,fontFamily:'IBM Plex Mono,monospace',lineHeight:1}}>{fmtA(si.rate)}</span>
              <span style={{fontSize:13,color:V('dim'),fontFamily:'IBM Plex Mono,monospace'}}>年化</span>
            </div>
            <span className="summary-metric-sub" style={{fontSize:11,color:V('dim'),fontFamily:'IBM Plex Mono,monospace'}}>累计 {fmtM(si.total)} · {si.days} 天</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══ 添加表单 ══════════════════════════════════════ */
function AddForm({onAdd,onCancel,commPerSide}){
  const [f,setF]=useState({ticker:'',type:'P',strike:'',qty:'1',openDate:today(),expDate:'',premium:'',marginType:'cash',customMargin:''});
  const set=(k,v)=>setF(p=>({...p,[k]:v}));
  const autoCapital=(f.marginType==='cash'?(parseFloat(f.strike)||0)*100:(parseFloat(f.customMargin)||0))*(parseInt(f.qty)||1);
  const qty=parseInt(f.qty)||1;
  const comm=commPerSide*qty*2;
  const netPrem=f.premium?Math.max(0,parseFloat(f.premium)*100*qty-comm):null;
  const valid=f.ticker&&f.strike&&f.expDate&&f.premium;
  const submit=()=>{
    if(!valid)return;
    onAdd({id:Date.now(),ticker:f.ticker.toUpperCase().trim(),type:f.type,strike:parseFloat(f.strike),qty,
      openDate:f.openDate,expDate:f.expDate,premium:parseFloat(f.premium),marginType:f.marginType,
      customMargin:parseFloat(f.customMargin)||0,currentPrice:null,optionPrice:null});
  };
  return(
    <div className="card mobile-form-card anim-in" style={{padding:22,marginBottom:16,borderColor:`${ACC.amber}33`}}>
      <div style={{fontSize:13,fontWeight:700,color:ACC.amber,marginBottom:18}}>＋ 添加期权仓位</div>
      <div className="mobile-form-grid" style={{display:'grid',gridTemplateColumns:'2fr 110px 1fr 80px',gap:12,marginBottom:12}}>
        <Field label="标的代码" value={f.ticker} onChange={v=>set('ticker',v.toUpperCase())} placeholder="MRVL"/>
        <SelectField label="方向" value={f.type} onChange={v=>set('type',v)} options={[{value:'P',label:'卖 Put'},{value:'C',label:'卖 Call'}]}/>
        <NumField label="行权价" prefix="$" value={f.strike} onChange={v=>set('strike',v)} placeholder="190"/>
        <NumField label="手数" value={f.qty} onChange={v=>set('qty',v)} placeholder="1" suffix="手"/>
      </div>
      <div className="mobile-form-grid" style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12,marginBottom:12}}>
        <DateField label="开仓日期" value={f.openDate} onChange={v=>set('openDate',v)}/>
        <DateField label="到期日期" value={f.expDate} onChange={v=>set('expDate',v)}/>
        <NumField label="开仓权利金" prefix="$" suffix="/股" value={f.premium} onChange={v=>set('premium',v)} placeholder="3.24"/>
      </div>
      <div className="mobile-form-grid" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:14}}>
        <SelectField label="保证金类型" value={f.marginType} onChange={v=>set('marginType',v)}
          options={[{value:'cash',label:'现金担保（行权价×100）'},{value:'custom',label:'自定义（券商实际占用）'}]}/>
        {f.marginType==='custom'
          ?<NumField label="自定义占用资金" prefix="$" value={f.customMargin} onChange={v=>set('customMargin',v)} placeholder="5000"/>
          :<Field label="占用资金（自动）" value={`$${fmt(autoCapital,0)}`} onChange={()=>{}} readOnly color={ACC.amber}/>}
      </div>
      {f.premium&&<div style={{background:V('surface'),border:`1px solid ${V('line')}`,borderRadius:10,padding:'10px 14px',marginBottom:14,display:'flex',gap:24,flexWrap:'wrap'}}>
        <span style={{fontSize:12,fontFamily:'IBM Plex Mono,monospace',color:V('dim')}}>手续费双边：<span style={{color:ACC.loss}}>${fmt(comm)}</span></span>
        {netPrem!=null&&<span style={{fontSize:12,fontFamily:'IBM Plex Mono,monospace',color:V('dim')}}>净权利金：<span style={{color:ACC.profit}}>${fmt(netPrem)}</span></span>}
      </div>}
      <div style={{display:'flex',gap:8}}>
        <button onClick={submit} disabled={!valid} className="btn btn-primary" style={{minWidth:100}}>添加仓位</button>
        <button onClick={onCancel} className="btn btn-ghost">取消</button>
      </div>
    </div>
  );
}

/* ══ 详情抽屉 ══════════════════════════════════════ */
function DetailDrawer({p,r,health,commPerSide,onUpdateOptionPrice,onClose,onDelete,onRoll}){
  return(
    <div className="detail-drawer anim-fade" style={{borderTop:`1px solid ${V('line')}`,background:V('surface'),borderRadius:'0 0 14px 14px',padding:'18px 20px'}}>
      <div style={{marginBottom:16}}>
        <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:V('dim'),marginBottom:5,fontFamily:'IBM Plex Mono,monospace'}}>
          <span>开仓 {p.openDate}</span>
          <span style={{color:ACC.amber}}>Θ {r.thetaPct.toFixed(0)}% · 剩 {r.daysLeft} 天</span>
          <span>到期 {p.expDate}</span>
        </div>
        <ThetaBar pct={r.thetaPct}/>
      </div>
      <div className="detail-stat-grid" style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))',gap:12,marginBottom:16,paddingBottom:16,borderBottom:`1px solid ${V('line')}`}}>
        <Stat label="开仓权利金" value={`$${fmt(r.openPrem)}`} sub={`$${fmt(p.premium)}/股×${r.qty}手`} color={ACC.amber}/>
        <Stat label="手续费双边" value={`-$${fmt(r.commTotal)}`} sub={`$${commPerSide}/张×${r.qty}×2`} color={ACC.loss}/>
        <Stat label="净权利金" value={`$${fmt(r.openPrem-r.commTotal)}`} color={ACC.profit}/>
        <Stat label="占用资金" value={`$${fmt(r.capital,0)}`} sub={p.marginType==='cash'?'现金担保':'自定义'} color={V('dim')}/>
        <Stat label="持有天数" value={`${r.daysHeld} 天`} sub={`共 ${r.daysTotal} 天`} color={V('dim')}/>
        {r.capturedPct!=null&&<Stat label="权利金捕获" value={`${r.capturedPct.toFixed(1)}%`} color={r.capturedPct>=50?ACC.profit:ACC.amber}/>}
        {r.buffer!=null&&<Stat label={p.type==='P'?'价外缓冲':'价外距离'} value={`${r.buffer>0?'+':''}${r.buffer.toFixed(1)}%`} sub={`现价 $${fmt(p.currentPrice)}`} color={r.buffer>0?ACC.profit:ACC.loss}/>}
      </div>
      {health&&(
        <div className="health-card" style={{'--health-color':health.color}}>
          <div className="health-card-head">
            <div>
              <div className="section-label">仓位健康分</div>
              <div className="health-card-title">{health.label} · {health.score}/100</div>
            </div>
            <div className="health-ring" style={{background:`conic-gradient(${health.color} ${health.score*3.6}deg, rgba(255,255,255,.08) 0deg)`}}>
              <span>{health.score}</span>
            </div>
          </div>
          <div className="health-notes">
            {health.notes.length?health.notes.map((n,i)=>(
              <div key={i} className={n.delta>=0?'pos':'neg'}>
                <span>{n.delta>=0?'+'+n.delta:n.delta}</span>{n.msg}
              </div>
            )):<div className="pos"><span>+0</span>暂无明显风险项，继续按计划管理</div>}
          </div>
        </div>
      )}
      <div className="detail-scenario-grid" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:14}}>
        <div className="card" style={{padding:14}}>
          <div style={{fontSize:10,color:ACC.blue,letterSpacing:'.12em',textTransform:'uppercase',fontFamily:'IBM Plex Mono,monospace',marginBottom:10}}>场景 A · 现在卖出</div>
          {/* OCC 合约代码 + CBOE 查价链接 */}
          {(()=>{
            const occ=buildOCCSymbol(p.ticker,p.expDate,p.type,p.strike);
            const cboeUrl=`https://www.cboe.com/delayed_quotes/options/${p.ticker}`;
            return(
              <div style={{background:V('surface'),borderRadius:7,padding:'6px 10px',marginBottom:10,display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,flexWrap:'wrap'}}>
                <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:11,color:V('faint'),letterSpacing:'.04em'}}>{occ}</span>
                <a href={cboeUrl} target="_blank" rel="noopener"
                  style={{fontSize:11,color:ACC.teal,textDecoration:'none',fontWeight:600,whiteSpace:'nowrap'}}>
                  CBOE 查价 ↗
                </a>
              </div>
            );
          })()}
          <div style={{marginBottom:10}}>
            <div className="section-label" style={{marginBottom:5}}>期权现价（自动 / 手动录入）</div>
            <InlineEdit value={p.optionPrice} onSave={onUpdateOptionPrice}/>
          </div>
          {r.profitNow!=null?(
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
              <Stat label="净利润" value={fmtM(r.profitNow)} color={r.profitNow>=0?ACC.profit:ACC.loss} sz={16}/>
              <Stat label="年化" value={fmtA(r.annualNow)} sub={`区间${r.yieldNow?.toFixed(1)}%`} color={r.annualNow>0?ACC.profit:ACC.loss} sz={16}/>
            </div>
          ):<span style={{fontSize:12,color:V('faint'),fontFamily:'IBM Plex Mono,monospace'}}>点击上方录入期权现价</span>}
        </div>
        <div className="card" style={{padding:14}}>
          <div style={{fontSize:10,color:ACC.amber,letterSpacing:'.12em',textTransform:'uppercase',fontFamily:'IBM Plex Mono,monospace',marginBottom:10}}>场景 B · 到期归零</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:10}}>
            <Stat label="净利润" value={`+$${fmt(r.profitExp)}`} color={ACC.profit} sz={16}/>
            <Stat label="年化" value={fmtA(r.annualExp)} sub={`区间${r.yieldExp?.toFixed(1)}%`} color={ACC.amber} sz={16}/>
          </div>
          <span style={{fontSize:11,color:V('faint'),fontFamily:'IBM Plex Mono,monospace'}}>仅扣单边 ${fmt(r.commExp)} · 剩 {r.daysLeft} 天</span>
        </div>
      </div>
      <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
        <button onClick={onRoll} className="btn" style={{background:ACC.amberSoft,color:ACC.amber,border:'1.5px solid '+ACC.amber+'44'}}>{'↻ Roll 滚仓'}</button>
        <button onClick={onClose} className="btn btn-primary" style={{background:ACC.blue,color:'#fff'}}>{'↩ 平仓'}</button>
        <button onClick={onDelete} className="btn btn-danger">{'删除'}</button>
      </div>
    </div>
  );
}

/* ══ 活跃仓位行 ══════════════════════════════════════ */
function PositionRow({p,commPerSide,portfolio,expanded,onToggle,onUpdateOptionPrice,onClose,onDelete,onRoll}){
  const r=calc(p,commPerSide);
  const health=scorePosition(p,r,portfolio);
  const isCall=p.type==='C';
  const typeColor=isCall?ACC.loss:ACC.profit;
  const urgency=r.daysLeft<=7?ACC.loss:r.daysLeft<=21?ACC.amber:V('dim');
  // 风险等级计算
  const dist=r.buffer;
  const riskClass=dist==null?'risk-safe':(dist<=0?'risk-itm':(dist<=3?'risk-warn':'risk-safe'));
  const isITM=dist!=null&&dist<=0;
  return(
    <div style={{overflow:'hidden',marginBottom:expanded?8:0,transition:'box-shadow .2s',boxShadow:expanded?'0 4px 24px rgba(0,0,0,.2)':'none',...(expanded?{borderRadius:14,border:'1px solid '+V('line-br')}:{})}}>
      <div className={`pos-clean-row pos-row-inner ${riskClass}`} onClick={onToggle}
        style={{'--row-accent':typeColor,display:'grid',gridTemplateColumns:'4px 110px 82px 86px 1fr 88px 106px 104px 104px 90px 36px',
          alignItems:'center',minHeight:56,padding:'2px 0',...(expanded?{background:V('card-hover')}:{})}}>
        <div className="pos-row-col-streak" style={{background:typeColor,height:'100%',minHeight:56,width:3,borderRadius:2}}/>
        <div className="pos-row-col-main" style={{padding:'0 14px',display:'flex',flexDirection:'column',gap:3}}>
          <span className="ticker-glow" style={{fontFamily:'IBM Plex Mono,monospace',fontWeight:700,fontSize:15,color:V('ink')}}>{p.ticker}</span>
          <div style={{display:'flex',alignItems:'center',gap:5}}>
            <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:typeColor,letterSpacing:'.06em'}}>{'卖 '+(isCall?'Call':'Put')}</span>
            {isITM&&<span className="badge-itm">{'ITM'}</span>}
          </div>
          {/* 移动端额外信息 */}
          <div className="pos-row-mobile-extra" style={{display:'none',gap:8,marginTop:2,flexWrap:'wrap'}}>
            <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:11,color:ACC.amber,fontWeight:600}}>${fmt(p.strike,0)}</span>
            <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:11,color:urgency}}>{r.daysLeft}天·{p.expDate}</span>
          </div>
        </div>
        <div className="pos-row-col-strike" style={{display:'flex',flexDirection:'column',gap:3}}>
          <span className="pos-strike" style={{fontFamily:'IBM Plex Mono,monospace',fontSize:14,color:ACC.amber,fontWeight:600}}>{'$'+fmt(p.strike,0)}</span>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:V('faint')}}>{'×'+p.qty+'手'}</span>
        </div>
        <div className="pos-row-col-expiry" style={{display:'flex',flexDirection:'column',gap:2}}>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:13,color:urgency,fontWeight:r.daysLeft<=14?700:500}}>{r.daysLeft+'天'}</span>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:V('faint')}}>{p.expDate.slice(5)}</span>
        </div>
        <div className="pos-row-col-theta" style={{padding:'0 12px',display:'flex',flexDirection:'column',gap:4}}>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:V('faint'),letterSpacing:'.04em'}}>{'Θ '+r.thetaPct.toFixed(0)+'%'}</span>
          <ThetaBar pct={r.thetaPct} small/>
        </div>
        <div className="pos-row-col-prem" style={{display:'flex',flexDirection:'column',gap:3,alignItems:'flex-end',paddingRight:8}}>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:13,color:ACC.profit,fontWeight:600}}>{'$'+fmt(r.openPrem,0)}</span>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:V('faint')}}>{'$'+fmt(p.premium)+'/股'}</span>
          {p.optionDelta!=null&&<span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:9,color:V('faint'),marginTop:1}}>{'Δ '+p.optionDelta.toFixed(2)}</span>}
        </div>
        <div className="pos-row-col-price" style={{display:'flex',flexDirection:'column',gap:2,alignItems:'flex-end',paddingRight:8}}>
          {p.currentPrice?(<>
            <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:13,color:V('ink'),fontWeight:600}}>{'$'+fmt(p.currentPrice)}</span>
            {r.buffer!=null&&<span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:r.buffer>0?ACC.profit:ACC.loss,fontWeight:600}}>{(r.buffer>0?'↑':'↓')+Math.abs(r.buffer).toFixed(1)+'%'}</span>}
            {p.optionPrice!=null&&<span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:9,color:V('faint'),letterSpacing:'.03em'}}>{'Δ '+(p.optionDelta!=null?p.optionDelta.toFixed(2):'—')}</span>}
          </>):<span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:11,color:V('faint')}}>{'—'}</span>}
          {/* 移动端在价格下面补充年化 */}
          <div className="pos-row-mobile-extra" style={{display:'none',flexDirection:'column',gap:1,alignItems:'flex-end',marginTop:2}}>
            <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:ACC.amber,fontWeight:600}}>{fmtA(r.annualExp)}</span>
          </div>
        </div>
        <div className="pos-row-col-now" style={{display:'flex',flexDirection:'column',gap:3,alignItems:'flex-end',paddingRight:8}}>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:ACC.blue,letterSpacing:'.05em'}}>现在卖出</span>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:14,fontWeight:600,color:r.annualNow!=null?(r.annualNow>0?ACC.profit:ACC.loss):V('faint')}}>{r.annualNow!=null?fmtA(r.annualNow):'—'}</span>
        </div>
        <div className="pos-row-col-exp" style={{display:'flex',flexDirection:'column',gap:3,alignItems:'flex-end',paddingRight:8}}>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:ACC.amber,letterSpacing:'.05em'}}>持到到期</span>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:14,fontWeight:600,color:ACC.amber}}>{fmtA(r.annualExp)}</span>
        </div>
        <div className="pos-row-col-score" style={{display:'flex',flexDirection:'column',gap:3,alignItems:'flex-end',paddingRight:8}}>
          <span className="health-pill" style={{'--health-color':health.color}}>{health.score}</span>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:9,color:health.color,letterSpacing:'.05em'}}>{health.label}</span>
        </div>
        <div className="pos-row-col-arrow" style={{display:'flex',justifyContent:'center',color:V('faint'),fontSize:11,transform:expanded?'rotate(180deg)':'rotate(0)',transition:'transform .22s ease'}}>▼</div>
      </div>
      {expanded&&<DetailDrawer p={p} r={r} health={health} commPerSide={commPerSide}
        onUpdateOptionPrice={v=>onUpdateOptionPrice(p.id,v)}
        onClose={onClose} onDelete={onDelete} onRoll={onRoll}/>}
    </div>
  );
}

function ActiveTableHeader(){
  const H=({t,right})=><div style={{fontSize:10,color:V('faint'),letterSpacing:'.14em',textTransform:'uppercase',fontFamily:'IBM Plex Mono,monospace',textAlign:right?'right':'left',padding:'0 4px'}}>{t}</div>;
  return(
    <div className="pos-table-header" style={{display:'grid',gridTemplateColumns:'4px 110px 82px 86px 1fr 88px 106px 104px 104px 90px 36px',alignItems:'center',padding:'4px 0 10px',marginBottom:0,borderBottom:'1px solid rgba(28,44,58,.4)'}}>
      <div/><H t="标的"/><H t="行权价"/><H t="到期"/><H t="Θ 衰减"/><H t="权利金" right/><H t="股价" right/><H t="现在卖出" right/><H t="持到到期" right/><H t="健康分" right/><div/>
    </div>
  );
}

/* ══ 已平仓历史行 ══════════════════════════════════════ */
function ClosedRow({c,commPerSide,onDelete,onUpdateExpiryReview,positions=[],closed=[]}){
  const r=calcClosed(c,commPerSide);
  const isCall=c.type==='C';
  const typeColor=isCall?ACC.loss:ACC.profit;
  const isExpired=c.closeType==='expired';
  const isAssigned=c.closeType==='assigned';
  const isRoll=c.closeType==='roll';
  const isManual=!isRoll&&!isAssigned&&!isExpired;
  const canEstimateHold=isManual&&c.expDate&&c.expDate>=today();
  const canReviewExpiry=!!(c.expDate&&c.expDate<today()&&!isExpired&&!isAssigned);
  const cachedExpiryPrice=Number.isFinite(Number(c.expiryReviewPrice))?Number(c.expiryReviewPrice):null;
  const [holdQuote,setHoldQuote]=useState({loading:false,data:null,error:false});
  const [expiryQuote,setExpiryQuote]=useState({loading:false,data:null,error:false});
  const nextPos=positions.find(p=>p.rolledFrom===c.id);
  const nextClosed=closed.find(x=>x.rolledFrom===c.id);
  const rollTo={
    strike:c.rollToStrike??nextPos?.strike??nextClosed?.strike,
    expiry:c.rollToExpiry??nextPos?.expDate??nextClosed?.expDate,
    premium:c.rollToPremium??nextPos?.premium??nextClosed?.premium,
  };
  const nextProfit=nextClosed
    ?calcClosed(nextClosed,commPerSide).profit
    :nextPos
      ?calc(nextPos,commPerSide).profitNow??calc(nextPos,commPerSide).profitExp
      :null;
  useEffect(()=>{
    if(!canEstimateHold){
      setHoldQuote({loading:false,data:null,error:false});
      return;
    }
    let alive=true;
    setHoldQuote({loading:true,data:null,error:false});
    fetchOptionPriceCBOE(c.ticker,c.expDate,c.strike,c.type).then(data=>{
      if(alive)setHoldQuote({loading:false,data,error:!data?.price});
    }).catch(()=>{
      if(alive)setHoldQuote({loading:false,data:null,error:true});
    });
    return()=>{alive=false;};
  },[canEstimateHold,c.ticker,c.expDate,c.strike,c.type]);
  useEffect(()=>{
    if(!canReviewExpiry){
      setExpiryQuote({loading:false,data:null,error:false});
      return;
    }
    if(cachedExpiryPrice!=null){
      setExpiryQuote({loading:false,data:{
        price:cachedExpiryPrice,
        date:c.expiryReviewDate||c.expDate,
        source:c.expiryReviewSource||'Cached',
      },error:false});
      return;
    }
    let alive=true;
    setExpiryQuote({loading:true,data:null,error:false});
    fetchStockCloseOnDate(c.ticker,c.expDate).then(data=>{
      if(!alive)return;
      setExpiryQuote({loading:false,data,error:!data?.price});
      if(data?.price&&onUpdateExpiryReview){
        onUpdateExpiryReview(c.id,{
          price:data.price,
          date:data.date||c.expDate,
          source:data.source||'History',
          manual:false,
          silent:true,
        });
      }
    }).catch(()=>{
      if(alive)setExpiryQuote({loading:false,data:null,error:true});
    });
    return()=>{alive=false;};
  },[canReviewExpiry,cachedExpiryPrice,c.expiryReviewDate,c.expiryReviewSource,c.ticker,c.expDate,c.id,onUpdateExpiryReview]);
  const holdPrice=holdQuote.data?.price??null;
  const holdBuyback=holdPrice!=null?holdPrice*100*r.qty:null;
  const holdProfit=holdBuyback!=null?r.openPrem-holdBuyback-r.commUsed:null;
  const expiryPrice=expiryQuote.data?.price??null;
  const expiryReview=calcExpiryReview(c,r,expiryPrice,commPerSide);
  const detailNet=isAssigned?r.openPrem-(c.assignedMarketValue||0)-r.commUsed:r.profit;
  const badgeStyle=isRoll
    ?{color:ACC.purple,background:ACC.purpleBg,borderColor:`${ACC.purple}44`}
    :isAssigned
    ?{color:ACC.amber,background:ACC.amberSoft,borderColor:`${ACC.amber}44`}
    :isExpired
      ?{color:ACC.teal,background:ACC.tealBg,borderColor:`${ACC.teal}44`}
      :{color:ACC.blue,background:ACC.blueBg,borderColor:`${ACC.blue}44`};
  return(
    <div className="row-click" style={{borderBottom:'1px solid '+V('line'),overflow:'hidden'}}>
      <div className="closed-row-inner" style={{display:'grid',gridTemplateColumns:CLOSED_GRID,alignItems:'center',minHeight:52,padding:'4px 0'}}>
        <div style={{background:r.profit>=0?ACC.profit:ACC.loss,height:'100%',minHeight:46,borderRadius:2,opacity:.6}}/>
        <div style={{padding:'0 14px',display:'flex',flexDirection:'column',gap:2}}>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontWeight:700,fontSize:14,color:V('dim')}}>{c.ticker}</span>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:typeColor,opacity:.7,letterSpacing:'.06em'}}>卖 {isCall?'Call':'Put'}</span>
        </div>
        <div>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:13,color:ACC.amber,fontWeight:600}}>${fmt(c.strike,0)}</span>
          <div style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:V('faint')}}>×{c.qty}手</div>
        </div>
        <div>
          <div style={{fontFamily:'IBM Plex Mono,monospace',fontSize:11,color:V('dim')}}>{c.openDate}</div>
          <div style={{fontFamily:'IBM Plex Mono,monospace',fontSize:11,color:V('faint')}}>→ {c.closeDate}</div>
          {c.expDate&&<div style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:V('faint'),marginTop:2}}>原到期 {c.expDate}</div>}
        </div>
        <div style={{paddingRight:8}}>
          <span className="badge" style={badgeStyle}>
            {isRoll?'↻ Roll':isAssigned?'📦 接货':isExpired?'到期归零':'主动平仓'}
          </span>
          {!isRoll&&!isAssigned&&!isExpired&&c.expDate&&(
            <div style={{fontSize:10,color:V('faint'),fontFamily:'IBM Plex Mono,monospace',marginTop:3}}>原到期 {c.expDate}</div>
          )}
          {isAssigned&&<div style={{fontSize:10,color:V('faint'),fontFamily:'IBM Plex Mono,monospace',marginTop:3}}>{c.assignedShares}股 @ ${fmt(c.assignedCostPerShare)}</div>}
          {isRoll&&(
            <div style={{fontSize:10,color:V('faint'),fontFamily:'IBM Plex Mono,monospace',marginTop:3,lineHeight:1.45}}>
              {rollTo.strike!=null&&<div>续仓 ${fmt(rollTo.strike,0)}{rollTo.expiry?` · ${rollTo.expiry}`:''}</div>}
              {rollTo.premium!=null&&<div>新权利金 ${fmt(rollTo.premium)}</div>}
              {nextProfit!=null&&<div style={{color:nextProfit>=0?ACC.profit:ACC.loss}}>后续利润 {fmtM(nextProfit)}</div>}
            </div>
          )}
        </div>
        <div style={{padding:'0 10px',display:'flex',flexDirection:'column',gap:3}}>
          <div style={{display:'flex',alignItems:'center',gap:4,flexWrap:'wrap'}}>
            <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:13,color:ACC.amber,fontWeight:600}}>{'$'+fmt(r.openPrem)}</span>
            {!isExpired&&!isAssigned&&<><span style={{color:V('faint'),fontSize:11}}>{'−'}</span><span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:13,color:ACC.loss}}>{'$'+fmt(r.closePrem)}</span></>}
            {isAssigned&&<><span style={{color:V('faint'),fontSize:11}}>{'−'}</span><span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:13,color:ACC.loss}}>{'$'+fmt(c.assignedMarketValue,0)}</span></>}
            <span style={{color:V('faint'),fontSize:11}}>{'−'}</span>
            <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:13,color:ACC.loss}}>{'$'+fmt(r.commUsed)}</span>
          </div>
          <div style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:V('faint'),letterSpacing:'.04em'}}>
            {isExpired?'权利金 − 手续费':(isAssigned?'权利金 − 接货 − 费用':(isRoll?'旧仓权利金 − 买回 − 费用':'权利金 − 买回 − 费用'))}
          </div>
          <div style={{fontFamily:'IBM Plex Mono,monospace',fontSize:11,color:detailNet>=0?ACC.profit:ACC.loss,letterSpacing:'.04em',fontWeight:700}}>
            相减 = {fmtM(detailNet)}
          </div>
          {isRoll&&c.rollNetCredit!=null&&(
            <div style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:c.rollNetCredit>=0?ACC.profit:ACC.loss,letterSpacing:'.04em'}}>
              Roll 净收入 {fmtM(c.rollNetCredit)}
            </div>
          )}
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:2,alignItems:'flex-end',paddingRight:8}}>
          {canReviewExpiry?(
            expiryQuote.loading?(
              <>
                <span className="section-label">到期复盘</span>
                <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:12,color:V('faint')}}>拉取中...</span>
              </>
            ):expiryReview?(
              <>
                <span className="section-label">到期复盘</span>
                <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:12,color:expiryReview.wouldAssign?ACC.loss:ACC.profit,fontWeight:700}}>
                  {expiryReview.wouldAssign?'会行权':'未行权'}
                  <span style={{color:V('dim'),fontWeight:600}}> · </span>
                  <InlineEdit value={expiryPrice} onSave={v=>onUpdateExpiryReview&&onUpdateExpiryReview(c.id,{
                    price:v,date:c.expDate,source:'Manual',manual:true,
                  })}/>
                </span>
                <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:V('faint')}}>
                  {expiryQuote.data?.date&&expiryQuote.data.date!==c.expDate?`${expiryQuote.data.date} 收盘`:c.expiryReviewManual?'手动修正':'已缓存'}
                </span>
                <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:12,color:expiryReview.wouldAssign?ACC.amber:ACC.loss,fontWeight:600}}>
                  {expiryReview.wouldAssign
                    ?`避开内在 $${fmt(expiryReview.intrinsicValue)}`
                    :`少收权利金 $${fmt(expiryReview.lostPremium)}`}
                </span>
              </>
            ):(
              <>
                <span className="section-label">到期复盘</span>
                <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:12,color:V('faint')}}>暂无到期价</span>
                <InlineEdit value={null} onSave={v=>onUpdateExpiryReview&&onUpdateExpiryReview(c.id,{
                  price:v,date:c.expDate,source:'Manual',manual:true,
                })}/>
              </>
            )
          ):canEstimateHold?(
            holdQuote.loading?(
              <>
                <span className="section-label">未平估算</span>
                <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:12,color:V('faint')}}>拉取中...</span>
              </>
            ):holdProfit!=null?(
              <>
                <span className="section-label">未平估算</span>
                <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:13,color:V('dim')}}>现权利金 ${fmt(holdPrice)}</span>
                <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:15,fontWeight:700,color:holdProfit>=0?ACC.profit:ACC.loss}}>{fmtM(holdProfit)}</span>
              </>
            ):(
              <>
                <span className="section-label">未平估算</span>
                <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:12,color:V('faint')}}>暂无报价</span>
              </>
            )
          ):(
            <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:12,color:V('faint')}}>—</span>
          )}
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:2,alignItems:'flex-end',paddingRight:8}}>
          <span className="section-label">{isRoll?'旧仓收益':'期权收益'}</span>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:16,fontWeight:700,color:r.profit>=0?ACC.profit:ACC.loss}}>{fmtM(r.profit)}</span>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:2,alignItems:'flex-end',paddingRight:8}}>
          <span className="section-label">实现年化</span>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:16,fontWeight:700,color:r.annual>=0?ACC.profit:ACC.loss}}>{fmtA(r.annual)}</span>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:V('faint')}}>{r.daysHeld}天</span>
        </div>
        <div style={{display:'flex',justifyContent:'center'}}>
          <button onClick={onDelete} style={{background:'none',border:'none',color:V('faint'),cursor:'pointer',fontSize:14,padding:4}} title="删除记录">×</button>
        </div>
      </div>
    </div>
  );
}

/* ══ 股票仓位组件 ══════════════════════════════════════ */
function StockRow({s,onUpdatePrice,onDelete}){
  const costBasis=s.costPerShare*s.shares;
  const currentValue=s.currentPrice?s.currentPrice*s.shares:null;
  const unrealized=currentValue!=null?currentValue-costBasis:null;
  const unrealizedPct=unrealized!=null?(unrealized/costBasis)*100:null;
  const daysHeld=s.acquireDate?Math.max(1,daysBetween(s.acquireDate,today())):null;
  return(
    <div className="row-click" style={{borderBottom:'1px solid '+V('line'),overflow:'hidden'}}>
      <div className="stock-row-inner" style={{display:'grid',gridTemplateColumns:'3px 130px 120px 120px 1fr 130px 130px 36px',alignItems:'center',minHeight:54,padding:'4px 0'}}>
        <div style={{background:unrealized==null?V('line'):(unrealized>=0?ACC.profit:ACC.loss),height:'100%',minHeight:48,borderRadius:2,opacity:.7}}/>
        <div style={{padding:'0 14px',display:'flex',flexDirection:'column',gap:2}}>
          <span className="pos-ticker" style={{fontFamily:'IBM Plex Mono,monospace',fontWeight:700,fontSize:15,color:V('ink'),transition:'color .18s'}}>{s.ticker}</span>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:V('faint'),letterSpacing:'.04em'}}>
            {s.source==='assigned'?'📦 接货':'手动录入'}
          </span>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:2}}>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:14,color:V('ink'),fontWeight:600}}>{s.shares+' 股'}</span>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:V('faint')}}>{'成本 $'+fmt(s.costPerShare)+'/股'}</span>
        </div>
        <div>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:14,color:ACC.amber,fontWeight:600}}>{'$'+fmt(costBasis,0)}</span>
        </div>
        <div style={{padding:'0 12px',display:'flex',flexDirection:'column',gap:2}}>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:V('faint'),letterSpacing:'.08em'}}>{'当前价格'}</span>
          <InlineEdit value={s.currentPrice} onSave={v=>onUpdatePrice(s.id,v)}/>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:2,alignItems:'flex-end',paddingRight:8}}>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:15,fontWeight:600,color:V('ink')}}>
            {currentValue!=null?('$'+fmt(currentValue,0)):'—'}
          </span>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:2,alignItems:'flex-end',paddingRight:8}}>
          <span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:16,fontWeight:700,color:unrealized==null?V('faint'):unrealized>=0?ACC.profit:ACC.loss}}>
            {unrealized!=null?fmtM(unrealized):'—'}
          </span>
          {unrealizedPct!=null&&<span className={'risk-badge '+(unrealizedPct>=0?'risk-safe':'risk-itm')}>{fmtA(unrealizedPct)}</span>}
        </div>
        <div style={{display:'flex',justifyContent:'center'}}>
          <button onClick={()=>onDelete(s.id)} style={{background:'none',border:'none',color:V('faint'),cursor:'pointer',fontSize:13,padding:4,opacity:.5}}>{'×'}</button>
        </div>
      </div>
    </div>
  );
}

function StocksTableHeader(){
  const H=({t,right})=><div style={{fontSize:10,color:V('faint'),letterSpacing:'.12em',textTransform:'uppercase',fontFamily:'IBM Plex Mono,monospace',textAlign:right?'right':'left',padding:'0 4px'}}>{t}</div>;
  return(
    <div className="stock-table-header" style={{display:'grid',gridTemplateColumns:'4px 130px 120px 120px 1fr 130px 130px 36px',alignItems:'center',padding:'0 0 8px 0',marginBottom:4}}>
      <div/><H t="标的"/><H t="持仓"/><H t="成本基础"/><H t="现价"/><H t="当前市值" right/><H t="浮动盈亏" right/><div/>
    </div>
  );
}

function StocksSummary({stocks}){
  if(!stocks.length)return null;
  const totalCost=stocks.reduce((s,st)=>s+st.costPerShare*st.shares,0);
  const totalValue=stocks.filter(st=>st.currentPrice).reduce((s,st)=>s+st.currentPrice*st.shares,0);
  const totalUnreal=stocks.filter(st=>st.currentPrice).length?totalValue-stocks.filter(st=>st.currentPrice).reduce((s,st)=>s+st.costPerShare*st.shares,0):null;
  return(
    <div className="glass-card anim-in" style={{padding:'20px 24px',marginBottom:16}}>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))',gap:20,alignItems:'end'}}>
        <div style={{display:'flex',flexDirection:'column',gap:4}}>
          <span className="section-label">总成本基础</span>
          <span style={{fontSize:26,fontWeight:700,color:ACC.amber,fontFamily:'IBM Plex Mono,monospace',lineHeight:1}}>${fmt(totalCost,0)}</span>
        </div>
        {totalValue>0&&<div style={{display:'flex',flexDirection:'column',gap:4}}>
          <span className="section-label">当前总市值</span>
          <span style={{fontSize:26,fontWeight:700,color:V('ink'),fontFamily:'IBM Plex Mono,monospace',lineHeight:1}}>${fmt(totalValue,0)}</span>
        </div>}
        {totalUnreal!=null&&<div style={{display:'flex',flexDirection:'column',gap:4}}>
          <span className="section-label">总浮动盈亏</span>
          <span style={{fontSize:28,fontWeight:700,color:totalUnreal>=0?ACC.profit:ACC.loss,fontFamily:'IBM Plex Mono,monospace',lineHeight:1}}>{fmtM(totalUnreal)}</span>
          <span className={'risk-badge '+(totalUnreal>=0?'risk-safe':'risk-itm')} style={{alignSelf:'flex-start',marginTop:2}}>{fmtA(totalCost>0?(totalUnreal/totalCost)*100:null)}</span>
        </div>}
        <div style={{display:'flex',flexDirection:'column',gap:4}}>
          <span className="section-label">持股标的</span>
          <span style={{fontSize:26,fontWeight:700,color:V('dim'),fontFamily:'IBM Plex Mono,monospace',lineHeight:1}}>{stocks.length}</span>
        </div>
      </div>
    </div>
  );
}

/* 手动添加股票表单 */
function AddStockForm({onAdd,onCancel}){
  const [f,setF]=useState({ticker:'',shares:'',costPerShare:'',acquireDate:today()});
  const set=(k,v)=>setF(p=>({...p,[k]:v}));
  const valid=f.ticker&&f.shares&&f.costPerShare;
  return(
    <div className="card mobile-form-card anim-in" style={{padding:20,marginBottom:14,borderColor:`${ACC.profit}33`}}>
      <div style={{fontSize:13,fontWeight:700,color:ACC.profit,marginBottom:16}}>＋ 手动录入股票仓位</div>
      <div className="mobile-form-grid" style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:12,marginBottom:14}}>
        <Field label="标的代码" value={f.ticker} onChange={v=>set('ticker',v.toUpperCase())} placeholder="MRVL"/>
        <NumField label="持仓股数" value={f.shares} onChange={v=>set('shares',v)} placeholder="100" suffix="股"/>
        <NumField label="每股成本" prefix="$" value={f.costPerShare} onChange={v=>set('costPerShare',v)} placeholder="190.00"/>
        <DateField label="买入日期" value={f.acquireDate} onChange={v=>set('acquireDate',v)}/>
      </div>
      <div style={{display:'flex',gap:8}}>
        <button onClick={()=>{if(!valid)return;onAdd({id:Date.now(),ticker:f.ticker,shares:parseInt(f.shares),costPerShare:parseFloat(f.costPerShare),acquireDate:f.acquireDate,source:'manual',currentPrice:null});}} disabled={!valid} className="btn btn-primary">添加</button>
        <button onClick={onCancel} className="btn btn-ghost">取消</button>
      </div>
    </div>
  );
}

function ClosedTableHeader(){
  const H=({t,right})=><div style={{fontSize:10,color:V('faint'),letterSpacing:'.12em',textTransform:'uppercase',fontFamily:'IBM Plex Mono,monospace',textAlign:right?'right':'left',padding:'0 4px'}}>{t}</div>;
  return(
    <div className="closed-table-header" style={{display:'grid',gridTemplateColumns:CLOSED_GRID,alignItems:'center',padding:'0 0 8px 0',marginBottom:4}}>
      <div/><H t="标的"/><H t="行权价"/><H t="开/平仓日"/><H t="方式"/><H t="收支明细"/><H t="估算 / 复盘" right/><H t="净利润" right/><H t="实现年化" right/><div/>
    </div>
  );
}

/* 已平仓汇总 */
function ClosedSummary({closed,commPerSide}){
  if(!closed.length)return null;
  const rs=closed.map(c=>calcClosed(c,commPerSide));
  const totalProfit=rs.reduce((s,r)=>s+r.profit,0);
  const avgAnnual=rs.reduce((s,r)=>s+(r.annual||0),0)/rs.length;
  const wins=rs.filter(r=>r.profit>0).length;
  return(
    <div className="glass-card anim-in" style={{padding:'20px 24px',marginBottom:16}}>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))',gap:20,alignItems:'end'}}>
        <div style={{display:'flex',flexDirection:'column',gap:4}}>
          <span className="section-label">累计已实现利润</span>
          <span style={{fontSize:28,fontWeight:700,color:totalProfit>=0?ACC.profit:ACC.loss,fontFamily:'IBM Plex Mono,monospace',lineHeight:1}}>{fmtM(totalProfit)}</span>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:4}}>
          <span className="section-label">平均实现年化</span>
          <span style={{fontSize:28,fontWeight:700,color:avgAnnual>=0?ACC.profit:ACC.loss,fontFamily:'IBM Plex Mono,monospace',lineHeight:1}}>{fmtA(avgAnnual)}</span>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:4}}>
          <span className="section-label">胜率</span>
          <div style={{display:'flex',alignItems:'baseline',gap:8}}>
            <span style={{fontSize:28,fontWeight:700,color:ACC.blue,fontFamily:'IBM Plex Mono,monospace',lineHeight:1}}>{((wins/closed.length)*100).toFixed(0)}%</span>
            <span className="risk-badge risk-safe" style={{fontSize:10}}>{wins+'/'+closed.length+' 盈利'}</span>
          </div>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:4}}>
          <span className="section-label">总笔数</span>
          <span style={{fontSize:28,fontWeight:700,color:V('dim'),fontFamily:'IBM Plex Mono,monospace',lineHeight:1}}>{closed.length}</span>
        </div>
      </div>
    </div>
  );
}

/* ══ A/H 股账户工作台 ═════════════════════════════════ */
const cnMoney=(n,currency='CNY',signed=false,d=2)=>{
  if(n==null||!Number.isFinite(Number(n)))return'—';
  const value=Number(n),mark=currency==='HKD'?'HK$':'¥';
  return `${signed&&value>=0?'+':''}${value<0?'-':''}${mark}${fmt(Math.abs(value),d)}`;
};
const cnStockRate=(stock,hkdCnyRate)=>stock?.market==='HK'?num(hkdCnyRate,DEFAULT_HKD_CNY_RATE):1;
const cnStockCny=(stock,value,hkdCnyRate)=>value==null?null:num(value)*cnStockRate(stock,hkdCnyRate);
const datePlus=(days)=>{const d=new Date();d.setDate(d.getDate()+days);return d.toISOString().slice(0,10);};
const num=(value,fallback=0)=>{const n=Number(value);return Number.isFinite(n)?n:fallback;};
const CN_OPTION_FEE_PER_CONTRACT=2;
const cnOptionFee=(value,qty,manual=false)=>manual?num(value):(num(value)>0?num(value):Math.max(1,num(qty,1))*CN_OPTION_FEE_PER_CONTRACT);
const estimateCnOptionMargin=(p,nominal,openCash)=>{
  const manual=num(p.marginUsed);
  if(manual>0)return manual;
  return p.side==='SELL'?nominal:openCash;
};
const cnIndexEquivalent=(strike,etfPrice,indexPrice)=>num(strike)>0&&num(etfPrice)>0&&num(indexPrice)>0
  ?num(strike)/num(etfPrice)*num(indexPrice):null;
const cnOptionExpiry=(month)=>{
  const value=String(month||'');
  if(!/^\d{6}$/.test(value))return datePlus(30);
  const year=Number(value.slice(0,4)),monthIndex=Number(value.slice(4,6))-1;
  const first=new Date(year,monthIndex,1);
  const firstWednesday=1+((3-first.getDay()+7)%7);
  return `${year}-${String(monthIndex+1).padStart(2,'0')}-${String(firstWednesday+21).padStart(2,'0')}`;
};
const cnOptionMonthFromDate=(date)=>String(date||'').replace(/\D/g,'').slice(0,6);
const findCnPositionContract=(position,contracts=[])=>{
  const code=String(position.contractCode||'').trim().toUpperCase();
  if(code){
    const exact=contracts.find(contract=>String(contract.code||'').trim().toUpperCase()===code);
    if(exact)return exact;
  }
  const strike=num(position.strike,NaN),expiry=String(position.expDate||'').slice(0,10);
  const matches=contracts.filter(contract=>contract.type===position.type&&Number.isFinite(strike)&&Math.abs(num(contract.strike,NaN)-strike)<0.0005);
  return matches.find(contract=>String(contract.expiry||'').slice(0,10)===expiry)||matches[0]||null;
};
const cnOptionMark=(contract)=>{
  const last=num(contract?.last,NaN);
  if(Number.isFinite(last)&&last>=0)return last;
  const bid=num(contract?.bid,NaN),ask=num(contract?.ask,NaN);
  if(Number.isFinite(bid)&&Number.isFinite(ask)&&bid>=0&&ask>=0)return(bid+ask)/2;
  const settlement=num(contract?.settlement,NaN);
  return Number.isFinite(settlement)&&settlement>=0?settlement:null;
};
async function fetchCnOptionSnapshot(symbol,month){
  const response=await cnOptionFetch(symbol,month);
  const raw=await response.text();
  let payload;
  try{payload=JSON.parse(raw);}catch{throw new Error('期权行情返回格式异常');}
  if(!response.ok)throw new Error(payload?.detail||payload?.error||`HTTP ${response.status}`);
  return payload;
}

function calcCnOption(p,markPrice=p.currentPrice){
  const qty=Math.max(1,num(p.qty,1));
  const multiplier=Math.max(1,num(p.multiplier,10000));
  const openPrice=num(p.openPrice);
  const currentPrice=num(markPrice);
  const direction=p.side==='BUY'?1:-1;
  const gross=(currentPrice-openPrice)*multiplier*qty*direction;
  const fees=cnOptionFee(p.fees,qty,p.feesManual===true);
  const pnl=gross-fees;
  const openCash=openPrice*multiplier*qty;
  const nominal=num(p.strike)*multiplier*qty;
  const margin=estimateCnOptionMargin(p,nominal,openCash);
  const daysLeft=Math.max(0,daysBetween(today(),p.expDate||today()));
  const daysHeld=Math.max(1,daysBetween(p.openDate||today(),today()));
  let buffer=null;
  if(num(p.underlyingPrice)>0&&num(p.strike)>0){
    buffer=p.type==='P'
      ?((num(p.underlyingPrice)-num(p.strike))/num(p.underlyingPrice))*100
      :((num(p.strike)-num(p.underlyingPrice))/num(p.underlyingPrice))*100;
  }
  return{qty,multiplier,gross,fees,pnl,openCash,nominal,margin,daysLeft,daysHeld,buffer};
}

function scoreCnOption(p,r,totalMargin=0){
  let score=78;
  const notes=[];
  const add=(delta,msg)=>{score+=delta;if(msg)notes.push({delta,msg});};
  const delta=Math.abs(num(p.delta,NaN));
  if(r.daysLeft<=3)add(-22,'到期 3 天内，Gamma 风险很高');
  else if(r.daysLeft<=7)add(-15,'到期不足一周，需要盯盘');
  else if(r.daysLeft<=14)add(-7,'临近到期，准备移仓或止盈');
  else if(r.daysLeft>=20&&r.daysLeft<=55)add(5,'期限处于较舒适区间');
  if(r.buffer==null)add(-5,'缺少标的价格，未计入价外缓冲');
  else if(r.buffer<=0)add(-28,'合约已进入实值区');
  else if(r.buffer<3)add(-18,'价外缓冲不足 3%');
  else if(r.buffer<8)add(-8,'价外缓冲偏薄');
  else if(r.buffer>=15)add(6,'价外缓冲充足');
  if(Number.isFinite(delta)){
    if(delta>.4)add(-16,'Delta 偏高');
    else if(delta>.25)add(-8,'方向敞口需要关注');
    else if(delta>=.08&&delta<=.2)add(6,'Delta 位于常用卖方区间');
  }else add(-3,'缺少 Delta，评分保守处理');
  if(p.side==='SELL'&&totalMargin>0&&r.margin/totalMargin>.35)add(-9,'单笔占用超过期权保证金的 35%');
  if(p.side==='BUY')add(2,'买方最大亏损已锁定');
  const value=Math.round(clamp(score,0,100));
  return{score:value,label:scoreLabel(value),color:scoreColor(value),notes:notes.sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)).slice(0,3)};
}

function calcCnClosed(p){
  const r=calcCnOption(p,p.closePrice);
  const closeFees=cnOptionFee(p.closeFees,r.qty,p.closeFeesManual===true);
  const pnl=r.pnl-closeFees;
  const daysHeld=Math.max(1,daysBetween(p.openDate||today(),p.closeDate||today()));
  const capital=num(p.marginUsed)||r.openCash||r.nominal;
  return{...r,pnl,totalFees:r.fees+closeFees,daysHeld,annual:calcAnnual(pnl,capital,daysHeld)};
}

function CnOptionForm({onAdd,onCancel,currentIndex}){
  const [f,setF]=useState({
    underlying:'159922',underlyingName:'嘉实中证500ETF',exchange:'SZSE',contractCode:'',
    type:'P',side:'SELL',strike:'',qty:'1',multiplier:'10000',openDate:today(),expDate:cnOptionExpiry(CN_OPTION_NEXT_MONTH),
    openPrice:'',currentPrice:'',underlyingPrice:'',indexPrice:currentIndex??'',delta:'',iv:'',marginUsed:'',fees:'',
  });
  const [advanced,setAdvanced]=useState(false);
  const set=(key,value)=>setF(prev=>({...prev,[key]:value}));
  const setUnderlying=(value)=>setF(prev=>value==='510500'
    ?{...prev,underlying:value,underlyingName:'南方中证500ETF',exchange:'SSE'}
    :{...prev,underlying:'159922',underlyingName:'嘉实中证500ETF',exchange:'SZSE'});
  const setTrade=(value)=>{const [side,type]=value.split('-');setF(prev=>({...prev,side,type}));};
  useEffect(()=>{if(currentIndex>0)setF(prev=>prev.indexPrice===''?{...prev,indexPrice:currentIndex}:prev);},[currentIndex]);
  const valid=f.underlying&&f.strike&&f.qty&&f.multiplier&&f.openPrice&&f.expDate;
  const qty=Math.max(1,num(f.qty,1));
  const grossPremium=num(f.openPrice)*10000*qty;
  const nominal=num(f.strike)*10000*qty;
  const submit=()=>{
    if(!valid)return;
    onAdd({...f,id:Date.now(),qty:num(f.qty,1),multiplier:num(f.multiplier,10000),strike:num(f.strike),
      openPrice:num(f.openPrice),currentPrice:f.currentPrice===''?num(f.openPrice):num(f.currentPrice),
      underlyingPrice:f.underlyingPrice===''?null:num(f.underlyingPrice),delta:f.delta===''?null:num(f.delta),
      indexPrice:f.indexPrice===''?null:num(f.indexPrice),iv:f.iv===''?null:num(f.iv)/100,
      marginUsed:num(f.marginUsed),fees:f.fees===''?qty*CN_OPTION_FEE_PER_CONTRACT:num(f.fees),feesManual:f.fees!=='',feePerContract:CN_OPTION_FEE_PER_CONTRACT,currency:'CNY'});
  };
  return(
    <div className="cn-account-form anim-in">
      <div className="cn-form-title"><span>＋ 添加 A 股期权仓位</span><small>与美股录入一致，只保留交易必填项；乘数固定 10,000，行情与 Greeks 可稍后补充</small></div>
      <div className="cn-form-grid cn-option-core">
        <SelectField label="标的" value={f.underlying} onChange={setUnderlying} options={[{value:'159922',label:'159922 · 嘉实中证500ETF'},{value:'510500',label:'510500 · 南方中证500ETF'}]}/>
        <SelectField label="交易" value={`${f.side}-${f.type}`} onChange={setTrade} options={[{value:'SELL-P',label:'卖 Put'},{value:'SELL-C',label:'卖 Call'},{value:'BUY-C',label:'买 Call'},{value:'BUY-P',label:'买 Put'}]}/>
        <NumField label="行权价" prefix="¥" value={f.strike} onChange={v=>set('strike',v)} placeholder="5.000"/>
        <NumField label="张数" value={f.qty} onChange={v=>set('qty',v)} suffix="张"/>
        <DateField label="开仓日期" value={f.openDate} onChange={v=>set('openDate',v)}/>
        <DateField label="到期日期" value={f.expDate} onChange={v=>set('expDate',v)}/>
        <NumField label="开仓权利金" prefix="¥" suffix="/份" value={f.openPrice} onChange={v=>set('openPrice',v)} placeholder="0.1200"/>
        <div className="cn-entry-preview">
          <span>自动计算</span>
          <strong>{f.openPrice?cnMoney(grossPremium):'等待权利金'}</strong>
          <small>{f.strike?`名义本金 ${cnMoney(nominal)} · 手续费 ¥${CN_OPTION_FEE_PER_CONTRACT}/张`:`乘数 10,000 份/张 · 手续费 ¥${CN_OPTION_FEE_PER_CONTRACT}/张`}</small>
        </div>
      </div>
      <button type="button" className={`cn-advanced-toggle${advanced?' open':''}`} onClick={()=>setAdvanced(value=>!value)} aria-expanded={advanced}>
        <span>高级选项</span><small>合约代码、最新行情、Delta / IV、保证金与手续费</small><b>{advanced?'收起 ↑':'展开 ↓'}</b>
      </button>
      {advanced&&<div className="cn-form-grid cn-option-advanced anim-in">
        <Field label="期权合约代码" value={f.contractCode} onChange={v=>set('contractCode',v.trim())} placeholder="可选"/>
        <NumField label="期权现价" prefix="¥" value={f.currentPrice} onChange={v=>set('currentPrice',v)} placeholder="默认等于开仓价"/>
        <NumField label="标的现价" prefix="¥" value={f.underlyingPrice} onChange={v=>set('underlyingPrice',v)} placeholder="可选"/>
        <NumField label="中证500指数" value={f.indexPrice} onChange={v=>set('indexPrice',v)} suffix="点" placeholder="自动获取"/>
        <NumField label="Delta" value={f.delta} onChange={v=>set('delta',v)} placeholder="-0.18"/>
        <NumField label="IV" value={f.iv} onChange={v=>set('iv',v)} suffix="%" placeholder="25.0"/>
        <NumField label="保证金占用" prefix="¥" value={f.marginUsed} onChange={v=>set('marginUsed',v)} placeholder="卖方选填"/>
        <NumField label="开仓手续费" prefix="¥" value={f.fees} onChange={v=>set('fees',v)} placeholder={`默认 ${fmt(qty*CN_OPTION_FEE_PER_CONTRACT,2)}`}/>
      </div>}
      <div className="cn-form-actions"><button className="btn btn-primary" disabled={!valid} onClick={submit}>添加仓位</button><button className="btn btn-ghost" onClick={onCancel}>取消</button></div>
    </div>
  );
}

function CnOptionRow({p,totalMargin,currentIndex,onUpdate,onClose,onDelete}){
  const [mode,setMode]=useState('');
  const [edit,setEdit]=useState({currentPrice:p.currentPrice??'',underlyingPrice:p.underlyingPrice??'',indexPrice:currentIndex??p.indexPrice??'',delta:p.delta??'',iv:p.iv==null?'':p.iv*100,marginUsed:p.marginUsed??''});
  const [close,setClose]=useState({closePrice:p.currentPrice??'',closeDate:today(),closeFees:String(Math.max(1,num(p.qty,1))*CN_OPTION_FEE_PER_CONTRACT)});
  const r=calcCnOption(p),health=scoreCnOption(p,r,totalMargin);
  const indexPrice=currentIndex??p.indexPrice;
  const indexStrike=cnIndexEquivalent(p.strike,p.underlyingPrice,indexPrice);
  const setE=(key,value)=>setEdit(prev=>({...prev,[key]:value}));
  const setC=(key,value)=>setClose(prev=>({...prev,[key]:value}));
  return(
    <article className="cn-position-card" style={{'--cn-accent':health.color}}>
      <div className="cn-position-main">
        <div className="cn-position-id"><div><strong>{p.underlying}</strong><span>{p.underlyingName||p.contractCode||'A股期权'}</span></div><div className="cn-chips"><b className={p.side==='SELL'?'sell':'buy'}>{p.side==='SELL'?'卖出':'买入'}</b><b>{p.type==='P'?'PUT 认沽':'CALL 认购'}</b><i>{p.exchange==='SSE'?'上交所':'深交所'}</i></div></div>
        <div className="cn-position-metrics">
          <Stat label="行权价" value={`¥${fmt(p.strike,3)}`} sub={`${r.qty}张 × ${fmt(r.multiplier,0)}`}/>
          <Stat label="到期" value={`${r.daysLeft}天`} sub={p.expDate}/>
          <Stat label="开仓 / 现价" value={`${fmt(p.openPrice,4)} / ${fmt(p.currentPrice,4)}`} sub={p.contractCode||'手动录入'}/>
          <Stat label="ETF / 指数等效" value={p.underlyingPrice==null?'待录入':`¥${fmt(p.underlyingPrice,3)} → ${indexStrike==null?'—':fmt(indexStrike,0)}点`} sub={`${indexPrice?`中证500 ${fmt(indexPrice,0)} · `:''}${r.buffer==null?'未计算缓冲':`缓冲 ${fmt(r.buffer,1)}%`}`}/>
          <Stat label="IV / Delta" value={`${p.iv==null?'—':fmt(p.iv*100,1)+'%'} / ${p.delta==null?'—':fmt(p.delta,3)}`} sub={`保证金 ${cnMoney(r.margin)}`}/>
          <Stat label="浮动盈亏" value={cnMoney(r.pnl,'CNY',true)} sub={`手续费 ${cnMoney(r.fees)}`} color={r.pnl>=0?ACC.profit:ACC.loss}/>
        </div>
        <div className="cn-position-side"><span className="section-label">健康分</span><strong className="health-pill" style={{'--health-color':health.color}}>{health.score}</strong><small style={{color:health.color}}>{health.label}</small></div>
        <div className="cn-row-actions"><button onClick={()=>setMode(mode==='edit'?'':'edit')}>更新</button><button className="profit" onClick={()=>setMode(mode==='close'?'':'close')}>平仓</button><button className="danger" onClick={()=>{if(window.confirm(`确认删除 ${p.underlying} 这笔持仓？`))onDelete(p.id);}}>删除</button></div>
      </div>
      {mode==='edit'&&<div className="cn-inline-panel"><div className="cn-inline-grid"><NumField label="期权现价" prefix="¥" value={edit.currentPrice} onChange={v=>setE('currentPrice',v)}/><NumField label="标的现价" prefix="¥" value={edit.underlyingPrice} onChange={v=>setE('underlyingPrice',v)}/><NumField label="中证500指数" suffix="点" value={edit.indexPrice} onChange={v=>setE('indexPrice',v)}/><NumField label="Delta" value={edit.delta} onChange={v=>setE('delta',v)}/><NumField label="IV" suffix="%" value={edit.iv} onChange={v=>setE('iv',v)}/><NumField label="保证金占用" prefix="¥" value={edit.marginUsed} onChange={v=>setE('marginUsed',v)}/></div><div className="cn-form-actions"><button className="btn btn-primary" onClick={()=>{onUpdate(p.id,{currentPrice:num(edit.currentPrice),underlyingPrice:edit.underlyingPrice===''?null:num(edit.underlyingPrice),indexPrice:edit.indexPrice===''?null:num(edit.indexPrice),delta:edit.delta===''?null:num(edit.delta),iv:edit.iv===''?null:num(edit.iv)/100,marginUsed:num(edit.marginUsed)});setMode('');}}>保存行情</button><button className="btn btn-ghost" onClick={()=>setMode('')}>取消</button></div></div>}
      {mode==='close'&&<div className="cn-inline-panel close"><div><strong>确认平仓</strong><p>实现收益会按开平价、方向、乘数及两端手续费计算。</p></div><div className="cn-inline-grid compact"><NumField label="平仓价" prefix="¥" value={close.closePrice} onChange={v=>setC('closePrice',v)}/><DateField label="平仓日期" value={close.closeDate} onChange={v=>setC('closeDate',v)}/><NumField label="平仓手续费（¥2/张）" prefix="¥" value={close.closeFees} onChange={v=>setC('closeFees',v)}/></div><div className="cn-form-actions"><button className="btn btn-primary" disabled={close.closePrice===''} onClick={()=>onClose(p,{closePrice:num(close.closePrice),closeDate:close.closeDate,closeFees:num(close.closeFees),closeFeesManual:true,closeFeePerContract:CN_OPTION_FEE_PER_CONTRACT})}>计入已平仓</button><button className="btn btn-ghost" onClick={()=>setMode('')}>取消</button></div></div>}
    </article>
  );
}

function CnStockForm({onAdd,onCancel}){
  const [f,setF]=useState({market:'CN',ticker:'',name:'',shares:'',costPerShare:'',acquireDate:today()});
  const [saving,setSaving]=useState(false);
  const set=(key,value)=>setF(prev=>({...prev,[key]:value}));
  const valid=f.ticker&&f.shares&&f.costPerShare;
  const submit=async()=>{
    if(!valid||saving)return;
    setSaving(true);
    const quote=await fetchCnStockQuote(f.market,f.ticker);
    onAdd({...f,name:f.name.trim()||quote.name||'',id:Date.now(),shares:num(f.shares),costPerShare:num(f.costPerShare),
      currentPrice:quote.price,currency:f.market==='HK'?'HKD':'CNY',source:'auto-quote',
      quoteSymbol:quote.quoteSymbol,priceUpdatedAt:quote.price==null?null:Date.now()});
  };
  return(
    <div className="cn-account-form anim-in">
      <div className="cn-form-title"><span>＋ 录入股票持仓</span><small>港股通成本仍按港币录入，持仓页会按 HKD/CNY 折成人民币汇总</small></div>
      <div className="cn-form-grid stock">
        <SelectField label="市场" value={f.market} onChange={v=>set('market',v)} options={[{value:'CN',label:'A 股'},{value:'HK',label:'港股通'}]}/>
        <Field label="证券代码" value={f.ticker} onChange={v=>set('ticker',v.trim())} placeholder={f.market==='HK'?'00700':'600519'}/>
        <Field label="证券名称" value={f.name} onChange={v=>set('name',v)} placeholder="自动获取，可选修改"/>
        <NumField label="持仓股数" value={f.shares} onChange={v=>set('shares',v)} suffix="股"/>
        <NumField label="每股成本" prefix={f.market==='HK'?'HK$':'¥'} value={f.costPerShare} onChange={v=>set('costPerShare',v)}/>
        <DateField label="买入日期" value={f.acquireDate} onChange={v=>set('acquireDate',v)}/>
        <div className="cn-stock-autoquote"><span>当前价格</span><strong>{saving?'正在获取…':'自动获取'}</strong><small>{f.ticker?cnStockQuoteSymbol(f.market,f.ticker):'填写代码后保存'}</small></div>
      </div>
      <div className="cn-form-actions"><button className="btn btn-primary" disabled={!valid||saving} onClick={submit}>{saving?'获取行情中…':'保存持仓'}</button><button className="btn btn-ghost" onClick={onCancel}>取消</button></div>
    </div>
  );
}

function CnStockRow({stock,hkdCnyRate,onRefresh,onDelete,refreshing}){
  const currency=stock.currency||((stock.market==='HK')?'HKD':'CNY');
  const cost=num(stock.shares)*num(stock.costPerShare);
  const value=stock.currentPrice==null?null:num(stock.shares)*num(stock.currentPrice);
  const pnl=value==null?null:value-cost;
  const costCny=cnStockCny(stock,cost,hkdCnyRate);
  const valueCny=cnStockCny(stock,value,hkdCnyRate);
  const pnlCny=cnStockCny(stock,pnl,hkdCnyRate);
  const costPerShareCny=cnStockCny(stock,stock.costPerShare,hkdCnyRate);
  const currentPriceCny=cnStockCny(stock,stock.currentPrice,hkdCnyRate);
  const exchange=stock.market==='HK'?'港股通':String(stock.ticker).startsWith('6')?'沪市':'深市';
  const costSub=stock.market==='HK'?`${cnMoney(stock.costPerShare,currency)} × ${fmt(cnStockRate(stock,hkdCnyRate),4)} · 成本 ${cnMoney(costCny)}`:`成本 ${cnMoney(costCny)}`;
  const valueSub=stock.market==='HK'
    ?(value==null?'自动行情':`${cnMoney(stock.currentPrice,currency)} × ${fmt(cnStockRate(stock,hkdCnyRate),4)} · 市值 ${cnMoney(valueCny)}`)
    :(value==null?'自动行情':`市值 ${cnMoney(valueCny)}`);
  return(
    <article className="cn-stock-card">
      <div className="cn-stock-id"><b>{stock.ticker}</b><strong>{stock.name||'未命名证券'}</strong><span className={stock.market==='HK'?'hk':''}>{exchange}</span></div>
      <div className="cn-stock-metrics"><Stat label="持仓" value={`${fmt(stock.shares,0)} 股`} sub={stock.acquireDate}/><Stat label="成本价" value={cnMoney(costPerShareCny)} sub={costSub}/><Stat label="当前价" value={stock.currentPrice==null?'同步中':cnMoney(currentPriceCny)} sub={valueSub}/><Stat label="浮动盈亏" value={pnl==null?'—':cnMoney(pnlCny,'CNY',true)} sub={pnl==null?'行情同步后计算':fmtA(cost?100*pnl/cost:null)} color={pnl==null?V('dim'):pnl>=0?ACC.profit:ACC.loss}/></div>
      <div className="cn-row-actions"><button onClick={()=>onRefresh(stock)} disabled={refreshing}>{refreshing?'同步中…':'刷新行情'}</button><button className="danger" onClick={()=>{if(window.confirm(`确认删除 ${stock.ticker}？`))onDelete(stock.id);}}>删除</button></div>
    </article>
  );
}

function CnAccountPanel({positions,closed,stocks,onPositions,onClosed,onStocks,onAccountChange,showToast}){
  const [view,setView]=useState('options');
  const [showForm,setShowForm]=useState(false);
  const [indexQuote,setIndexQuote]=useState(()=>readCsi500Cache());
  const [refreshingStock,setRefreshingStock]=useState(null);
  const [refreshingOptions,setRefreshingOptions]=useState(false);
  const [stockMarketFilter,setStockMarketFilter]=useState('ALL');
  const [stockQuery,setStockQuery]=useState('');
  const [hkdCnyQuote,setHkdCnyQuote]=useState(()=>readHkdCnyCache(30*24*60*60*1000)||{rate:DEFAULT_HKD_CNY_RATE,source:'fallback'});
  useEffect(()=>{
    let alive=true;
    loadCsi500Index().then(payload=>{if(alive&&payload?.price>0)setIndexQuote(payload);});
    return()=>{alive=false;};
  },[]);
  useEffect(()=>{
    let alive=true;
    loadHkdCnyRate().then(payload=>{if(alive&&payload?.rate>0)setHkdCnyQuote(payload);});
    return()=>{alive=false;};
  },[]);
  const hkdCnyRate=hkdCnyQuote?.rate||DEFAULT_HKD_CNY_RATE;
  const totalMargin=positions.reduce((sum,p)=>sum+calcCnOption(p).margin,0);
  const optionPnl=positions.reduce((sum,p)=>sum+calcCnOption(p).pnl,0);
  const closedPnl=closed.reduce((sum,p)=>sum+calcCnClosed(p).pnl,0);
  const scores=positions.map(p=>scoreCnOption(p,calcCnOption(p),totalMargin).score);
  const avgScore=scores.length?Math.round(scores.reduce((a,b)=>a+b,0)/scores.length):null;
  const cnStocks=stocks.filter(s=>s.market!=='HK'),hkStocks=stocks.filter(s=>s.market==='HK');
  const normalizedStockQuery=stockQuery.trim().toLowerCase();
  const filteredStocks=stocks.filter(stock=>{
    if(stockMarketFilter==='CN'&&stock.market==='HK')return false;
    if(stockMarketFilter==='HK'&&stock.market!=='HK')return false;
    if(!normalizedStockQuery)return true;
    return [stock.ticker,stock.name,stock.quoteSymbol].some(value=>String(value||'').toLowerCase().includes(normalizedStockQuery));
  });
  const totals=(items)=>items.reduce((acc,s)=>{const cost=num(s.shares)*cnStockCny(s,s.costPerShare,hkdCnyRate);const value=s.currentPrice==null?null:num(s.shares)*cnStockCny(s,s.currentPrice,hkdCnyRate);return{cost:acc.cost+cost,value:acc.value+(value??0),priced:acc.priced+(value==null?0:1)};},{cost:0,value:0,priced:0});
  const cnTotal=totals(cnStocks),hkTotal=totals(hkStocks);
  const stockQuoteKey=stocks.map(stock=>`${stock.id}:${stock.market}:${stock.ticker}`).join('|');
  useEffect(()=>{
    if(!stockQuoteKey)return;
    let alive=true;
    Promise.all(stocks.map(async stock=>({id:stock.id,...await fetchCnStockQuote(stock.market,stock.ticker)}))).then(quotes=>{
      if(!alive)return;
      const byId=new Map(quotes.filter(item=>item.price!=null||item.name).map(item=>[item.id,item]));
      let changed=false;
      const next=stocks.map(stock=>{const quote=byId.get(stock.id);if(!quote)return stock;const currentPrice=quote.price??stock.currentPrice;const name=stock.name||quote.name||'';if(currentPrice===stock.currentPrice&&name===stock.name)return stock;changed=true;return{...stock,name,currentPrice,quoteSymbol:quote.quoteSymbol,priceUpdatedAt:quote.price==null?stock.priceUpdatedAt:Date.now()};});
      if(changed)onStocks(next);
    });
    return()=>{alive=false;};
  },[stockQuoteKey]);
  const addLabel=view==='options'?'录入期权':view==='stocks'?'录入股票':'';
  const addPosition=(item)=>{onPositions([...positions,item]);setShowForm(false);showToast(`已添加 ${item.underlying} ${item.type==='P'?'认沽':'认购'}`);};
  const refreshOptionPositions=async()=>{
    if(!positions.length||refreshingOptions)return;
    setRefreshingOptions(true);
    const groups=[...new Map(positions.map(position=>{
      const month=cnOptionMonthFromDate(position.expDate);
      return[`${position.underlying}-${month}`,{symbol:position.underlying,month}];
    })).values()];
    const [freshIndex,results]=await Promise.all([
      loadCsi500Index(true),
      Promise.all(groups.map(async group=>{
        try{return{...group,payload:await fetchCnOptionSnapshot(group.symbol,group.month)};}
        catch(error){return{...group,error};}
      })),
    ]);
    if(freshIndex?.price>0)setIndexQuote(freshIndex);
    const snapshots=new Map(results.filter(result=>result.payload).map(result=>[`${result.symbol}-${result.month}`,result.payload]));
    let matched=0;
    const updatedAt=Date.now();
    const next=positions.map(position=>{
      const month=cnOptionMonthFromDate(position.expDate);
      const snapshot=snapshots.get(`${position.underlying}-${month}`);
      const contract=findCnPositionContract(position,snapshot?.contracts);
      const indexPrice=freshIndex?.price??snapshot?.indexPrice??position.indexPrice;
      if(!snapshot||!contract)return indexPrice===position.indexPrice?position:{...position,indexPrice};
      matched+=1;
      const mark=cnOptionMark(contract);
      return{...position,
        currentPrice:mark??position.currentPrice,
        underlyingPrice:snapshot.underlyingPrice??position.underlyingPrice,
        indexPrice,
        delta:contract.delta??position.delta,
        iv:contract.iv??position.iv,
        contractCode:position.contractCode||contract.code,
        quoteUpdatedAt:updatedAt,
        quoteSource:snapshot.source||contract.priceSource||'cn-options',
      };
    });
    onPositions(next);
    const failed=results.filter(result=>result.error).length;
    if(matched)showToast(`已更新 ${matched}/${positions.length} 笔期权行情${failed?' · 部分行情源失败':''}`,failed?ACC.amber:ACC.profit);
    else showToast('暂未匹配到持仓合约，请检查行权价和到期日',ACC.loss);
    setRefreshingOptions(false);
  };
  const refreshStock=async(stock)=>{
    setRefreshingStock(stock.id);
    const quote=await fetchCnStockQuote(stock.market,stock.ticker);
    if(quote.price==null&&!quote.name)showToast(`${stock.ticker} 行情暂时没有返回`,ACC.loss);
    else{onStocks(stocks.map(item=>item.id===stock.id?{...item,name:item.name||quote.name||'',currentPrice:quote.price??item.currentPrice,quoteSymbol:quote.quoteSymbol,priceUpdatedAt:quote.price==null?item.priceUpdatedAt:Date.now()}:item));showToast(`${stock.ticker} 行情与名称已更新`);}
    setRefreshingStock(null);
  };
  const closePosition=(p,data)=>{const record={...p,...data,closedAt:Date.now()};onAccountChange(positions.filter(item=>item.id!==p.id),[record,...closed],stocks);showToast(`${p.underlying} 已平仓 · ${cnMoney(calcCnClosed(record).pnl,'CNY',true)}`);};
  return(
    <section className="cn-account">
      <div className="cn-account-hero">
        <div><div className="cnopt-kicker">CN / HK CONNECT · PORTFOLIO</div><h2>A/H 股账户</h2><p>A 股期权、A 股与港股通股票统一管理；港股通按汇率折人民币汇总，风险口径不依赖 SGOV。</p></div>
        <div className="cn-account-hero-badges"><span>人民币账户</span><span>港股通</span><span>{indexQuote?.price?`中证500 ${fmt(indexQuote.price,0)}点`:'指数同步中'}</span></div>
      </div>
      <div className="cn-account-overview">
        <div><span>活跃期权</span><strong>{positions.length}</strong><small>浮盈 {cnMoney(optionPnl,'CNY',true)}</small></div>
        <div><span>期权保证金</span><strong>{cnMoney(totalMargin)}</strong><small>未填则按仓位估算</small></div>
        <div><span>股票持仓</span><strong>{stocks.length}</strong><small>A 股 {cnStocks.length} · 港股通 {hkStocks.length}</small></div>
        <div><span>期权已实现</span><strong className={closedPnl>=0?'pos':'neg'}>{cnMoney(closedPnl,'CNY',true)}</strong><small>{closed.length} 笔记录</small></div>
        <div><span>期权健康分</span><strong style={{color:avgScore==null?V('dim'):scoreColor(avgScore)}}>{avgScore??'—'}</strong><small>{avgScore==null?'暂无仓位':scoreLabel(avgScore)}</small></div>
      </div>
      <div className="cn-account-nav">
        <div className="cn-account-tabs">
          {[['options','活跃期权',positions.length],['stocks','股票持仓',stocks.length],['closed','期权已平仓',closed.length],['chain','期权数据',null]].map(([key,label,count])=><button key={key} className={view===key?'active':''} onClick={()=>{setView(key);setShowForm(false);}}><span>{label}</span>{count!=null&&<b>{count}</b>}</button>)}
        </div>
        <div className="cn-account-actions">
          {view==='options'&&<button className="btn cn-account-refresh" onClick={refreshOptionPositions} disabled={refreshingOptions||!positions.length}>{refreshingOptions?'同步行情中…':'↻ 获取最新数据'}</button>}
          {addLabel&&<button className="btn cn-account-add" onClick={()=>setShowForm(!showForm)}>{showForm?'✕ 取消':`＋ ${addLabel}`}</button>}
        </div>
      </div>

      {view==='options'&&<>
        {showForm&&<CnOptionForm onAdd={addPosition} onCancel={()=>setShowForm(false)} currentIndex={indexQuote?.price}/>}
        {!positions.length&&!showForm?<div className="cn-account-empty"><span>Δ</span><strong>还没有 A 股期权持仓</strong><p>录入买入或卖出仓位后，会自动计算浮盈、指数等效行权价和健康分。</p><button className="btn btn-primary" onClick={()=>setShowForm(true)}>＋ 录入第一笔</button></div>:<div className="cn-position-list">{positions.map(p=><CnOptionRow key={p.id} p={p} totalMargin={totalMargin} currentIndex={indexQuote?.price} onUpdate={(id,patch)=>onPositions(positions.map(item=>item.id===id?{...item,...patch}:item))} onClose={closePosition} onDelete={id=>onPositions(positions.filter(item=>item.id!==id))}/>)}</div>}
      </>}

      {view==='stocks'&&<>
        {showForm&&<CnStockForm onAdd={s=>{onStocks([...stocks,s]);setShowForm(false);showToast(`已添加 ${s.market==='HK'?'港股通':'A股'} ${s.ticker}${s.currentPrice==null?' · 行情稍后自动重试':` · 当前价 ${cnMoney(cnStockCny(s,s.currentPrice,hkdCnyRate))}`}`);}} onCancel={()=>setShowForm(false)}/>}
        {!!stocks.length&&<div className="cn-stock-summary"><div><span>A 股 · 人民币</span><strong>{cnMoney(cnTotal.value)}</strong><small>成本 {cnMoney(cnTotal.cost)} · {cnTotal.priced}/{cnStocks.length} 已录价</small></div><div className="hk"><span>港股通 · 折人民币</span><strong>{cnMoney(hkTotal.value)}</strong><small>成本 {cnMoney(hkTotal.cost)} · HKD/CNY {fmt(hkdCnyRate,4)} · {hkTotal.priced}/{hkStocks.length} 已录价</small></div></div>}
        {!!stocks.length&&<div className="cn-stock-toolbar">
          <div className="cnopt-segmented">
            {[['ALL','全部'],['CN','A 股'],['HK','港股通']].map(([value,label])=><button key={value} className={stockMarketFilter===value?'active':''} onClick={()=>setStockMarketFilter(value)}>{label}</button>)}
          </div>
          <input value={stockQuery} onChange={e=>setStockQuery(e.target.value)} placeholder="代码 / 名称筛选"/>
          <span>{filteredStocks.length}/{stocks.length}</span>
        </div>}
        {!stocks.length&&!showForm?<div className="cn-account-empty"><span>沪港</span><strong>还没有股票持仓</strong><p>支持 A 股和港股通；页面会统一折成人民币展示。</p><button className="btn btn-primary" onClick={()=>setShowForm(true)}>＋ 录入第一笔</button></div>:(
          filteredStocks.length?<div className="cn-stock-list">{filteredStocks.map(s=><CnStockRow key={s.id} stock={s} hkdCnyRate={hkdCnyRate} onRefresh={refreshStock} refreshing={refreshingStock===s.id} onDelete={id=>onStocks(stocks.filter(item=>item.id!==id))}/>)}</div>
          :<div className="cn-account-empty compact"><span>筛选</span><strong>没有匹配的股票持仓</strong><p>换一个市场、代码或名称试试。</p></div>
        )}
      </>}

      {view==='closed'&&<>
        {!closed.length?<div className="cn-account-empty"><span>✓</span><strong>暂无 A 股期权平仓记录</strong><p>在活跃期权中点击「平仓」，记录会自动转入这里。</p></div>:<div className="cn-closed-list">{closed.map(c=>{const r=calcCnClosed(c);return <article className="cn-closed-card" key={`${c.id}-${c.closedAt||c.closeDate}`}><div className="cn-closed-id"><strong>{c.underlying}</strong><span>{c.side==='SELL'?'卖出':'买入'} {c.type==='P'?'PUT':'CALL'} · ¥{fmt(c.strike,3)}</span><small>{c.openDate} → {c.closeDate}</small></div><div className="cn-closed-metrics"><Stat label="开 / 平仓价" value={`${fmt(c.openPrice,4)} / ${fmt(c.closePrice,4)}`} sub={`${r.qty}张 × ${fmt(r.multiplier,0)}`}/><Stat label="总手续费" value={cnMoney(r.totalFees)} sub={`持有 ${r.daysHeld} 天`}/><Stat label="实现收益" value={cnMoney(r.pnl,'CNY',true)} sub={r.annual==null?'—':`年化 ${fmtA(r.annual)}`} color={r.pnl>=0?ACC.profit:ACC.loss}/></div><button className="cn-delete-icon" title="删除记录" onClick={()=>{if(window.confirm('确认删除这条平仓记录？'))onClosed(closed.filter(item=>item!==c));}}>×</button></article>;})}</div>}
      </>}

      {view==='chain'&&<div className="cn-account-chain"><CnOptionsPanel embedded/></div>}
    </section>
  );
}

/* ══ 主应用 ══════════════════════════════════════ */

/* ══ 登录页 ══════════════════════════════════════ */
const LOGIN_KEY='opt-session';
// 不再在前端保存/比较密码明文——登录时直接拿输入的密码去问后端
// （/api/health 会做真正的密码校验），验证通过才放行，并复用为云端同步密码。

function LoginScreen({onLogin}){
  const [pwd,setPwd]=useState('');
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);

  const handleLogin=async()=>{
    const p=pwd.trim();
    if(!p){setError('请输入密码');return;}
    setLoading(true);setError('');
    try{
      const proxyBase=localStorage.getItem('whl-cloud-url')||DEFAULT_CLOUD_URL;
      const res=await fetch(`${proxyBase}/api/health`,{
        headers:{Authorization:`Bearer ${p}`},
        signal:AbortSignal.timeout(10000),
      });
      if(res.ok){
        localStorage.setItem('whl-cloud-pwd',p);
        sessionStorage.setItem(LOGIN_KEY,'1');
        onLogin();
      }else{
        setError('ACCESS DENIED · 密码错误');
      }
    }catch(e){
      setError('无法连接服务器，请检查网络后重试');
    }finally{
      setLoading(false);
    }
  };

  return(
    <div className="login-bg">
      <div className="login-box">
        <div className="login-logo" style={{marginBottom:32}}>
          <svg width="72" height="72" viewBox="0 0 28 28" fill="none">
            <rect x="2" y="2" width="24" height="24" rx="7" fill="none" stroke="#f5b731" strokeWidth="1.2" opacity=".4"/>
            <rect x="5" y="5" width="18" height="18" rx="4" fill="rgba(245,183,49,.06)"/>
            <path d="M8 17 L11 12 L14 14.5 L17 9 L20 13" stroke="#f5b731" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            <circle cx="20" cy="13" r="2" fill="#3dd68c"/>
            <path d="M8 20h12" stroke="rgba(245,183,49,.15)" strokeWidth="1"/>
          </svg>
        </div>
        <div style={{fontWeight:700,fontSize:24,color:'#dde8ef',letterSpacing:'.06em',marginBottom:4}}>
          {'Optimus Terminal'.split('').map((ch,i)=>(
            <span key={i} className="jump-letter" style={{animationDelay:(i*0.04)+'s'}}>{ch===' '?'\u00A0':ch}</span>
          ))}
        </div>
        <div style={{fontFamily:'IBM Plex Mono,monospace',fontSize:11,color:'rgba(122,150,170,.6)',letterSpacing:'.2em',marginBottom:40}}>{'WHEEL STRATEGY ENGINE'}</div>
        <input className="login-input" type="password" value={pwd} onChange={e=>{setPwd(e.target.value);setError('');}}
          onKeyDown={e=>{if(e.key==='Enter')handleLogin();}}
          placeholder="ACCESS CODE" autoFocus/>
        <div className="login-error">{error}</div>
        <button className="login-btn" onClick={handleLogin} disabled={loading} style={{marginTop:12,opacity:loading?.7:1}}>
          {loading?'CONNECTING...':'进入终端'}
        </button>
        <div style={{marginTop:32,fontFamily:'IBM Plex Mono,monospace',fontSize:10,color:'rgba(63,85,104,.4)',letterSpacing:'.08em'}}>
          {'v2.0 · ENCRYPTED SESSION'}
          
        </div>
      </div>
    </div>
  );
}

function App(){
  const [theme,setTheme]=useState(()=>localStorage.getItem(SK.THEME)||'dark');
  const [positions,setPositions]=useState(()=>ls(SK.POS,[]));
  const [closed,setClosed]=useState(()=>ls(SK.CLOSED,[]));
  const [stocks,setStocks]=useState(()=>ls(SK.STOCKS,[]));
  const [sgov,setSgov]=useState(()=>ls(SK.SGOV,{}));
  const [cfg,setCfg]=useState(()=>ls(SK.CFG,{commPerSide:DEFAULT_COMM}));
  const [cnPositions,setCnPositions]=useState(()=>ls(SK.CN_POS,[]));
  const [cnClosed,setCnClosed]=useState(()=>ls(SK.CN_CLOSED,[]));
  const [cnStocks,setCnStocks]=useState(()=>ls(SK.CN_STOCKS,[]));
  const [apiKey,setApiKey]=useState(()=>localStorage.getItem(SK.KEY)||'');
  const [finnhubKey,setFinnhubKey]=useState(()=>localStorage.getItem(SK.FH_KEY)||'');
  // 云端同步（已内置默认配置）
  const [cloudUrl,setCloudUrl]=useState(()=>localStorage.getItem('whl-cloud-url')||DEFAULT_CLOUD_URL);
  const [cloudPwd,setCloudPwd]=useState(()=>localStorage.getItem('whl-cloud-pwd')||'');
  const [cloudStatus,setCloudStatus]=useState('idle');
  const cloudLoaded=React.useRef(false); // 防止初始化期间空数据覆盖云端 // idle | syncing | ok | err
  const [showCloudModal,setShowCloudModal]=useState(false);

  const [tab,setTab]=useState('active');
  const [expanded,setExpanded]=useState(null);
  const [showForm,setShowForm]=useState(false);
  const [showStockForm,setShowStockForm]=useState(false);
  const [showApiModal,setShowApiModal]=useState(false);
  const [showFhModal,setShowFhModal]=useState(false);
  const [showCommModal,setShowCommModal]=useState(false);
  const [closeTarget,setCloseTarget]=useState(null);
  const [rollTarget,setRollTarget]=useState(null);
  const [loading,setLoading]=useState(false);
  const [lastRefresh,setLastRefresh]=useState(null);
  const [toast,setToast]=useState(null);

  useEffect(()=>{document.documentElement.dataset.theme=theme;localStorage.setItem(SK.THEME,theme);},[theme]);

  // 启动时从云端拉数据（有配置时）
  useEffect(()=>{
    if(!cloudUrl||!cloudPwd)return;
    setCloudStatus('syncing');
    cloudGet(cloudPwd).then(remote=>{
      if(remote===null){setCloudStatus('err');return;}
      // 云端有数据才覆盖本地；云端是空对象{}说明是第一次，把本地数据推上去
      const hasRemoteData=remote.positions?.length||remote.closed?.length||remote.stocks?.length||remote.sgov?.marketValue||remote.cnPositions?.length||remote.cnClosed?.length||remote.cnStocks?.length;
      if(hasRemoteData){
        if(remote.positions)setPositions(remote.positions);
        if(remote.closed)setClosed(remote.closed);
        if(remote.stocks)setStocks(remote.stocks);
        if(remote.sgov)setSgov(remote.sgov);
        if(remote.cfg)setCfg(remote.cfg);
        if(remote.cnPositions)setCnPositions(remote.cnPositions);
        if(remote.cnClosed)setCnClosed(remote.cnClosed);
        if(remote.cnStocks)setCnStocks(remote.cnStocks);
        setCloudStatus('ok');
        cloudLoaded.current=true;
      }else{
        // 云端是空的，把本地数据推上去初始化
        const payload=buildPayload(
          ls(SK.POS,[]),ls(SK.CLOSED,[]),ls(SK.STOCKS,[]),ls(SK.SGOV,{}),ls(SK.CFG,{commPerSide:DEFAULT_COMM}),
          ls(SK.CN_POS,[]),ls(SK.CN_CLOSED,[]),ls(SK.CN_STOCKS,[])
        );
cloudLoaded.current=true;
                cloudPut(payload,cloudPwd).then(ok=>setCloudStatus(ok?'ok':'err'));

      }
    });
  },[cloudUrl,cloudPwd]);

  // 把所有业务数据打包推送云端
  const pushCloud=useCallback(async(data)=>{
    if(!cloudUrl||!cloudPwd)return;
    // 云端数据尚未加载完成前，不允许推送（防止空数据覆盖）
    if(!cloudLoaded.current){console.warn('pushCloud blocked: cloud not loaded yet');return;}
    setCloudStatus('syncing');
    const ok=await cloudPut(data,cloudPwd);
    setCloudStatus(ok?'ok':'err');
  },[cloudUrl,cloudPwd]);

  // 带云端同步的 mutate
  const buildPayload=(pos,cl,st,sg,cf,cnPos=cnPositions,cnCl=cnClosed,cnSt=cnStocks)=>({
    positions:pos,closed:cl,stocks:st,sgov:sg,cfg:cf,
    cnPositions:cnPos,cnClosed:cnCl,cnStocks:cnSt,
    updatedAt:Date.now(),
  });

  const commPerSide=cfg.commPerSide??DEFAULT_COMM;
  const showToast=(msg,color=ACC.profit)=>{setToast({msg,color});setTimeout(()=>setToast(null),2800);};

  const mutate=(next)=>{
    setPositions(next);lss(SK.POS,next);
    pushCloud(buildPayload(next,closed,stocks,sgov,cfg));
  };
  const mutateClosed=(next)=>{
    setClosed(next);lss(SK.CLOSED,next);
    pushCloud(buildPayload(positions,next,stocks,sgov,cfg));
  };
  const updateClosedExpiryReview=useCallback((id,data)=>{
    setClosed(prev=>{
      const next=prev.map(c=>c.id===id?{
        ...c,
        expiryReviewPrice:data.price,
        expiryReviewDate:data.date,
        expiryReviewSource:data.source||'History',
        expiryReviewManual:!!data.manual,
        expiryReviewUpdatedAt:Date.now(),
      }:c);
      lss(SK.CLOSED,next);
      pushCloud(buildPayload(positions,next,stocks,sgov,cfg));
      return next;
    });
    if(!data.silent)showToast('到期价已修正');
  },[positions,stocks,sgov,cfg,pushCloud]);
  const mutateStocks=(next)=>{
    setStocks(next);lss(SK.STOCKS,next);
    pushCloud(buildPayload(positions,closed,next,sgov,cfg));
  };
  const mutateSgov=(next)=>{
    setSgov(next);lss(SK.SGOV,next);
    pushCloud(buildPayload(positions,closed,stocks,next,cfg));
  };
  const mutateCfg=(next)=>{
    setCfg(next);lss(SK.CFG,next);
    pushCloud(buildPayload(positions,closed,stocks,sgov,next));
  };
  const mutateCnPositions=(next)=>{
    setCnPositions(next);lss(SK.CN_POS,next);
    pushCloud(buildPayload(positions,closed,stocks,sgov,cfg,next,cnClosed,cnStocks));
  };
  const mutateCnClosed=(next)=>{
    setCnClosed(next);lss(SK.CN_CLOSED,next);
    pushCloud(buildPayload(positions,closed,stocks,sgov,cfg,cnPositions,next,cnStocks));
  };
  const mutateCnStocks=(next)=>{
    setCnStocks(next);lss(SK.CN_STOCKS,next);
    pushCloud(buildPayload(positions,closed,stocks,sgov,cfg,cnPositions,cnClosed,next));
  };
  const mutateCnAccount=(nextPositions,nextClosed,nextStocks)=>{
    setCnPositions(nextPositions);setCnClosed(nextClosed);setCnStocks(nextStocks);
    lss(SK.CN_POS,nextPositions);lss(SK.CN_CLOSED,nextClosed);lss(SK.CN_STOCKS,nextStocks);
    pushCloud(buildPayload(positions,closed,stocks,sgov,cfg,nextPositions,nextClosed,nextStocks));
  };

  const addPosition=(pos)=>{mutate([...positions,pos]);setShowForm(false);setExpanded(pos.id);showToast(`已添加 ${pos.ticker} ${pos.type==='P'?'Put':'Call'} $${pos.strike}`);};
  const removePosition=(id)=>{mutate(positions.filter(p=>p.id!==id));setExpanded(null);showToast('已删除仓位',ACC.loss);};
  const updateOptionPrice=(id,price)=>mutate(positions.map(p=>p.id===id?{...p,optionPrice:price}:p));
  const toggleExpand=(id)=>setExpanded(prev=>prev===id?null:id);
  const saveApiKey=(key)=>{localStorage.setItem(SK.KEY,key);setApiKey(key);setShowApiModal(false);showToast('Anthropic Key 已保存');};
  const saveFhKey=(key)=>{localStorage.setItem(SK.FH_KEY,key);setFinnhubKey(key);setShowFhModal(false);showToast('Finnhub Key 已保存 ✓',ACC.teal);};
  const saveComm=(v)=>{mutateCfg({...cfg,commPerSide:v});setShowCommModal(false);showToast(`手续费已更新 $${v}/张`);};
  const toggleTheme=()=>setTheme(t=>t==='dark'?'light':'dark');

  // 刷新报价：股价走 Vercel 代理，期权走 CBOE
  const refreshPrices=async()=>{
    const allTickers=[...new Set([...positions.map(p=>p.ticker),...stocks.map(s=>s.ticker)])];
    if(!allTickers.length)return;
    setLoading('refresh');
    try{
      // 股价：Vercel 代理 → Yahoo（服务端请求，无 CORS）
      const stockPrices=await fetchStockPrices(allTickers);
      // 期权现价：CBOE（免 Key，真实数据）
      const optPrices=positions.length?await fetchAllOptionPrices(positions,null):{};
      const optOk=Object.keys(optPrices).length;
      if(positions.length)mutate(positions.map(p=>({
        ...p,
        currentPrice:stockPrices[p.ticker]??p.currentPrice,
        ...(optPrices[p.id]?{optionPrice:optPrices[p.id].price,optionDelta:optPrices[p.id].delta||null}:{}),
      })));
      if(stocks.length)mutateStocks(stocks.map(s=>({...s,currentPrice:stockPrices[s.ticker]??s.currentPrice})));
      setLastRefresh(new Date().toLocaleTimeString('zh-CN'));
      const stockOk=Object.values(stockPrices).filter(v=>v!=null).length;
      showToast(`股价 ${stockOk}/${allTickers.length} · 期权现价 ${optOk}/${positions.length}`);
    }catch(e){showToast('刷新失败：'+e.message,ACC.loss);}
    setLoading(false);
  };

  const refreshPricesAI=async()=>{
    if(!positions.length&&!stocks.length)return;
    if(!apiKey){setShowApiModal(true);return;}
    setLoading('ai');
    try{
      const allTickers=[...new Set([...positions.map(p=>p.ticker),...stocks.map(s=>s.ticker)])];
      const prices=await fetchAIPrices(allTickers,apiKey);
      if(positions.length)mutate(positions.map(p=>({...p,currentPrice:prices[p.ticker]??p.currentPrice})));
      if(stocks.length)mutateStocks(stocks.map(s=>({...s,currentPrice:prices[s.ticker]??s.currentPrice})));
      setLastRefresh(new Date().toLocaleTimeString('zh-CN'));
      showToast('AI 报价已更新 ↻');
    }catch(e){showToast('AI 失败：'+e.message,ACC.loss);}
    setLoading(false);
  };

  // 平仓 / 接货
  const confirmClose=(pos,data)=>{
    const {closePrice,closeDate,closeType,assignedShares,assignedCostPerShare,assignedMarketValue,assignedTicker}=data;
    const record={...pos,closePrice,closeDate,closeType,closedAt:Date.now(),...(closeType==='assigned'?{assignedShares,assignedCostPerShare,assignedMarketValue}:{})};
    mutateClosed([record,...closed]);
    mutate(positions.filter(p=>p.id!==pos.id));

    if(closeType==='assigned'){
      // 新建股票仓位
      const newStock={
        id:Date.now(),ticker:assignedTicker,shares:assignedShares,
        costPerShare:assignedCostPerShare,acquireDate:closeDate,
        source:'assigned',currentPrice:pos.currentPrice||null,
        fromOptionId:pos.id,
      };
      mutateStocks([...stocks,newStock]);
      // SGOV 市值自动扣减接货占用资金
      if(sgov?.marketValue){
        const newMV=Math.max(0,(sgov.marketValue||0)-assignedMarketValue);
        mutateSgov({...sgov,marketValue:newMV});
      }
      showToast(`📦 ${assignedTicker} 接货 ${assignedShares}股，SGOV 已扣减 $${fmt(assignedMarketValue,0)}`,ACC.amber);
    }else{
      showToast(`${pos.ticker} 已平仓，收益 ${fmtM(calcClosed(record,commPerSide).profit)}`);
    }
    setExpanded(null);setCloseTarget(null);
  };
  const confirmRoll=(pos,data)=>{
    const {buybackPrice,rollDate,newExpiry,newStrike,newPremium,netCredit,rollComm}=data;
    const newId=Date.now();
    // 1. 关闭旧仓位（记录为 roll）
    const closedRecord={
      ...pos,
      closePrice:buybackPrice,closeDate:rollDate,closeType:'roll',closedAt:Date.now(),
      rollNetCredit:netCredit,rollComm,
      rollToPositionId:newId,rollToExpiry:newExpiry,rollToStrike:newStrike,rollToPremium:newPremium,
    };
    mutateClosed([closedRecord,...closed]);
    // 2. 创建新仓位
    const newPos={
      id:newId,ticker:pos.ticker,type:pos.type,strike:newStrike,qty:pos.qty||1,
      openDate:rollDate,expDate:newExpiry,premium:newPremium,
      marginType:pos.marginType,customMargin:pos.customMargin||0,
      currentPrice:pos.currentPrice,optionPrice:null,
      rolledFrom:pos.id,
    };
    mutate([...positions.filter(p=>p.id!==pos.id),newPos]);
    setRollTarget(null);setExpanded(newPos.id);
    showToast('↻ Roll 完成 · 净'+fmtM(netCredit),netCredit>=0?ACC.profit:ACC.amber);
  };

  const removeClosedRecord=(id)=>{mutateClosed(closed.filter(c=>c.id!==id));showToast('已删除记录',ACC.loss);};
  const updateStockPrice=(id,price)=>mutateStocks(stocks.map(s=>s.id===id?{...s,currentPrice:price}:s));
  const removeStock=(id)=>{mutateStocks(stocks.filter(s=>s.id!==id));showToast('已删除股票仓位',ACC.loss);};

  const totalMarginUsed=positions.reduce((s,p)=>s+(p.marginType==='cash'?p.strike*100:(p.customMargin||0))*(p.qty||1),0);

  return(
    <div className="app-shell" style={{minHeight:'100vh',display:'flex',flexDirection:'column'}}>
      {toast&&<div className="toast" style={{background:toast.color,color:'#0c1217'}}>{toast.msg}</div>}
      {showApiModal&&<ApiKeyModal onSave={saveApiKey} onClose={()=>setShowApiModal(false)}/>}
      {showFhModal&&<FinnhubModal current={finnhubKey} onSave={saveFhKey} onClose={()=>setShowFhModal(false)}/>}
      {showCommModal&&<CommModal current={commPerSide} onSave={saveComm} onClose={()=>setShowCommModal(false)}/>}
      {showCloudModal&&<CloudSetupModal
        onSave={(u,p)=>{
          setCloudUrl(u);setCloudPwd(p);setShowCloudModal(false);setCloudStatus('syncing');
          cloudGet(p).then(remote=>{
            if(remote===null){setCloudStatus('err');return;}
            const hasData=remote.positions?.length||remote.closed?.length||remote.stocks?.length||remote.sgov?.marketValue||remote.cnPositions?.length||remote.cnClosed?.length||remote.cnStocks?.length;
            if(hasData){
              if(remote.positions)setPositions(remote.positions);
              if(remote.closed)setClosed(remote.closed);
              if(remote.stocks)setStocks(remote.stocks);
              if(remote.sgov)setSgov(remote.sgov);
              if(remote.cfg)setCfg(remote.cfg);
              if(remote.cnPositions)setCnPositions(remote.cnPositions);
              if(remote.cnClosed)setCnClosed(remote.cnClosed);
              if(remote.cnStocks)setCnStocks(remote.cnStocks);
              setCloudStatus('ok');cloudLoaded.current=true;showToast('☁ 云端数据已加载',ACC.teal);
            }else{
              // 云端空的，把本地数据推上去
              const payload=buildPayload(positions,closed,stocks,sgov,cfg);
              cloudPut(payload,p).then(ok=>{
                setCloudStatus(ok?'ok':'err');
                if(ok)showToast('☁ 本地数据已同步到云端',ACC.teal);
              });
            }
          });
        }}
        onClose={()=>setShowCloudModal(false)}/>}
      {rollTarget&&<RollModal pos={rollTarget} commPerSide={commPerSide}
        onConfirm={(data)=>confirmRoll(rollTarget,data)} onClose={()=>setRollTarget(null)}/>}
      {closeTarget&&<CloseModal pos={closeTarget} commPerSide={commPerSide}
        onConfirm={(data)=>confirmClose(closeTarget,data)} onClose={()=>setCloseTarget(null)}/>}

      {/* ── Header ── */}
      <div className="app-header" style={{borderBottom:`1px solid ${V('line')}`,background:V('surface'),backdropFilter:'blur(14px)',position:'sticky',top:0,zIndex:50,boxShadow:V('shadow'),height:56,display:'flex',alignItems:'center'}}>
        <div className="app-header-inner" style={{maxWidth:'100%',width:'100%',padding:'0 16px',display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,flexWrap:'wrap'}}>
          <div className="app-brand" style={{display:'flex',alignItems:'center',gap:10}}>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" style={{flexShrink:0}}>
              <rect x="2" y="2" width="24" height="24" rx="7" fill="none" stroke="#f5b731" strokeWidth="1.5" opacity=".3"/>
              <rect x="5" y="5" width="18" height="18" rx="4" fill="rgba(245,183,49,.08)"/>
              <path d="M8 17 L11 12 L14 14.5 L17 9 L20 13" stroke="#f5b731" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              <circle cx="20" cy="13" r="2" fill="#3dd68c"/>
              <path d="M8 20h12" stroke="rgba(245,183,49,.2)" strokeWidth="1"/>
            </svg>
            <div style={{display:'flex',flexDirection:'column',gap:0}}>
              <span style={{fontWeight:700,fontSize:14,letterSpacing:'.04em',lineHeight:1.2,color:V('ink')}}>Optimus Terminal</span>
              <span style={{fontSize:9,color:V('faint'),fontFamily:'IBM Plex Mono,monospace',letterSpacing:'.12em'}}>WHEEL STRATEGY</span>
            </div>
          </div>
          <div className="header-btns" style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
            {lastRefresh&&<span className="header-time" style={{fontSize:11,color:V('faint'),fontFamily:'IBM Plex Mono,monospace'}}>更新 {lastRefresh}</span>}
            {/* 导出备份 */}
            <button onClick={()=>{
              const payload=buildPayload(positions,closed,stocks,sgov,cfg);
              const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
              const url=URL.createObjectURL(blob);
              const a=document.createElement('a');
              a.href=url;a.download='optimus-backup-'+today()+'.json';a.click();
              URL.revokeObjectURL(url);
              showToast('备份已下载',ACC.teal);
            }} className="btn btn-ghost" style={{fontSize:12,padding:'7px 12px'}}>{'💾'}</button>
            {/* 云端同步状态 */}
            <button onClick={()=>setShowCloudModal(true)} className="btn btn-ghost"
              style={{fontSize:12,padding:'7px 12px',
                color:cloudStatus==='ok'?ACC.teal:cloudStatus==='err'?ACC.loss:cloudStatus==='syncing'?ACC.amber:V('faint'),
                borderColor:cloudStatus==='ok'?`${ACC.teal}44`:cloudStatus==='err'?`${ACC.loss}44`:cloudStatus==='syncing'?`${ACC.amber}44`:V('line')}}>
              {cloudStatus==='ok'?'☁ 已同步':cloudStatus==='err'?'☁ 同步失败':cloudStatus==='syncing'?'☁ 同步中…':'☁ 未配置'}
            </button>
            {US_ACCOUNT_TABS.includes(tab)&&<button onClick={()=>setShowCommModal(true)} className="btn btn-ghost btn-comm" style={{fontSize:12,fontFamily:'IBM Plex Mono,monospace',padding:'7px 12px'}}>¢ ${commPerSide}/张</button>}
            {US_ACCOUNT_TABS.includes(tab)&&<button onClick={refreshPrices} disabled={!!loading} className="btn"
              style={{background:loading==='refresh'?V('line'):ACC.blueBg,color:loading==='refresh'?V('faint'):ACC.blue,
                border:`1.5px solid ${loading==='refresh'?V('line'):`${ACC.blue}44`}`,fontWeight:500}}>
              {loading==='refresh'?'拉取中…':'↻ CBOE 刷新'}
            </button>}
            {tab==='active'&&<button onClick={()=>setShowForm(s=>!s)} className="btn"
              style={{background:ACC.amberSoft,color:ACC.amber,border:`1.5px solid ${ACC.amber}44`,fontWeight:600}}>
              {showForm?'✕ 取消':'＋ 添加'}
            </button>}
            <button className="theme-btn" onClick={toggleTheme} title={theme==='dark'?'切换浅色':'切换深色'}>{theme==='dark'?'☀':'🌙'}</button>
          </div>
        </div>
      </div>

      {/* ── 主体布局 ── */}
      <div className="layout" style={{flex:1}}>
        {/* 左侧 Tab 导航 */}
        <div className="sidebar">
          <div className="sidebar-section">账户</div>
          <button className={`tab-btn${US_ACCOUNT_TABS.includes(tab)?' active':''}`} onClick={()=>setTab('active')}>
            <span className="tab-dot" style={{background:ACC.profit}}/>
            <span className="tab-label tab-label-full">美股账户</span><span className="tab-label tab-label-short">美股</span>
            <span className="tab-unit">USD</span>
            <span className="tab-count">{positions.length+stocks.length}</span>
          </button>
          <button className={`tab-btn${tab==='cnaccount'?' active':''}`} onClick={()=>setTab('cnaccount')}>
            <span className="tab-dot" style={{background:ACC.loss}}/>
            <span className="tab-label tab-label-full">A/H 股账户</span><span className="tab-label tab-label-short">A/H</span>
            <span className="tab-unit">CNY</span>
            <span className="tab-count">{cnPositions.length+cnStocks.length}</span>
          </button>
          <div className="sidebar-sep"/>
          <div className="sidebar-section">工具</div>
          <button className={`tab-btn${tab==='finews'?' active':''}`} onClick={()=>setTab('finews')}>
            <span className="tab-dot" style={{background:ACC.blue}}/>
            <span className="tab-label tab-label-full">收藏网站</span><span className="tab-label tab-label-short">收藏</span>
          </button>
          <button className={`tab-btn${tab==='learn'?' active':''}`} onClick={()=>setTab('learn')}>
            <span className="tab-dot" style={{background:ACC.purple}}/>
            <span className="tab-label tab-label-full">期权学习</span><span className="tab-label tab-label-short">学习</span>
          </button>
        </div>

        {/* 右侧内容 */}
        <div className="main-area">
          {US_ACCOUNT_TABS.includes(tab)&&(
            <div className="market-account-shell us-market">
              <div className="market-account-hero">
                <div><div className="cnopt-kicker">US WHEEL · PORTFOLIO</div><h2>美股账户</h2><p>美股期权、股票持仓与 SGOV 底仓统一管理；CBOE 延迟行情刷新，收益和保证金按美元口径汇总。</p></div>
                <div className="market-account-hero-badges"><span>美元账户</span><span>CBOE 延迟</span><span>SGOV 底仓</span></div>
              </div>
              <div className="market-account-nav">
                <div className="market-account-tabs">
                  {[
                    ['active','活跃期权',positions.length],['stocks','股票持仓',stocks.length],
                    ['closed','期权已平仓',closed.length],['sgov','SGOV 底仓',null],
                  ].map(([key,label,count])=><button key={key} className={tab===key?'active':''} onClick={()=>setTab(key)}><span>{label}</span>{count!=null&&<b>{count}</b>}</button>)}
                </div>
              </div>
            </div>
          )}
          {/* 活跃仓位 Tab */}
          {tab==='active'&&(
            <>
              {showForm&&<AddForm onAdd={addPosition} onCancel={()=>setShowForm(false)} commPerSide={commPerSide}/>}
              {positions.length>0&&<SummaryBar positions={positions} commPerSide={commPerSide} sgov={sgov}/>}
              {positions.length===0&&!showForm&&(
                <div style={{textAlign:'center',padding:'70px 20px',color:V('faint'),border:`1.5px dashed ${V('line')}`,borderRadius:16}}>
                  <div style={{fontSize:38,marginBottom:12,opacity:.3}}>◎</div>
                  <div style={{fontSize:15,marginBottom:6,color:V('dim')}}>还没有活跃仓位</div>
                  <div style={{fontSize:13}}>点击右上角「＋ 添加」录入</div>
                </div>
              )}
              {positions.length>0&&(
                <div className="pos-list">
                  <ActiveTableHeader/>
                  {positions.map(p=>(
                    <PositionRow key={p.id} p={p} commPerSide={commPerSide}
                      portfolio={{totalMargin:totalMarginUsed,sgov}}
                      expanded={expanded===p.id}
                      onToggle={()=>toggleExpand(p.id)}
                      onUpdateOptionPrice={updateOptionPrice}
                      onClose={()=>{setCloseTarget(p);setExpanded(null);}}
                      onDelete={()=>removePosition(p.id)}
                      onRoll={()=>{setRollTarget(p);setExpanded(null);}}/>
                  ))}
                </div>
              )}
            </>
          )}

          {/* 已平仓 Tab */}
          {tab==='closed'&&(
            <>
              <ClosedSummary closed={closed} commPerSide={commPerSide}/>
              {closed.length===0?(
                <div style={{textAlign:'center',padding:'70px 20px',color:V('faint'),border:`1.5px dashed ${V('line')}`,borderRadius:16}}>
                  <div style={{fontSize:38,marginBottom:12,opacity:.3}}>📋</div>
                  <div style={{fontSize:15,marginBottom:6,color:V('dim')}}>暂无平仓记录</div>
                  <div style={{fontSize:13}}>在「活跃期权」展开一笔，点击「↩ 平仓」</div>
                </div>
              ):(<>
                <ClosedTableHeader/>
                {closed.map(c=><ClosedRow key={c.id} c={c} commPerSide={commPerSide} positions={positions} closed={closed} onUpdateExpiryReview={updateClosedExpiryReview} onDelete={()=>removeClosedRecord(c.id)}/>)}
              </>)}
            </>
          )}

          {/* 股票持仓 Tab */}
          {tab==='stocks'&&(
            <>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14,flexWrap:'wrap',gap:8}}>
                <div>
                  <div style={{fontWeight:700,fontSize:15,marginBottom:2}}>股票持仓</div>
                  <div style={{fontSize:12,color:V('dim'),fontFamily:'IBM Plex Mono,monospace'}}>接货自动录入 · 可手动添加 · 刷新股价同步更新</div>
                </div>
                <button onClick={()=>setShowStockForm(s=>!s)} className="btn"
                  style={{background:ACC.profit+'18',color:ACC.profit,border:`1.5px solid ${ACC.profit}44`,fontWeight:600}}>
                  {showStockForm?'✕ 取消':'＋ 手动添加'}
                </button>
              </div>
              {showStockForm&&<AddStockForm
                onAdd={s=>{mutateStocks([...stocks,s]);setShowStockForm(false);showToast(`已添加 ${s.ticker} ${s.shares}股`);}}
                onCancel={()=>setShowStockForm(false)}/>}
              <StocksSummary stocks={stocks}/>
              {stocks.length===0&&!showStockForm?(
                <div style={{textAlign:'center',padding:'60px 20px',color:V('faint'),border:`1.5px dashed ${V('line')}`,borderRadius:16}}>
                  <div style={{fontSize:38,marginBottom:12,opacity:.3}}>📊</div>
                  <div style={{fontSize:15,marginBottom:6,color:V('dim')}}>暂无股票仓位</div>
                  <div style={{fontSize:13}}>期权被行权「接货」时自动建仓 · 或点击「手动添加」</div>
                </div>
              ):(stocks.length>0&&<>
                <StocksTableHeader/>
                {stocks.map(s=><StockRow key={s.id} s={s} onUpdatePrice={updateStockPrice} onDelete={removeStock}/>)}
              </>)}
            </>
          )}

          {/* SGOV Tab */}
          <div style={{display:tab==='sgov'?'block':'none'}}>
            <SgovPanel sgov={sgov} onUpdate={mutateSgov} totalMarginUsed={totalMarginUsed}/>
          </div>

          {/* 观察列表暂时从导航隐藏，保留组件代码便于后续恢复 */}
          <div style={{display:tab==='watchlist'?'block':'none'}}><WatchlistPanel/></div>

          {/* A/H 股账户工作台：内部包含活跃期权、股票、已平仓和期权数据 */}
          <div style={{display:tab==='cnaccount'||tab==='cnoptions'?'block':'none'}}>
            <CnAccountPanel positions={cnPositions} closed={cnClosed} stocks={cnStocks}
              onPositions={mutateCnPositions} onClosed={mutateCnClosed} onStocks={mutateCnStocks}
              onAccountChange={mutateCnAccount} showToast={showToast}/>
          </div>

          {/* 期权筛选暂时从导航隐藏，保留组件代码便于后续恢复 */}
          <div style={{display:tab==='scan'?'block':'none'}}><ScanPanel/></div>
          <div style={{display:tab==='finews'?'block':'none'}}><LinkHubPanel/></div>

          {/* 期权学习 Tab */}
          <div style={{display:tab==='learn'?'block':'none'}}><LearnPanel/></div>
        </div>
      </div>
    </div>
  );
}

function Root(){
  const [auth,setAuth]=useState(()=>sessionStorage.getItem(LOGIN_KEY)==='1');
  if(!auth)return <LoginScreen onLogin={()=>setAuth(true)}/>;
  return <App/>;
}
export default Root;
