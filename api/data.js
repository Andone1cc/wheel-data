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

// 常数时间字符串比较，防止密码校验被时序攻击猜出内容
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return require('crypto').timingSafeEqual(bufA, bufB);
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
    const raw = await redisGet(redisUrl, redisToken, key);
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
    await redisSet(redisUrl, redisToken, key, body);
    return res.status(200).json({ ok: true });
  }

  return res.status(404).json({ error: 'Not found' });
};
