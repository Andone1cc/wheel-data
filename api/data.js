const XLSX = require('xlsx');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

async function redisGet(url, token, key) {
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.result || null;
}

async function redisSet(url, token, key, valueStr) {
  const res = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain; charset=utf-8' },
    body: valueStr,
  });
  return res.ok;
}

function canUseLocalFileStorage() {
  return process.env.NODE_ENV !== 'production' && !process.env.UPSTASH_REDIS_REST_URL;
}

async function localGet() {
  if (!canUseLocalFileStorage()) return null;
  try {
    return await require('fs').promises.readFile(process.env.LOCAL_DATA_FILE, 'utf8');
  } catch {
    return null;
  }
}

async function localSet(valueStr) {
  if (!canUseLocalFileStorage()) return false;
  const fs = require('fs').promises;
  const path = require('path');
  await fs.mkdir(path.dirname(process.env.LOCAL_DATA_FILE), { recursive: true });
  await fs.writeFile(process.env.LOCAL_DATA_FILE, valueStr);
  return true;
}

// 常数时间字符串比较，防止密码校验被时序攻击猜出内容
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return require('crypto').timingSafeEqual(bufA, bufB);
}

// A 股 ETF 期权公共行情。期权与标的行情只走交易所官方公开接口；
// 深交所公开 Greeks 不可靠，因此在服务端用官方收盘价做 BS 反推。
const CN_OPTION_UNDERLYINGS = {
  '510500': { symbol: '510500', quoteSymbol: 'sh510500', name: '南方中证500ETF', exchange: 'SSE', multiplier: 10000 },
  '159922': { symbol: '159922', quoteSymbol: 'sz159922', name: '嘉实中证500ETF', exchange: 'SZSE', multiplier: 10000 },
};
const cnOptionCache = new Map();
let cnMonthCache = { time: 0, months: [] };
let csi500IndexCache = { time: 0, data: null };
const CSI500_INDEX_CACHE_MS = 5 * 60 * 1000;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36';
// 上游请求策略：Vercel 的函数实例是短生命周期的，因此这里做的是“单实例保护”。
// 共享故障快照仍由 Redis 负责，避免在上游异常时连续重试拖慢整次函数执行。
const UPSTREAM_POLICY = {
  'qt.gtimg.cn': { minIntervalMs: 120, cooldownMs: 5000 },
  'cdn.cboe.com': { minIntervalMs: 220, cooldownMs: 8000 },
  'query1.finance.yahoo.com': { minIntervalMs: 180, cooldownMs: 8000 },
  'yunhq.sse.com.cn': { minIntervalMs: 180, cooldownMs: 5000 },
  'szse.cn': { minIntervalMs: 180, cooldownMs: 5000 },
  'open.er-api.com': { minIntervalMs: 120, cooldownMs: 5000 },
  '_default': { minIntervalMs: 80, cooldownMs: 4000 },
};
const upstreamState = new Map();
const upstreamLocks = new Map();
const SZSE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'User-Agent': BROWSER_USER_AGENT,
  Referer: 'https://www.szse.cn/market/product/option/index.html',
};
const SSE_HQ_BASE = 'https://yunhq.sse.com.cn:32042/';
const SSE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'User-Agent': BROWSER_USER_AGENT,
  Referer: 'https://www.sse.com.cn/assortment/options/price/',
};

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function marketNumber(value) {
  if (value == null || value === '') return null;
  return finiteNumber(String(value).replace(/,/g, ''));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function upstreamHost(url) {
  try { return new URL(url).hostname; } catch { return '_default'; }
}

function upstreamPolicy(url) {
  const host = upstreamHost(url);
  return UPSTREAM_POLICY[host] || UPSTREAM_POLICY._default;
}

async function beforeUpstreamRequest(url) {
  const host = upstreamHost(url);
  const policy = upstreamPolicy(url);
  // 深交所报告接口并发请求容易触发网关限流；上交所行情接口支持并行拉取
  // 合约链和标的行情，不能让两次请求排队后把 Vercel 函数拖过超时上限。
  const serialized = host === 'www.szse.cn';
  const previous = serialized ? (upstreamLocks.get(host) || Promise.resolve()) : Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  if (serialized) upstreamLocks.set(host, current);
  await previous.catch(() => {});
  const state = upstreamState.get(host) || { lastRequest: 0, failures: 0, cooldownUntil: 0 };
  const now = Date.now();
  if (state.cooldownUntil > now) {
    if (serialized) release();
    throw new Error(`${host} 暂时冷却中，请稍后重试`);
  }
  const gap = policy.minIntervalMs - (now - state.lastRequest);
  if (gap > 0) await wait(gap);
  state.lastRequest = Date.now();
  upstreamState.set(host, state);
  return { host, state, policy, release: serialized ? release : null };
}

function markUpstreamSuccess(host, state) {
  state.failures = 0;
  state.cooldownUntil = 0;
  upstreamState.set(host, state);
}

function markUpstreamFailure(host, state, policy) {
  state.failures = (state.failures || 0) + 1;
  if (state.failures >= 3) state.cooldownUntil = Date.now() + policy.cooldownMs;
  upstreamState.set(host, state);
}

async function fetchUpstream(url, options = {}, format = 'text') {
  const { timeoutMs = 8000, attempts = 2, ...fetchOptions } = options;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let requestContext;
    try {
      requestContext = await beforeUpstreamRequest(url);
      const response = await fetch(url, { ...fetchOptions, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`);
        throw error;
      } else if (format === 'json') {
        const value = await response.json();
        markUpstreamSuccess(requestContext.host, requestContext.state);
        return value;
      } else if (format === 'arrayBuffer') {
        const value = await response.arrayBuffer();
        markUpstreamSuccess(requestContext.host, requestContext.state);
        return value;
      } else {
        const value = await response.text();
        markUpstreamSuccess(requestContext.host, requestContext.state);
        return value;
      }
    } catch (error) {
      lastError = error;
      if (requestContext) markUpstreamFailure(requestContext.host, requestContext.state, requestContext.policy);
      if (/^4\d\d /.test(error.message) && !error.message.startsWith('429 ')) throw error;
    } finally {
      requestContext?.release?.();
    }
    if (attempt < attempts - 1) await wait(250 + attempt * 450);
  }
  throw lastError || new Error('上游行情暂时不可用');
}

async function fetchText(url, options = {}) {
  return fetchUpstream(url, options, 'text');
}

async function fetchJson(url, options = {}) {
  return fetchUpstream(url, options, 'json');
}

function quoteFreshness(source, quoteTime = null) {
  if (source === 'Tencent' || source === 'tencent-quote-index' || source === 'tencent-etf-realtime') return 'realtime';
  if (source === 'sse-official-realtime') return 'realtime';
  if (source === 'CBOE' || source === 'Yahoo') return 'delayed';
  if (source === 'szse-official-close' || source === 'sse-official-close') return 'official-close';
  return quoteTime ? 'delayed' : 'unknown';
}

function withQuoteMeta(payload, { symbol, source, quoteTime = null, currency = null, assetType = 'stock', stale = false, staleReason = null } = {}) {
  return {
    ...payload,
    symbol: symbol || payload.symbol || payload.ticker || null,
    assetType: payload.assetType || assetType,
    currency: payload.currency || currency || null,
    source: payload.source || source || null,
    quoteTime: payload.quoteTime || quoteTime || null,
    receivedAt: payload.receivedAt || new Date().toISOString(),
    freshness: payload.freshness || quoteFreshness(payload.source || source, payload.quoteTime || quoteTime),
    stale: payload.stale ?? stale,
    staleReason: payload.staleReason || staleReason || null,
  };
}

async function fetchCboeStockQuote(ticker) {
  const data = await fetchJson(
    `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(ticker)}.json`,
    { headers: { 'User-Agent': BROWSER_USER_AGENT }, timeoutMs: 6500, attempts: 1 }
  );
  const quote = data?.data || {};
  const price = finiteNumber(quote.current_price) ?? finiteNumber(quote.close) ?? finiteNumber(quote.prev_day_close);
  if (!(price > 0)) return null;
  const quoteTime = quote.quote_time || quote.timestamp || quote.last_updated || null;
  return withQuoteMeta({ name: quote.company_name || quote.symbol_name || null, price }, {
    symbol: ticker,
    source: 'CBOE',
    quoteTime,
    currency: 'USD',
  });
}

async function fetchExchangeRateQuote(ticker) {
  const match = /^([A-Z]{3})([A-Z]{3})=X$/.exec(String(ticker || '').toUpperCase());
  if (!match) return null;
  const [, base, target] = match;
  const data = await fetchJson(`https://open.er-api.com/v6/latest/${base}`, {
    headers: { 'User-Agent': BROWSER_USER_AGENT },
    timeoutMs: 4500,
    attempts: 1,
  });
  const price = finiteNumber(data?.rates?.[target]);
  if (!(price > 0)) return null;
  return withQuoteMeta({ name: `${base}/${target}`, price }, {
    symbol: ticker,
    source: 'ExchangeRate',
    currency: target,
  });
}

// “压舱石”监控数据：930955 的 PE / 股息率优先取中证指数官方数据文件，
// 10 年期国债优先取新浪公开 CN10YT 行情，东方财富只作为 PB 的补充源。
function anchorScaled(value, threshold = 20) {
  const n = finiteNumber(value);
  if (!(n > 0)) return null;
  return Math.abs(n) > threshold ? n / 100 : n;
}

async function fetchSinaAnchorBondYield() {
  const raw = await fetchText('https://hq.sinajs.cn/list=globalbd_cn10yt', {
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      Referer: 'https://stock.finance.sina.com.cn/forex/globalbd/cn10yt.html',
    },
    timeoutMs: 5000,
    attempts: 1,
  });
  const match = /globalbd_cn10yt="([^"]*)"/.exec(raw);
  const fields = match ? match[1].split(',') : [];
  const value = finiteNumber(fields[1]);
  if (!(value > 0)) throw new Error('新浪 CN10YT 无有效收益率');
  return {
    value,
    quoteTime: fields[12] && fields[13] ? `${fields[12]}T${fields[13]}+08:00` : null,
    source: 'Sina CN10YT',
  };
}

async function fetchCsIndexAnchorValuation() {
  const now = new Date();
  const start = new Date(now.getTime() - 20 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const end = now.toISOString().slice(0, 10).replace(/-/g, '');
  const [perfPayload, indicatorBuffer] = await Promise.all([
    fetchJson(`https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=930955&startDate=${start}&endDate=${end}`, {
      headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'application/json' },
      timeoutMs: 6500,
      attempts: 1,
    }).catch(() => null),
    fetchUpstream('https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/indicator/930955indicator.xls', {
      headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'application/vnd.ms-excel' },
      timeoutMs: 6500,
      attempts: 1,
    }, 'arrayBuffer').catch(() => null),
  ]);
  const perfRows = Array.isArray(perfPayload?.data) ? perfPayload.data : [];
  const perf = [...perfRows].sort((a, b) => String(b.tradeDate || '').localeCompare(String(a.tradeDate || '')))[0] || {};
  let indicator = {};
  if (indicatorBuffer) {
    try {
      const workbook = XLSX.read(Buffer.from(indicatorBuffer), { type: 'buffer' });
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true });
      const row = rows.slice(1).find(item => String(item?.[1] || '') === '930955') || rows[1] || [];
      indicator = {
        date: row[0] ? String(row[0]) : null,
        pe: finiteNumber(row[6]),
        dividendYield: finiteNumber(row[9]) ?? finiteNumber(row[8]),
      };
    } catch (error) {
      console.warn('CSIndex indicator parse:', error.message);
    }
  }
  const indexPE = indicator.pe ?? finiteNumber(perf.peg);
  const dividendYield = indicator.dividendYield;
  if (indexPE == null && dividendYield == null) throw new Error('中证指数官方估值暂时不可用');
  return {
    indexPE,
    dividendYield,
    asOf: indicator.date || perf.tradeDate || null,
    source: 'CSIndex official',
    sourceLinks: {
      index: 'https://www.csindex.com.cn/zh-CN/indices/index-detail/930955#/indices/family/detail?indexCode=930955',
      indicator: 'https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/indicator/930955indicator.xls',
    },
  };
}

// 中证指数的日频 indicator 文件不提供 PB；东方财富的指数行情接口对
// 930955 也经常返回 0。因此 PB 单独走公开估值页，并且只作为可选指标，
// 不参与 PE / 股息率 / 国债收益率主链路的成功判定。
async function fetchEtfRunAnchorPb() {
  const raw = await fetchText('https://www.etf.run/index/CSI/930955', {
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      Referer: 'https://www.etf.run/',
    },
    timeoutMs: 6500,
    attempts: 1,
  });
  const value = finiteNumber(raw.match(/最新市净率<\/span><span[^>]*>([\d.]+)<\/span>/)?.[1])
    ?? finiteNumber(raw.match(/PB[：:]\s*([\d.]+)倍/)?.[1]);
  if (!(value > 0)) throw new Error('ETF.run PB 无有效值');
  const asOf = raw.match(/更新时间：\s*(\d{4}\/\d{2}\/\d{2})/)?.[1]?.replaceAll('/', '') || null;
  return { value, asOf, source: 'ETF.run PB' };
}

async function fetchAnchorDividendHistory() {
  const raw = await fetchText('https://fund.eastmoney.com/pingzhongdata/159307.js', {
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'application/javascript,text/plain,*/*',
      Referer: 'https://fund.eastmoney.com/159307.html',
    },
    timeoutMs: 6500,
    attempts: 1,
  });
  const trendText = raw.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/)?.[1];
  if (!trendText) throw new Error('159307 分红历史格式暂时不可用');
  const trend = JSON.parse(trendText);
  const events = trend
    .filter(item => typeof item?.unitMoney === 'string' && item.unitMoney.includes('分红'))
    .map(item => {
      const perShare = finiteNumber(item.unitMoney.match(/每份派现金([\d.]+)元/)?.[1]);
      if (!(perShare > 0) || !(item.x > 0)) return null;
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(item.x));
      return { id: `159307-${date}`, exDate: date, perShare, description: item.unitMoney };
    })
    .filter(Boolean);
  if (!events.length) throw new Error('159307 暂无可识别分红记录');
  return {
    symbol: '159307.SZ',
    events,
    asOf: events.at(-1)?.exDate || null,
    source: 'Eastmoney fund dividend history',
    sourceLink: 'https://fund.eastmoney.com/159307.html',
    stale: false,
  };
}

async function fetchAnchorMetrics() {
  const lastVerifiedAnchorSnapshot = {
    indexPE: 8.64,
    dividendYield: 4.55,
    bond10Y: 1.676,
    asOf: '20260818',
  };
  const headers = {
    'User-Agent': BROWSER_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://quote.eastmoney.com/',
  };
  const indexRequest = fetchJson(
    'https://push2.eastmoney.com/api/qt/stock/get?secid=2.930955&fields=f58,f43,f57,f162,f164,f167,f173,f124',
    { headers, timeoutMs: 5500, attempts: 1 },
  ).catch(() => null);
  const bondRequest = fetchSinaAnchorBondYield().catch(() => null);
  const csIndexRequest = fetchCsIndexAnchorValuation().catch(() => null);
  const pbRequest = fetchEtfRunAnchorPb().catch(() => null);
  const [indexPayload, bondPayload, csIndex, pbPayload] = await Promise.all([indexRequest, bondRequest, csIndexRequest, pbRequest]);
  const index = indexPayload?.data || {};
  const indexPE = csIndex?.indexPE ?? anchorScaled(index.f164 ?? index.f162);
  const indexPB = anchorScaled(index.f167, 5) ?? pbPayload?.value ?? null;
  const dividendYield = csIndex?.dividendYield ?? anchorScaled(index.f173);
  // f43 是指数点位，不是债券收益率；新浪失败时必须走已验证快照，
  // 不能把 930955 的点位误当成 CN10Y 百分比。
  const bond10Y = bondPayload?.value ?? null;
  const stale = indexPE == null || dividendYield == null || bond10Y == null;
  const resolvedPE = indexPE ?? lastVerifiedAnchorSnapshot.indexPE;
  const resolvedDividendYield = dividendYield ?? lastVerifiedAnchorSnapshot.dividendYield;
  const resolvedBond10Y = bond10Y ?? lastVerifiedAnchorSnapshot.bond10Y;
  const liveSource = [csIndex?.source, bondPayload?.source, indexPB != null ? (anchorScaled(index.f167, 5) != null ? 'Eastmoney PB' : pbPayload?.source) : null].filter(Boolean).join(' + ');
  return {
    indexCode: '930955',
    indexName: '中证红利低波100',
    etfCode: '159307',
    indexPE: resolvedPE,
    indexPB,
    dividendYield: resolvedDividendYield,
    bond10Y: resolvedBond10Y,
    spread: resolvedDividendYield - resolvedBond10Y,
    asOf: stale ? (csIndex?.asOf || bondPayload?.quoteTime || lastVerifiedAnchorSnapshot.asOf) : (csIndex?.asOf || bondPayload?.quoteTime || new Date().toISOString()),
    source: stale ? `${liveSource || '官方数据'} · 最近已验证快照` : liveSource,
    stale,
    warning: stale ? '上游行情暂时不可用，已使用最近一次中证/新浪已验证快照；恢复后会自动更新。' : null,
    sourceLinks: {
      index: csIndex?.sourceLinks?.index || 'https://quote.eastmoney.com/zz/2.930955.html',
      bond: 'https://stock.finance.sina.com.cn/forex/globalbd/cn10yt.html',
      chinabond: 'https://yield.chinabond.com.cn/cbweb-cbrc-web/cbrc/showCbrc',
      pb: 'https://www.etf.run/index/CSI/930955',
    },
  };
}

function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

function bsValue(type, spot, strike, years, rate, dividend, volatility) {
  if (!(spot > 0 && strike > 0 && years > 0 && volatility > 0)) return null;
  const rootT = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate - dividend + volatility * volatility / 2) * years) / (volatility * rootT);
  const d2 = d1 - volatility * rootT;
  const spotPv = spot * Math.exp(-dividend * years);
  const strikePv = strike * Math.exp(-rate * years);
  const price = type === 'C'
    ? spotPv * normalCdf(d1) - strikePv * normalCdf(d2)
    : strikePv * normalCdf(-d2) - spotPv * normalCdf(-d1);
  const delta = type === 'C'
    ? Math.exp(-dividend * years) * normalCdf(d1)
    : Math.exp(-dividend * years) * (normalCdf(d1) - 1);
  return { price, delta };
}

function impliedVol(type, optionPrice, spot, strike, years, rate, dividend) {
  if (!(optionPrice > 0 && spot > 0 && strike > 0 && years > 0)) return null;
  let low = 0.001;
  let high = 5;
  const lowValue = bsValue(type, spot, strike, years, rate, dividend, low)?.price;
  const highValue = bsValue(type, spot, strike, years, rate, dividend, high)?.price;
  if (lowValue == null || optionPrice < lowValue - 1e-5 || optionPrice > highValue + 1e-5) return null;
  for (let i = 0; i < 72; i += 1) {
    const mid = (low + high) / 2;
    const value = bsValue(type, spot, strike, years, rate, dividend, mid).price;
    if (value > optionPrice) high = mid;
    else low = mid;
  }
  return (low + high) / 2;
}

function marketPrice(contract) {
  if (contract.bid > 0 && contract.ask > 0 && contract.ask >= contract.bid) return (contract.bid + contract.ask) / 2;
  return contract.last > 0 ? contract.last : null;
}

function enrichLocalGreeks(contracts, spot) {
  const rate = 0.015;
  const pairYields = new Map();
  const groups = new Map();
  contracts.forEach((contract) => {
    const key = `${contract.contractStyle || 'M'}-${Number(contract.strike).toFixed(4)}`;
    if (!groups.has(key)) groups.set(key, {});
    groups.get(key)[contract.type] = contract;
  });
  groups.forEach((pair, key) => {
    if (!pair.C || !pair.P) return;
    const call = marketPrice(pair.C);
    const put = marketPrice(pair.P);
    const years = Math.max((pair.C.dte ?? pair.P.dte ?? 1) / 365, 1 / 365);
    const discountedSpot = call != null && put != null
      ? call - put + pair.C.strike * Math.exp(-rate * years)
      : null;
    if (discountedSpot > 0 && spot > 0) {
      const q = Math.max(-0.05, Math.min(0.25, -Math.log(discountedSpot / spot) / years));
      pairYields.set(key, q);
    }
  });
  const validYields = [...pairYields.values()].sort((a, b) => a - b);
  const fallbackYield = validYields.length ? validYields[Math.floor(validYields.length / 2)] : 0;
  return contracts.map((contract) => {
    const key = `${contract.contractStyle || 'M'}-${Number(contract.strike).toFixed(4)}`;
    const dividend = pairYields.get(key) ?? fallbackYield;
    const years = Math.max((contract.dte ?? 1) / 365, 1 / 365);
    const price = marketPrice(contract);
    const iv = impliedVol(contract.type, price, spot, contract.strike, years, rate, dividend);
    const delta = iv ? bsValue(contract.type, spot, contract.strike, years, rate, dividend, iv)?.delta : null;
    return { ...contract, iv, delta, greekSource: 'local-bs', dividendYield: dividend };
  });
}

function fallbackOptionMonths() {
  const now = new Date();
  const result = [];
  const addMonth = (date) => {
    const value = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!result.includes(value)) result.push(value);
  };
  addMonth(new Date(now.getFullYear(), now.getMonth(), 1));
  addMonth(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  let cursor = new Date(now.getFullYear(), now.getMonth() + 2, 1);
  while (result.length < 4) {
    if ([2, 5, 8, 11].includes(cursor.getMonth())) addMonth(cursor);
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return result;
}

function shanghaiDate(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function daysUntil(dateString, fromDate = shanghaiDate()) {
  const expiry = new Date(`${dateString}T00:00:00+08:00`).getTime();
  const start = new Date(`${fromDate}T00:00:00+08:00`).getTime();
  return Math.max(0, Math.round((expiry - start) / 86400000));
}

function fourthWednesday(month) {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(4, 6)) - 1;
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const firstWednesday = 1 + ((3 - first.getUTCDay() + 7) % 7);
  const day = firstWednesday + 21;
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatSseQuoteTime(dateValue, timeValue) {
  const date = String(dateValue || '').padStart(8, '0');
  const time = String(timeValue || '').padStart(6, '0');
  if (date.length !== 8) return '';
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}${timeValue == null ? '' : ` ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`}`;
}

function formatTencentQuoteTime(value) {
  const time = String(value || '');
  if (!/^\d{14}$/.test(time)) return '';
  return `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)} ${time.slice(8, 10)}:${time.slice(10, 12)}:${time.slice(12, 14)}`;
}

function pickLatestQuote(quotes) {
  return quotes.filter(Boolean).sort((a, b) => {
    const aTime = Date.parse(a.quoteTime || '') || 0;
    const bTime = Date.parse(b.quoteTime || '') || 0;
    return bTime - aTime;
  })[0] || null;
}

async function fetchTencentCsi500Index() {
  const text = await fetchText('https://qt.gtimg.cn/q=sh000905', {
    headers: {
      Accept: '*/*',
      'User-Agent': BROWSER_USER_AGENT,
      Referer: 'https://gu.qq.com/',
    },
    timeoutMs: 1800,
    attempts: 1,
  });
  const quoted = /="([^"]+)"/.exec(text)?.[1];
  const fields = quoted?.split('~') || [];
  const price = marketNumber(fields[3]);
  if (!(price > 0) || fields[2] !== '000905') throw new Error('腾讯中证500指数行情为空');
  return withQuoteMeta({
    code: '000905', name: '中证500指数', price,
    change: marketNumber(fields[31]), changePct: marketNumber(fields[32]),
    previousClose: marketNumber(fields[4]),
    quoteTime: formatTencentQuoteTime(fields[30]) || shanghaiDate(),
    source: 'tencent-quote-index',
  }, {
    symbol: '000905', source: 'tencent-quote-index', quoteTime: formatTencentQuoteTime(fields[30]) || shanghaiDate(), currency: 'CNY', assetType: 'index',
  });
}

async function fetchTencentEtfQuote(config) {
  const exchangePrefix = config.exchange === 'SZSE' ? 'sz' : 'sh';
  const text = await fetchText(`https://qt.gtimg.cn/q=${exchangePrefix}${config.symbol}`, {
    headers: {
      Accept: '*/*',
      'User-Agent': BROWSER_USER_AGENT,
      Referer: 'https://gu.qq.com/',
    },
    timeoutMs: 2200,
    attempts: 1,
  });
  const quoted = /="([^"]+)"/.exec(text)?.[1];
  const fields = quoted?.split('~') || [];
  const price = marketNumber(fields[3]);
  if (!(price > 0)) throw new Error(`${config.symbol} ETF 盘中行情为空`);
  return withQuoteMeta({
    price,
    previousClose: marketNumber(fields[4]),
    change: marketNumber(fields[31]),
    changePct: marketNumber(fields[32]),
    quoteTime: formatTencentQuoteTime(fields[30]) || shanghaiDate(),
    source: 'tencent-etf-realtime',
  }, {
    symbol: config.symbol, source: 'tencent-etf-realtime', quoteTime: formatTencentQuoteTime(fields[30]) || shanghaiDate(), currency: 'CNY', assetType: 'etf',
  });
}

function parseTencentQuoteText(text, { symbol, tencentSymbol, currency = null, assetType = 'stock' } = {}) {
  const fields = (text.match(/="([\s\S]*?)";/)?.[1] || '').split('~');
  const price = marketNumber(fields[3]);
  if (fields.length < 4 || !(price > 0)) return null;
  const sourceCurrency = currency || fields[75] || fields[35] || null;
  const quoteTime = formatTencentQuoteTime(fields[30]) || null;
  return withQuoteMeta({
    name: fields[1] || null,
    code: fields[2] || tencentSymbol || null,
    price,
    previousClose: marketNumber(fields[4]),
    changePct: marketNumber(fields[32]),
    volume: marketNumber(fields[6]),
    quoteTime,
    source: 'Tencent',
  }, {
    symbol: symbol || tencentSymbol,
    source: 'Tencent',
    quoteTime,
    currency: sourceCurrency,
    assetType,
  });
}

async function fetchTencentQuote(tencentSymbol, options = {}) {
  const buffer = await fetchUpstream(`https://qt.gtimg.cn/q=${encodeURIComponent(tencentSymbol)}`, {
    headers: { Accept: '*/*', 'User-Agent': BROWSER_USER_AGENT, Referer: 'https://gu.qq.com/' },
    timeoutMs: options.timeoutMs || 3000,
    attempts: options.attempts || 1,
  }, 'arrayBuffer');
  const text = new TextDecoder('gbk').decode(buffer);
  return parseTencentQuoteText(text, { ...options, tencentSymbol });
}

async function fetchLiveEtfQuote(config) {
  return fetchTencentEtfQuote(config);
}

async function fetchCsi500Index() {
  if (csi500IndexCache.data && Date.now() - csi500IndexCache.time < CSI500_INDEX_CACHE_MS) {
    return { ...csi500IndexCache.data, cached: true };
  }
  try {
    let data;
    try {
      data = await fetchTencentCsi500Index();
    } catch (realtimeError) {
      const payload = await fetchJson(sseHqUrl('v1/sh1/list/self/000905', {
        select: 'code,cpxxextendname,last,change,chg_rate,amp_rate,volume,amount,prev_close',
      }), { headers: SSE_HEADERS, timeoutMs: 2200, attempts: 1 });
      const row = payload?.list?.[0];
      const price = marketNumber(row?.[2]);
      if (!(price > 0)) throw realtimeError;
      data = withQuoteMeta({
        code: '000905', name: '中证500指数', price,
        change: marketNumber(row?.[3]), changePct: marketNumber(row?.[4]),
        previousClose: marketNumber(row?.[8]),
        quoteTime: formatSseQuoteTime(payload.date, payload.time),
        source: 'sse-official-index',
      }, {
        symbol: '000905', source: 'sse-official-index', quoteTime: formatSseQuoteTime(payload.date, payload.time), currency: 'CNY', assetType: 'index',
      });
    }
    csi500IndexCache = { time: Date.now(), data };
    return { ...data, cached: false };
  } catch (error) {
    if (csi500IndexCache.data) {
      return { ...csi500IndexCache.data, cached: true, stale: true, freshness: 'stale', staleReason: 'upstream-unavailable' };
    }
    throw error;
  }
}

function sseHqUrl(path, params) {
  const url = new URL(path, SSE_HQ_BASE);
  Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function szseReportUrl(params) {
  const url = new URL('https://www.szse.cn/api/report/ShowReport/data');
  Object.entries({ SHOWTYPE: 'JSON', ...params }).forEach(([key, value]) => {
    if (value != null && value !== '') url.searchParams.set(key, value);
  });
  return url.toString();
}

async function fetchSzseReport(params) {
  // 深交所标准 HTTPS 接口通常在 1 秒内返回。限制单次等待和重试次数，
  // 避免 Vercel 因一个上游请求反复重试而耗尽整次函数执行时间。
  const payload = await fetchJson(szseReportUrl(params), {
    headers: SZSE_HEADERS,
    timeoutMs: 3000,
    attempts: 2,
  });
  const report = Array.isArray(payload) ? payload[0] : payload;
  if (!report || report.error) throw new Error(report?.error || '深交所官方数据为空');
  return report;
}

async function fetchSzseReportPages(params, firstReport) {
  const pageCount = Math.max(1, Number(firstReport?.metadata?.pagecount) || 1);
  if (pageCount === 1) return firstReport.data || [];
  const remaining = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) => fetchSzseReport({ ...params, PAGENO: index + 2 }))
  );
  return [firstReport, ...remaining].flatMap((report) => report.data || []);
}

async function fetchSzseOfficialCloseChain(config, month, months, realtime = false) {
  const monthLabel = `${Number(month.slice(-2))}月`;
  const optionQueries = [`中证500ETF购${monthLabel}`, `中证500ETF沽${monthLabel}`];
  let realtimeUnderlying = null;
  if (realtime) {
    try {
      realtimeUnderlying = await fetchLiveEtfQuote(config);
    } catch {}
  }
  let latestError;

  for (let offset = 0; offset >= -7; offset -= 1) {
    const quoteDate = shanghaiDate(offset);
    const quoteParams = optionQueries.map((query) => ({
      CATALOGID: '1815_stock_snapshot', TABKEY: 'tab6', txtDMorJC: query,
      txtBeginDate: quoteDate, txtEndDate: quoteDate, PAGENO: 1,
    }));
    const catalogParams = optionQueries.map((query) => ({
      CATALOGID: 'ysplbrb', TABKEY: 'tab1', txtQueryKeyAndJC: query, PAGENO: 1,
    }));
    try {
      const [callQuotesFirst, putQuotesFirst, callCatalog, putCatalog, underlyingReport] = await Promise.all([
        fetchSzseReport(quoteParams[0]),
        fetchSzseReport(quoteParams[1]),
        fetchSzseReport(catalogParams[0]),
        fetchSzseReport(catalogParams[1]),
        realtimeUnderlying
          ? Promise.resolve({ data: [{ ss: realtimeUnderlying.price }] })
          : fetchSzseReport({
            CATALOGID: '1815_stock_snapshot', TABKEY: 'tab2', txtDMorJC: config.symbol,
            txtBeginDate: quoteDate, txtEndDate: quoteDate, PAGENO: 1,
          }),
      ]);
      const underlyingRow = (underlyingReport.data || [])[0];
      if (!(underlyingRow && marketNumber(underlyingRow.ss) > 0)) continue;
      if (!(callQuotesFirst.data?.length || putQuotesFirst.data?.length)) continue;

      const [callQuotes, putQuotes] = await Promise.all([
        fetchSzseReportPages(quoteParams[0], callQuotesFirst),
        fetchSzseReportPages(quoteParams[1], putQuotesFirst),
      ]);
      const catalogByCode = new Map(
        [...(callCatalog.data || []), ...(putCatalog.data || [])].map((row) => [row.hydm, row])
      );
      const contracts = [...callQuotes, ...putQuotes].map((row) => {
        const catalog = catalogByCode.get(row.hybm) || {};
        const expiry = catalog.xqrq || null;
        return {
          code: row.hybm,
          name: catalog.hymc || row.hyjc || '',
          type: (catalog.hylx || row.hyjc || '').includes('沽') ? 'P' : 'C',
          strike: marketNumber(catalog.xqj),
          multiplier: marketNumber(catalog.hydw) || config.multiplier,
          expiry,
          dte: expiry ? daysUntil(expiry, quoteDate) : null,
          bidSize: null,
          bid: null,
          ask: null,
          askSize: null,
          last: marketNumber(row.jspj) ?? marketNumber(row.jjsj),
          settlement: marketNumber(row.jjsj),
          previousSettlement: marketNumber(row.qjsj),
          changePct: marketNumber(row.zdf),
          volume: marketNumber(row.cjl),
          openInterest: marketNumber(row.wpcl),
          quoteTime: quoteDate,
          contractStyle: 'M',
          priceSource: 'szse-official-close',
        };
      }).filter((contract) => contract.code && contract.strike > 0);
      if (!contracts.length) continue;

      const officialUnderlyingPrice = marketNumber(underlyingRow.ss);
      const underlyingPrice = realtimeUnderlying?.price || officialUnderlyingPrice;
      const underlyingQuoteTime = realtimeUnderlying?.quoteTime || quoteDate;
      return {
        ...config,
        assetType: 'option-chain',
        currency: 'CNY',
        months,
        selectedMonth: month,
        underlyingPrice,
        underlyingQuoteTime,
        underlyingSource: realtimeUnderlying?.source || 'szse-official-close',
        quoteTime: quoteDate,
        contracts: enrichLocalGreeks(contracts, underlyingPrice),
        delayed: true,
        source: 'szse-official-close',
        freshness: 'official-close',
        receivedAt: new Date().toISOString(),
        notice: realtimeUnderlying
          ? `159922 标的使用腾讯盘中行情（${underlyingQuoteTime}）；期权链为深交所官方收盘口径（${quoteDate}），不含实时买卖盘。`
          : `深交所期权链为日终口径，最新官方发布日为 ${quoteDate}；交易日盘中显示上一交易日属于正常情况，不含实时买卖盘。`,
        greekNote: realtimeUnderlying
          ? 'IV/Delta 由深交所官方收盘期权价与腾讯盘中 ETF 现价按 Black-Scholes 反推，仅供研究。'
          : 'IV/Delta 由深交所官方收盘价按 Black-Scholes 反推，仅供研究。',
      };
    } catch (error) {
      // 网络层错误与交易日无关，继续扫描前 7 天只会重复等待同一个故障源。
      // 立即交给共享快照兜底；仅在接口成功但当天无数据时才继续找上一交易日。
      latestError = error;
      break;
    }
  }
  throw latestError || new Error('深交所最近交易日行情为空');
}

async function getSseMonths() {
  if (cnMonthCache.months.length && Date.now() - cnMonthCache.time < 15 * 60 * 1000) return cnMonthCache.months;
  const months = fallbackOptionMonths();
  cnMonthCache = { time: Date.now(), months };
  return months;
}

async function fetchSseOfficialChain(config, month, months) {
  const expiry = fourthWednesday(month);
  const [chain, underlying] = await Promise.all([
    fetchJson(sseHqUrl(`v1/sho/list/tstyle/${config.symbol}_${month.slice(-2)}`, {
      select: 'contractid,last,chg_rate,presetpx,exepx',
      order: 'contractid,ase',
    }), { headers: SSE_HEADERS, timeoutMs: 9000, attempts: 1 }),
    fetchJson(sseHqUrl(`v1/sh1/list/self/${config.symbol}`, {
      select: 'code,cpxxextendname,last,change,chg_rate,amp_rate,volume,amount,prev_close',
    }), { headers: SSE_HEADERS, timeoutMs: 9000, attempts: 1 }),
  ]);
  const underlyingRow = underlying?.list?.[0];
  const underlyingPrice = marketNumber(underlyingRow?.[2]);
  if (!(underlyingPrice > 0)) throw new Error('上交所标的行情为空');

  const contracts = (chain?.list || []).map((row) => {
    const contractId = String(row?.[0] || '');
    const type = contractId.includes('P') ? 'P' : 'C';
    const contractStyle = contractId.slice(11, 12) || 'M';
    return {
      code: contractId,
      name: contractId,
      type,
      strike: marketNumber(row?.[4]),
      multiplier: contractStyle === 'M' ? config.multiplier : null,
      expiry,
      dte: daysUntil(expiry),
      bidSize: null,
      bid: null,
      ask: null,
      askSize: null,
      last: marketNumber(row?.[1]),
      previousSettlement: marketNumber(row?.[3]),
      changePct: marketNumber(row?.[2]),
      volume: null,
      openInterest: null,
      quoteTime: formatSseQuoteTime(chain.date, chain.time),
      contractStyle,
      priceSource: 'sse-official-realtime',
    };
  }).filter((contract) => contract.code && contract.strike > 0);
  if (!contracts.length) throw new Error(`${month} 上交所官方期权行情为空`);

  return {
    ...config,
    assetType: 'option-chain',
    currency: 'CNY',
    months,
    selectedMonth: month,
    underlyingPrice,
    quoteTime: formatSseQuoteTime(chain.date, chain.time),
    contracts: enrichLocalGreeks(contracts, underlyingPrice),
    source: 'sse-official-realtime',
    freshness: 'realtime',
    receivedAt: new Date().toISOString(),
    notice: '上交所官方实时行情；官方公网接口不含 Bid/Ask、成交量和持仓量。',
    greekNote: 'IV/Delta 由上交所官方实时最新价按 Black-Scholes 反推，仅供研究。',
  };
}

async function fetchSseChain(config, requestedMonth) {
  const months = await getSseMonths();
  const month = months.includes(requestedMonth) ? requestedMonth : months[0];
  if (!month) throw new Error('暂未查询到上交所可用合约月份');
  return fetchSseOfficialChain(config, month, months);
}

async function fetchSzseChain(config, requestedMonth, realtime = false) {
  // 深交所链路不再调用上交所 32042 端口获取月份。ETF 期权月份规则可在
  // 本地生成；用户明确选择的 YYYYMM 也直接交给深交所官方接口验证。
  const months = fallbackOptionMonths();
  const requested = /^\d{6}$/.test(String(requestedMonth || '')) ? String(requestedMonth) : '';
  const month = requested || months[0];
  if (requested && !months.includes(requested)) months.unshift(requested);
  if (!month) throw new Error('暂未查询到深交所可用合约月份');
  return fetchSzseOfficialCloseChain(config, month, months, realtime);
}

async function fetchCnOptionChain(symbol, month, force = false, realtime = false, options = {}) {
  const config = CN_OPTION_UNDERLYINGS[symbol];
  if (!config) throw new Error('仅支持 510500、159922');
  const cacheKey = `${symbol}-${month || 'near'}-${realtime ? 'realtime' : 'official'}`;
  const cached = cnOptionCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.time < 60000) return { ...cached.data, cached: true };
  try {
    // 指数仅用于换算展示，不能阻塞期权链主请求。若进程中已有缓存则顺手带回，
    // 否则由前端独立请求 /api/cn-options?indexOnly=1。
    const data = config.exchange === 'SSE'
      ? await fetchSseChain(config, month)
      : await fetchSzseChain(config, month, realtime);
    const index = csi500IndexCache.data;
    const enriched = index && data.underlyingPrice > 0 ? {
      ...data,
      indexPrice: index.price,
      indexQuoteTime: index.quoteTime,
      indexSource: index.source,
      contracts: data.contracts.map((contract) => ({
        ...contract,
        indexStrike: contract.strike > 0 ? (contract.strike / data.underlyingPrice) * index.price : null,
      })),
    } : data;
    const fetchedAt = new Date().toISOString();
    const dataDate = String(enriched.quoteTime || enriched.underlyingQuoteTime || shanghaiDate()).slice(0, 10);
    const snapshot = {
      ...enriched,
      dataDate,
      fetchedAt,
      snapshotSavedAt: Date.now(),
    };
    cnOptionCache.set(cacheKey, { time: Date.now(), data: snapshot });
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (redisUrl && redisToken && options.persist !== false) {
      // 普通查询不阻塞行情响应；收盘 Cron 会显式 await 持久化。
      redisSet(redisUrl, redisToken, `wheel_cn_option_${cacheKey}`, JSON.stringify(snapshot)).catch(() => {});
    }
    return { ...snapshot, cached: false, stale: false };
  } catch (error) {
    let fallback = cached?.data || null;
    if (!fallback) {
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (redisUrl && redisToken) {
        try {
          // 实时请求与收盘 Cron 使用不同缓存键；实时失败时必须读取收盘快照。
          const requestedMonth = /^\d{6}$/.test(String(month || ''))
            ? String(month)
            : fallbackOptionMonths()[0];
          const keys = [
            `wheel_cn_option_${cacheKey}`,
            `wheel_cn_option_eod_latest_${symbol}_${requestedMonth}`,
          ];
          for (const key of keys) {
            const raw = await redisGet(redisUrl, redisToken, key);
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed?.contracts?.length) {
              fallback = parsed;
              break;
            }
          }
        } catch {}
      }
    }
    if (fallback) {
      const snapshotTime = fallback.dataDate || fallback.quoteTime || (fallback.snapshotSavedAt
        ? new Date(fallback.snapshotSavedAt).toISOString()
        : '时间未知');
      const isSzseClose = config.exchange === 'SZSE' || fallback.source === 'szse-official-close';
      return {
        ...fallback,
        cached: true,
        stale: true,
        freshness: 'stale',
        cacheScope: cached ? 'memory' : 'shared',
        staleReason: isSzseClose ? 'official-close-lag' : 'upstream-unavailable',
        warning: isSzseClose
          ? `深交所期权链为日终口径，最新官方发布日为 ${snapshotTime}；当前为云端保存的官方快照。`
          : `官方行情暂时不可用，已返回云端最近快照（${snapshotTime}）。`,
      };
    }
    throw error;
  }
}

function cnOptionEodKey(symbol, month) {
  return `wheel_cn_option_eod_latest_${symbol}_${month}`;
}

async function persistCnOptionSnapshot(snapshot, cacheKey, options = {}) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) throw new Error('未配置 UPSTASH_REDIS_REST_URL/TOKEN，无法保存收盘快照');
  const month = snapshot.selectedMonth;
  const dataDate = snapshot.dataDate || String(snapshot.quoteTime || shanghaiDate()).slice(0, 10);
  const mode = options.mode || 'eod';
  const isPreclose = mode === 'preclose';
  const latestKey = isPreclose
    ? `wheel_cn_option_preclose_latest_${snapshot.symbol}_${month}`
    : cnOptionEodKey(snapshot.symbol, month);
  const value = JSON.stringify({
    ...snapshot,
    dataDate,
    fetchedAt: snapshot.fetchedAt || new Date().toISOString(),
    snapshotMode: mode,
    snapshotSource: snapshot.source || null,
    freshness: isPreclose ? (snapshot.freshness || 'delayed') : 'official-close',
    notice: isPreclose
      ? `盘中预备快照（${dataDate}）；期权链可能仍为上一交易日官方口径。`
      : `交易日收盘快照（${dataDate}）；盘中实时数据不可用时将自动使用此快照。`,
    stale: false,
  });
  const keys = [
    `wheel_cn_option_${cacheKey}`,
    isPreclose
      ? `wheel_cn_option_preclose_${snapshot.symbol}_${dataDate}_${month}`
      : `wheel_cn_option_eod_${snapshot.symbol}_${dataDate}_${month}`,
    latestKey,
  ];
  const results = await Promise.all(keys.map((key) => redisSet(redisUrl, redisToken, key, value)));
  if (results.some((ok) => !ok)) throw new Error('收盘快照写入 Redis 失败');
  return { key: latestKey, dataDate, month };
}

async function runCnOptionEodSync(symbol) {
  const configuredMonths = fallbackOptionMonths();
  const months = process.env.CN_OPTION_EOD_ALL_MONTHS === '1'
    ? configuredMonths
    : configuredMonths.slice(0, 2);
  const startedAt = new Date().toISOString();
  const results = [];
  const errors = [];
  for (const month of months) {
    try {
      // 收盘任务不请求腾讯盘中价，保证 ETF、期权链和 Greeks 使用同一交易日口径。
      const payload = await fetchCnOptionChain(symbol, month, true, false, { persist: false });
      const saved = await persistCnOptionSnapshot({
        ...payload,
        snapshotMode: 'eod',
        fetchedAt: new Date().toISOString(),
      }, `${symbol}-${month}-official`);
      results.push({ symbol, month, dataDate: saved.dataDate, contracts: payload.contracts?.length || 0 });
    } catch (error) {
      errors.push({ symbol, month, error: error.message });
    }
  }
  return {
    symbol,
    startedAt,
    finishedAt: new Date().toISOString(),
    months,
    saved: results,
    errors,
    ok: results.length > 0 && errors.length === 0,
  };
}

async function runCnOptionPrecloseSync(symbol) {
  const months = fallbackOptionMonths().slice(0, 2);
  const startedAt = new Date().toISOString();
  const results = [];
  const errors = [];
  for (const month of months) {
    try {
      // 预备任务请求盘中标的价；深交所期权链仍可能是上一交易日官方收盘口径。
      const payload = await fetchCnOptionChain(symbol, month, true, true, { persist: false });
      const saved = await persistCnOptionSnapshot({
        ...payload,
        snapshotMode: 'preclose',
        fetchedAt: new Date().toISOString(),
      }, `${symbol}-${month}-realtime`, { mode: 'preclose' });
      results.push({ symbol, month, dataDate: saved.dataDate, contracts: payload.contracts?.length || 0 });
    } catch (error) {
      errors.push({ symbol, month, error: error.message });
    }
  }
  return {
    symbol,
    startedAt,
    finishedAt: new Date().toISOString(),
    months,
    saved: results,
    errors,
    ok: results.length > 0 && errors.length === 0,
  };
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const reqUrl = req.url || '';
  // 统一在最上面解析一次密码，后面所有需要鉴权的分支都用它
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const passwordOk = !!process.env.ACCESS_PASSWORD && safeEqual(token, process.env.ACCESS_PASSWORD);

  // ══════════════════════════════════════════════════
  // A 股期权收盘快照任务（Vercel Cron 专用）
  // /api/cron/cn-options-510500
  // /api/cron/cn-options-159922
  // ══════════════════════════════════════════════════
  if (reqUrl.startsWith('/api/cron/cn-options') || reqUrl.includes('cronSymbol=')) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const cronSecret = process.env.CRON_SECRET;
    const cronAuthorized = cronSecret && safeEqual(token, cronSecret);
    if (process.env.NODE_ENV === 'production' && !cronAuthorized) {
      return res.status(401).json({ error: 'Cron secret 不正确' });
    }
    const cronUrl = new URL(reqUrl, 'http://localhost');
    const symbol = cronUrl.searchParams.get('symbol')
      || cronUrl.searchParams.get('cronSymbol')
      || (reqUrl.includes('159922') ? '159922' : '510500');
    try {
      const result = reqUrl.includes('preclose') || cronUrl.searchParams.get('cronMode') === 'preclose'
        ? await runCnOptionPrecloseSync(symbol)
        : await runCnOptionEodSync(symbol);
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (redisUrl && redisToken) {
        const statusKey = `wheel_cn_option_eod_status_${shanghaiDate()}`;
        await redisSet(redisUrl, redisToken, statusKey, JSON.stringify(result));
      }
      return res.status(result.ok ? 200 : 502).json(result);
    } catch (error) {
      return res.status(500).json({ error: 'A 股期权收盘任务失败', detail: error.message });
    }
  }

  // ══════════════════════════════════════════════════
  // 富途 OpenD API 代理（需密码 —— 这条链路能直接访问你的
  // 真实交易网关，不鉴权=任何人都能读写你的行情/仓位接口）
  // /api/futu/* → 转发到富途服务器
  // ══════════════════════════════════════════════════
  if (reqUrl.startsWith('/api/futu/')) {
    if (!passwordOk) {
      return res.status(401).json({ error: '密码错误' });
    }
    const FUTU_BASE = process.env.FUTU_API_URL;
    if (!FUTU_BASE) {
      // 不再内置任何默认地址，必须在 Vercel 环境变量里配置真实网关地址
      return res.status(500).json({ error: 'FUTU_API_URL 未配置' });
    }
    // /api/futu/watchlist → /api/watchlist
    // /api/futu/option-chain?code=US.IBIT&... → /api/option-chain?code=US.IBIT&...
    const futuPath = reqUrl.replace('/api/futu', '/api');
    const futuUrl = FUTU_BASE + futuPath;

    try {
      const fetchOpts = {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
      };

      // POST 请求转发 body
      if (req.method === 'POST' || req.method === 'PUT') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        fetchOpts.body = Buffer.concat(chunks).toString();
      }

      const futuRes = await fetch(futuUrl, fetchOpts);
      const data = await futuRes.json();
      return res.status(futuRes.status).json(data);
    } catch (e) {
      return res.status(502).json({ error: 'Futu API 连接失败', detail: e.message });
    }
  }

  // ══════════════════════════════════════════════════
  // CBOE 期权链代理（保留，作备用）
  // ══════════════════════════════════════════════════
  if (reqUrl.startsWith('/api/cboe/')) {
    const ticker = decodeURIComponent(reqUrl.replace('/api/cboe/', '').split('?')[0]);
    try {
      const data = await fetchJson(
        `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(ticker)}.json`,
        { headers: { 'User-Agent': BROWSER_USER_AGENT }, timeoutMs: 12000, attempts: 1 }
      );
      const quote = data?.data || {};
      const quoteTime = quote.quote_time || quote.timestamp || quote.last_updated || null;
      const payload = {
        ...data,
        symbol: ticker,
        assetType: 'option-chain',
        currency: 'USD',
        source: 'CBOE',
        quoteTime,
        receivedAt: new Date().toISOString(),
        freshness: 'delayed',
        stale: false,
      };
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
      return res.status(200).json(payload);
    } catch (e) {
      return res.status(502).json({ error: 'CBOE failed', detail: e.message });
    }
  }

  // ══════════════════════════════════════════════════
  // “压舱石”股债息差监控
  // /api/anchor-metrics
  // ══════════════════════════════════════════════════
  if (reqUrl.startsWith('/api/anchor-metrics')) {
    try {
      const payload = await fetchAnchorMetrics();
      res.setHeader('Cache-Control', reqUrl.includes('refresh=') ? 'no-store' : 'public, s-maxage=900, stale-while-revalidate=3600');
      return res.status(200).json(payload);
    } catch (e) {
      return res.status(502).json({ error: '压舱石监控数据暂时不可用', detail: e.message });
    }
  }

  if (reqUrl.startsWith('/api/anchor-dividends')) {
    try {
      const payload = await fetchAnchorDividendHistory();
      res.setHeader('Cache-Control', reqUrl.includes('refresh=') ? 'no-store' : 'public, s-maxage=86400, stale-while-revalidate=172800');
      return res.status(200).json(payload);
    } catch (e) {
      return res.status(502).json({ error: '159307 分红历史暂时不可用', detail: e.message });
    }
  }

  // ══════════════════════════════════════════════════
  // 股价代理（Yahoo v8，给主面板刷新用）
  // ══════════════════════════════════════════════════
  if (reqUrl.startsWith('/api/quote/')) {
    const ticker = decodeURIComponent(reqUrl.replace('/api/quote/', '').split('?')[0]);
    try {
      const upperTicker = ticker.toUpperCase();
      const isHk = upperTicker.endsWith('.HK');
      const isSse = upperTicker.endsWith('.SS');
      const isSzse = upperTicker.endsWith('.SZ');
      const isCnOrHk = isHk || isSse || isSzse;
      const code = upperTicker.split('.')[0];
      const tencentSymbol = isHk
        ? `hk${code.padStart(5, '0')}`
        : isSse ? `sh${code}`
          : isSzse ? `sz${code}`
            : !upperTicker.includes('=') ? `us${code}` : '';
      const locale = isHk ? '&lang=zh-Hant-HK&region=HK' : (isSse || isSzse) ? '&lang=zh-CN&region=CN' : '';
      const yahooRequest = fetchJson(
        `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d${locale}`,
        { headers: { 'User-Agent': BROWSER_USER_AGENT }, timeoutMs: 6000, attempts: 1 }
      ).then(data => {
        const meta = data?.chart?.result?.[0]?.meta || {};
        const price = finiteNumber(meta.regularMarketPrice) ?? finiteNumber(meta.previousClose);
        if (!(price > 0)) return null;
        const quoteTime = meta.regularMarketTime ? new Date(Number(meta.regularMarketTime) * 1000).toISOString() : null;
        return withQuoteMeta({
          name: meta.shortName || meta.longName || null,
          price,
          previousClose: finiteNumber(meta.previousClose),
          quoteTime,
        }, {
          symbol: ticker,
          source: 'Yahoo',
          quoteTime,
          currency: isHk ? 'HKD' : isSse || isSzse ? 'CNY' : 'USD',
        });
      });
      const cnQuoteRequest = tencentSymbol
        ? fetchTencentQuote(tencentSymbol, {
          symbol: ticker,
          currency: isHk ? 'HKD' : isSse || isSzse ? 'CNY' : 'USD',
          timeoutMs: 4500,
          attempts: 1,
        })
        : Promise.resolve(null);
      const cboeQuoteRequest = !isCnOrHk && !upperTicker.includes('=')
        ? fetchCboeStockQuote(upperTicker).catch(() => null)
        : Promise.resolve(null);
      const fxQuoteRequest = upperTicker.includes('=')
        ? fetchExchangeRateQuote(upperTicker).catch(() => null)
        : Promise.resolve(null);
      const [yahooResult, cnQuoteResult, cboeQuoteResult, fxQuoteResult] = await Promise.allSettled([yahooRequest, cnQuoteRequest, cboeQuoteRequest, fxQuoteRequest]);
      const yahooQuote = yahooResult.status === 'fulfilled' ? yahooResult.value : null;
      const cnQuote = cnQuoteResult.status === 'fulfilled' ? cnQuoteResult.value : null;
      const cboeQuote = cboeQuoteResult.status === 'fulfilled' ? cboeQuoteResult.value : null;
      const fxQuote = fxQuoteResult.status === 'fulfilled' ? fxQuoteResult.value : null;
      // A/H 股票优先腾讯盘中价；美股优先 CBOE 延迟价，再回退 Yahoo/腾讯。
      // 这样不会因为 Yahoo 返回上一交易日的 regularMarketPrice 而覆盖更近的本地行情。
      const selected = (isCnOrHk ? [cnQuote, yahooQuote, cboeQuote] : [cboeQuote, yahooQuote, cnQuote, fxQuote]).find((quote) => quote?.price > 0 || quote?.name);
      const price = selected?.price ?? null;
      const name = selected?.name || null;
      if (price == null && !name) throw new Error('股票行情源暂时不可用');
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json(withQuoteMeta({ ticker, price, name }, {
        symbol: ticker,
        source: selected?.source || 'unknown',
        quoteTime: selected?.quoteTime || null,
        currency: selected?.currency || (isHk ? 'HKD' : isSse || isSzse ? 'CNY' : upperTicker.includes('=') ? upperTicker.slice(3, 6) : 'USD'),
        assetType: upperTicker.includes('=') ? 'fx' : 'stock',
      }));
    } catch (e) {
      return res.status(502).json({ ticker, price: null, name: null, error: e.message });
    }
  }

  // ══════════════════════════════════════════════════
  // 历史收盘价代理（用于到期自动结算和已平仓到期复盘）
  // /api/history/:ticker?date=YYYY-MM-DD
  // ══════════════════════════════════════════════════
  if (reqUrl.startsWith('/api/history/')) {
    const [rawTicker, query = ''] = reqUrl.replace('/api/history/', '').split('?');
    const ticker = decodeURIComponent(rawTicker);
    const params = new URLSearchParams(query);
    const date = params.get('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return res.status(400).json({ ticker, price: null, error: 'date must be YYYY-MM-DD' });
    }

    const [y, m, d] = date.split('-').map(Number);
    const target = Date.UTC(y, m - 1, d);
    const period1 = Math.floor((target - 5 * 86400000) / 1000);
    const period2 = Math.floor((target + 3 * 86400000) / 1000);
    const pickClose = (rows) => {
      if (!rows.length) return null;
      const targetEnd = Math.floor((target + 86399999) / 1000);
      const beforeOrOn = rows.filter((row) => row.ts <= targetEnd).sort((a, b) => b.ts - a.ts)[0];
      return beforeOrOn || rows.sort((a, b) => a.ts - b.ts)[0];
    };

    // Yahoo 的 query1 在云函数出口偶尔会返回 429；query2 使用同一数据但
    // 不同边缘节点，作为低成本的第二次尝试。
    for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
      try {
        const payload = await fetchJson(
          `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${period1}&period2=${period2}`,
          {
            headers: {
              Accept: 'application/json, text/plain, */*',
              'Accept-Language': 'en-US,en;q=0.9',
              Referer: 'https://finance.yahoo.com/',
              'User-Agent': BROWSER_USER_AGENT,
            },
            timeoutMs: 4500,
            attempts: 1,
          },
        );
        const result = payload?.chart?.result?.[0];
        const timestamps = result?.timestamp || [];
        const closes = result?.indicators?.quote?.[0]?.close || [];
        const rows = timestamps
          .map((ts, index) => ({ ts, price: closes[index], date: new Date(ts * 1000).toISOString().slice(0, 10) }))
          .filter((row) => Number(row.price) > 0);
        const picked = pickClose(rows);
        if (picked) {
          res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
          return res.status(200).json({ ticker, date: picked.date, requestedDate: date, price: Number(picked.price), source: 'Yahoo' });
        }
      } catch {}
    }

    // Nasdaq 对 ETF 和股票使用不同 assetclass。DRAM 等 Cboe ETF 若按 stocks
    // 请求会直接返回 Symbol not exists，因此 ETF 必须优先尝试。
    const fromDate = new Date(target - 5 * 86400000).toISOString().slice(0, 10);
    const toDate = new Date(target + 3 * 86400000).toISOString().slice(0, 10);
    for (const assetClass of ['etf', 'stocks']) {
      try {
        const nasdaqUrl = new URL(`https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/historical`);
        nasdaqUrl.searchParams.set('assetclass', assetClass);
        nasdaqUrl.searchParams.set('fromdate', fromDate);
        nasdaqUrl.searchParams.set('todate', toDate);
        nasdaqUrl.searchParams.set('limit', '20');
        const nasdaqRes = await fetch(nasdaqUrl, {
          headers: {
            'User-Agent': BROWSER_USER_AGENT,
            Accept: 'application/json, text/plain, */*',
            Origin: 'https://www.nasdaq.com',
            Referer: 'https://www.nasdaq.com/',
          },
          signal: AbortSignal.timeout(5000),
        });
        if (!nasdaqRes.ok) continue;
        const rows = ((await nasdaqRes.json())?.data?.tradesTable?.rows || [])
          .map((row) => {
            const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(row.date || '');
            const price = Number(String(row.close || '').replace(/[$,]/g, ''));
            if (!match || !(price > 0)) return null;
            const isoDate = `${match[3]}-${match[1]}-${match[2]}`;
            return { date: isoDate, ts: Math.floor(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])) / 1000), price };
          })
          .filter(Boolean);
        const picked = pickClose(rows);
        if (picked) {
          res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
          return res.status(200).json({ ticker, date: picked.date, requestedDate: date, price: picked.price, source: `Nasdaq-${assetClass}` });
        }
      } catch {}
    }

    try {
      const d1 = new Date(target - 5 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
      const d2 = new Date(target + 3 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
      const stooqRes = await fetch(
        `https://stooq.com/q/d/l/?s=${encodeURIComponent(ticker.toLowerCase() + '.us')}&d1=${d1}&d2=${d2}&i=d`,
        { headers: { 'User-Agent': BROWSER_USER_AGENT }, signal: AbortSignal.timeout(4500) }
      );
      const rows = (await stooqRes.text()).trim().split(/\r?\n/).slice(1)
        .map((line) => {
          const [rowDate, , , , close] = line.split(',');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(rowDate || '')) return null;
          const [yy, mm, dd] = rowDate.split('-').map(Number);
          return { date: rowDate, ts: Math.floor(Date.UTC(yy, mm - 1, dd) / 1000), price: Number(close) };
        })
        .filter((row) => row && Number.isFinite(row.price));
      const picked = pickClose(rows);
      if (picked) {
        res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
        return res.status(200).json({ ticker, date: picked.date, requestedDate: date, price: Number(picked.price), source: 'Stooq' });
      }
    } catch {}

    return res.status(200).json({ ticker, date, price: null });
  }

  // ══════════════════════════════════════════════════
  // A 股中证 500 ETF 期权查询（公开只读，无需账户密码）
  // /api/cn-options?symbol=510500&month=202608
  // ══════════════════════════════════════════════════
  if (reqUrl.startsWith('/api/cn-options')) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const url = new URL(reqUrl, 'http://localhost');
    if (url.searchParams.get('indexOnly') === '1') {
      try {
        const data = await fetchCsi500Index();
        res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
        return res.status(200).json(data);
      } catch (e) {
        return res.status(502).json({ error: '中证500指数行情拉取失败', detail: e.message });
      }
    }
      const symbol = url.searchParams.get('symbol') || '510500';
      const month = url.searchParams.get('month') || '';
    try {
      const force = url.searchParams.get('refresh') === '1';
      const realtime = url.searchParams.get('realtime') === '1';
      const data = await fetchCnOptionChain(symbol, month, force, realtime);
      // 深交所期权链本身仍是官方收盘口径，但标的 ETF 使用腾讯盘中价，
      // 因此不能再让 CDN 长时间复用旧的标的价格。刷新请求同时绕过进程缓存。
      res.setHeader('Cache-Control', data.exchange === 'SZSE'
        ? 'public, s-maxage=30, stale-while-revalidate=120'
        : 'public, s-maxage=30, stale-while-revalidate=600');
      return res.status(200).json(data);
    } catch (e) {
      return res.status(502).json({ error: 'A 股期权行情拉取失败', detail: e.message });
    }
  }

  // ══════════════════════════════════════════════════
  // 云端数据同步（需密码）
  // ══════════════════════════════════════════════════
  if (!passwordOk) {
    return res.status(401).json({ error: '密码错误' });
  }

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const key = 'wheel_data';

  if (req.method === 'GET' && reqUrl.includes('health')) {
    return res.status(200).json({ ok: true, time: Date.now() });
  }

  if (req.method === 'GET') {
    const raw = redisUrl && redisToken
      ? await redisGet(redisUrl, redisToken, key)
      : await localGet();
    if (!raw) return res.status(200).json({});
    try { return res.status(200).json(JSON.parse(raw)); }
    catch { return res.status(200).json({}); }
  }

  if (req.method === 'PUT') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    try { JSON.parse(body); } catch {
      return res.status(400).json({ error: '无效 JSON' });
    }
    if (redisUrl && redisToken) await redisSet(redisUrl, redisToken, key, body);
    else await localSet(body);
    return res.status(200).json({ ok: true });
  }

  return res.status(404).json({ error: 'Not found' });
};
