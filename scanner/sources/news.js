import axios from 'axios';
import { parseStringPromise } from 'xml2js';

const DELAY_MS = 800;
const MAX_ITEMS = 10;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchNewsForReg(reg, days) {
  const q = encodeURIComponent(`"${reg.code}" medical device`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en&gl=US&ceid=US:en`;
  const { data } = await axios.get(url, {
    timeout: 12000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RegVueBot/1.0)' },
  });
  const parsed = await parseStringPromise(data, { explicitArray: true });
  const items = parsed?.rss?.channel?.[0]?.item || [];
  const cutoff = new Date(Date.now() - days * 86400000);

  return items
    .map(item => {
      const title = Array.isArray(item.title) ? item.title[0] : (item.title || '');
      const link  = Array.isArray(item.link)  ? item.link[0]  : (item.link  || '');
      const guid  = item.guid?.[0]?._ || item.guid?.[0] || '';
      const src   = item.source?.[0]?._ || (typeof item.source?.[0] === 'string' ? item.source[0] : '');
      const pubDate = item.pubDate?.[0];
      return {
        title:        String(title).trim(),
        url:          String(link || guid).trim(),
        source:       String(src).trim(),
        published_at: pubDate ? new Date(pubDate) : null,
      };
    })
    .filter(item => {
      if (!item.title || !item.url) return false;
      if (item.published_at && !isNaN(item.published_at) && item.published_at < cutoff) return false;
      return true;
    })
    .slice(0, MAX_ITEMS);
}

export async function fetchAllNews(regs, days = 30) {
  const results = {};
  for (const reg of regs) {
    try {
      results[reg.id] = await fetchNewsForReg(reg, days);
      console.log(`[news] ${reg.code}: ${results[reg.id].length} items`);
    } catch (err) {
      console.error(`[news] ${reg.code}: ${err.message}`);
      results[reg.id] = [];
    }
    await sleep(DELAY_MS);
  }
  return results;
}
