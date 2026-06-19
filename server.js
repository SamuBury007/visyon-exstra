// server.js - Proxy server per estrarre link video da vixsrc.to / vidsrc.to
// npm install express axios cheerio cors

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Headers realistici per sembrare un browser normale
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://vixsrc.to/',
  'Origin': 'https://vixsrc.to',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1'
};

// Cache semplice per non rifare richieste inutilmente
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minuti

// ==================== ENDPOINT PRINCIPALE ====================

// GET /movie/:id  - Estrai link video da un movie ID
// Esempio: /movie/786892
app.get('/movie/:id', async (req, res) => {
  try {
    const movieId = req.params.id;
    const cacheKey = `movie_${movieId}`;
    
    // Check cache
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        return res.json(cached.data);
      }
      cache.delete(cacheKey);
    }

    console.log(`[+] Fetching movie page: https://vixsrc.to/movie/${movieId}`);
    
    // 1. Prendi la pagina del movie
    const moviePage = await axios.get(`https://vixsrc.to/movie/${movieId}`, {
      headers: {
        ...BROWSER_HEADERS,
        'Referer': 'https://vixsrc.to/',
      },
      timeout: 15000
    });

    const $ = cheerio.load(moviePage.data);
    
    // 2. Cerca il primo iframe che punta a vidsrc
    let embedUrl = null;
    
    // Cerca iframe con src che contiene vidsrc
    $('iframe').each((i, el) => {
      const src = $(el).attr('src') || '';
      if (src.includes('vidsrc') || src.includes('embed')) {
        embedUrl = src.startsWith('http') ? src : `https:${src}`;
        return false;
      }
    });
    
    // Se non trova iframe, cerca nel codice JS
    if (!embedUrl) {
      const scripts = $('script').map((i, el) => $(el).html()).get();
      for (const script of scripts) {
        if (!script) continue;
        const match = script.match(/https?:\/\/[^"'\s]*vidsrc[^"'\s]*/i);
        if (match) {
          embedUrl = match[0];
          break;
        }
        // Cerca anche pattern tipo: src="//vidsrc.to/embed/..."
        const match2 = script.match(/src\s*=\s*["'](\/\/[^"']*vidsrc[^"']*)["']/i);
        if (match2) {
          embedUrl = `https:${match2[1]}`;
          break;
        }
      }
    }

    if (!embedUrl) {
      // Fallback: costruiamo direttamente l'URL embed
      embedUrl = `https://vidsrc.to/embed/movie/${movieId}`;
    }

    console.log(`[+] Embed URL: ${embedUrl}`);

    // 3. Prendi la pagina embed
    const embedPage = await axios.get(embedUrl, {
      headers: {
        ...BROWSER_HEADERS,
        'Referer': `https://vixsrc.to/movie/${movieId}`,
      },
      timeout: 15000
    });

    const embedHtml = embedPage.data;
    
    // 4. Estrai i link dei playlist/stream
    const streams = await extractStreams(embedHtml, embedUrl, movieId);

    const result = {
      success: true,
      movieId,
      embedUrl,
      streams,
      timestamp: new Date().toISOString(),
      note: "I token scadono. Usa il proxy /proxy/ per stream continuo."
    };

    // Salva in cache
    cache.set(cacheKey, { data: result, timestamp: Date.now() });

    res.json(result);
  } catch (error) {
    console.error('[!] Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data?.substring(0, 500) || 'Unknown error'
    });
  }
});

// ==================== HELPER: Estrazione streams ====================

async function extractStreams(html, baseUrl, movieId) {
  const streams = [];
  
  // Pattern 1: Cerca URL m3u8 nel codice
  const m3u8Patterns = [
    /https?:\/\/[^"'\s]*\.m3u8[^"'\s]*/gi,
    /https?:\/\/[^"'\s]*(?:master|index|playlist)[^"'\s]*\.m3u8[^"'\s]*/gi,
    /https?:\/\/[^"'\s]*\/playlist\/[^"'\s]*/gi,
  ];

  for (const pattern of m3u8Patterns) {
    const matches = html.match(pattern);
    if (matches) {
      for (const url of matches) {
        const cleanUrl = url.replace(/[\\"']/g, '').split('&amp;').join('&');
        if (!streams.find(s => s.url === cleanUrl)) {
          streams.push({
            url: cleanUrl,
            type: 'm3u8',
            quality: extractQuality(cleanUrl) || 'unknown',
            source: 'direct_extract'
          });
        }
      }
    }
  }

  // Pattern 2: Cerca URL mp4
  const mp4Pattern = /https?:\/\/[^"'\s]*\.mp4[^"'\s]*/gi;
  const mp4Matches = html.match(mp4Pattern);
  if (mp4Matches) {
    for (const url of mp4Matches) {
      const cleanUrl = url.replace(/[\\"']/g, '').split('&amp;').join('&');
      if (!streams.find(s => s.url === cleanUrl)) {
        streams.push({
          url: cleanUrl,
          type: 'mp4',
          quality: extractQuality(cleanUrl) || 'unknown',
          source: 'direct_extract'
        });
      }
    }
  }

  // Pattern 3: Cerca oggetti JSON con URL video
  const jsonPatterns = [
    /["'](?:file|src|url|video|source)["']\s*:\s*["']([^"']+)["']/gi,
    /["'](?:hls|mp4|stream)["']\s*:\s*["']([^"']+)["']/gi,
  ];

  for (const pattern of jsonPatterns) {
    const matches = html.matchAll(pattern);
    for (const match of matches) {
      let url = match[1].replace(/\\\//g, '/');
      if (url.includes('m3u8') || url.includes('mp4') || url.includes('playlist')) {
        if (!streams.find(s => s.url === url)) {
          streams.push({
            url: url,
            type: url.includes('.m3u8') ? 'm3u8' : 'mp4',
            quality: extractQuality(url) || 'unknown',
            source: 'json_extract'
          });
        }
      }
    }
  }

  // Pattern 4: Cerca source nei tag video
  const sourcePattern = /<source[^>]*src=["']([^"']+)["'][^>]*type=["']video\/([^"']+)["']/gi;
  const sourceMatches = html.matchAll(sourcePattern);
  for (const match of sourceMatches) {
    const url = match[1];
    if (!streams.find(s => s.url === url)) {
      streams.push({
        url: url,
        type: match[2] === 'mp4' ? 'mp4' : 'm3u8',
        quality: extractQuality(url) || 'unknown',
        source: 'html_source'
      });
    }
  }

  // Se non ha trovato niente, prova a fare una richiesta diretta all'API di vidsrc
  if (streams.length === 0) {
    try {
      // Prova l'API interna di vidsrc
      const apiUrl = `https://vidsrc.to/api/source/${movieId}`;
      const apiResponse = await axios.get(apiUrl, {
        headers: {
          ...BROWSER_HEADERS,
          'Referer': baseUrl,
          'X-Requested-With': 'XMLHttpRequest'
        },
        timeout: 10000
      });
      
      if (apiResponse.data && apiResponse.data.sources) {
        for (const src of apiResponse.data.sources) {
          streams.push({
            url: src.file || src.url || src.src,
            type: src.type || 'm3u8',
            quality: src.label || src.quality || extractQuality(src.file || '') || 'unknown',
            source: 'api'
          });
        }
      }
    } catch (e) {
      console.log('[!] API fallback failed:', e.message);
    }
  }

  return streams;
}

function extractQuality(url) {
  // Cerca pattern di qualità nell'URL
  const patterns = [
    /(\d{3,4})p/i,
    /rendition=(\d{3,4})p/i,
    /(\d{3,4})\.m3u8/i,
    /_(\d{3,4})_/i,
    /quality[=:](\d{3,4})/i,
    /height[=:](\d{3,4})/i,
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return `${match[1]}p`;
  }
  
  return null;
}

// ==================== ENDPOINT PROXY ====================

// GET /proxy?url=...  - Proxy per stream video (bypass CORS e token issues)
app.get('/proxy', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    console.log(`[+] Proxying: ${url.substring(0, 100)}...`);

    // Headers specifici per richieste video
    const videoHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer': 'https://vidsrc.to/',
      'Origin': 'https://vidsrc.to',
      'Range': req.headers.range || '',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'video',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
    };

    // Se è un m3u8, analizza e restituisci i playlist
    if (url.includes('.m3u8') || url.includes('playlist')) {
      const response = await axios.get(url, {
        headers: videoHeaders,
        responseType: 'text',
        timeout: 15000
      });

      const content = response.data;
      
      // Se il m3u8 contiene riferimenti relativi, riscrivili
      const base = url.substring(0, url.lastIndexOf('/') + 1);
      const proxiedContent = content.replace(/^(https?:\/\/)?([^#\n\r][^\n\r]*\.(?:m3u8|ts))/gm, (match) => {
        if (match.startsWith('http')) {
          return `/proxy?url=${encodeURIComponent(match)}`;
        } else {
          return `/proxy?url=${encodeURIComponent(base + match)}`;
        }
      });

      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      return res.send(proxiedContent);
    }

    // Per file .ts o mp4, proxa direttamente
    const response = await axios({
      method: 'GET',
      url: url,
      headers: videoHeaders,
      responseType: 'stream',
      timeout: 30000
    });

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp4',
      'Content-Length': response.headers['content-length'],
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });

    // Se c'è Range header, gestisci parziale
    if (req.headers.range) {
      res.set('Content-Range', response.headers['content-range']);
      res.status(206);
    }

    response.data.pipe(res);

  } catch (error) {
    console.error('[!] Proxy error:', error.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Proxy failed', details: error.message });
    }
  }
});

// ==================== ENDPOINT DIRETTO: Resolve URL playlist ====================

// GET /resolve?url=...  - Risolve un URL playlist (m3u8) e restituisce i dettagli
app.get('/resolve', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    const response = await axios.get(url, {
      headers: {
        ...BROWSER_HEADERS,
        'Referer': 'https://vidsrc.to/',
      },
      timeout: 15000
    });

    const content = response.data;
    
    // Parse m3u8 per estrarre informazioni
    const lines = content.split('\n');
    const streams = [];
    let currentStream = {};

    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
        // Estrai qualità
        const bwMatch = trimmed.match(/BANDWIDTH=(\d+)/);
        const resMatch = trimmed.match(/RESOLUTION=(\d+x\d+)/);
        currentStream = {
          bandwidth: bwMatch ? parseInt(bwMatch[1]) : null,
          resolution: resMatch ? resMatch[1] : null,
        };
      } else if (trimmed && !trimmed.startsWith('#')) {
        // È un URL
        const streamUrl = trimmed.startsWith('http') ? trimmed : 
          url.substring(0, url.lastIndexOf('/') + 1) + trimmed;
        
        streams.push({
          ...currentStream,
          url: streamUrl,
          quality: currentStream.resolution ? 
            currentStream.resolution.split('x')[1] + 'p' : 
            extractQuality(streamUrl) || 'auto'
        });
        currentStream = {};
      }
    }

    // Se non ci sono stream multipli, aggiungi l'URL stesso
    if (streams.length === 0 && !content.includes('#EXT-X-STREAM-INF')) {
      // M3u8 diretto con segmenti .ts
      const tsCount = (content.match(/\.ts/g) || []).length;
      streams.push({
        url: url,
        type: 'm3u8_direct',
        segments: tsCount,
        quality: extractQuality(url) || 'unknown'
      });
    }

    res.json({
      success: true,
      url: url,
      type: content.includes('#EXTM3U') ? 'm3u8' : 'unknown',
      streams,
      raw_preview: content.substring(0, 500)
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ENDPOINT: Info movie ====================

// GET /info/:id  - Ottieni informazioni sul movie
app.get('/info/:id', async (req, res) => {
  try {
    const movieId = req.params.id;
    const page = await axios.get(`https://vixsrc.to/movie/${movieId}`, {
      headers: BROWSER_HEADERS,
      timeout: 10000
    });
    
    const $ = cheerio.load(page.data);
    
    const info = {
      title: $('h1, .title, [class*="title"]').first().text().trim(),
      year: $('[class*="year"], .year').first().text().trim(),
      description: $('p.description, [class*="description"], p[class*="desc"]').first().text().trim(),
      rating: $('[class*="rating"], .rating').first().text().trim(),
      genres: [],
      poster: null,
    };
    
    // Poster
    $('img[class*="poster"], img[class*="cover"], img[alt*="poster"]').each((i, el) => {
      const src = $(el).attr('src');
      if (src && !info.poster) {
        info.poster = src.startsWith('http') ? src : `https:${src}`;
      }
    });

    // Generi
    $('[class*="genre"] a, .genres a, [class*="tag"]').each((i, el) => {
      const genre = $(el).text().trim();
      if (genre) info.genres.push(genre);
    });

    res.json({ success: true, movieId, info });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== AVVIO SERVER ====================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║            VixSrc Video Stream Extractor Server             ║
╠══════════════════════════════════════════════════════════════╣
║                                                            ║
║  Endpoints:                                                ║
║                                                            ║
║  GET /movie/:id     → Estrai tutti gli stream del movie    ║
║  GET /info/:id      → Info sul movie                       ║
║  GET /resolve?url=  → Analizza un playlist m3u8            ║
║  GET /proxy?url=    → Proxy per stream (bypass CORS/token) ║
║                                                            ║
║  Esempi:                                                   ║
║  http://localhost:${PORT}/movie/786892                              ║
║  http://localhost:${PORT}/proxy?url=https://...m3u8                 ║
║  http://localhost:${PORT}/resolve?url=https://...m3u8               ║
║                                                            ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
