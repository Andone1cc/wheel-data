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
let cnMonthCache = { time: 0, months: [] };
const SINA_HEADERS = {
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
  Referer: 'https://stock.finance.sina.com.cn/',
};
const SZSE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'User-Agent': SINA_HEADERS['User-Agent'],
  Referer: 'https://www.szse.cn/market/product/option/index.html',
};
const SSE_HQ_BASE = 'https://yunhq.sse.com.cn:32042/';
const SSE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'User-Agent': SINA_HEADERS['User-Agent'],
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

async function fetchUpstream(url, options = {}, format = 'text') {
  const { timeoutMs = 8000, ...fetchOptions } = options;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { ...fetchOptions, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`);
        if (response.status < 500 && response.status !== 429) throw error;
        lastError = error;
      } else if (format === 'json') {
        return await response.json();
      } else {
        return await response.text();
      }
    } catch (error) {
      lastError = error;
      if (/^4\d\d /.test(error.message) && !error.message.startsWith('429 ')) throw error;
    }
    if (attempt < 2) await wait(250 + attempt * 450);
  }
  throw lastError || new Error('上游行情暂时不可用');
}

async function fetchText(url, options = {}) {
  return fetchUpstream(url, options, 'text');
}

async function fetchJson(url, options = {}) {
  return fetchUpstream(url, options, 'json');
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
  const payload = await fetchJson(szseReportUrl(params), { headers: SZSE_HEADERS, timeoutMs: 10000 });
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

async function fetchSzseOfficialCloseChain(config, month, months) {
  const monthLabel = `${Number(month.slice(-2))}月`;
  const optionQueries = [`中证500ETF购${monthLabel}`, `中证500ETF沽${monthLabel}`];
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
    const underlyingParams = {
      CATALOGID: '1815_stock_snapshot', TABKEY: 'tab2', txtDMorJC: config.symbol,
      txtBeginDate: quoteDate, txtEndDate: quoteDate, PAGENO: 1,
    };

    try {
      const [callQuotesFirst, putQuotesFirst, callCatalog, putCatalog, underlyingReport] = await Promise.all([
        fetchSzseReport(quoteParams[0]),
        fetchSzseReport(quoteParams[1]),
        fetchSzseReport(catalogParams[0]),
        fetchSzseReport(catalogParams[1]),
        fetchSzseReport(underlyingParams),
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

      const underlyingPrice = marketNumber(underlyingRow.ss);
      return {
        ...config,
        months,
        selectedMonth: month,
        underlyingPrice,
        quoteTime: quoteDate,
        contracts: enrichLocalGreeks(contracts, underlyingPrice),
        delayed: true,
        source: 'szse-official-close',
        warning: `新浪实时行情不可用，已自动切换为深交所官方收盘行情（${quoteDate}），不含实时买卖盘。`,
        greekNote: 'IV/Delta 由深交所官方收盘价按 Black-Scholes 反推，仅供研究。',
      };
    } catch (error) {
      latestError = error;
    }
  }
  throw latestError || new Error('深交所最近交易日行情为空');
}

async function getSseMonths() {
  if (cnMonthCache.months.length && Date.now() - cnMonthCache.time < 15 * 60 * 1000) return cnMonthCache.months;
  try {
    const data = await fetchJson(sseHqUrl('v1/sho/list/exchange/stockexpire', {
      select: 'stockid,expiremonth',
    }), { headers: SSE_HEADERS, timeoutMs: 10000 });
    const months = (data?.list || [])
      .filter((row) => String(row?.[0]) === '510500')
      .map((row) => String(row[1]))
      .filter((month) => /^\d{6}$/.test(month));
    if (!months.length) throw new Error('合约月份为空');
    cnMonthCache = { time: Date.now(), months };
    return months;
  } catch (error) {
    try {
      const data = await fetchJson('https://stock.finance.sina.com.cn/futures/api/openapi.php/StockOptionService.getStockName?exchange=null&cate=500ETF');
      const months = (data?.result?.data?.contractMonth || []).slice(1).map((month) => month.replace('-', '')).filter(Boolean);
      if (!months.length) throw new Error('合约月份为空');
      cnMonthCache = { time: Date.now(), months };
      return months;
    } catch {
      if (cnMonthCache.months.length) return cnMonthCache.months;
      const months = fallbackOptionMonths();
      cnMonthCache = { time: Date.now(), months };
      return months;
    }
  }
}

async function fetchSseOfficialChain(config, month, months) {
  const expiry = fourthWednesday(month);
  const [chain, underlying] = await Promise.all([
    fetchJson(sseHqUrl(`v1/sho/list/tstyle/${config.symbol}_${month.slice(-2)}`, {
      select: 'contractid,last,chg_rate,presetpx,exepx',
      order: 'contractid,ase',
    }), { headers: SSE_HEADERS, timeoutMs: 10000 }),
    fetchJson(sseHqUrl(`v1/sh1/list/self/${config.symbol}`, {
      select: 'code,cpxxextendname,last,change,chg_rate,amp_rate,volume,amount,prev_close',
    }), { headers: SSE_HEADERS, timeoutMs: 10000 }),
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
    months,
    selectedMonth: month,
    underlyingPrice,
    quoteTime: formatSseQuoteTime(chain.date, chain.time),
    contracts: enrichLocalGreeks(contracts, underlyingPrice),
    source: 'sse-official-realtime',
    warning: '新浪实时行情不可用，已自动切换为上交所官方实时行情；官方公网接口不含 Bid/Ask、成交量和持仓量。',
    greekNote: 'IV/Delta 由上交所官方实时最新价按 Black-Scholes 反推，仅供研究。',
  };
}

async function fetchSseChain(config, requestedMonth) {
  const months = await getSseMonths();
  const month = months.includes(requestedMonth) ? requestedMonth : months[0];
  if (!month) throw new Error('暂未查询到上交所可用合约月份');
  try {
    const codeRows = await fetchSinaRows([`OP_UP_${config.symbol}${month.slice(-4)}`, `OP_DOWN_${config.symbol}${month.slice(-4)}`]);
    const calls = (codeRows.get(`OP_UP_${config.symbol}${month.slice(-4)}`) || []).filter(Boolean).map((item) => item.replace('CON_OP_', ''));
    const puts = (codeRows.get(`OP_DOWN_${config.symbol}${month.slice(-4)}`) || []).filter(Boolean).map((item) => item.replace('CON_OP_', ''));
    const types = new Map([...calls.map((code) => [code, 'C']), ...puts.map((code) => [code, 'P'])]);
    const codes = [...calls, ...puts];
    if (!codes.length) throw new Error(`${month} 上交所合约列表为空`);
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
    if (!contracts.length || !(underlying.price > 0)) throw new Error(`${month} 上交所期权行情为空`);
    const fallback = enrichLocalGreeks(contracts, underlying.price);
    const fallbackByCode = new Map(fallback.map((contract) => [contract.code, contract]));
    return {
      ...config,
      months,
      selectedMonth: month,
      underlyingPrice: underlying.price,
      quoteTime: [underlying.date, underlying.time].filter(Boolean).join(' '),
      contracts: contracts.map((contract) => contract.greekSource ? contract : fallbackByCode.get(contract.code)),
      source: 'sina-realtime',
      greekNote: '上交所 Greeks 取新浪实时行情；缺失值使用 Black-Scholes 计算。',
    };
  } catch {
    return fetchSseOfficialChain(config, month, months);
  }
}

async function fetchSzseChain(config, requestedMonth) {
  const months = await getSseMonths();
  const month = months.includes(requestedMonth) ? requestedMonth : months[0];
  if (!month) throw new Error('暂未查询到深交所可用合约月份');
  try {
    const upKey = `OP_UP_${config.symbol}${month.slice(-4)}`;
    const downKey = `OP_DOWN_${config.symbol}${month.slice(-4)}`;
    const codeRows = await fetchSinaRows([upKey, downKey]);
    const calls = (codeRows.get(upKey) || []).filter(Boolean).map((item) => item.replace('CON_OP_', ''));
    const puts = (codeRows.get(downKey) || []).filter(Boolean).map((item) => item.replace('CON_OP_', ''));
    const types = new Map([...calls.map((code) => [code, 'C']), ...puts.map((code) => [code, 'P'])]);
    const codes = [...calls, ...puts];
    if (!codes.length) throw new Error(`${month} 深交所合约列表为空`);
    const [quoteRows, underlying] = await Promise.all([
      fetchSinaRows(codes, 'CON_OP_'),
      fetchUnderlying(config),
    ]);
    if (!(underlying.price > 0)) throw new Error('深交所标的行情为空');
    const contracts = codes.map((code) => quoteFromSina(code, quoteRows.get(code), {
      type: types.get(code), multiplier: config.multiplier, contractStyle: 'M',
    })).filter(Boolean);
    if (!contracts.length) throw new Error(`${month} 深交所期权行情为空`);
    return {
      ...config,
      months,
      selectedMonth: month,
      underlyingPrice: underlying.price,
      quoteTime: [underlying.date, underlying.time].filter(Boolean).join(' '),
      contracts: enrichLocalGreeks(contracts, underlying.price),
      source: 'sina-realtime',
      greekNote: '深交所公开行情未提供可靠 Greeks；IV/Delta 由同执行价 Call/Put 中间价按 Black-Scholes 反推，仅供研究。',
    };
  } catch {
    return fetchSzseOfficialCloseChain(config, month, months);
  }
}

async function fetchCnOptionChain(symbol, month) {
  const config = CN_OPTION_UNDERLYINGS[symbol];
  if (!config) throw new Error('仅支持 510500、159922');
  const cacheKey = `${symbol}-${month || 'near'}`;
  const cached = cnOptionCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 60000) return { ...cached.data, cached: true };
  try {
    const data = config.exchange === 'SSE'
      ? await fetchSseChain(config, month)
      : await fetchSzseChain(config, month);
    cnOptionCache.set(cacheKey, { time: Date.now(), data });
    return { ...data, cached: false, stale: false };
  } catch (error) {
    if (cached) {
      return {
        ...cached.data,
        cached: true,
        stale: true,
        warning: `上游行情暂时不可用，已返回最近快照：${error.message}`,
      };
    }
    throw error;
  }
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
