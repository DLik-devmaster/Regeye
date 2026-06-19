import axios from 'axios';
import * as cheerio from 'cheerio';

const CURRENT_YEAR = new Date().getFullYear();

// Keywords that indicate a year is about a published edition
const PUBLISH_RE = /\b(published|edition|released|confirmed|effective|issued|supersedes|current\s+version|current\s+edition)\b/i;
// Keywords that indicate a year is about a future/planned event — skip these
const REVIEW_RE  = /\b(review|planned|scheduled|revision|under\s+revision|next\s+review|upcoming|expected|will\s+be)\b/i;

// Extract year from text, scoring by context.
// Returns the best candidate year or null.
function extractPublishedYear(text) {
  const WINDOW = 90; // chars before/after the year to inspect
  const candidates = [];

  for (const m of text.matchAll(/\b(20\d{2})\b/g)) {
    const y = parseInt(m[1]);
    if (y < 2000 || y > CURRENT_YEAR) continue; // future years are not published editions

    const start   = Math.max(0, m.index - WINDOW);
    const end     = Math.min(text.length, m.index + m[0].length + WINDOW);
    const context = text.slice(start, end);

    if (REVIEW_RE.test(context)) continue;           // skip review/planned dates
    const confidence = PUBLISH_RE.test(context) ? 2 : 1;
    candidates.push({ year: y, confidence });
  }

  if (!candidates.length) return null;

  // Prefer high-confidence hits; within same confidence tier pick the latest year
  const best = candidates.reduce((a, b) =>
    b.confidence > a.confidence || (b.confidence === a.confidence && b.year > a.year) ? b : a
  );
  return String(best.year);
}

// For short snippets (title, h1) trust any year — it's almost certainly the edition year
function extractYearSimple(text) {
  const years = [...text.matchAll(/\b(20\d{2})\b/g)]
    .map(m => parseInt(m[1]))
    .filter(y => y >= 2000 && y <= CURRENT_YEAR);
  return years.length ? String(Math.max(...years)) : null;
}

async function fetchSourceUrl(url) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Regeye/1.0)' },
      timeout: 12000,
      maxRedirects: 3,
    });
    const $ = cheerio.load(res.data);
    $('script, style, nav, footer').remove();

    const priority = [
      $('title').text(),
      $('h1').first().text(),
      $('meta[name="description"]').attr('content') || '',
    ].join(' ');

    const body = $('body').text().slice(0, 5000);
    return { priority, body };
  } catch (err) {
    console.warn(`[custom] source_url fetch failed (${url}): ${err.message}`);
    return null;
  }
}

// Uses serper.dev (2500 free queries on signup, no CX needed)
async function searchGoogle(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return null;

  try {
    const res = await axios.post('https://google.serper.dev/search', { q: query, num: 5 }, {
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    const items = [...(res.data.organic || []), ...(res.data.knowledgeGraph ? [res.data.knowledgeGraph] : [])];
    const text = items.map(i => `${i.title || ''} ${i.snippet || ''}`).join(' ');
    return extractPublishedYear(text);
  } catch (err) {
    console.warn(`[custom] Serper query "${query}" failed: ${err.message}`);
    return null;
  }
}

export async function checkCustomStandards(regs) {
  const results = {};

  for (const reg of regs) {
    let foundYear = null;

    // Primary: parse source URL
    if (reg.source_url) {
      const page = await fetchSourceUrl(reg.source_url);
      if (page) {
        // Title/h1/meta — simple extraction (very likely the edition year)
        const priorityYear = extractYearSimple(page.priority);
        // Body — context-aware extraction to skip "next review" dates
        const bodyYear = extractPublishedYear(page.body);

        // Prefer priority; body is fallback
        foundYear = priorityYear || bodyYear;
        if (foundYear) console.log(`[custom] ${reg.code} source_url → year ${foundYear}`);
      }
    }

    // Secondary: Serper/Google — context-aware year from snippets
    const query = `"${reg.code}" current version OR latest edition`;
    const googleYear = await searchGoogle(query);
    if (googleYear) {
      console.log(`[custom] ${reg.code} Google → year ${googleYear}`);
      if (!foundYear || parseInt(googleYear) > parseInt(foundYear)) foundYear = googleYear;
    }

    if (foundYear) results[reg.id] = { year: foundYear };
  }

  return results;
}
