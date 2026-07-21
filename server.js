const http = require('http');
const fs = require('fs');
const path = require('path');
const handler = require('./api/data');

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const DIST_ROOT = path.join(ROOT, 'dist');

process.env.NODE_ENV ||= 'development';
process.env.ACCESS_PASSWORD ||= 'local';
process.env.LOCAL_DATA_FILE ||= path.join(ROOT, '.local-data', 'wheel_data.json');

const CSP = "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com https://hq.sinajs.cn; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https: http:; img-src 'self' data: https:;";

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err.code === 'ENOENT' ? 'Not found' : err.message);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Content-Security-Policy': CSP,
    });
    res.end(data);
  });
}

function staticRoot() {
  return fs.existsSync(path.join(DIST_ROOT, 'index.html')) ? DIST_ROOT : ROOT;
}

function decorateResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
      decorateResponse(res);
      await handler(req, res);
      return;
    }

    const root = staticRoot();

    if (url.pathname === '/' || url.pathname === '/wheel-dashboard.html') {
      sendFile(res, path.join(root, 'index.html'));
      return;
    }

    const filePath = path.normalize(path.join(root, url.pathname));
    if (!filePath.startsWith(root)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      sendFile(res, filePath);
      return;
    }
    sendFile(res, path.join(root, 'index.html'));
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Local server failed', detail: err.message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Wheel dashboard running at http://${HOST}:${PORT}`);
  console.log(`Local ACCESS_PASSWORD: ${process.env.ACCESS_PASSWORD}`);
});
