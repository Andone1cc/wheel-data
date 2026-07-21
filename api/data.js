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

async function fetchUpstream(url, options = {}, format = 'text') {
  const { timeoutMs = 8000, attempts = 3, ...fetchOptions } = options;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
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

async function fetchCboeStockQuote(ticker) {
  const data = await fetchJson(
    `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(ticker)}.json`,
    { headers: { 'User-Agent': BROWSER_USER_AGENT }, timeoutMs: 6500, attempts: 1 }
  );
  const quote = data?.data || {};
  const price = finiteNumber(quote.current_price) ?? finiteNumber(quote.close) ?? finiteNumber(quote.prev_day_close);
  if (!(price > 0)) return null;
  return { name: quote.company_name || quote.symbol_name || null, price };
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
  return { name: `${base}/${target}`, price, source: 'ExchangeRate' };
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
  return {
    code: '000905', name: '中证500指数', price,
    change: marketNumber(fields[31]), changePct: marketNumber(fields[32]),
    previousClose: marketNumber(fields[4]),
    quoteTime: formatTencentQuoteTime(fields[30]),
    source: 'tencent-quote-index',
  };
}

async function fetchCsi500Index() {
  if (csi500IndexCache.data && Date.now() - csi500IndexCache.time < CSI500_INDEX_CACHE_MS) {
    return { ...csi500IndexCache.data, cached: true };
  }
  try {
    let data;
    try {
      data = await fetchTencentCsi500Index();
    } catch (tencentError) {
      const payload = await fetchJson(sseHqUrl('v1/sh1/list/self/000905', {
        select: 'code,cpxxextendname,last,change,chg_rate,amp_rate,volume,amount,prev_close',
      }), { headers: SSE_HEADERS, timeoutMs: 2200, attempts: 1 });
      const row = payload?.list?.[0];
      const price = marketNumber(row?.[2]);
      if (!(price > 0)) throw tencentError;
      data = {
        code: '000905', name: '中证500指数', price,
        change: marketNumber(row?.[3]), changePct: marketNumber(row?.[4]),
        previousClose: marketNumber(row?.[8]),
        quoteTime: formatSseQuoteTime(payload.date, payload.time),
        source: 'sse-official-index',
      };
    }
    csi500IndexCache = { time: Date.now(), data };
    return { ...data, cached: false };
  } catch (error) {
    if (csi500IndexCache.data) {
      return { ...csi500IndexCache.data, cached: true, stale: true };
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
    timeoutMs: 4500,
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
        notice: `深交所官方收盘行情（${quoteDate}），不含实时买卖盘。`,
        greekNote: 'IV/Delta 由深交所官方收盘价按 Black-Scholes 反推，仅供研究。',
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
  try {
    const data = await fetchJson(sseHqUrl('v1/sho/list/exchange/stockexpire', {
      select: 'stockid,expiremonth',
    }), { headers: SSE_HEADERS, timeoutMs: 3500, attempts: 1 });
    const months = (data?.list || [])
      .filter((row) => String(row?.[0]) === '510500')
      .map((row) => String(row[1]))
      .filter((month) => /^\d{6}$/.test(month));
    if (!months.length) throw new Error('合约月份为空');
    cnMonthCache = { time: Date.now(), months };
    return months;
  } catch (error) {
    if (cnMonthCache.months.length) return cnMonthCache.months;
    const months = fallbackOptionMonths();
    cnMonthCache = { time: Date.now(), months };
    return months;
  }
}

async function fetchSseOfficialChain(config, month, months) {
  const expiry = fourthWednesday(month);
  const [chain, underlying] = await Promise.all([
    fetchJson(sseHqUrl(`v1/sho/list/tstyle/${config.symbol}_${month.slice(-2)}`, {
      select: 'contractid,last,chg_rate,presetpx,exepx',
      order: 'contractid,ase',
    }), { headers: SSE_HEADERS, timeoutMs: 5000, attempts: 1 }),
    fetchJson(sseHqUrl(`v1/sh1/list/self/${config.symbol}`, {
      select: 'code,cpxxextendname,last,change,chg_rate,amp_rate,volume,amount,prev_close',
    }), { headers: SSE_HEADERS, timeoutMs: 5000, attempts: 1 }),
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

async function fetchSzseChain(config, requestedMonth) {
  // 深交所链路不再调用上交所 32042 端口获取月份。ETF 期权月份规则可在
  // 本地生成；用户明确选择的 YYYYMM 也直接交给深交所官方接口验证。
  const months = fallbackOptionMonths();
  const requested = /^\d{6}$/.test(String(requestedMonth || '')) ? String(requestedMonth) : '';
  const month = requested || months[0];
  if (requested && !months.includes(requested)) months.unshift(requested);
  if (!month) throw new Error('暂未查询到深交所可用合约月份');
  return fetchSzseOfficialCloseChain(config, month, months);
}

async function fetchCnOptionChain(symbol, month) {
  const config = CN_OPTION_UNDERLYINGS[symbol];
  if (!config) throw new Error('仅支持 510500、159922');
  const cacheKey = `${symbol}-${month || 'near'}`;
  const cached = cnOptionCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 60000) return { ...cached.data, cached: true };
  try {
    // 指数仅用于换算展示，不能阻塞期权链主请求。若进程中已有缓存则顺手带回，
    // 否则由前端独立请求 /api/cn-options?indexOnly=1。
    const data = config.exchange === 'SSE'
      ? await fetchSseChain(config, month)
      : await fetchSzseChain(config, month);
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
    const snapshot = { ...enriched, snapshotSavedAt: Date.now() };
    cnOptionCache.set(cacheKey, { time: Date.now(), data: snapshot });
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (redisUrl && redisToken) {
      try {
        await redisSet(redisUrl, redisToken, `wheel_cn_option_${cacheKey}`, JSON.stringify(snapshot));
      } catch {}
    }
    return { ...snapshot, cached: false, stale: false };
  } catch (error) {
    let fallback = cached?.data || null;
    if (!fallback) {
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (redisUrl && redisToken) {
        try {
          const raw = await redisGet(redisUrl, redisToken, `wheel_cn_option_${cacheKey}`);
          const parsed = raw ? JSON.parse(raw) : null;
          if (parsed?.contracts?.length) fallback = parsed;
        } catch {}
      }
    }
    if (fallback) {
      const snapshotTime = fallback.quoteTime || (fallback.snapshotSavedAt
        ? new Date(fallback.snapshotSavedAt).toISOString()
        : '时间未知');
      const isSzseClose = config.exchange === 'SZSE' || fallback.source === 'szse-official-close';
      return {
        ...fallback,
        cached: true,
        stale: true,
        cacheScope: cached ? 'memory' : 'shared',
        staleReason: isSzseClose ? 'official-close-lag' : 'upstream-unavailable',
        warning: isSzseClose
          ? `深交所官方收盘数据最新可用日为 ${snapshotTime}；今日收盘数据未发布前，暂展示该日官方数据。`
          : `官方行情暂时不可用，已返回云端最近快照（${snapshotTime}）。`,
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
      const upperTicker = ticker.toUpperCase();
      const isHk = upperTicker.endsWith('.HK');
      const isSse = upperTicker.endsWith('.SS');
      const isSzse = upperTicker.endsWith('.SZ');
      const isCnOrHk = isHk || isSse || isSzse;
      const code = upperTicker.split('.')[0];
      const tencentSymbol = isHk ? `hk${code.padStart(5, '0')}` : isSse ? `sh${code}` : isSzse ? `sz${code}` : '';
      const locale = isHk ? '&lang=zh-Hant-HK&region=HK' : (isSse || isSzse) ? '&lang=zh-CN&region=CN' : '';
      const yahooRequest = fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d${locale}`,
        { headers: { 'User-Agent': BROWSER_USER_AGENT }, signal: AbortSignal.timeout(6000) }
      ).then(async response => {
        if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);
        return response.json();
      });
      const cnQuoteRequest = tencentSymbol ? fetch(
        `https://qt.gtimg.cn/q=${encodeURIComponent(tencentSymbol)}`,
        { headers: { 'User-Agent': BROWSER_USER_AGENT, Referer: 'https://gu.qq.com/' }, signal: AbortSignal.timeout(4500) }
      ).then(async response => {
        if (!response.ok) return null;
        const text = new TextDecoder('gbk').decode(await response.arrayBuffer());
        const fields = (text.match(/="([\s\S]*?)";/)?.[1] || '').split('~');
        const cnPrice = Number(fields[3]);
        return fields.length > 3 ? { name: fields[1] || null, price: Number.isFinite(cnPrice) ? cnPrice : null } : null;
      }).catch(() => null) : Promise.resolve(null);
      const cboeQuoteRequest = !isCnOrHk && !upperTicker.includes('=')
        ? fetchCboeStockQuote(upperTicker).catch(() => null)
        : Promise.resolve(null);
      const fxQuoteRequest = upperTicker.includes('=')
        ? fetchExchangeRateQuote(upperTicker).catch(() => null)
        : Promise.resolve(null);
      const [yahooResult, cnQuoteResult, cboeQuoteResult, fxQuoteResult] = await Promise.allSettled([yahooRequest, cnQuoteRequest, cboeQuoteRequest, fxQuoteRequest]);
      const data = yahooResult.status === 'fulfilled' ? yahooResult.value : null;
      const cnQuote = cnQuoteResult.status === 'fulfilled' ? cnQuoteResult.value : null;
      const cboeQuote = cboeQuoteResult.status === 'fulfilled' ? cboeQuoteResult.value : null;
      const fxQuote = fxQuoteResult.status === 'fulfilled' ? fxQuoteResult.value : null;
      const meta = data?.chart?.result?.[0]?.meta || {};
      const price = meta.regularMarketPrice ?? cnQuote?.price ?? cboeQuote?.price ?? fxQuote?.price ?? null;
      const name = cnQuote?.name || meta.shortName || meta.longName || cboeQuote?.name || fxQuote?.name || null;
      if (price == null && !name) throw new Error('股票行情源暂时不可用');
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json({ ticker, price, name, source: meta.regularMarketPrice != null ? 'Yahoo' : cnQuote?.price != null ? 'Tencent' : cboeQuote?.price != null ? 'CBOE' : fxQuote?.source || 'ExchangeRate' });
    } catch (e) {
      return res.status(502).json({ ticker, price: null, name: null, error: e.message });
    }
  }

  // ══════════════════════════════════════════════════
  // 历史收盘价代理（用于已平仓到期复盘）
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

    try {
      const yahooRes = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${period1}&period2=${period2}`,
        { headers: { 'User-Agent': BROWSER_USER_AGENT }, signal: AbortSignal.timeout(4500) }
      );
      const yahooText = await yahooRes.text();
      const payload = yahooText.trim().startsWith('{') ? JSON.parse(yahooText) : null;
      const result = payload?.chart?.result?.[0];
      const timestamps = result?.timestamp || [];
      const closes = result?.indicators?.quote?.[0]?.close || [];
      const rows = timestamps
        .map((ts, index) => ({ ts, price: closes[index], date: new Date(ts * 1000).toISOString().slice(0, 10) }))
        .filter((row) => Number.isFinite(Number(row.price)));
      const picked = pickClose(rows);
      if (picked) {
        res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
        return res.status(200).json({ ticker, date: picked.date, requestedDate: date, price: Number(picked.price), source: 'Yahoo' });
      }
    } catch {}

    try {
      const fromDate = new Date(target - 5 * 86400000).toISOString().slice(0, 10);
      const toDate = new Date(target + 3 * 86400000).toISOString().slice(0, 10);
      const nasdaqUrl = new URL(`https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/historical`);
      nasdaqUrl.searchParams.set('assetclass', 'stocks');
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
      const rows = ((await nasdaqRes.json())?.data?.tradesTable?.rows || [])
        .map((row) => {
          const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(row.date || '');
          const price = Number(String(row.close || '').replace(/[$,]/g, ''));
          if (!match || !Number.isFinite(price)) return null;
          const isoDate = `${match[3]}-${match[1]}-${match[2]}`;
          return { date: isoDate, ts: Math.floor(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])) / 1000), price };
        })
        .filter(Boolean);
      const picked = pickClose(rows);
      if (picked) {
        res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
        return res.status(200).json({ ticker, date: picked.date, requestedDate: date, price: picked.price, source: 'Nasdaq' });
      }
    } catch {}

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
      const data = await fetchCnOptionChain(symbol, month);
      // 深交所提供的是日终收盘数据，允许 CDN 较长复用；上交所为实时行情，
      // 只做短缓存。stale-while-revalidate 可在上游抖动时继续返回成功版本。
      res.setHeader('Cache-Control', data.exchange === 'SZSE'
        ? 'public, s-maxage=900, stale-while-revalidate=86400'
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
