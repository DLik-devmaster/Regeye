import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db.js', () => ({
  default: { query: vi.fn() },
  initDb: vi.fn(),
}));

vi.mock('../scanner/index.js', () => ({
  runScan: vi.fn().mockResolvedValue(undefined),
  maxYear: vi.fn(),
}));

import request from 'supertest';
import app from '../app.js';
import pool from '../db.js';
import { state as scanState } from '../scanState.js';

beforeEach(() => {
  vi.resetAllMocks();
  scanState.running = false;
});

afterEach(() => {
  scanState.running = false;
  vi.unstubAllGlobals();
});

// ── Health ────────────────────────────────────────────────────

describe('GET /api/health', () => {
  it('returns ok with timestamp', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.time).toBeDefined();
  });
});

// ── Regulations ───────────────────────────────────────────────

describe('GET /api/regulations', () => {
  it('returns rows from DB', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'iso-13485', code: 'ISO 13485' }] });
    const res = await request(app).get('/api/regulations');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].code).toBe('ISO 13485');
  });
});

describe('POST /api/regulations', () => {
  it('creates regulation and returns 201', async () => {
    const reg = { id: 'iso-13485', code: 'ISO 13485', version: '2016', title: 'QMS', body: 'ISO' };
    pool.query.mockResolvedValue({ rows: [reg] });
    const res = await request(app).post('/api/regulations').send(reg);
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('ISO 13485');
  });
});

// ── Change status ─────────────────────────────────────────────

describe('PATCH /api/regulations/:id/changes/:idx/status', () => {
  it('returns 400 for invalid status value', async () => {
    const res = await request(app)
      .patch('/api/regulations/iso-13485/changes/0/status')
      .send({ status: 'invalid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid status');
  });

  it('returns 404 when regulation not found', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .patch('/api/regulations/missing/changes/0/status')
      .send({ status: 'closed' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when index out of range', async () => {
    pool.query.mockResolvedValue({ rows: [{ changes: [{ label: 'a', status: 'open' }] }] });
    const res = await request(app)
      .patch('/api/regulations/iso-13485/changes/5/status')
      .send({ status: 'closed' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('index out of range');
  });

  it('updates change status and returns ok', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ changes: [{ label: 'a', status: 'open' }] }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .patch('/api/regulations/iso-13485/changes/0/status')
      .send({ status: 'closed' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── Reset assessment ──────────────────────────────────────────

describe('POST /api/regulations/:id/reset-assessment', () => {
  it('resets and returns updated reg', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'iso-13485', code: 'ISO 13485', gap_score: 0 }] });
    const res = await request(app).post('/api/regulations/iso-13485/reset-assessment');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.gap_score).toBe(0);
  });

  it('returns 404 when regulation not found', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app).post('/api/regulations/missing/reset-assessment');
    expect(res.status).toBe(404);
  });
});

// ── Alerts ────────────────────────────────────────────────────

describe('PATCH /api/alerts/:id/acknowledge', () => {
  it('acknowledges alert and returns ok', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app).patch('/api/alerts/42/acknowledge');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── Scan ─────────────────────────────────────────────────────

describe('GET /api/scan/status', () => {
  it('returns running: false by default', async () => {
    const res = await request(app).get('/api/scan/status');
    expect(res.status).toBe(200);
    expect(res.body.running).toBe(false);
  });
});

describe('POST /api/scan', () => {
  it('starts scan and returns ok', async () => {
    const res = await request(app)
      .post('/api/scan')
      .send({ sources: ['mdcg'] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 409 when scan already running', async () => {
    scanState.running = true;
    const res = await request(app).post('/api/scan').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already in progress/i);
  });
});

// ── Assess ────────────────────────────────────────────────────

describe('POST /api/regulations/:id/assess', () => {
  it('returns 404 when regulation not found', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app).post('/api/regulations/missing/assess');
    expect(res.status).toBe(404);
  });

  it('returns changes and gap_score from Claude', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const reg = {
      id: 'iso-13485', code: 'ISO 13485', title: 'QMS', body: 'ISO',
      version: '2016', latest_version: '2024', status: 'outdated',
      category: 'QMS',
    };
    pool.query
      .mockResolvedValueOnce({ rows: [reg] })
      .mockResolvedValueOnce({ rows: [] });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: '[{"clause":"4.1","type":"modified","impact":"high","label":"New req","action":"Update SOP"}]' }],
      }),
    }));

    const res = await request(app).post('/api/regulations/iso-13485/assess');
    expect(res.status).toBe(200);
    expect(res.body.changes).toHaveLength(1);
    expect(res.body.changes[0].clause).toBe('4.1');
    expect(res.body.gap_score).toBe(20);
  });

  it('sets gap_score to 0 for up-to-date regulation', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const reg = {
      id: 'iso-13485', code: 'ISO 13485', title: 'QMS', body: 'ISO',
      version: '2016', latest_version: '2016', status: 'up-to-date',
      category: 'QMS',
    };
    pool.query
      .mockResolvedValueOnce({ rows: [reg] })
      .mockResolvedValueOnce({ rows: [] });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: '[{"clause":"4.1","type":"modified","impact":"high","label":"Obligation","action":"Maintain records"}]' }],
      }),
    }));

    const res = await request(app).post('/api/regulations/iso-13485/assess');
    expect(res.status).toBe(200);
    expect(res.body.gap_score).toBe(0);
  });
});
