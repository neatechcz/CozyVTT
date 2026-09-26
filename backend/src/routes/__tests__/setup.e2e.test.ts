/**
 * Setup route session integration tests.
 * Uses an in-memory Express session store and a small settings fake so the
 * test never writes to a configured application database.
 */

jest.mock('../../services/systemSettings', () => ({
  getSystemSettings: jest.fn(),
  isSetupCompleted: jest.fn(),
  markSetupCompleted: jest.fn(),
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
import { getSystemSettings, isSetupCompleted, markSetupCompleted } from '../../services/systemSettings';
import setupRoutes from '../setup';
import adminRoutes from '../admin';

const setupAdmin = {
  id: 'setup-admin-id',
  email: 'admin@example.test',
  displayName: 'Setup Admin',
  platformRole: 'ADMIN',
};

const registerUserMock = jest.mocked(registerUser);
const getSystemSettingsMock = jest.mocked(getSystemSettings);
const isSetupCompletedMock = jest.mocked(isSetupCompleted);
const markSetupCompletedMock = jest.mocked(markSetupCompleted);
let persistedSettings: Record<string, unknown>;

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
  app.use('/api/admin', adminRoutes);
  return app;
}

describe('POST /api/setup/init session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerUserMock.mockResolvedValue(setupAdmin as never);
    persistedSettings = {
      setupCompleted: false,
      instanceName: 'CozyVTT',
      timezone: 'UTC',
      allowRegistration: false,
    };
    isSetupCompletedMock.mockImplementation(async () => persistedSettings.setupCompleted as boolean);
    getSystemSettingsMock.mockImplementation(async () => persistedSettings as never);
    markSetupCompletedMock.mockImplementation(async (...args: any[]) => {
      const initialSettings = args[0] as Record<string, unknown> | undefined;
      Object.assign(persistedSettings, initialSettings, { setupCompleted: true });
    });
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

  it('persists reviewed instance settings during setup and exposes them through admin settings', async () => {
    const agent = request.agent(createSetupTestApp());
    const response = await agent.post('/api/setup/init').send({
      email: setupAdmin.email,
      password: 'StrongSetupPass1!',
      displayName: setupAdmin.displayName,
      instanceName: '  Supplement Audit  ',
      timezone: 'Europe/Prague',
      allowRegistration: true,
    });

    expect(response.status).toBe(201);
    expect(markSetupCompletedMock).toHaveBeenCalledWith({
      instanceName: 'Supplement Audit',
      timezone: 'Europe/Prague',
      allowRegistration: true,
    });

    const settingsResponse = await agent.get('/api/admin/settings');
    expect(settingsResponse.status).toBe(200);
    expect(settingsResponse.body.settings).toEqual(expect.objectContaining({
      setupCompleted: true,
      instanceName: 'Supplement Audit',
      timezone: 'Europe/Prague',
      allowRegistration: true,
    }));

    const reinitResponse = await agent.post('/api/setup/init').send({
      email: 'second-admin@example.test',
      password: 'StrongSetupPass1!',
      displayName: 'Second Admin',
    });
    expect(reinitResponse.status).toBe(400);
    expect(registerUserMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid timezone before creating the administrator', async () => {
    const response = await request(createSetupTestApp()).post('/api/setup/init').send({
      email: setupAdmin.email,
      password: 'StrongSetupPass1!',
      displayName: setupAdmin.displayName,
      instanceName: 'Supplement Audit',
      timezone: 'Mars/Olympus_Mons',
      allowRegistration: true,
    });

    expect(response.status).toBe(400);
    expect(registerUserMock).not.toHaveBeenCalled();
    expect(markSetupCompletedMock).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean public registration setting before creating the administrator', async () => {
    const response = await request(createSetupTestApp()).post('/api/setup/init').send({
      email: setupAdmin.email,
      password: 'StrongSetupPass1!',
      displayName: setupAdmin.displayName,
      instanceName: 'Supplement Audit',
      timezone: 'Europe/Prague',
      allowRegistration: 'true',
    });

    expect(response.status).toBe(400);
    expect(registerUserMock).not.toHaveBeenCalled();
    expect(markSetupCompletedMock).not.toHaveBeenCalled();
  });
});
