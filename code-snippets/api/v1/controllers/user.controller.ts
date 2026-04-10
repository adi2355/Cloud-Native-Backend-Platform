/**
 * User Controller
 * Handles HTTP requests for user management
 */

import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../../types/authenticated-request.types';
import { getUserId, getRequestId } from '../../../utils/auth-guards';
import { UserService, UpdateUserData } from '../../../services/user.service';
import {
  ApiResponse,
  UpdateUserSchema,
  UserPrivacySettingsSchema,
  UserNotificationSettingsSchema,
  Prisma,
} from '../../../models';
import {
  OnboardingPreferencesUpdateSchema,
  ONBOARDING_SCHEMA_VERSION,
  mergeOnboardingPreferences,
  type OnboardingPreferences,
} from '@shared/contracts';
import { validateOnboardingAnswers } from '../../../services/onboarding-validation.service';
import { LoggerService } from '../../../services/logger.service';
import { getErrorMessage, getErrorStack } from '../../../utils/error-handler';
import { AppError, ErrorCodes } from '../../../utils/AppError';
import { S3Service } from '../../../services/s3.service';

// S3Service will be injected through constructor dependency injection
import { validateFileUpload, ALLOWED_IMAGE_TYPES, FILE_SIZE_LIMITS } from '../schemas/user.schemas';
import { z } from 'zod';

export class UserController {
  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private userService: UserService,
    private logger: LoggerService,
    private s3Service: S3Service,
  ) {
    // Lightweight constructor - all dependencies injected explicitly
  }

  /**
   * Get current user profile
   * GET /api/v1/users/profile
   */
  public async getProfile(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);

      const user = await this.userService.findById(userId);

      if (!user) {
        throw AppError.notFound('User');
      }

      // Remove sensitive fields
      const { passwordHash, ...userProfile } = user;

      res.json({
        success: true,
        data: userProfile,
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to get user profile', { context: 'UserController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Update current user profile
   * PUT /api/v1/users/profile
   */
  public async updateProfile(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);

      // Validate request body
      const validationResult = UpdateUserSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        throw AppError.validation('Invalid request data', validationResult.error.errors);
      }

      const updatedUser = await this.userService.updateUser(
        userId,
        validationResult.data,
      );

      // Remove sensitive fields
      const { passwordHash, ...userProfile } = updatedUser;

      res.json({
        success: true,
        data: userProfile,
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      } as ApiResponse);
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
      } else {
        this.logger.error('Failed to update user profile', { context: 'UserController', error: getErrorMessage(error), stack: getErrorStack(error) });
        next(AppError.internal('Failed to update user profile'));
      }
    }
  }

  /**
   * Get user statistics
   * GET /api/v1/users/stats
   */
  public async getUserStats(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);

      const stats = await this.userService.getUserStats(userId);

      res.json({
        success: true,
        data: stats,
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to get user stats', { context: 'UserController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Delete user account
   * DELETE /api/v1/users/profile
   */
  public async deleteAccount(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);

      // Optionally verify password before deletion
      const { password } = req.body;
      if (password) {
        const isValid = await this.userService.validatePassword(userId, password);
        if (!isValid) {
          throw AppError.forbidden('Invalid password');
        }
      }

      await this.userService.deleteUser(userId);

      res.json({
        success: true,
        data: { message: 'Account deleted successfully' },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to delete user account', { context: 'UserController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Change password
   * POST /api/v1/users/change-password
   */
  public async changePassword(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);

      const { oldPassword, newPassword } = req.body;

      if (!oldPassword || !newPassword) {
        throw AppError.validation('Old password and new password are required');
      }

      // Validate old password
      const isValid = await this.userService.validatePassword(userId, oldPassword);
      if (!isValid) {
        throw AppError.forbidden('Invalid old password');
      }

      // Validate new password strength
      if (newPassword.length < 8) {
        throw AppError.validation('New password must be at least 8 characters long');
      }

      await this.userService.changePassword(userId, newPassword);

      res.json({
        success: true,
        data: { message: 'Password changed successfully' },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to change password', { context: 'UserController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Get user preferences
   * GET /api/v1/users/preferences
   */
  public async getPreferences(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);

      const user = await this.userService.findById(userId);
      
      if (!user) {
        throw AppError.notFound('User');
      }

      res.json({
        success: true,
        data: {
          wellnessPreferences: user.wellnessPreferences,
          privacySettings: user.privacySettings,
          notificationSettings: user.notificationSettings,
          userType: user.userType,
        },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to get user preferences', { context: 'UserController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Update user preferences
   * PUT /api/v1/users/preferences
   */
  public async updatePreferences(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);

      const { wellnessPreferences, privacySettings, notificationSettings, userType } = req.body;

      const updateData: UpdateUserData = {};
      if (wellnessPreferences !== undefined) updateData.wellnessPreferences = wellnessPreferences;
      if (privacySettings !== undefined) updateData.privacySettings = privacySettings;
      if (notificationSettings !== undefined) updateData.notificationSettings = notificationSettings;
      if (userType !== undefined) updateData.userType = userType;

      const updatedUser = await this.userService.updateUser(userId, updateData);

      res.json({
        success: true,
        data: {
          wellnessPreferences: updatedUser.wellnessPreferences,
          privacySettings: updatedUser.privacySettings,
          notificationSettings: updatedUser.notificationSettings,
          userType: updatedUser.userType,
        },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to update user preferences', { context: 'UserController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Upload user avatar
   * POST /api/v1/users/avatar
   * POST /api/v1/users/me/avatar
   */
  public async uploadAvatar(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);

      // Check if file was uploaded
      if (!req.file) {
        throw AppError.validation('No file uploaded');
      }

      // Validate file using schema validation
      const fileValidation = validateFileUpload(
        req.file,
        ALLOWED_IMAGE_TYPES,
        FILE_SIZE_LIMITS.AVATAR,
      );
      
      if (!fileValidation.valid) {
        throw AppError.validation(fileValidation.error!);
      }
      
      // Upload avatar to S3
      const uploadResult = await this.s3Service.uploadAvatar({
        userId,
        file: req.file.buffer,
        contentType: req.file.mimetype,
        filename: req.file.originalname,
      });

      // Update user profile with avatar URL
      const updatedUser = await this.userService.updateUser(userId, {
        avatarUrl: uploadResult.publicUrl || uploadResult.url,
      });

      // Remove sensitive fields
      const { passwordHash, ...userProfile } = updatedUser;

      res.json({
        success: true,
        data: userProfile,
        message: 'Avatar uploaded successfully',
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      } as ApiResponse);
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
      } else {
        this.logger.error('Failed to upload avatar', { context: 'UserController', error: getErrorMessage(error), stack: getErrorStack(error) });
        next(AppError.internal('Failed to upload avatar'));
      }
    }
  }

  /**
   * Delete user avatar
   * DELETE /api/v1/users/avatar
   */
  public async deleteAvatar(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);

      // Get current user to find avatar key
      const user = await this.userService.findById(userId);
      if (!user || !user.avatarUrl) {
        throw AppError.notFound('Avatar');
      }

      // Extract key from avatar URL
      const avatarKey = this.extractS3KeyFromUrl(user.avatarUrl);
      if (avatarKey) {
        await this.s3Service.deleteAvatar(avatarKey);
      }

      // Update user profile to remove avatar URL
      await this.userService.updateUser(userId, {
        avatarUrl: undefined,
      });

      res.json({
        success: true,
        data: { message: 'Avatar deleted successfully' },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to delete avatar', { context: 'UserController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Get presigned URL for avatar upload
   * GET /api/v1/users/avatar/upload-url
   */
  public async getAvatarUploadUrl(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);

      const contentType = req.query.contentType as string || 'image/jpeg';

      const { uploadUrl, key } = await this.s3Service.generateUploadUrl(userId, contentType);

      res.json({
        success: true,
        data: {
          uploadUrl,
          key,
          expiresIn: 300, // 5 minutes
        },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to generate avatar upload URL', { context: 'UserController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Partially update current user profile
   * PATCH /api/v1/users/profile
   */
  public async patchProfile(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);

      // Validate request body for partial update
      const validationResult = UpdateUserSchema.partial().safeParse(req.body);
      
      if (!validationResult.success) {
        throw AppError.validation('Invalid request data', validationResult.error.errors);
      }

      // Check if there are any fields to update
      if (Object.keys(validationResult.data).length === 0) {
        throw AppError.validation('No data provided for update');
      }

      const updatedUser = await this.userService.updateUser(
        userId,
        validationResult.data,
      );

      // Remove sensitive fields
      const { passwordHash, ...userProfile } = updatedUser;

      res.json({
        success: true,
        data: userProfile,
        message: 'User profile updated successfully',
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      } as ApiResponse);
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
      } else {
        this.logger.error('Failed to patch user profile', { context: 'UserController', error: getErrorMessage(error), stack: getErrorStack(error) });
        next(AppError.internal('Failed to patch user profile'));
      }
    }
  }

  /**
   * Partially update current user profile (alias for /me)
   * PATCH /api/v1/users/me
   */
  public async updateMyProfile(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);

      // Validate request body for partial update  
      const validationResult = UpdateUserSchema.partial().safeParse(req.body);
      
      if (!validationResult.success) {
        throw AppError.validation('Invalid user profile data', validationResult.error.errors);
      }

      // Check if there are any fields to update
      if (Object.keys(validationResult.data).length === 0) {
        throw AppError.validation('No data provided for update');
      }

      const updatedUser = await this.userService.updateUser(
        userId,
        validationResult.data,
      );

      // Remove sensitive fields
      const { passwordHash, ...userProfile } = updatedUser;

      res.json({
        success: true,
        data: userProfile,
        message: 'User profile updated successfully',
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      } as ApiResponse);
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
      } else {
        this.logger.error('Failed to update user profile', { context: 'UserController', error: getErrorMessage(error), stack: getErrorStack(error) });
        next(AppError.internal('Failed to update user profile'));
      }
    }
  }

  /**
   * Partially update current user's preferences
   * PATCH /api/v1/users/me/preferences
   */
  public async updateMyPreferences(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);

      // Validate incoming preferences data
      // and prototype poisoning attacks. Unknown fields will return 400 validation error.
      const preferencesSchema = z.object({
        privacySettings: UserPrivacySettingsSchema.optional(),
        notificationSettings: UserNotificationSettingsSchema.optional(),
        wellnessPreferences: z.string().optional(),
        onboardingPreferences: OnboardingPreferencesUpdateSchema.optional(),
      }).strict();

      const validationResult = preferencesSchema.safeParse(req.body);

      if (!validationResult.success) {
        throw AppError.validation('Invalid preference data', validationResult.error.errors);
      }

      if (Object.keys(validationResult.data).length === 0) {
        throw AppError.validation('No preferences provided for update');
      }

      // Fetch current user to merge existing preferences
      const currentUser = await this.userService.findById(userId);
      if (!currentUser) {
        throw AppError.notFound('User');
      }

      const updatedUserData: UpdateUserData = {};

      // Merge privacy settings if provided
      if (validationResult.data.privacySettings) {
        updatedUserData.privacySettings = {
          ...(currentUser.privacySettings as object || {}),
          ...validationResult.data.privacySettings,
        };
      }

      // Merge notification settings if provided
      if (validationResult.data.notificationSettings) {
        updatedUserData.notificationSettings = {
          ...(currentUser.notificationSettings as object || {}),
          ...validationResult.data.notificationSettings,
        };
      }

      // Update product preferences if provided
      if (validationResult.data.wellnessPreferences !== undefined) {
        updatedUserData.wellnessPreferences = validationResult.data.wellnessPreferences;
      }

      // Merge onboarding preferences if provided (DEEP merge for answers)
      if (validationResult.data.onboardingPreferences) {
        const incomingOnboarding = validationResult.data.onboardingPreferences;

        // Validate schema version is supported
        if (incomingOnboarding.schemaVersion && incomingOnboarding.schemaVersion > ONBOARDING_SCHEMA_VERSION) {
          throw AppError.validation(
            `Onboarding schema version ${incomingOnboarding.schemaVersion} is newer than supported version ${ONBOARDING_SCHEMA_VERSION}. Please update the server.`,
            { receivedVersion: incomingOnboarding.schemaVersion, supportedVersion: ONBOARDING_SCHEMA_VERSION }
          );
        }

        // Validate individual answer values against question types
        if (incomingOnboarding.answers) {
          const answerValidation = validateOnboardingAnswers(incomingOnboarding.answers);
          if (!answerValidation.valid) {
            this.logger.warn('Invalid onboarding answers received', {
              context: 'UserController.updateMyPreferences',
              userId,
              errors: answerValidation.errors,
            });
            throw AppError.validation(
              'Invalid onboarding answer values',
              answerValidation.errors.map(e => ({
                questionId: e.questionId,
                message: e.message,
              }))
            );
          }
        }

        // Use the shared merge function with server-controlled timestamp
        const existingOnboarding = currentUser.onboardingPreferences as OnboardingPreferences | null;
        const serverTimestamp = new Date().toISOString();

        const mergeResult = mergeOnboardingPreferences(
          existingOnboarding,
          incomingOnboarding,
          serverTimestamp
        );

        // Handle monotonic completion violation
        if (!mergeResult.success) {
          this.logger.warn('Monotonic completion violation attempted', {
            context: 'UserController.updateMyPreferences',
            userId,
            violation: mergeResult.violation,
            existingCompletedAt: mergeResult.existingCompletedAt,
          });
          throw new AppError(
            400,
            ErrorCodes.INVALID_OPERATION,
            mergeResult.message,
            true,
            {
              violation: mergeResult.violation,
              existingCompletedAt: mergeResult.existingCompletedAt
            }
          );
        }

        updatedUserData.onboardingPreferences = mergeResult.data;
      }

      const updatedUser = await this.userService.updateUser(userId, updatedUserData);

      // Remove sensitive fields
      const { passwordHash, ...userProfile } = updatedUser;

      res.json({
        success: true,
        data: userProfile,
        message: 'User preferences updated successfully',
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      } as ApiResponse);
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
      } else {
        this.logger.error('Failed to update user preferences', { context: 'UserController', error: getErrorMessage(error), stack: getErrorStack(error) });
        next(AppError.internal('Failed to update user preferences'));
      }
    }
  }

  /**
   * Export user data for GDPR compliance
   * GET /api/v1/users/profile/export
   */
  public async exportUserData(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);

      const exportData = await this.userService.exportUserData(userId, getRequestId(req));
      const fileName = `appplatform_export_${userId}_${new Date().toISOString().split('T')[0]}.json`;

      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json(exportData);
    } catch (error) {
      this.logger.error('Failed to export user data', { context: 'UserController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Extract S3 key from URL
   */
  private extractS3KeyFromUrl(url: string): string | null {
    try {
      // Handle both S3 URLs and CloudFront URLs
      const patterns = [
        /https?:\/\/[^\/]+\.s3[^\/]*\.amazonaws\.com\/(.+)/,
        /https?:\/\/s3[^\/]*\.amazonaws\.com\/[^\/]+\/(.+)/,
        /avatars\/[^\/]+\/[^\/]+/,
      ];

      for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
          return match[1] || match[0];
        }
      }

      return null;
    } catch (error) {
      this.logger.warn('Failed to extract S3 key from URL', { url, error: getErrorMessage(error) });
      return null;
    }
  }
}
