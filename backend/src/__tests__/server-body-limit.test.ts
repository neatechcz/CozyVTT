/**
 * server.ts body-limit wiring
 * PATCH /api/characters/:id/data accepts up to 1mb of JSON; every other route
 * keeps the global default (100kb). Imports the real server.ts with its side
 * effects (listen, WebSocket, PostgreSQL session store, setup gate) mocked.
 */

// server.ts calls httpServer.listen(PORT); supertest calls listen(0) on its
// own server. Only the latter really listens.
jest.mock('http', () => {
  const actual = jest.requireActual('http');
  return {
    ...actual,
    createServer: (...args: unknown[]) => {
      const server = actual.createServer(...args);
      const realListen = server.listen.bind(server);
      server.listen = (port: unknown, ...rest: unknown[]) =>
        port === 0 ? realListen(port, ...rest) : server;
      return server;
    },
  };
});
jest.mock('../websocket', () => ({ initializeWebSocket: jest.fn() }));
jest.mock('../config/session', () => ({
  sessionConfig: { secret: 'test-secret', resave: false, saveUninitialized: false },
}));
jest.mock('../middleware/setup', () => ({
  requireSetupComplete: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../config/database', () => ({ prisma: {} }));

import request from 'supertest';
import logger from '../utils/logger';
import app from '../server';

// server.ts's global error handler turns body-parser's PayloadTooLargeError
// into a 500 and logs it; "too large" is asserted through that log entry.
const logError = jest.spyOn(logger, 'error').mockImplementation(() => logger);

function rejectedAsTooLarge(res: request.Response): boolean {
  return (
    res.status >= 400 &&
    res.status !== 401 &&
    (logError.mock.calls as unknown[][]).some(
      ([message, meta]) =>
        message === 'Unhandled error' && (meta as any)?.message === 'request entity too large'
    )
  );
}

beforeEach(() => logError.mockClear());

const bigBody = (kb: number) => ({
  changes: [{ path: 'backstory', base: null, value: 'x'.repeat(kb * 1024) }],
});

test('PATCH /api/characters/:id/data parses a ~200 kB body (reaches auth → 401)', async () => {
  const res = await request(app).patch('/api/characters/char-1/data').send(bigBody(200));
  expect(rejectedAsTooLarge(res)).toBe(false);
  expect(res.status).toBe(401);
});

test('PATCH /api/characters/:id/data still rejects bodies over 1mb', async () => {
  const res = await request(app).patch('/api/characters/char-1/data').send(bigBody(1100));
  expect(rejectedAsTooLarge(res)).toBe(true);
});

test('other routes keep the global 100kb limit (~200 kB PUT rejected)', async () => {
  const res = await request(app)
    .put('/api/characters/char-1')
    .send({ data: { backstory: 'x'.repeat(200 * 1024) } });
  expect(rejectedAsTooLarge(res)).toBe(true);
});
