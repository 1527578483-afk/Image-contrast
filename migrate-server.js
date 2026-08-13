// Local migration server — relays video data from browser to disk
// Run with: node migrate-server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 9877;
const OUT_DIR = path.join(__dirname, 'migration-data');

let migrationStatus = { phase: 'idle', done: '', count: 0, updatedAt: null };

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

// MIME types for static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, filePath) {
  const file = path.join(__dirname, filePath);
  if (!file.startsWith(__dirname)) { res.writeHead(403); res.end(); return; } // path traversal guard

  try {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200); res.end(); return;
  }

  const parsed = url.parse(req.url, true);

  // POST /save — receive a video file
  if (req.method === 'POST' && parsed.pathname === '/save') {
    const filename = decodeURIComponent(parsed.query.name || 'video.bin');
    const safeName = filename.replace(/[^a-zA-Z0-9_.\-]/g, '_');
    const filePath = path.join(OUT_DIR, safeName);

    const ws = fs.createWriteStream(filePath);
    let size = 0;
    req.on('data', chunk => { size += chunk.length; });
    req.pipe(ws);
    ws.on('finish', () => {
      console.log(`✅ Saved: ${safeName} (${(size/1024/1024).toFixed(1)} MB)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, file: safeName, size }));
    });
    ws.on('error', (err) => {
      console.error(`❌ Error saving ${safeName}:`, err.message);
      res.writeHead(500); res.end(err.message);
    });
    return;
  }

  // POST /save-meta — receive metadata JSON
  if (req.method === 'POST' && parsed.pathname === '/save-meta') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const filePath = path.join(OUT_DIR, 'filmarchive-meta.json');
      fs.writeFileSync(filePath, body, 'utf-8');
      console.log(`✅ Metadata saved (${body.length} bytes)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // GET /status — migration progress (polled by orchestrator)
  if (req.method === 'GET' && parsed.pathname === '/status') {
    // Update status if done parameter is present
    if (parsed.query.done) {
      migrationStatus = {
        phase: parsed.query.done, // 'export' or 'import'
        done: parsed.query.done,
        count: parseInt(parsed.query.count) || 0,
        updatedAt: new Date().toISOString(),
      };
      console.log(`📢 状态更新: ${migrationStatus.done} 完成, ${migrationStatus.count} 个文件`);
    }
    const files = fs.readdirSync(OUT_DIR).filter(f => f.startsWith('video_')).length;
    const metaExists = fs.existsSync(path.join(OUT_DIR, 'filmarchive-meta.json'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...migrationStatus, videoFiles: files, metaExists }));
    return;
  }

  // GET /list — return list of saved files for import
  if (req.method === 'GET' && parsed.pathname === '/list') {
    try {
      const files = fs.readdirSync(OUT_DIR).map(f => {
        const stat = fs.statSync(path.join(OUT_DIR, f));
        return { name: f, size: stat.size };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(files));
    } catch (e) {
      res.writeHead(500); res.end(e.message);
    }
    return;
  }

  // GET /file/:name — serve a saved file (for import)
  if (req.method === 'GET' && parsed.pathname.startsWith('/file/')) {
    const fname = decodeURIComponent(parsed.pathname.slice(6));
    const safeName = fname.replace(/[^a-zA-Z0-9_.\-]/g, '_');
    const filePath = path.join(OUT_DIR, safeName);
    try {
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // GET / — serve launch page that redirects to file:// with correct hash
  if (parsed.pathname === '/' || parsed.pathname === '/launch') {
    const mode = parsed.query.mode || 'export';
    const projectDir = __dirname;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>启动迁移</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d0d0d;color:#e0e0e0;text-align:center}
a{color:#e2b04a;font-size:18px}</style></head>
<body><div>
<p>正在跳转到迁移工具...</p>
<p style="font-size:13px;color:#888">如果页面没有自动跳转，请点击下方链接</p>
<a href="file://${projectDir}/migrate.html#auto=${mode}">打开迁移工具 (${mode})</a>
</div>
<script>
(function(){
  var url = 'file://${projectDir}/migrate.html#auto=${mode}';
  // Navigate directly to the file:// URL
  location.replace(url);
})();
</script></body></html>`);
    return;
  }

  // GET /migrate.html — serve the migration tool page
  if (parsed.pathname === '/migrate.html') {
    serveStatic(res, 'migrate.html');
    return;
  }

  // Other static files
  serveStatic(res, parsed.pathname.slice(1) || 'migrate.html');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  视频档案 — 数据迁移服务器');
  console.log(`  地址: http://localhost:${PORT}`);
  console.log('══════════════════════════════════════════════');
  console.log('');
  console.log('  📤 导出: 在 Edge 浏览器中打开上面的地址');
  console.log('  📥 导入: 在 Electron 应用中打开上面的地址');
  console.log('');
  console.log('  输出目录:', OUT_DIR);
  console.log('');
  console.log('  按 Ctrl+C 停止服务器');
  console.log('');
});
