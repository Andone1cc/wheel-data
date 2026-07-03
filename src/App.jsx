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
const SK={POS:'whl-pos-v2',CLOSED:'whl-closed-v1',STOCKS:'whl-stocks-v1',SGOV:'whl-sgov-v3',CFG:'whl-cfg-v2',KEY:'whl-api-key',FH_KEY:'whl-finnhub-key',THEME:'whl-theme'};

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

/* ── 计算已平仓收益 ── */
function calcClosed(c,comm=DEFAULT_COMM){
  const qty=c.qty||1;
  const openPrem=c.premium*100*qty;
  const capital=(c.marginType==='cash'?c.strike*100:(c.customMargin||0))*qty;
  const closeType=c.closeType||'manual'; // 'manual'|'expired'
  const commUsed=closeType==='expired'?comm*qty:comm*qty*2;
  const closePrem=(c.closePrice||0)*100*qty;
  const profit=openPrem-closePrem-commUsed;
  const daysHeld=Math.max(1,daysBetween(c.openDate,c.closeDate||today()));
  const annual=calcAnnual(profit,capital,daysHeld);
  const yld=capital?(profit/capital)*100:null;
  return{qty,openPrem,closePrem,profit,capital,daysHeld,annual,yld,commUsed};
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
          style={{paddingLeft:prefix?28:12,paddingRight:suffix?32:12,color:color||V('ink'),cursor:readOnly?'default':'text',background:readOnly?'transparent':undefined,borderStyle:readOnly?'dashed':undefined}}/>
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
        <div style={{overflowX:'auto'}}>
          <div style={{display:'grid',gridTemplateColumns:'1.1fr 0.8fr 0.7fr 0.6fr 0.9fr 0.7fr 0.9fr 0.7fr 0.7fr 0.3fr',gap:0,padding:'0 0 8px',marginBottom:4}}>
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
              <div key={t} className="card" style={{display:'grid',gridTemplateColumns:'1.1fr 0.8fr 0.7fr 0.6fr 0.9fr 0.7fr 0.9fr 0.7fr 0.7fr 0.3fr',gap:0,marginBottom:6,borderLeft:'3px solid '+rankColor}}>
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

  const proxyBase=localStorage.getItem('whl-cloud-url')||DEFAULT_CLOUD_URL;

  const scan=async()=>{
    setLoading(true);setResults([]);setError('');
    const today=new Date();
    const found=[];
    // 从富途获取观察列表
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
      setProgress('扫描 '+display+'…');
      try{
        // 1. 获取到期日列表
        const daysRes=await futuFetch('/api/futu/option-days?code='+encodeURIComponent(code),{signal:AbortSignal.timeout(10000)});
        const daysData=await daysRes.json();
        if(daysData.status!=='success'||!Array.isArray(daysData.data))continue;

        console.log(display+' 到期日数量:',daysData.data.length,daysData.data.map(d=>d.strike_time).slice(0,5));
        // 2. 筛选 DTE 在范围内的到期日
        const validDates=daysData.data.filter(d=>{
          const exp=new Date(d.strike_time);
          const dte=Math.round((exp-today)/86400000);
          return dte>=Number(minDte)&&dte<=Number(maxDte);
        });
        if(!validDates.length)continue;

        // 3. 获取正股摘要（IV/HV/IV Rank）
        let stockSummary={};
        try{
          const sumRes=await futuFetch('/api/futu/stock-option-summary?code='+encodeURIComponent(code),{signal:AbortSignal.timeout(10000)});
          const sumData=await sumRes.json();
          if(sumData.status==='success')stockSummary=sumData.data||{};
        }catch{}

        console.log(display+' 符合DTE的日期:',validDates.length,validDates.map(d=>d.strike_time.split(' ')[0]));
        // 4. 对每个到期日拉 Put 期权链
        for(const dateObj of validDates){
          const dateStr=dateObj.strike_time.split(' ')[0];
          const chainRes=await futuFetch('/api/futu/option-chain?code='+encodeURIComponent(code)+'&date='+dateStr+'&option_type=PUT',{signal:AbortSignal.timeout(12000)});
          const chainData=await chainRes.json();
          if(chainData.status!=='success'||!Array.isArray(chainData.data))continue;

          const exp=new Date(dateStr);
          const dte=Math.round((exp-today)/86400000);
          if(dte<=0)continue;

          console.log(display+' '+dateStr+' Put数量:',chainData.data.length);
          for(const opt of chainData.data){
            const delta=Math.abs(opt.delta||0);
            if(delta<Number(minDelta)||delta>Number(maxDelta))continue;
            const annual=opt.seller_annual_return||0;
            if(annual<Number(minAnnual))continue;
            const mid=opt.mid_price||0;
            if(mid<=0)continue;

            found.push({
              ticker:display,
              code:opt.code,
              stockPrice:null,
              expiry:dateStr,
              strike:opt.strike_price,
              delta:delta,
              bid:opt.bid_price||0,
              ask:opt.ask_price||0,
              mid:mid,
              iv:opt.implied_volatility||null,
              theta:opt.theta||null,
              gamma:opt.gamma||null,
              openInterest:opt.open_interest||0,
              annualPct:annual,
              profitProb:opt.profit_probability||null,
              dte:dte,
              ivRank:stockSummary.iv_rank||null,
              ivPct:stockSummary.iv_percentile||null,
              stockIV:stockSummary.iv||null,
              stockHV:stockSummary.hv||null,
            });
          }
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
    const sorted=Object.values(best).sort((a,b)=>b[sortKey]-a[sortKey]);
    setResults(sorted);
    setProgress('');
    if(!sorted.length)setError('未找到符合条件的合约，请放宽筛选条件或检查富途 API 连接');
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

      <div className="card" style={{padding:'14px 18px',marginBottom:14,display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:12}}>
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
        <div style={{overflowX:'auto'}}>
          <div style={{display:'grid',gridTemplateColumns:'1.2fr 1fr 0.7fr 0.7fr 0.7fr 0.7fr 0.8fr 0.7fr 0.8fr 0.7fr',gap:0,padding:'0 0 8px',marginBottom:4,minWidth:680}}>
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
              <div key={i} className="card" style={rowStyle}>
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
  const [section,setSection]=useState('concepts');
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

  const htmlMap={concepts:conceptsHTML,greeks:greeksHTML,case1:case1HTML,case2:case2HTML};

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

/* ══ SGOV 面板 ══════════════════════════════════════ */
function SgovPanel({sgov,onUpdate,totalMarginUsed}){
  const s=sgov||{};
  const si=calcSgov(s);
  const sgovVsMargin=(si?.total&&totalMarginUsed>0)?calcAnnual(si.total,totalMarginUsed,si.days):null;
  return(
    <div className="glass-card anim-in" style={{borderColor:`rgba(45,212,191,.25)`,padding:'16px 20px',marginBottom:16}}>
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
        <div style={{width:3,height:16,borderRadius:2,background:ACC.teal,flexShrink:0}}/>
        <span style={{fontWeight:700,fontSize:14,color:ACC.teal}}>SGOV 保证金底仓</span>
        <span style={{fontSize:11,color:V('faint'),fontFamily:'IBM Plex Mono,monospace'}}>嘉信杠杆 · 利息来源</span>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1.6fr 1fr .9fr 1.1fr',gap:12,marginBottom:si?14:0}}>
        <NumField label="当前市值" prefix="$" value={s.marketValue??''} placeholder="100000" onChange={v=>onUpdate({...s,marketValue:parseFloat(v)||null})}/>
        <DateField label="计息起始日" value={s.startDate??''} onChange={v=>onUpdate({...s,startDate:v})}/>
        <NumField label="年化利率" hint="默认4%" suffix="%" value={s.annualRate??''} placeholder="4.0" onChange={v=>onUpdate({...s,annualRate:parseFloat(v)||null})}/>
        <NumField label="手动修正" hint="可±" prefix="$" value={s.manualAdj??''} placeholder="0" onChange={v=>onUpdate({...s,manualAdj:parseFloat(v)||null})}/>
      </div>
      {si&&(
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))',gap:14,paddingTop:12,borderTop:`1px solid ${V('line')}`}}>
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
    <div className="card anim-in" style={{padding:22,marginBottom:16,borderColor:`${ACC.amber}33`}}>
      <div style={{fontSize:13,fontWeight:700,color:ACC.amber,marginBottom:18}}>＋ 添加期权仓位</div>
      <div style={{display:'grid',gridTemplateColumns:'2fr 110px 1fr 80px',gap:12,marginBottom:12}}>
        <Field label="标的代码" value={f.ticker} onChange={v=>set('ticker',v.toUpperCase())} placeholder="MRVL"/>
        <SelectField label="方向" value={f.type} onChange={v=>set('type',v)} options={[{value:'P',label:'卖 Put'},{value:'C',label:'卖 Call'}]}/>
        <NumField label="行权价" prefix="$" value={f.strike} onChange={v=>set('strike',v)} placeholder="190"/>
        <NumField label="手数" value={f.qty} onChange={v=>set('qty',v)} placeholder="1" suffix="手"/>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12,marginBottom:12}}>
        <DateField label="开仓日期" value={f.openDate} onChange={v=>set('openDate',v)}/>
        <DateField label="到期日期" value={f.expDate} onChange={v=>set('expDate',v)}/>
        <NumField label="开仓权利金" prefix="$" suffix="/股" value={f.premium} onChange={v=>set('premium',v)} placeholder="3.24"/>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:14}}>
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
function DetailDrawer({p,r,commPerSide,onUpdateOptionPrice,onClose,onDelete,onRoll}){
  return(
    <div className="anim-fade" style={{borderTop:`1px solid ${V('line')}`,background:V('surface'),borderRadius:'0 0 14px 14px',padding:'18px 20px'}}>
      <div style={{marginBottom:16}}>
        <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:V('dim'),marginBottom:5,fontFamily:'IBM Plex Mono,monospace'}}>
          <span>开仓 {p.openDate}</span>
          <span style={{color:ACC.amber}}>Θ {r.thetaPct.toFixed(0)}% · 剩 {r.daysLeft} 天</span>
          <span>到期 {p.expDate}</span>
        </div>
        <ThetaBar pct={r.thetaPct}/>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))',gap:12,marginBottom:16,paddingBottom:16,borderBottom:`1px solid ${V('line')}`}}>
        <Stat label="开仓权利金" value={`$${fmt(r.openPrem)}`} sub={`$${fmt(p.premium)}/股×${r.qty}手`} color={ACC.amber}/>
        <Stat label="手续费双边" value={`-$${fmt(r.commTotal)}`} sub={`$${commPerSide}/张×${r.qty}×2`} color={ACC.loss}/>
        <Stat label="净权利金" value={`$${fmt(r.openPrem-r.commTotal)}`} color={ACC.profit}/>
        <Stat label="占用资金" value={`$${fmt(r.capital,0)}`} sub={p.marginType==='cash'?'现金担保':'自定义'} color={V('dim')}/>
        <Stat label="持有天数" value={`${r.daysHeld} 天`} sub={`共 ${r.daysTotal} 天`} color={V('dim')}/>
        {r.capturedPct!=null&&<Stat label="权利金捕获" value={`${r.capturedPct.toFixed(1)}%`} color={r.capturedPct>=50?ACC.profit:ACC.amber}/>}
        {r.buffer!=null&&<Stat label={p.type==='P'?'价外缓冲':'价外距离'} value={`${r.buffer>0?'+':''}${r.buffer.toFixed(1)}%`} sub={`现价 $${fmt(p.currentPrice)}`} color={r.buffer>0?ACC.profit:ACC.loss}/>}
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:14}}>
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
function PositionRow({p,commPerSide,expanded,onToggle,onUpdateOptionPrice,onClose,onDelete,onRoll}){
  const r=calc(p,commPerSide);
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
        style={{'--row-accent':typeColor,display:'grid',gridTemplateColumns:'4px 110px 86px 96px 1fr 90px 116px 116px 116px 36px',
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
            {p.optionPrice!=null&&<span style={{fontFamily:'IBM Plex Mono,monospace',fontSize:9,color:V('faint'),letterSpacing:'.03em'}}>{'Δ '+(p.delta!=null?p.delta.toFixed(2):'—')}</span>}
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
        <div className="pos-row-col-arrow" style={{display:'flex',justifyContent:'center',color:V('faint'),fontSize:11,transform:expanded?'rotate(180deg)':'rotate(0)',transition:'transform .22s ease'}}>▼</div>
      </div>
      {expanded&&<DetailDrawer p={p} r={r} commPerSide={commPerSide}
        onUpdateOptionPrice={v=>onUpdateOptionPrice(p.id,v)}
        onClose={onClose} onDelete={onDelete} onRoll={onRoll}/>}
    </div>
  );
}

function ActiveTableHeader(){
  const H=({t,right})=><div style={{fontSize:10,color:V('faint'),letterSpacing:'.14em',textTransform:'uppercase',fontFamily:'IBM Plex Mono,monospace',textAlign:right?'right':'left',padding:'0 4px'}}>{t}</div>;
  return(
    <div className="pos-table-header" style={{display:'grid',gridTemplateColumns:'4px 110px 86px 96px 1fr 90px 116px 116px 116px 36px',alignItems:'center',padding:'4px 0 10px',marginBottom:0,borderBottom:'1px solid rgba(28,44,58,.4)'}}>
      <div/><H t="标的"/><H t="行权价"/><H t="到期"/><H t="Θ 衰减"/><H t="权利金" right/><H t="股价" right/><H t="现在卖出" right/><H t="持到到期" right/><div/>
    </div>
  );
}

/* ══ 已平仓历史行 ══════════════════════════════════════ */
function ClosedRow({c,commPerSide,onDelete}){
  const r=calcClosed(c,commPerSide);
  const isCall=c.type==='C';
  const typeColor=isCall?ACC.loss:ACC.profit;
  const isExpired=c.closeType==='expired';
  const isAssigned=c.closeType==='assigned';
  const badgeStyle=isAssigned
    ?{color:ACC.amber,background:ACC.amberSoft,borderColor:`${ACC.amber}44`}
    :isExpired
      ?{color:ACC.teal,background:ACC.tealBg,borderColor:`${ACC.teal}44`}
      :{color:ACC.blue,background:ACC.blueBg,borderColor:`${ACC.blue}44`};
  return(
    <div className="row-click" style={{borderBottom:'1px solid '+V('line'),overflow:'hidden'}}>
      <div style={{display:'grid',gridTemplateColumns:'3px 110px 86px 96px 110px 1fr 120px 120px 36px',alignItems:'center',minHeight:52,padding:'4px 0'}}>
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
        </div>
        <div style={{paddingRight:8}}>
          <span className="badge" style={badgeStyle}>
            {isAssigned?'📦 接货':isExpired?'到期归零':'主动平仓'}
          </span>
          {isAssigned&&<div style={{fontSize:10,color:V('faint'),fontFamily:'IBM Plex Mono,monospace',marginTop:3}}>{c.assignedShares}股 @ ${fmt(c.assignedCostPerShare)}</div>}
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
            {isExpired?'权利金 − 手续费':(isAssigned?'权利金 − 接货 − 费用':'权利金 − 买回 − 费用')}
          </div>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:2,alignItems:'flex-end',paddingRight:8}}>
          <span className="section-label">期权收益</span>
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
      <div style={{display:'grid',gridTemplateColumns:'3px 130px 120px 120px 1fr 130px 130px 36px',alignItems:'center',minHeight:54,padding:'4px 0'}}>
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
    <div style={{display:'grid',gridTemplateColumns:'4px 130px 120px 120px 1fr 130px 130px 36px',alignItems:'center',padding:'0 0 8px 0',marginBottom:4}}>
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
    <div className="card anim-in" style={{padding:20,marginBottom:14,borderColor:`${ACC.profit}33`}}>
      <div style={{fontSize:13,fontWeight:700,color:ACC.profit,marginBottom:16}}>＋ 手动录入股票仓位</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:12,marginBottom:14}}>
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
    <div style={{display:'grid',gridTemplateColumns:'4px 110px 86px 96px 100px 1fr 120px 120px 36px',alignItems:'center',padding:'0 0 8px 0',marginBottom:4}}>
      <div/><H t="标的"/><H t="行权价"/><H t="开/平仓日"/><H t="方式"/><H t="收支明细"/><H t="净利润" right/><H t="实现年化" right/><div/>
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
      const hasRemoteData=remote.positions?.length||remote.closed?.length||remote.stocks?.length||remote.sgov?.marketValue;
      if(hasRemoteData){
        if(remote.positions)setPositions(remote.positions);
        if(remote.closed)setClosed(remote.closed);
        if(remote.stocks)setStocks(remote.stocks);
        if(remote.sgov)setSgov(remote.sgov);
        if(remote.cfg)setCfg(remote.cfg);
        setCloudStatus('ok');
        cloudLoaded.current=true;
      }else{
        // 云端是空的，把本地数据推上去初始化
        const payload=buildPayload(
          ls(SK.POS,[]),ls(SK.CLOSED,[]),ls(SK.STOCKS,[]),ls(SK.SGOV,{}),ls(SK.CFG,{commPerSide:DEFAULT_COMM})
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
  const buildPayload=(pos,cl,st,sg,cf)=>({
    positions:pos,closed:cl,stocks:st,sgov:sg,cfg:cf,
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
    // 1. 关闭旧仓位（记录为 roll）
    const closedRecord={...pos,closePrice:buybackPrice,closeDate:rollDate,closeType:'roll',closedAt:Date.now(),rollNetCredit:netCredit};
    mutateClosed([closedRecord,...closed]);
    // 2. 创建新仓位
    const newPos={
      id:Date.now(),ticker:pos.ticker,type:pos.type,strike:newStrike,qty:pos.qty||1,
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
    <div style={{minHeight:'100vh',display:'flex',flexDirection:'column'}}>
      {toast&&<div className="toast" style={{background:toast.color,color:'#0c1217'}}>{toast.msg}</div>}
      {showApiModal&&<ApiKeyModal onSave={saveApiKey} onClose={()=>setShowApiModal(false)}/>}
      {showFhModal&&<FinnhubModal current={finnhubKey} onSave={saveFhKey} onClose={()=>setShowFhModal(false)}/>}
      {showCommModal&&<CommModal current={commPerSide} onSave={saveComm} onClose={()=>setShowCommModal(false)}/>}
      {showCloudModal&&<CloudSetupModal
        onSave={(u,p)=>{
          setCloudUrl(u);setCloudPwd(p);setShowCloudModal(false);setCloudStatus('syncing');
          cloudGet(p).then(remote=>{
            if(remote===null){setCloudStatus('err');return;}
            const hasData=remote.positions?.length||remote.closed?.length||remote.stocks?.length||remote.sgov?.marketValue;
            if(hasData){
              if(remote.positions)setPositions(remote.positions);
              if(remote.closed)setClosed(remote.closed);
              if(remote.stocks)setStocks(remote.stocks);
              if(remote.sgov)setSgov(remote.sgov);
              if(remote.cfg)setCfg(remote.cfg);
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
            <button onClick={()=>setShowCommModal(true)} className="btn btn-ghost btn-comm" style={{fontSize:12,fontFamily:'IBM Plex Mono,monospace',padding:'7px 12px'}}>¢ ${commPerSide}/张</button>
            <button onClick={refreshPrices} disabled={!!loading} className="btn"
              style={{background:loading==='refresh'?V('line'):ACC.blueBg,color:loading==='refresh'?V('faint'):ACC.blue,
                border:`1.5px solid ${loading==='refresh'?V('line'):`${ACC.blue}44`}`,fontWeight:500}}>
              {loading==='refresh'?'拉取中…':'↻ CBOE 刷新'}
            </button>
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
          <div className="sidebar-section">仓位</div>
          <button className={`tab-btn${tab==='active'?' active':''}`} onClick={()=>setTab('active')}>
            <span className="tab-dot" style={{background:ACC.profit}}/>
            <span className="tab-label tab-label-full">活跃期权</span><span className="tab-label tab-label-short">活跃</span>
            <span className="tab-count">{positions.length}</span>
          </button>
          <button className={`tab-btn${tab==='stocks'?' active':''}`} onClick={()=>setTab('stocks')}>
            <span className="tab-dot" style={{background:ACC.blue}}/>
            <span className="tab-label tab-label-full">股票持仓</span><span className="tab-label tab-label-short">股票</span>
            <span className="tab-count">{stocks.length}</span>
          </button>
          <button className={`tab-btn${tab==='closed'?' active':''}`} onClick={()=>setTab('closed')}>
            <span className="tab-dot" style={{background:V('faint')}}/>
            <span className="tab-label tab-label-full">已平仓</span><span className="tab-label tab-label-short">平仓</span>
            <span className="tab-count">{closed.length}</span>
          </button>
          <div className="sidebar-sep"/>
          <div className="sidebar-section">底仓</div>
          <button className={`tab-btn${tab==='sgov'?' active':''}`} onClick={()=>setTab('sgov')}>
            <span className="tab-dot" style={{background:ACC.teal}}/>
            <span className="tab-label">SGOV</span>
          </button>
          <div className="sidebar-sep"/>
          <div className="sidebar-section">工具</div>
          <button className={`tab-btn${tab==='watchlist'?' active':''}`} onClick={()=>setTab('watchlist')}>
            <span className="tab-dot" style={{background:ACC.blue}}/>
            <span className="tab-label tab-label-full">观察列表</span><span className="tab-label tab-label-short">观察</span>
          </button>
          <button className={`tab-btn${tab==='scan'?' active':''}`} onClick={()=>setTab('scan')}>
            <span className="tab-dot" style={{background:ACC.amber}}/>
            <span className="tab-label tab-label-full">期权筛选</span><span className="tab-label tab-label-short">筛选</span>
          </button>
          <button className={`tab-btn${tab==='finews'?' active':''}`} onClick={()=>setTab('finews')}>
            <span className="tab-dot" style={{background:ACC.teal}}/>
            <span className="tab-label tab-label-full">美股日报</span><span className="tab-label tab-label-short">日报</span>
          </button>
          <button className={`tab-btn${tab==='learn'?' active':''}`} onClick={()=>setTab('learn')}>
            <span className="tab-dot" style={{background:ACC.purple}}/>
            <span className="tab-label tab-label-full">期权学习</span><span className="tab-label tab-label-short">学习</span>
          </button>
        </div>

        {/* 右侧内容 */}
        <div className="main-area">
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
                {closed.map(c=><ClosedRow key={c.id} c={c} commPerSide={commPerSide} onDelete={()=>removeClosedRecord(c.id)}/>)}
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

          {/* 观察列表 Tab */}
          <div style={{display:tab==='watchlist'?'block':'none'}}><WatchlistPanel/></div>

          {/* 期权筛选 Tab */}
          <div style={{display:tab==='scan'?'block':'none'}}><ScanPanel/></div>

          {/* 美股日报 Tab */}
          <div style={{display:tab==='finews'?'block':'none',textAlign:'center',padding:'80px 20px'}}>
            <div style={{fontSize:48,marginBottom:16,opacity:.3}}>{'📰'}</div>
            <div style={{fontSize:18,fontWeight:700,color:V('ink'),marginBottom:8}}>{'FiNews · AI 美股盘后日报'}</div>
            <div style={{fontSize:13,color:V('dim'),marginBottom:24,lineHeight:1.7,maxWidth:500,margin:'0 auto 24px'}}>{'每日自动整理盘后总结、主要新闻、市场温度和核心数据，适合早晨快速了解昨夜美股概况。'}</div>
            <a href="https://finews.elsetech.app/" target="_blank" rel="noopener"
              style={{display:'inline-flex',alignItems:'center',gap:8,padding:'12px 28px',borderRadius:12,background:ACC.amberSoft,color:ACC.amber,border:'1.5px solid '+ACC.amber+'44',fontWeight:700,fontSize:15,textDecoration:'none',transition:'transform .1s'}}
              onMouseDown={e=>e.currentTarget.style.transform='scale(.97)'}
              onMouseUp={e=>e.currentTarget.style.transform='none'}>
              {'打开 FiNews ↗'}
            </a>
          </div>

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
