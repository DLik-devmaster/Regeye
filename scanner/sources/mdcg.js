import axios from 'axios';
import * as cheerio from 'cheerio';

const MDCG_URL = 'https://health.ec.europa.eu/medical-devices-sector/new-regulations/guidance-mdcg-endorsed-documents-and-other-guidance_en';

// Parse revision from text like "MDCG 2021-24 Rev.1" or "MDCG 2019-9 rev. 1"
function parseRevision(text) {
  const rev = text.match(/rev\.?\s*(\d+)/i);
  return rev ? `Rev.${rev[1]}` : null;
}

// Extract MDCG document number from text/link
function parseDocCode(text) {
  const m = text.match(/MDCG\s+\d{4}-\d+(?:-\d+)?/i);
  return m ? m[0].replace(/\s+/, ' ') : null;
}

export async function fetchMDCGVersions() {
  console.log('[mdcg] fetching guidance page...');
  const res = await axios.get(MDCG_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RegVue/1.0)' },
    timeout: 15000
  });

  const $ = cheerio.load(res.data);
  const found = {};

  // The page lists documents in tables or lists — find all links/text containing "MDCG"
  $('a, td, li').each((_, el) => {
    const text = $(el).text().trim();
    const code = parseDocCode(text);
    if (!code) return;

    const rev = parseRevision(text);
    const normalized = code.toUpperCase();

    // Keep the highest revision found
    if (!found[normalized] || (rev && !found[normalized].rev)) {
      found[normalized] = { code: normalized, rev, rawText: text };
    }
  });

  // Also check page update dates from links
  $('a[href*="mdcg"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    const code = parseDocCode(text) || parseDocCode(href);
    if (!code) return;

    const rev = parseRevision(text) || parseRevision(href);
    const normalized = code.toUpperCase();
    if (!found[normalized] || (rev && !found[normalized].rev)) {
      found[normalized] = { code: normalized, rev, rawText: text };
    }
  });

  console.log(`[mdcg] found ${Object.keys(found).length} documents`);
  return found;
}
