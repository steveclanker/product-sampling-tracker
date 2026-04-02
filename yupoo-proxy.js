#!/usr/bin/env node
// Yupoo Image Scraper Proxy for Product Sampling Tracker
// Fetches a Yupoo album page, extracts all product images
// Run: node yupoo-proxy.js (port 3856)

const http = require('http');
const https = require('https');
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
      // Follow redirects
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
  
  // Try to get album ID from URL path
  // Formats: /albums/12345, /12345, etc.
  let albumId = null;
  for (const part of pathParts) {
    if (/^\d+$/.test(part)) { albumId = part; break; }
  }
  
  // Fetch the page HTML to extract embedded data
  const html = await fetchPage(yupooUrl);
  
  // Extract image origin and owner info from page
  const imgOriginMatch = html.match(/IMAGE_ORIGIN\s*=\s*['"]([^'"]+)['"]/);
  const imgOrigin = imgOriginMatch ? imgOriginMatch[1].replace(/^\/\//, 'https://') : 'https://photo.yupoo.com';
  
  const ownerIdMatch = html.match(/OWNER_ID\s*=\s*['"]([^'"]*)['"]/);
  const ownerId = ownerIdMatch ? ownerIdMatch[1] : '';

  const tokenMatch = html.match(/TOKEN\s*=\s*['"]([^'"]*)['"]/);
  const token = tokenMatch ? tokenMatch[1] : '';
  
  const images = [];
  
  // Strategy 1: Try the Yupoo API if we have an album ID
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
    } catch(e) {
      // API might need auth, fall through to HTML scraping
    }
  }
  
  // Strategy 2: Extract image URLs directly from HTML/JS
  if (images.length === 0) {
    // Look for photo.yupoo.com or any yupoo image CDN URLs in page source
    const photoRegex = /(?:https?:)?\/\/(?:photo|img)\.yupoo\.com\/([^'")\s]+)/g;
    const seen = new Set();
    let match;
    while ((match = photoRegex.exec(html)) !== null) {
      const path = match[1];
      // Skip icons, logos, avatars, and tiny UI elements
      if (path.includes('icon') || path.includes('logo') || path.includes('avatar') || path.includes('badge')) continue;
      // Normalise to get the base file path (remove size suffix)
      const basePath = path.replace(/\/(small|medium|big|origphotos|thumb_\d+|square)\.jpg.*/, '');
      if (seen.has(basePath)) continue;
      seen.add(basePath);
      images.push({
        thumb: `${imgOrigin}/${basePath}/small.jpg`,
        full: `${imgOrigin}/${basePath}/big.jpg`,
        id: basePath.split('/').pop()
      });
    }
  }
  
  // Strategy 3: Look for data-src or lazy-load image attributes
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
  
  // Strategy 4: Look for background-image styles with yupoo URLs
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

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
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
  
  // Image proxy endpoint - fetches yupoo images to avoid CORS
  if (url.pathname === '/proxy-image' && req.method === 'GET') {
    const imgUrl = url.searchParams.get('url');
    if (!imgUrl || !imgUrl.includes('yupoo.com')) {
      res.writeHead(400); res.end('Invalid URL');
      return;
    }
    try {
      const fullUrl = imgUrl.startsWith('//') ? 'https:' + imgUrl : imgUrl;
      const proto = fullUrl.startsWith('https') ? https : http;
      const proxyReq = proto.get(fullUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://x.yupoo.com/',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
        }
      }, (proxyRes) => {
        // Follow redirects for images too
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
          const redirectUrl = proxyRes.headers.location.startsWith('//') ? 'https:' + proxyRes.headers.location : proxyRes.headers.location;
          const rProto = redirectUrl.startsWith('https') ? https : http;
          rProto.get(redirectUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://x.yupoo.com/' }
          }, (rRes) => {
            res.writeHead(rRes.statusCode, {
              'Content-Type': rRes.headers['content-type'] || 'image/jpeg',
              'Cache-Control': 'public, max-age=86400',
              'Access-Control-Allow-Origin': '*'
            });
            rRes.pipe(res);
          }).on('error', () => { res.writeHead(502); res.end('Redirect proxy error'); });
          return;
        }
        // Return error info for non-200 so frontend can detect failures
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
    } catch(e) { res.writeHead(500); res.end('Error: ' + e.message); }
    return;
  }
  
  if (url.pathname === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({status: 'ok', service: 'yupoo-proxy'}));
    return;
  }
  
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Yupoo proxy running on http://127.0.0.1:${PORT}`);
});
