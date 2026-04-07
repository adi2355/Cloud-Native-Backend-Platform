/**
 * User Routes
 * Handles user profile, preferences, and avatar management
 */

import { Router, RequestHandler } from 'express';
import multer from 'multer';
import { UserController } from '../controllers/user.controller';
import { z } from 'zod';
import {
  UpdateUserProfileSchema,
  AvatarUploadUrlSchema,
  UserPreferencesUpdateSchema,
  ChangePasswordSchema,
  UserDataExportSchema,
} from '../schemas/user.schemas';
import type { MiddlewareFactory } from '../../../core/middleware-factory';
import { ControllerRegistry } from '../../../core/controller-registry';

// Route services interface
export interface RouteServices {
  middlewareFactory: MiddlewareFactory;
  controllerRegistry: ControllerRegistry;
}

const router = Router();

// Service injection support
let routeServices: RouteServices | null = null;

/**
 * Initialize route services and register routes
 */
export function initializeRouteServices(services: RouteServices): void {
  routeServices = services;
  
  // Register all routes after services are initialized
  registerUserRoutes();
}

/**
 * Get UserController from ControllerRegistry with dependency injection
 */
const getUserController = (): UserController => {
  if (!routeServices) {
    throw new Error('Route services not initialized. Call initializeRouteServices() first.');
  }
  return routeServices.controllerRegistry.getController<UserController>('user');
};

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size
  },
  fileFilter: (req, file, cb) => {
    // Accept images only
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

/**
 * Get rate limiter from MiddlewareFactory
 */
const getUserRateLimit = (): RequestHandler => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.getRateLimiter('standard');
};

const getAvatarRateLimit = (): RequestHandler => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.getRateLimiter('strict'); // More restrictive for file uploads
};

/**
 * Register all user routes after services are initialized
 */

/**
 * Get validation middleware from MiddlewareFactory
 */
const getValidation = (schema: z.AnyZodObject) => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.getValidation(schema);
};

function registerUserRoutes() {
  // Clear any existing routes first
  router.stack.length = 0;

  // All routes require authentication - handled by RouteRegistry via MiddlewareFactory

  /**
   * GET /api/v1/users/profile
   * Get current user profile
   */
  router.get('/profile', getUserRateLimit(), getUserController().getProfile.bind(getUserController()) as RequestHandler);

  /**
   * PUT /api/v1/users/profile
   * Update current user profile
   */
  router.put('/profile', getUserRateLimit(), getValidation(UpdateUserProfileSchema), getUserController().updateProfile.bind(getUserController()) as RequestHandler);

  /**
   * PATCH /api/v1/users/profile
   * Partially update current user profile
   */
  router.patch('/profile', getUserRateLimit(), getValidation(UpdateUserProfileSchema), getUserController().patchProfile.bind(getUserController()) as RequestHandler);

  /**
   * GET /api/v1/users/profile/export
   * Export user data for GDPR compliance
   */
  router.get('/profile/export', getUserRateLimit(), getValidation(UserDataExportSchema), getUserController().exportUserData.bind(getUserController()) as RequestHandler);

  /**
   * GET /api/v1/users/stats
   * Get user statistics
   */
  router.get('/stats', getUserRateLimit(), getUserController().getUserStats.bind(getUserController()) as RequestHandler);

  /**
   * DELETE /api/v1/users/profile
   * Delete user account
   */
  router.delete('/profile', getUserRateLimit(), getUserController().deleteAccount.bind(getUserController()) as RequestHandler);

  /**
   * POST /api/v1/users/change-password
   * Change user password
   */
  router.post('/change-password', getUserRateLimit(), getValidation(ChangePasswordSchema), getUserController().changePassword.bind(getUserController()) as RequestHandler);

  /**
   * GET /api/v1/users/preferences
   * Get user preferences
   */
  router.get('/preferences', getUserRateLimit(), getUserController().getPreferences.bind(getUserController()) as RequestHandler);

  /**
   * PUT /api/v1/users/preferences
   * Update user preferences
   */
  router.put('/preferences', getUserRateLimit(), getValidation(UserPreferencesUpdateSchema), getUserController().updatePreferences.bind(getUserController()) as RequestHandler);

  /**
   * POST /api/v1/users/avatar
   * Upload user avatar
   */
  router.post('/avatar', getAvatarRateLimit(), upload.single('avatar'), getUserController().uploadAvatar.bind(getUserController()) as RequestHandler);

  /**
   * DELETE /api/v1/users/avatar
   * Delete user avatar
   */
  router.delete('/avatar', getAvatarRateLimit(), getUserController().deleteAvatar.bind(getUserController()) as RequestHandler);

  /**
   * GET /api/v1/users/avatar/upload-url
   * Get presigned URL for direct avatar upload
   */
  router.get('/avatar/upload-url', getAvatarRateLimit(), getValidation(AvatarUploadUrlSchema), getUserController().getAvatarUploadUrl.bind(getUserController()) as RequestHandler);

  /**
   * PATCH /api/v1/users/me
   * Partially update current user's profile
   */
  router.patch('/me', getUserRateLimit(), getValidation(UpdateUserProfileSchema), getUserController().updateMyProfile.bind(getUserController()) as RequestHandler);

  /**
   * PATCH /api/v1/users/me/preferences
   * Partially update current user's preferences
   */
  router.patch('/me/preferences', getUserRateLimit(), getValidation(UserPreferencesUpdateSchema), getUserController().updateMyPreferences.bind(getUserController()) as RequestHandler);

  /**
   * POST /api/v1/users/me/avatar
   * Upload current user's avatar (alias route)
   */
  router.post('/me/avatar', getAvatarRateLimit(), upload.single('avatar'), getUserController().uploadAvatar.bind(getUserController()) as RequestHandler);
}

export default router;