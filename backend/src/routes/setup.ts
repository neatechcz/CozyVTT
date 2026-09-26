/// <reference path="../types/express.d.ts" />
import { Router, Request, Response } from 'express';
import { isSetupCompleted, markSetupCompleted, hasUsers } from '../services/systemSettings';
import { registerUser, sanitizeUser } from '../services/auth';
import { sanitizeInput, validateEmail, validatePasswordStrength } from '../utils/validation';
import logger from '../utils/logger';

const router = Router();

/**
 * Setup Wizard Routes
 * Initial Setup & Onboarding
 * CRITICAL: These routes must be accessible even when setup is not complete
 */

/**
 * GET /api/setup/status
 * Check if setup wizard needs to be run
 * Public endpoint - no authentication required
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const setupComplete = await isSetupCompleted();
    const usersExist = await hasUsers();

    res.status(200).json({
      setupCompleted: setupComplete,
      hasUsers: usersExist,
      needsSetup: !setupComplete || !usersExist,
    });
  } catch (error) {
    logger.error('Error checking setup status', { err: error });
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to check setup status',
    });
  }
});

/**
 * POST /api/setup/init
 * Initialize the system with first admin account
 * Public endpoint - no authentication required
 * Create admin account and complete setup
 */
router.post('/init', async (req: Request, res: Response) => {
  try {
    const {
      email,
      password,
      displayName,
      instanceName,
      timezone,
      allowRegistration,
    } = req.body || {};

    // Check if setup is already completed
    const setupComplete = await isSetupCompleted();
    if (setupComplete) {
      return res.status(400).json({
        error: 'Setup Already Completed',
        message: 'System setup has already been completed',
      });
    }

    // Check if users already exist
    const usersExist = await hasUsers();
    if (usersExist) {
      return res.status(400).json({
        error: 'Users Exist',
        message: 'Cannot run setup when users already exist',
      });
    }

    // Validate required fields
    if (!email || !password || !displayName) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Email, password, and display name are required',
      });
    }

    // Validate email format
    if (!validateEmail(email)) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Invalid email format',
      });
    }

    // Validate password strength
    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Password does not meet requirements',
        errors: passwordValidation.errors,
      });
    }

    // Older clients can omit the optional instance settings and keep their
    // existing defaults. Validate and sanitize any reviewed values before
    // creating the first administrator account.
    const initialSettings: {
      instanceName?: string;
      timezone?: string;
      allowRegistration?: boolean;
    } = {};

    if (instanceName !== undefined) {
      if (typeof instanceName !== 'string') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Instance name must be text',
        });
      }

      const safeInstanceName = sanitizeInput(instanceName).slice(0, 100);
      if (safeInstanceName.length < 2) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Instance name must be at least 2 characters',
        });
      }
      initialSettings.instanceName = safeInstanceName;
    }

    if (timezone !== undefined) {
      if (typeof timezone !== 'string') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Timezone must be text',
        });
      }

      const safeTimezone = sanitizeInput(timezone).slice(0, 50);
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: safeTimezone });
      } catch {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Invalid timezone',
        });
      }
      initialSettings.timezone = safeTimezone;
    }

    if (allowRegistration !== undefined) {
      if (typeof allowRegistration !== 'boolean') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Public registration setting must be a boolean',
        });
      }
      initialSettings.allowRegistration = allowRegistration;
    }

    // Create first admin user
    // registerUser automatically makes first user an ADMIN
    const user = await registerUser({
      email,
      password,
      displayName,
    });

    // Mark setup as completed
    await markSetupCompleted(initialSettings);

    // Rotate the session ID so setup cannot carry an attacker-provided or
    // pre-authentication session into the new administrator session.
    try {
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      req.session.userId = user.id;
      req.session.email = user.email;
      req.session.displayName = user.displayName;
      req.session.platformRole = user.platformRole;

      // Save before responding so the first authenticated request after setup
      // cannot race the session store write.
      await new Promise<void>((resolve, reject) => {
        req.session.save((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    } catch (error) {
      logger.error('Failed to establish the setup administrator session', { err: error });
      return res.status(500).json({
        error: 'Setup Session Failed',
        message: 'Setup completed, but automatic login failed. Please sign in with the administrator account you created.',
      });
    }

    return res.status(201).json({
      message: 'Setup completed successfully',
      user: sanitizeUser(user),
    });
  } catch (error) {
    logger.error('Error during setup', { err: error });

    if (error instanceof Error) {
      return res.status(400).json({
        error: 'Setup Failed',
        message: error.message,
      });
    } else {
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred during setup',
      });
    }
  }
});

export default router;
