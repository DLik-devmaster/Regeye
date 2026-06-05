import pool from '../db.js';
import { fetchMDCGVersions } from './sources/mdcg.js';
import { fetchFDAUpdates } from './sources/fda.js';
import { checkISOStandards } from './sources/iso.js';
import { checkIECStandards } from './sources/iec.js';
import { checkCustomStandards } from './sources/custom.js';
import { fetchAllNews } from './sources/news.js';
import { maxYear } from '../utils.js';

export { maxYear };

async function createAlert(regId, code, severity, type, title, body) {
  // Skip if an identical unacknowledged alert already exists
  const { rows } = await pool.query(
    `SELECT id FROM alerts WHERE reg_id=$1 AND type=$2 AND title=$3 AND acknowledged=FALSE`,
    [regId, type, title]
  );
  if (rows.length > 0) {
    console.log(`[scanner] alert already exists, skipping: ${title}`);
    return;
  }
  await pool.query(
    `INSERT INTO alerts (reg_id, code, severity, type, title, body) VALUES ($1,$2,$3,$4,$5,$6)`,
    [regId, code, severity, type, title, body]
  );
  console.log(`[scanner] alert created: ${code} — ${title}`);
}

async function updateRegulation(id, latestVersion, status, severity) {
  await pool.query(
    `UPDATE regulations SET latest_version=$1, status=$2, severity=$3, last_checked=NOW() WHERE id=$4`,
    [latestVersion, status, severity, id]
  );
}

// ── MDCG scanner ──────────────────────────────────────────────
async function runMDCGScan() {
  console.log('[scanner] starting MDCG scan...');
  let fetched;
  try {
    fetched = await fetchMDCGVersions();
  } catch (err) {
    console.error('[scanner] MDCG fetch failed:', err.message);
    return;
  }

  const { rows: regs } = await pool.query(
    `SELECT * FROM regulations WHERE body = 'MDCG'`
  );

  for (const reg of regs) {
    const baseCode = reg.code.replace(/\s+Rev\.\d+/i, '').toUpperCase();
    const found = fetched[baseCode];
    if (!found) {
      await pool.query(`UPDATE regulations SET last_checked=NOW() WHERE id=$1`, [reg.id]);
      continue;
    }

    const onlineVersion = found.rev ? `${baseCode} ${found.rev}` : baseCode;
    // MDCG codes encode the revision in reg.code itself (e.g. "MDCG 2021-24 Rev.1")
    // when version/latest_version are "—" (set by catalogItemToReg), fall back to code
    const storedVersion =
      (reg.latest_version && reg.latest_version !== '—') ? reg.latest_version :
      (reg.version && reg.version !== '—') ? reg.version :
      reg.code;

    if (onlineVersion.toUpperCase() !== storedVersion.toUpperCase()) {
      console.log(`[scanner] MDCG update: ${reg.code} → ${onlineVersion}`);
      await updateRegulation(reg.id, onlineVersion, 'outdated', 'minor');
      await createAlert(
        reg.id, reg.code, 'minor', 'new-version',
        `${reg.code} updated — ${onlineVersion}`,
        `A new version of ${reg.code} has been published. Review the updated guidance document.`
      );
    } else {
      await pool.query(
        `UPDATE regulations SET status='up-to-date', severity=NULL, last_checked=NOW() WHERE id=$1`,
        [reg.id]
      );
    }
  }
}

// ── FDA scanner ──────────────────────────────────────────────
async function runFDAScan() {
  console.log('[scanner] starting FDA scan...');
  let docs;
  try {
    docs = await fetchFDAUpdates();
  } catch (err) {
    console.error('[scanner] FDA fetch failed:', err.message);
    return;
  }

  const { rows: regs } = await pool.query(
    `SELECT * FROM regulations WHERE body = 'FDA'`
  );

  for (const reg of regs) {
    const keywords = reg.code.toLowerCase().split(/[\s\/]+/).filter(w => w.length > 3);
    const match = docs.find(doc =>
      keywords.some(kw => doc.title.toLowerCase().includes(kw))
    );

    if (match) {
      const alreadyAlerted = await pool.query(
        `SELECT id FROM alerts WHERE reg_id=$1 AND title LIKE $2`,
        [reg.id, `%${match.document_number}%`]
      );
      if (alreadyAlerted.rows.length > 0) {
        await pool.query(`UPDATE regulations SET last_checked=NOW() WHERE id=$1`, [reg.id]);
        continue;
      }

      console.log(`[scanner] FDA match: ${reg.code} → ${match.title}`);
      await createAlert(
        reg.id, reg.code, 'major', 'modified',
        match.title.slice(0, 120),
        `Published ${match.publication_date}. ${(match.abstract || '').slice(0, 300)}`
      );
    }

    await pool.query(`UPDATE regulations SET last_checked=NOW() WHERE id=$1`, [reg.id]);
  }
}

// ── ISO scanner ───────────────────────────────────────────────
async function runISOScan() {
  console.log('[scanner] starting ISO scan...');
  const { rows: regs } = await pool.query(
    `SELECT * FROM regulations WHERE body = 'ISO'`
  );
  if (regs.length === 0) return;

  let results;
  try {
    results = await checkISOStandards(regs);
  } catch (err) {
    console.error('[scanner] ISO scan failed:', err.message);
    return;
  }

  for (const reg of regs) {
    const found = results[reg.code];
    if (!found) {
      await pool.query(`UPDATE regulations SET last_checked=NOW() WHERE id=$1`, [reg.id]);
      continue;
    }

    const storedYear = maxYear(reg.latest_version || reg.version);
    if (found.year && storedYear && parseInt(found.year) > parseInt(storedYear)) {
      console.log(`[scanner] ISO update: ${reg.code} → ${found.latestEdition}`);
      await updateRegulation(reg.id, found.latestEdition, 'outdated', 'minor');
      await createAlert(
        reg.id, reg.code, 'minor', 'new-version',
        `${reg.code} updated — ${found.latestEdition}`,
        `A newer edition of ${reg.code} has been published (${found.latestEdition}). Review and assess impact on your QMS.`
      );
    } else {
      await pool.query(`UPDATE regulations SET last_checked=NOW() WHERE id=$1`, [reg.id]);
    }
  }
}

// ── IEC scanner ───────────────────────────────────────────────
async function runIECScan() {
  console.log('[scanner] starting IEC scan...');
  const { rows: regs } = await pool.query(
    `SELECT * FROM regulations WHERE body = 'IEC'`
  );
  if (regs.length === 0) return;

  let results;
  try {
    results = await checkIECStandards(regs);
  } catch (err) {
    console.error('[scanner] IEC scan failed:', err.message);
    return;
  }

  for (const reg of regs) {
    const found = results[reg.code];
    if (!found) {
      await pool.query(`UPDATE regulations SET last_checked=NOW() WHERE id=$1`, [reg.id]);
      continue;
    }

    const storedYear = maxYear(reg.latest_version || reg.version);
    if (found.year && storedYear && parseInt(found.year) > parseInt(storedYear)) {
      console.log(`[scanner] IEC update: ${reg.code} → ${found.latestEdition}`);
      await updateRegulation(reg.id, found.latestEdition, 'outdated', 'minor');
      await createAlert(
        reg.id, reg.code, 'minor', 'new-version',
        `${reg.code} updated — ${found.latestEdition}`,
        `A newer edition of ${reg.code} has been published (${found.latestEdition}). Review and assess impact on your QMS.`
      );
    } else {
      await pool.query(`UPDATE regulations SET last_checked=NOW() WHERE id=$1`, [reg.id]);
    }
  }
}

// ── Custom scanner (source_url + Google CSE) ──────────────────
async function runCustomScan() {
  console.log('[scanner] starting custom scan...');
  const { rows: regs } = await pool.query(
    `SELECT * FROM regulations WHERE source_url IS NOT NULL`
  );
  if (regs.length === 0) {
    console.log('[scanner] no regs with source_url');
    return;
  }

  let results;
  try {
    results = await checkCustomStandards(regs);
  } catch (err) {
    console.error('[scanner] custom scan failed:', err.message);
    return;
  }

  for (const reg of regs) {
    const found = results[reg.id];
    if (!found) {
      await pool.query(`UPDATE regulations SET last_checked=NOW() WHERE id=$1`, [reg.id]);
      continue;
    }

    const storedYear = maxYear(reg.latest_version || reg.version);
    if (found.year && storedYear && parseInt(found.year) > parseInt(storedYear)) {
      console.log(`[scanner] custom update: ${reg.code} → ${found.year}`);
      await updateRegulation(reg.id, found.year, 'outdated', 'minor');
      await createAlert(
        reg.id, reg.code, 'minor', 'new-version',
        `${reg.code} updated — ${found.year}`,
        `A newer version of ${reg.code} may be available (${found.year}). Verify at the official source and assess impact on your QMS.`
      );
    } else {
      await pool.query(`UPDATE regulations SET last_checked=NOW() WHERE id=$1`, [reg.id]);
    }
  }
}

// ── News scanner ──────────────────────────────────────────────
async function runNewsScan() {
  console.log('[scanner] starting news scan...');
  const { rows: regs } = await pool.query(`SELECT id, code, title FROM regulations`);
  if (!regs.length) { console.log('[scanner] no regulations for news scan'); return; }

  const results = await fetchAllNews(regs);
  let inserted = 0;
  for (const reg of regs) {
    for (const item of (results[reg.id] || [])) {
      try {
        const r = await pool.query(
          `INSERT INTO news_items (reg_id, title, url, source, published_at)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (reg_id, url) DO NOTHING`,
          [reg.id, item.title, item.url, item.source || null, item.published_at || null]
        );
        if (r.rowCount > 0) inserted++;
      } catch { /* skip on conflict / invalid */ }
    }
  }
  console.log(`[scanner] news scan done — ${inserted} new items`);
}

// ── Main scan entry point ─────────────────────────────────────
export async function runScan(sources = ['mdcg', 'fda', 'iso', 'iec', 'custom']) {
  console.log(`[scanner] === scan started (${sources.join(', ')}) ===`);
  const t = Date.now();

  if (sources.includes('mdcg'))   await runMDCGScan();
  if (sources.includes('fda'))    await runFDAScan();
  if (sources.includes('iso'))    await runISOScan();
  if (sources.includes('iec'))    await runIECScan();
  if (sources.includes('custom')) await runCustomScan();
  if (sources.includes('news'))   await runNewsScan();

  console.log(`[scanner] === scan done in ${((Date.now() - t) / 1000).toFixed(1)}s ===`);
}
