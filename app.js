import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import * as cheerio from 'cheerio';
import multer from 'multer';
import pool from './db.js';
import { runScan } from './scanner/index.js';
import { state as scanState } from './scanState.js';
import { calcGapScore } from './utils.js';

const require = createRequire(import.meta.url);
const PAID_BODIES = new Set(['ISO', 'ASTM']);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

export { calcGapScore };

const __dir = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

const staticDir = join(__dir, 'clauseline');
if (existsSync(staticDir)) {
  app.use(express.static(staticDir));
}

// ── Regulations ───────────────────────────────────────────────

app.get('/api/regulations', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM regulations ORDER BY severity DESC NULLS LAST, code`
    );
    res.json(rows);
  } catch (err) {
    console.error('[api] GET /regulations:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/regulations', async (req, res) => {
  const { id, code, version, latest_version, title, body, category, status, severity, gap_score, changes, source_url } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO regulations (id, code, version, latest_version, title, body, category, status, severity, gap_score, changes, source_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         version=EXCLUDED.version, latest_version=EXCLUDED.latest_version,
         title=EXCLUDED.title, status=EXCLUDED.status,
         severity=EXCLUDED.severity, gap_score=EXCLUDED.gap_score,
         changes=EXCLUDED.changes, source_url=EXCLUDED.source_url, last_checked=NOW()
       RETURNING *`,
      [id, code, version, latest_version || version, title, body, category || null,
       status || 'up-to-date', severity || null, gap_score || 0, JSON.stringify(changes || []),
       source_url || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[api] POST /regulations:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/regulations/:id/changes/:idx/status', async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  const idx = parseInt(req.params.idx);
  if (!['open', 'in-progress', 'closed'].includes(status))
    return res.status(400).json({ error: 'invalid status' });
  try {
    const { rows } = await pool.query(`SELECT changes FROM regulations WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const changes = rows[0].changes || [];
    if (idx < 0 || idx >= changes.length)
      return res.status(400).json({ error: 'index out of range' });
    changes[idx] = { ...changes[idx], status };
    await pool.query(`UPDATE regulations SET changes=$1 WHERE id=$2`, [JSON.stringify(changes), id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/regulations/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM regulations WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/regulations/:id/reset-assessment', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE regulations SET changes='[]', gap_score=0 WHERE id=$1 RETURNING id, code, gap_score`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, ...rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Alerts ────────────────────────────────────────────────────

app.get('/api/alerts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM alerts ORDER BY created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/alerts/:id/acknowledge', async (req, res) => {
  try {
    await pool.query(`UPDATE alerts SET acknowledged=TRUE WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/alerts/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM alerts WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dev ───────────────────────────────────────────────────────

app.post('/api/dev/simulate-update', async (req, res) => {
  const { reg_id, latest_version, severity = 'minor' } = req.body;
  try {
    const { rows } = await pool.query(`SELECT * FROM regulations WHERE id=$1`, [reg_id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Regulation not found' });
    const reg = rows[0];
    await pool.query(
      `UPDATE regulations SET latest_version=$1, status='outdated', severity=$2, last_checked=NOW() WHERE id=$3`,
      [latest_version, severity, reg_id]
    );
    await pool.query(`DELETE FROM alerts WHERE reg_id=$1 AND type='new-version'`, [reg_id]);
    await pool.query(
      `INSERT INTO alerts (reg_id, code, severity, type, title, body) VALUES ($1,$2,$3,'new-version',$4,$5)`,
      [reg_id, reg.code, severity,
       `${reg.code} updated — ${latest_version}`,
       `A new edition of ${reg.code} has been published (${latest_version}). Your tracked version is ${reg.version}. Review and assess impact on your QMS.`]
    );
    res.json({ ok: true, reg_id, latest_version });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gap Assessment ────────────────────────────────────────────

async function fetchChangelogContext(reg) {
  if (!reg.source_url) return null;
  try {
    const res = await fetch(reg.source_url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Clauseline/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    $('script, style, nav, header, footer, aside').remove();
    const text = ($('main, article, .content, [role="main"]').first().text() || $('body').text())
      .replace(/\s+/g, ' ').trim();
    return text.slice(0, 3000) || null;
  } catch {
    return null;
  }
}

// opts.documentContext = { oldText, newText } for document-based mode
export async function generateGapAssessment(reg, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const isPaid = PAID_BODIES.has((reg.body || '').toUpperCase());
  const isUpToDate = reg.version === reg.latest_version;
  const { documentContext } = opts;

  const schema = `Return ONLY a JSON array (no markdown, no explanation):
[{"clause":"<section>","type":"<added|modified|removed>","impact":"<high|medium|low>","label":"<max 80 chars>","action":"<max 120 chars>"}]`;

  let prompt, disclaimer;

  if (documentContext) {
    disclaimer = false;
    prompt = `You are a regulatory compliance expert for medical device manufacturers.

Regulation: ${reg.code} — ${reg.title} | Issuing body: ${reg.body}
Controlled version: ${reg.version} | Latest version: ${reg.latest_version}

Compare the two document versions and identify specific gaps based only on the provided text.
Focus on: new requirements, modified scope or wording, removed requirements, changed normative references.

=== CONTROLLED VERSION ===
${documentContext.oldText.slice(0, 5000)}

=== LATEST VERSION ===
${documentContext.newText.slice(0, 5000)}

${schema}`;

  } else if (isPaid) {
    disclaimer = true;
    prompt = `You are a regulatory compliance expert for medical device manufacturers.

NOTE: ${reg.code} (${reg.title}) is published by ${reg.body} and is not publicly available in full.
This assessment is based on publicly known information about this standard only.

Controlled version: ${reg.version} | ${isUpToDate ? 'Status: up-to-date' : `Latest published: ${reg.latest_version}`}
Category: ${reg.category || 'General'}

Generate 4-6 key compliance requirements and common audit gap areas for ${reg.code}.
These represent typical findings in regulatory audits and notified body assessments.

${schema}`;

  } else {
    disclaimer = false;
    const changelogCtx = await fetchChangelogContext(reg);
    const versionNote = isUpToDate
      ? `Status: up-to-date (version ${reg.version}). Identify key ongoing compliance obligations specific to this version.`
      : `Gap: controlled version ${reg.version} → latest published ${reg.latest_version}. Reference actual clause changes in this specific version update.`;

    prompt = `You are a regulatory compliance expert for medical device manufacturers (ISO 13485, EU MDR, FDA QMSR context).

Regulation: ${reg.code} — ${reg.title}
Issuing body: ${reg.body} | Category: ${reg.category || 'General'}
Controlled version: ${reg.version} | Latest version: ${reg.latest_version}
${changelogCtx ? `\nPublicly available source information:\n${changelogCtx}\n` : ''}
${versionNote}

${schema}`;
  }

  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!apiRes.ok) {
    const msg = await apiRes.text();
    throw new Error(`Claude API ${apiRes.status}: ${msg.slice(0, 200)}`);
  }

  const json = await apiRes.json();
  const text = json.content?.[0]?.text || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Claude response contained no JSON array');

  const raw = JSON.parse(match[0]);
  const changes = raw.map(c => ({
    clause: String(c.clause || ''),
    type: ['added', 'modified', 'removed'].includes(c.type) ? c.type : 'modified',
    impact: ['high', 'medium', 'low'].includes(c.impact) ? c.impact : 'medium',
    label: String(c.label || '').slice(0, 120),
    action: String(c.action || '').slice(0, 180),
  }));

  return { changes, disclaimer };
}

app.post('/api/regulations/:id/assess', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(`SELECT * FROM regulations WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Regulation not found' });
    const reg = rows[0];

    const isUpToDate = reg.version === reg.latest_version;
    const mode = PAID_BODIES.has((reg.body || '').toUpperCase()) ? 'paid' : 'open';
    console.log(`[assess] generating for ${reg.code} [${mode}]…`);
    const { changes, disclaimer } = await generateGapAssessment(reg);
    const gapScore = isUpToDate ? 0 : calcGapScore(changes);

    await pool.query(
      `UPDATE regulations SET changes=$1, gap_score=$2 WHERE id=$3`,
      [JSON.stringify(changes), gapScore, id]
    );

    console.log(`[assess] ${reg.code}: ${changes.length} items, score ${gapScore}${disclaimer ? ' [disclaimer]' : ''}`);
    res.json({ changes, gap_score: gapScore, disclaimer });
  } catch (err) {
    console.error('[assess]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/regulations/:id/assess/documents',
  upload.fields([{ name: 'oldDoc', maxCount: 1 }, { name: 'newDoc', maxCount: 1 }]),
  async (req, res) => {
    const { id } = req.params;
    try {
      const { rows } = await pool.query(`SELECT * FROM regulations WHERE id=$1`, [id]);
      if (!rows.length) return res.status(404).json({ error: 'Regulation not found' });
      const reg = rows[0];

      const oldFile = req.files?.oldDoc?.[0];
      const newFile = req.files?.newDoc?.[0];
      if (!oldFile || !newFile) return res.status(400).json({ error: 'Both oldDoc and newDoc files required' });

      const pdfParse = require('pdf-parse');
      const [oldData, newData] = await Promise.all([
        pdfParse(oldFile.buffer),
        pdfParse(newFile.buffer),
      ]);

      console.log(`[assess-docs] ${reg.code}: parsed ${oldData.text.length} + ${newData.text.length} chars`);
      const { changes } = await generateGapAssessment(reg, {
        documentContext: { oldText: oldData.text, newText: newData.text },
      });

      const isUpToDate = reg.version === reg.latest_version;
      const gapScore = isUpToDate ? 0 : calcGapScore(changes);

      await pool.query(
        `UPDATE regulations SET changes=$1, gap_score=$2 WHERE id=$3`,
        [JSON.stringify(changes), gapScore, id]
      );

      console.log(`[assess-docs] ${reg.code}: ${changes.length} items, score ${gapScore}`);
      res.json({ changes, gap_score: gapScore, disclaimer: false, mode: 'document' });
    } catch (err) {
      console.error('[assess-docs]', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// ── News ──────────────────────────────────────────────────────

app.get('/api/news', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const { rows } = await pool.query(
      `SELECT n.id, n.reg_id, n.title, n.url, n.source, n.published_at,
              r.code, r.title AS reg_title, r.body AS reg_body
       FROM news_items n
       JOIN regulations r ON n.reg_id = r.id
       WHERE n.published_at > NOW() - ($1 || ' days')::INTERVAL
          OR n.published_at IS NULL
       ORDER BY n.published_at DESC NULLS LAST`,
      [days]
    );
    const map = {};
    for (const row of rows) {
      if (!map[row.reg_id]) {
        map[row.reg_id] = {
          reg_id: row.reg_id, code: row.code,
          title: row.reg_title, body: row.reg_body,
          items: [],
        };
      }
      map[row.reg_id].items.push({
        id: row.id, title: row.title, url: row.url,
        source: row.source, published_at: row.published_at,
      });
    }
    const grouped = Object.values(map).sort((a, b) => {
      const aT = a.items[0]?.published_at || 0;
      const bT = b.items[0]?.published_at || 0;
      return new Date(bT) - new Date(aT);
    });
    res.json(grouped);
  } catch (err) {
    console.error('[api] GET /news:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Scan ──────────────────────────────────────────────────────

app.post('/api/scan', async (req, res) => {
  if (scanState.running) {
    return res.status(409).json({ error: 'Scan already in progress' });
  }
  const sources = req.body.sources || ['mdcg', 'fda'];
  res.json({ ok: true, message: `Scan started for: ${sources.join(', ')}` });

  scanState.running = true;
  try {
    await runScan(sources);
  } finally {
    scanState.running = false;
  }
});

app.get('/api/scan/status', (_req, res) => {
  res.json({ running: scanState.running });
});

// ── Health ────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

export default app;
