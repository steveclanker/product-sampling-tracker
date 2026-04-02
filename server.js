#!/usr/bin/env node
// Combined server: serves tracker HTML + Yupoo proxy endpoints
// Run: node server.js (port 3856)
// Frontend uses relative URLs (/scrape, /proxy-image) - no tunnel config needed

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 3856;

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json, */*',
        'Referer': url,
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function scrapeYupoo(yupooUrl) {
  const parsed = new URL(yupooUrl);
  const owner = parsed.hostname.split('.')[0];
  const pathParts = parsed.pathname.split('/').filter(Boolean);
  
  let albumId = null;
  for (const part of pathParts) {
    if (/^\d+$/.test(part)) { albumId = part; break; }
  }
  
  const html = await fetchPage(yupooUrl);
  
  const imgOriginMatch = html.match(/IMAGE_ORIGIN\s*=\s*['"]([^'"]+)['"]/);
  const imgOrigin = imgOriginMatch ? imgOriginMatch[1].replace(/^\/\//, 'https://') : 'https://photo.yupoo.com';
  
  const ownerIdMatch = html.match(/OWNER_ID\s*=\s*['"]([^'"]*)['"]/);
  const ownerId = ownerIdMatch ? ownerIdMatch[1] : '';

  const images = [];
  
  // Strategy 1: Try the Yupoo API
  if (albumId) {
    try {
      const apiUrl = `https://${owner}.x.yupoo.com/api/albums/${albumId}?uid=${ownerId}`;
      const albumData = await fetchJSON(apiUrl);
      if (albumData && albumData.data && albumData.data.photos) {
        for (const photo of albumData.data.photos) {
          if (photo.fileid || photo.file_id) {
            const fid = photo.fileid || photo.file_id;
            images.push({
              thumb: `${imgOrigin}/${owner}/${fid}/small.jpg`,
              full: `${imgOrigin}/${owner}/${fid}/big.jpg`,
              id: fid
            });
          }
        }
      }
    } catch(e) { /* fall through */ }
  }
  
  // Strategy 2: Extract from HTML
  if (images.length === 0) {
    const photoRegex = /(?:https?:)?\/\/(?:photo|img)\.yupoo\.com\/([^'")\s]+)/g;
    const seen = new Set();
    let match;
    while ((match = photoRegex.exec(html)) !== null) {
      const p = match[1];
      if (p.includes('icon') || p.includes('logo') || p.includes('avatar') || p.includes('badge')) continue;
      const basePath = p.replace(/\/(small|medium|big|origphotos|thumb_\d+|square)\.jpg.*/, '');
      if (seen.has(basePath)) continue;
      seen.add(basePath);
      images.push({
        thumb: `${imgOrigin}/${basePath}/small.jpg`,
        full: `${imgOrigin}/${basePath}/big.jpg`,
        id: basePath.split('/').pop()
      });
    }
  }
  
  // Strategy 3: data-src attributes
  if (images.length === 0) {
    const dataSrcRegex = /data-(?:src|original|lazy)\s*=\s*["']([^"']*yupoo[^"']*)/g;
    let match;
    while ((match = dataSrcRegex.exec(html)) !== null) {
      const url = match[1].replace(/^\/\//, 'https://');
      if (!url.includes('icon') && !url.includes('logo')) {
        images.push({ thumb: url, full: url.replace(/small|medium|thumb_\d+/, 'big'), id: url.split('/').pop() });
      }
    }
  }
  
  // Strategy 4: background-image styles
  if (images.length === 0) {
    const bgRegex = /background-image:\s*url\(['"]?([^'")\s]*yupoo[^'")\s]*)['"]?\)/g;
    let match;
    while ((match = bgRegex.exec(html)) !== null) {
      const url = match[1].replace(/^\/\//, 'https://');
      images.push({ thumb: url, full: url.replace(/small|medium|thumb_\d+/, 'big'), id: url.split('/').pop() });
    }
  }
  
  return { owner, albumId, imageCount: images.length, images };
}

function proxyImage(imgUrl, res) {
  const fullUrl = imgUrl.startsWith('//') ? 'https:' + imgUrl : imgUrl;
  const proto = fullUrl.startsWith('https') ? https : http;
  const proxyReq = proto.get(fullUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://x.yupoo.com/',
      'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
    }
  }, (proxyRes) => {
    // Follow redirects
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      const redirectUrl = proxyRes.headers.location.startsWith('//') ? 'https:' + proxyRes.headers.location : proxyRes.headers.location;
      return proxyImage(redirectUrl, res);
    }
    if (proxyRes.statusCode !== 200) {
      res.writeHead(proxyRes.statusCode, { 'Access-Control-Allow-Origin': '*' });
      res.end('Image fetch failed: ' + proxyRes.statusCode);
      return;
    }
    res.writeHead(200, {
      'Content-Type': proxyRes.headers['content-type'] || 'image/jpeg',
      'Content-Length': proxyRes.headers['content-length'] || '',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => { res.writeHead(502); res.end('Proxy error: ' + e.message); });
  proxyReq.setTimeout(20000, () => { proxyReq.destroy(); res.writeHead(504); res.end('Image fetch timeout'); });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // --- API routes ---
  
  if (url.pathname === '/scrape' && req.method === 'GET') {
    const yupooUrl = url.searchParams.get('url');
    if (!yupooUrl || !yupooUrl.includes('yupoo.com')) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'Invalid Yupoo URL'}));
      return;
    }
    try {
      const result = await scrapeYupoo(yupooUrl);
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: e.message}));
    }
    return;
  }
  
  if (url.pathname === '/proxy-image' && req.method === 'GET') {
    const imgUrl = url.searchParams.get('url');
    if (!imgUrl || !imgUrl.includes('yupoo.com')) {
      res.writeHead(400); res.end('Invalid URL');
      return;
    }
    proxyImage(imgUrl, res);
    return;
  }
  
  if (url.pathname === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({status: 'ok', service: 'product-sampling-tracker'}));
    return;
  }
  
  // --- Static file serving ---
  
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    try {
      const content = fs.readFileSync(htmlPath, 'utf-8');
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(content);
    } catch(e) {
      res.writeHead(500); res.end('Cannot read index.html');
    }
    return;
  }
  
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Product Sampling Tracker running on http://127.0.0.1:${PORT}`);
  console.log('Yupoo proxy available at /scrape and /proxy-image');
});
