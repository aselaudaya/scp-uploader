#!/usr/bin/env node
// Tiny dependency-free drag-and-drop file uploader for the devbox.
// Serves an upload page on GET / and streams uploaded files to UPLOAD_DIR.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8090;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(require('os').homedir(), 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Keep only a safe basename; never let a filename escape UPLOAD_DIR.
function safeName(raw) {
  const base = path.basename(raw || '').replace(/[/\\]/g, '_').trim();
  if (!base || base === '.' || base === '..') return 'file_' + Date.now();
  return base;
}

// If a file already exists, add " (2)", " (3)", ... so nothing is overwritten.
function uniquePath(name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(UPLOAD_DIR, name);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(UPLOAD_DIR, `${stem} (${n})${ext}`);
    n++;
  }
  return candidate;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Devbox Uploader</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         max-width: 760px; margin: 40px auto; padding: 0 16px; }
  h1 { font-size: 1.4rem; }
  #drop { border: 2px dashed #888; border-radius: 12px; padding: 48px 16px;
          text-align: center; color: #666; transition: .15s; cursor: pointer; }
  #drop.hover { border-color: #2a7; background: rgba(34,170,119,.08); color: #2a7; }
  #list { margin-top: 24px; list-style: none; padding: 0; }
  .row { display: flex; align-items: center; gap: 10px; padding: 8px 0;
         border-bottom: 1px solid #8883; font-size: .9rem; }
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { width: 140px; height: 8px; background: #8883; border-radius: 4px; overflow: hidden; }
  .fill { height: 100%; width: 0; background: #2a7; transition: width .1s; }
  .status { width: 64px; text-align: right; }
  .ok { color: #2a7; } .err { color: #e44; }
  small { color: #888; }
  #opts { margin: 12px 0; font-size: .9rem; color: #666;
          display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  #opts select { font: inherit; }
  .saved { color: #888; font-size: .8rem; white-space: nowrap; }
  h2 { font-size: 1.1rem; margin-top: 32px; display: flex; align-items: center; gap: 8px; }
  #refresh { font: inherit; cursor: pointer; border: 1px solid #8886; background: none;
             border-radius: 6px; padding: 2px 8px; color: inherit; }
  #files { list-style: none; padding: 0; }
  .size { color: #888; font-size: .8rem; white-space: nowrap; }
  .row a { color: #2a7; text-decoration: none; }
  .row a:hover { text-decoration: underline; }
  .del { cursor: pointer; border: none; background: none; color: #e44;
         font: inherit; padding: 2px 6px; border-radius: 6px; }
  .del:hover { background: rgba(238,68,68,.12); }
</style>
</head>
<body>
  <h1>Upload files to devbox</h1>
  <p><small>Files are saved to <code>${UPLOAD_DIR}</code></small></p>
  <div id="opts">
    <label><input type="checkbox" id="compress" checked> Compress images before upload</label>
    <label>Max size <select id="maxdim">
      <option value="1024">1024px</option>
      <option value="1600">1600px</option>
      <option value="2048" selected>2048px</option>
      <option value="0">Original</option>
    </select></label>
    <label>Target <select id="target">
      <option value="204800">~200 KB</option>
      <option value="512000" selected>~500 KB</option>
      <option value="1048576">~1 MB</option>
    </select></label>
    <label>Format <select id="format">
      <option value="image/jpeg" selected>JPEG</option>
      <option value="image/webp">WebP</option>
    </select></label>
    <small>(done in your browser, originals never leave your machine)</small>
  </div>
  <div id="drop">
    <strong>Drag &amp; drop</strong> files or images here<br>
    <small>or click to choose</small>
    <input id="input" type="file" multiple hidden>
  </div>
  <ul id="list"></ul>
  <h2>Files in uploads <button id="refresh" title="Refresh list">&#x21bb;</button></h2>
  <ul id="files"></ul>
<script>
  const drop = document.getElementById('drop');
  const input = document.getElementById('input');
  const list = document.getElementById('list');
  const compress = document.getElementById('compress');
  const maxdim = document.getElementById('maxdim');
  const target = document.getElementById('target');
  const format = document.getElementById('format');
  const filesEl = document.getElementById('files');
  const refresh = document.getElementById('refresh');

  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { upload([...input.files]); input.value = ''; });
  ['dragenter','dragover'].forEach(e => drop.addEventListener(e, ev => {
    ev.preventDefault(); drop.classList.add('hover');
  }));
  ['dragleave','drop'].forEach(e => drop.addEventListener(e, ev => {
    ev.preventDefault(); drop.classList.remove('hover');
  }));
  drop.addEventListener('drop', ev => upload([...ev.dataTransfer.files]));

  function upload(files) {
    for (const file of files) sendOne(file);
  }

  // Types the canvas can decode and re-encode. GIF/SVG are skipped
  // (animation/vector content would be destroyed by rasterizing).
  const COMPRESSIBLE = ['image/jpeg', 'image/png', 'image/webp'];

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function encode(canvas, mime, q) {
    return new Promise(resolve => canvas.toBlob(resolve, mime, q));
  }

  // Re-encode an image in the browser; returns the original file if
  // compression is off, unsupported, fails, or wouldn't shrink it.
  // Quality is binary-searched to land under the selected target size.
  async function maybeCompress(file) {
    if (!compress.checked || !COMPRESSIBLE.includes(file.type)) return file;
    try {
      const bmp = await createImageBitmap(file);
      const maxDim = parseInt(maxdim.value, 10) || Infinity; // 0 = original size
      const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();

      const mime = format.value;
      const targetBytes = parseInt(target.value, 10);
      let blob = await encode(canvas, mime, 0.95);
      if (blob && blob.size > targetBytes) {
        let lo = 0.3, hi = 0.95, best = null;
        for (let i = 0; i < 5; i++) {
          const q = (lo + hi) / 2;
          const attempt = await encode(canvas, mime, q);
          if (!attempt) break;
          if (attempt.size <= targetBytes) { best = attempt; lo = q; }
          else { hi = q; blob = attempt; } // track smallest over-target result
        }
        if (best) blob = best;
      }
      if (!blob || blob.size >= file.size) return file;
      const ext = mime === 'image/webp' ? '.webp' : '.jpg';
      const name = file.name.replace(/\\.[^.]*$/, '') + ext;
      return new File([blob], name, { type: mime });
    } catch (e) {
      return file;
    }
  }

  async function sendOne(original) {
    const row = document.createElement('li');
    row.className = 'row';
    row.innerHTML = '<span class="name"></span><span class="saved"></span>' +
      '<div class="bar"><div class="fill"></div></div>' +
      '<span class="status">0%</span>';
    row.querySelector('.name').textContent = original.name;
    list.prepend(row);
    const fill = row.querySelector('.fill');
    const status = row.querySelector('.status');

    status.textContent = '...';
    const file = await maybeCompress(original);
    if (file !== original) {
      row.querySelector('.saved').textContent =
        fmtSize(original.size) + ' \\u2192 ' + fmtSize(file.size);
      row.querySelector('.name').textContent = file.name;
    }

    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/upload/' + encodeURIComponent(file.name));
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        const pct = Math.round(e.loaded / e.total * 100);
        fill.style.width = pct + '%';
        status.textContent = pct + '%';
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        fill.style.width = '100%';
        status.textContent = 'done'; status.className = 'status ok';
        loadFiles();
      } else {
        status.textContent = 'error'; status.className = 'status err';
      }
    };
    xhr.onerror = () => { status.textContent = 'error'; status.className = 'status err'; };
    xhr.send(file);
  }

  // ---- existing files: list / download / delete ----
  async function loadFiles() {
    try {
      const res = await fetch('/files');
      if (!res.ok) throw new Error(res.status);
      const files = await res.json();
      files.sort((a, b) => b.mtime - a.mtime);
      filesEl.innerHTML = '';
      if (!files.length) {
        const li = document.createElement('li');
        li.innerHTML = '<small>No files yet.</small>';
        filesEl.append(li);
        return;
      }
      for (const f of files) {
        const li = document.createElement('li');
        li.className = 'row';
        li.innerHTML = '<a class="name" download></a><span class="size"></span>' +
          '<button class="del" title="Delete">&#x2715;</button>';
        const link = li.querySelector('.name');
        link.textContent = f.name;
        link.href = '/files/' + encodeURIComponent(f.name);
        li.querySelector('.size').textContent = fmtSize(f.size);
        li.querySelector('.del').addEventListener('click', async () => {
          if (!confirm('Delete "' + f.name + '"?')) return;
          const r = await fetch('/files/' + encodeURIComponent(f.name), { method: 'DELETE' });
          if (r.ok) li.remove(); else alert('Delete failed');
          if (!filesEl.children.length) loadFiles();
        });
        filesEl.append(li);
      }
    } catch (e) {
      filesEl.innerHTML = '<li><small class="err">Could not load file list.</small></li>';
    }
  }
  refresh.addEventListener('click', loadFiles);
  loadFiles();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }

  // List files in UPLOAD_DIR as JSON: [{ name, size, mtime }]
  if (req.method === 'GET' && req.url === '/files') {
    fs.readdir(UPLOAD_DIR, { withFileTypes: true }, (err, entries) => {
      if (err) { res.writeHead(500); return res.end('error'); }
      const files = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        try {
          const st = fs.statSync(path.join(UPLOAD_DIR, e.name));
          files.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
        } catch (_) { /* file vanished between readdir and stat */ }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(files));
    });
    return;
  }

  // Download or delete a single file. safeName keeps us inside UPLOAD_DIR.
  if ((req.method === 'GET' || req.method === 'DELETE') && req.url.startsWith('/files/')) {
    const name = safeName(decodeURIComponent(req.url.slice('/files/'.length)));
    const file = path.join(UPLOAD_DIR, name);

    if (req.method === 'DELETE') {
      return fs.unlink(file, err => {
        if (err) {
          res.writeHead(err.code === 'ENOENT' ? 404 : 500);
          return res.end('error');
        }
        console.log('deleted', file);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });
    }

    return fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      fs.createReadStream(file).pipe(res);
    });
  }

  if (req.method === 'PUT' && req.url.startsWith('/upload/')) {
    const raw = decodeURIComponent(req.url.slice('/upload/'.length));
    const dest = uniquePath(safeName(raw));
    const out = fs.createWriteStream(dest);
    req.pipe(out);
    out.on('finish', () => {
      console.log('saved', dest);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    out.on('error', err => {
      console.error('write error', err);
      res.writeHead(500); res.end('error');
    });
    req.on('error', () => { out.destroy(); });
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Uploader running at http://0.0.0.0:${PORT}  ->  ${UPLOAD_DIR}`);
});
