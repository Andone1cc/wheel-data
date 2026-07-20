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
    headers: { Authorization: `Bearer ${token}` },
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

// A 股 ETF 期权公共行情。合约清单来自交易所/新浪，量价来自新浪实时行情；
// 深交所公开 Greeks 不可靠，因此在服务端用同执行价 Call/Put 盘口做 BS 反推。
const CN_OPTION_UNDERLYINGS = {
  '510500': { symbol: '510500', quoteSymbol: 'sh510500', name: '南方中证500ETF', exchange: 'SSE', multiplier: 10000 },
  '159922': { symbol: '159922', quoteSymbol: 'sz159922', name: '嘉实中证500ETF', exchange: 'SZSE', multiplier: 10000 },
};
const cnOptionCache = new Map();
const SINA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
  Referer: 'https://stock.finance.sina.com.cn/',
};

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function parseSinaVariables(text, prefix) {
  const rows = new Map();
  const pattern = new RegExp(`hq_str_${prefix}([^=]+)="([^"]*)"`, 'g');
  let match;
  while ((match = pattern.exec(text))) rows.set(match[1], match[2].split(','));
  return rows;
}

async function fetchSinaRows(symbols, prefix = '') {
  if (!symbols.length) return new Map();
  const list = symbols.map((symbol) => `${prefix}${symbol}`).join(',');
  const text = await fetchText(`https://hq.sinajs.cn/list=${list}`, { headers: SINA_HEADERS });
  return parseSinaVariables(text, prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function quoteFromSina(code, row, fallback = {}) {
  if (!row || row.length < 42) return null;
  return {
    code,
    type: fallback.type || (row[45] === 'P' ? 'P' : 'C'),
    strike: finiteNumber(row[7]) ?? fallback.strike,
    bidSize: finiteNumber(row[0]),
    bid: finiteNumber(row[1]),
    last: finiteNumber(row[2]),
    ask: finiteNumber(row[3]),
    askSize: finiteNumber(row[4]),
    openInterest: finiteNumber(row[5]),
    changePct: finiteNumber(row[6]),
    open: finiteNumber(row[9]),
    high: finiteNumber(row[39]),
    low: finiteNumber(row[40]),
    volume: finiteNumber(row[41]),
    turnover: finiteNumber(row[42]),
    quoteTime: row[32] || null,
    contractStyle: row[43] || fallback.contractStyle || 'M',
    expiry: row[46] || fallback.expiry || null,
    dte: finiteNumber(row[47]),
    name: fallback.name || '',
    multiplier: finiteNumber(fallback.multiplier) || 10000,
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

async function fetchUnderlying(config) {
  const rows = await fetchSinaRows([config.quoteSymbol]);
  const row = rows.get(config.quoteSymbol);
  return {
    price: finiteNumber(row?.[3]),
    date: row?.[30] || null,
    time: row?.[31] || null,
  };
}

async function getSseMonths() {
  const data = await fetchJson('https://stock.finance.sina.com.cn/futures/api/openapi.php/StockOptionService.getStockName?exchange=null&cate=500ETF');
  return (data?.result?.data?.contractMonth || []).slice(1).map((month) => month.replace('-', ''));
}

async function fetchSseChain(config, requestedMonth) {
  const months = await getSseMonths();
  const month = months.includes(requestedMonth) ? requestedMonth : months[0];
  if (!month) throw new Error('暂未查询到上交所可用合约月份');
  const codeRows = await fetchSinaRows([`OP_UP_${config.symbol}${month.slice(-4)}`, `OP_DOWN_${config.symbol}${month.slice(-4)}`]);
  const calls = (codeRows.get(`OP_UP_${config.symbol}${month.slice(-4)}`) || []).filter(Boolean).map((item) => item.replace('CON_OP_', ''));
  const puts = (codeRows.get(`OP_DOWN_${config.symbol}${month.slice(-4)}`) || []).filter(Boolean).map((item) => item.replace('CON_OP_', ''));
  const types = new Map([...calls.map((code) => [code, 'C']), ...puts.map((code) => [code, 'P'])]);
  const codes = [...calls, ...puts];
  const [quoteRows, greekRows, underlying] = await Promise.all([
    fetchSinaRows(codes, 'CON_OP_'),
    fetchSinaRows(codes, 'CON_SO_'),
    fetchUnderlying(config),
  ]);
  const contracts = codes.map((code) => {
    const quote = quoteFromSina(code, quoteRows.get(code), { type: types.get(code), multiplier: config.multiplier });
    if (!quote) return null;
    const greek = greekRows.get(code);
    const delta = finiteNumber(greek?.[5]);
    const iv = finiteNumber(greek?.[9]);
    const validGreek = delta != null && Math.abs(delta) <= 1 && iv >= 0.01 && iv <= 5;
    return { ...quote, delta: validGreek ? delta : null, iv: validGreek ? iv : null, greekSource: validGreek ? 'sina' : null };
  }).filter(Boolean);
  const fallback = enrichLocalGreeks(contracts, underlying.price);
  const fallbackByCode = new Map(fallback.map((contract) => [contract.code, contract]));
  return {
    ...config,
    months,
    selectedMonth: month,
    underlyingPrice: underlying.price,
    quoteTime: [underlying.date, underlying.time].filter(Boolean).join(' '),
    contracts: contracts.map((contract) => contract.greekSource ? contract : fallbackByCode.get(contract.code)),
    greekNote: '上交所 Greeks 取新浪实时行情；缺失值使用 Black-Scholes 计算。',
  };
}

async function getSzseContracts() {
  const base = 'https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=ysplbrb&TABKEY=tab1&txtQueryKeyAndJC=%E4%B8%AD%E8%AF%81500ETF';
  const headers = { 'User-Agent': SINA_HEADERS['User-Agent'], Referer: 'https://www.szse.cn/market/product/option/index.html' };
  const first = await fetchJson(`${base}&PAGENO=1&random=${Date.now()}`, { headers });
  const pageCount = first?.[0]?.metadata?.pagecount || 1;
  const pages = await Promise.all(Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => (
    fetchJson(`${base}&PAGENO=${index + 2}&random=${Date.now() + index + 1}`, { headers })
  )));
  return [first, ...pages].flatMap((page) => page?.[0]?.data || []);
}

async function fetchSzseChain(config, requestedMonth) {
  const listed = await getSzseContracts();
  const normalized = listed.map((row) => ({
    code: row.hydm,
    name: row.hymc,
    type: row.hylx === '认沽' ? 'P' : 'C',
    strike: finiteNumber(row.xqj),
    multiplier: finiteNumber(row.hydw) || config.multiplier,
    expiry: row.xqrq,
    month: String(row.xqrq || '').slice(0, 7).replace('-', ''),
    contractStyle: 'M',
  }));
  const months = [...new Set(normalized.map((row) => row.month).filter(Boolean))].sort();
  const month = months.includes(requestedMonth) ? requestedMonth : months[0];
  if (!month) throw new Error('暂未查询到深交所可用合约月份');
  const selected = normalized.filter((row) => row.month === month);
  const [quoteRows, underlying] = await Promise.all([
    fetchSinaRows(selected.map((row) => row.code), 'CON_OP_'),
    fetchUnderlying(config),
  ]);
  const now = new Date();
  const contracts = selected.map((item) => {
    const dte = Math.max(0, Math.ceil((new Date(`${item.expiry}T15:00:00+08:00`) - now) / 86400000));
    return quoteFromSina(item.code, quoteRows.get(item.code), { ...item, dte });
  }).filter(Boolean).map((contract) => ({ ...contract, dte: contract.dte ?? Math.max(0, Math.ceil((new Date(`${contract.expiry}T15:00:00+08:00`) - now) / 86400000)) }));
  return {
    ...config,
    months,
    selectedMonth: month,
    underlyingPrice: underlying.price,
    quoteTime: [underlying.date, underlying.time].filter(Boolean).join(' '),
    contracts: enrichLocalGreeks(contracts, underlying.price),
    greekNote: '深交所公开行情未提供可靠 Greeks；IV/Delta 由同执行价 Call/Put 中间价按 Black-Scholes 反推，仅供研究。',
  };
}

async function fetchCnOptionChain(symbol, month) {
  const config = CN_OPTION_UNDERLYINGS[symbol];
  if (!config) throw new Error('仅支持 510500、159922');
  const cacheKey = `${symbol}-${month || 'near'}`;
  const cached = cnOptionCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 60000) return { ...cached.data, cached: true };
  const data = config.exchange === 'SSE'
    ? await fetchSseChain(config, month)
    : await fetchSzseChain(config, month);
  cnOptionCache.set(cacheKey, { time: Date.now(), data });
  return { ...data, cached: false };
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const reqUrl = req.url || '';
  // 统一在最上面解析一次密码，后面所有需要鉴权的分支都用它
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const passwordOk = !!process.env.ACCESS_PASSWORD && safeEqual(token, process.env.ACCESS_PASSWORD);

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
      const r = await fetch(
        `https://cdn.cboe.com/api/global/delayed_quotes/options/${ticker}.json`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const data = await r.json();
      return res.status(200).json(data);
    } catch (e) {
      return res.status(502).json({ error: 'CBOE failed', detail: e.message });
    }
  }

  // ══════════════════════════════════════════════════
  // 股价代理（Yahoo v8，给主面板刷新用）
  // ══════════════════════════════════════════════════
  if (reqUrl.startsWith('/api/quote/')) {
    const ticker = decodeURIComponent(reqUrl.replace('/api/quote/', '').split('?')[0]);
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const data = await r.json();
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
      return res.status(200).json({ ticker, price });
    } catch (e) {
      return res.status(502).json({ ticker, price: null, error: e.message });
    }
  }

  // ══════════════════════════════════════════════════
  // A 股中证 500 ETF 期权查询（公开只读，无需账户密码）
  // /api/cn-options?symbol=510500&month=202608
  // ══════════════════════════════════════════════════
  if (reqUrl.startsWith('/api/cn-options')) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const url = new URL(reqUrl, 'http://localhost');
    const symbol = url.searchParams.get('symbol') || '510500';
    const month = url.searchParams.get('month') || '';
    try {
      const data = await fetchCnOptionChain(symbol, month);
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
