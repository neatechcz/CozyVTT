import express from 'express';
import request from 'supertest';

jest.mock('../../config/database', () => ({ prisma: {} }));
jest.mock('../../services/email', () => ({ isSmtpConfigured: jest.fn(), sendPasswordResetEmail: jest.fn() }));

import authRouter, { loginLimiter, loginVolumeLimiter } from '../auth';
import { trustProxyHops } from '../../config/proxy';

/** Stand-in login: 200 for the right password, 401 otherwise, behind the real limiter. */
function app(hops = 1) {
  const a = express();
  a.set('trust proxy', trustProxyHops(String(hops)));
  a.use(express.json());
  a.post('/login', loginLimiter, (req, res) => { res.sendStatus(req.body.password === 'right' ? 200 : 401); });
  return a;
}

// express-rate-limit keeps state per limiter instance; reset the test client IPs between cases.
async function reset(...keys: string[]) { for (const k of keys) await loginLimiter.resetKey(k); }

describe('login rate limiter', () => {
  beforeEach(() => reset('::ffff:127.0.0.1', '127.0.0.1', '203.0.113.7', '198.51.100.9'));

  it('is the limiter mounted on POST /login of the real auth router', () => {
    const layer = (authRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }> })
      .stack.find((l) => l.route?.path === '/login' && l.route.methods.post);
    expect(layer?.route?.stack.map((s) => s.handle)).toContain(loginLimiter);
    expect(layer?.route?.stack.map((s) => s.handle)).toContain(loginVolumeLimiter);
  });

  it('caps all login requests, successful ones included, at 30 per window', async () => {
    const a = express();
    a.post('/login', loginVolumeLimiter, (_req, res) => { res.sendStatus(200); });
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await request(a).post('/login')).status);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
    await loginVolumeLimiter.resetKey('::ffff:127.0.0.1');
    await loginVolumeLimiter.resetKey('127.0.0.1');
  });

  it('never counts successful logins (e.g. MCP restarts)', async () => {
    const a = app();
    for (let i = 0; i < 8; i++) expect((await request(a).post('/login').send({ password: 'right' })).status).toBe(200);
  });

  it('blocks after 5 failed attempts, including a later correct password', async () => {
    const a = app();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await request(a).post('/login').send({ password: 'wrong' })).status);
    codes.push((await request(a).post('/login').send({ password: 'wrong' })).status);
    codes.push((await request(a).post('/login').send({ password: 'right' })).status);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });

  it('with two trusted hops, keeps separate buckets per public client', async () => {
    const a = app(2);
    // host Nginx appends the client, the gateway appends the Docker bridge address it saw
    const from = (client: string) => request(a).post('/login').set('X-Forwarded-For', `${client}, 172.18.0.1`);
    for (let i = 0; i < 5; i++) expect((await from('203.0.113.7').send({ password: 'wrong' })).status).toBe(401);
    expect((await from('203.0.113.7').send({ password: 'wrong' })).status).toBe(429);
    expect((await from('198.51.100.9').send({ password: 'right' })).status).toBe(200);
  });

  it('cannot be bypassed by a spoofed X-Forwarded-For with two trusted hops', async () => {
    const a = app(2);
    // client sends "X-Forwarded-For: <random>"; host Nginx and the gateway append real addresses
    const spoof = (n: number) => request(a).post('/login').set('X-Forwarded-For', `10.9.9.${n}, 203.0.113.7, 172.18.0.1`);
    for (let i = 0; i < 5; i++) expect((await spoof(i).send({ password: 'wrong' })).status).toBe(401);
    expect((await spoof(99).send({ password: 'wrong' })).status).toBe(429);
  });
});
