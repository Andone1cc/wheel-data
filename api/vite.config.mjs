import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import apiHandler from './api/data.js';

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

function localApiPlugin() {
  return {
    name: 'wheel-local-api',
    configureServer(server) {
      process.env.NODE_ENV ||= 'development';
      process.env.ACCESS_PASSWORD ||= 'local';
      process.env.LOCAL_DATA_FILE ||= new URL('./.local-data/wheel_data.json', import.meta.url).pathname;

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) {
          next();
          return;
        }

        try {
          decorateResponse(res);
          await apiHandler(req, res);
        } catch (err) {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Local API failed', detail: err.message }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localApiPlugin()],
});
