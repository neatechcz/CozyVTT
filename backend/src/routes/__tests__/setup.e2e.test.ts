/**
 * Setup route session integration tests.
 * Uses an in-memory Express session store and mocks user creation/settings so
 * the test never writes to a configured application database.
 */

jest.mock('../../services/systemSettings', () => ({
  isSetupCompleted: jest.fn().mockResolvedValue(false),
  markSetupCompleted: jest.fn().mockResolvedValue(undefined),
  hasUsers: jest.fn().mockResolvedValue(false),
}));

jest.mock('../../services/auth', () => ({
  registerUser: jest.fn(),
  sanitizeUser: jest.fn((user) => user),
}));

import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { registerUser } from '../../services/auth';
import setupRoutes from '../setup';

const setupAdmin = {
  id: 'setup-admin-id',
  email: 'admin@example.test',
  displayName: 'Setup Admin',
  platformRole: 'ADMIN',
};

const registerUserMock = jest.mocked(registerUser);

function createSetupTestApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'setup-test-secret',
    resave: false,
    saveUninitialized: false,
    name: 'cozyvtt.sid',
    cookie: { secure: false },
  }));

  app.post('/test/seed-session', (req, res) => {
    req.session.userId = 'stale-user-id';
    req.session.mfaPending = true;
    res.sendStatus(204);
  });
  app.get('/test/session', (req, res) => {
    res.json({
      userId: req.session.userId,
      email: req.session.email,
      displayName: req.session.displayName,
      platformRole: req.session.platformRole,
      mfaPending: req.session.mfaPending,
    });
  });
  app.use('/api/setup', setupRoutes);
  return app;
}

describe('POST /api/setup/init session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerUserMock.mockResolvedValue(setupAdmin as never);
  });

  it('rotates and persists the authenticated admin session before returning success', async () => {
    const agent = request.agent(createSetupTestApp());
    const seeded = await agent.post('/test/seed-session');
    const initialCookie = String(seeded.headers['set-cookie']).split(';')[0];

    const response = await agent.post('/api/setup/init').send({
      email: setupAdmin.email,
      password: 'StrongSetupPass1!',
      displayName: setupAdmin.displayName,
    });

    expect(response.status).toBe(201);
    expect(response.body.user.id).toBe(setupAdmin.id);
    expect(response.headers['set-cookie']).toBeDefined();
    const setupCookie = String(response.headers['set-cookie']).split(';')[0];
    expect(setupCookie).not.toBe(initialCookie);

    const sessionResponse = await agent.get('/test/session');
    expect(sessionResponse.body).toEqual({
      userId: setupAdmin.id,
      email: setupAdmin.email,
      displayName: setupAdmin.displayName,
      platformRole: setupAdmin.platformRole,
    });
  });
});
