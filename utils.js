export function maxYear(versionStr) {
  const years = [...(versionStr || '').matchAll(/\d{4}/g)].map(m => parseInt(m[0]));
  return years.length ? Math.max(...years).toString() : null;
}

export function calcGapScore(changes) {
  const raw = changes.reduce((s, c) =>
    s + (c.impact === 'high' ? 20 : c.impact === 'medium' ? 10 : 5), 0);
  return Math.min(raw, 100);
}
