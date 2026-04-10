/**
 * User Schema Validation
 * Zod schemas for user-related API endpoints including file uploads
 *
 * Documentation: https://zod.dev/
 * File Upload Reference: https://expressjs.com/en/resources/middleware/multer.html
 */

import { z } from 'zod';
import { OnboardingPreferencesUpdateSchema } from '@shared/contracts';

const OptionalDateOfBirthSchema = z.union([
  z.string().date().transform((value) => new Date(value)),
  z.date(),
  z.null(),
]).optional();

// Express type for Multer file validation
declare namespace Express {
  namespace Multer {
    interface File {
      fieldname: string;
      originalname: string;
      encoding: string;
      mimetype: string;
      size: number;
      destination: string;
      filename: string;
      path: string;
      buffer: Buffer;
    }
  }
}

// User profile update schema
export const UpdateUserProfileSchema = z.object({
  body: z.object({
    username: z.string().min(1).max(50).optional(),
    name: z.string().min(2).max(100).optional(),
    dateOfBirth: OptionalDateOfBirthSchema,
    wellnessPreferences: z.string().optional(),
    avatarUrl: z.string().url().optional().nullable(),
    userType: z.enum(['CONSUMER', 'MEDICAL', 'RESEARCHER', 'ADMIN']).optional(),
    privacySettings: z.object({
      allowAnalytics: z.boolean().optional(),
      shareUsageData: z.boolean().optional(),
      marketingEmails: z.boolean().optional(),
      dataRetentionPeriod: z.number().int().min(0).optional(),
    }).optional(),
    notificationSettings: z.object({
      pushNotifications: z.boolean().optional(),
      emailNotifications: z.boolean().optional(),
      achievementAlerts: z.boolean().optional(),
      goalReminders: z.boolean().optional(),
    }).optional(),
  }),
});

// Avatar upload validation schema
export const AvatarUploadSchema = z.object({
  params: z.object({
    // No params for avatar upload
  }).optional(),
  query: z.object({
    contentType: z.string()
      .regex(/^image\/(jpeg|jpg|png|webp|gif)$/, 'Invalid image type')
      .optional()
      .default('image/jpeg'),
  }).optional(),
  body: z.object({
    // File validation will be handled by multer middleware
  }).optional(),
});

// Journal photo upload validation schema
export const JournalPhotoUploadSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid journal entry ID'),
  }),
  query: z.object({
    // Optional query parameters
  }).optional(),
  body: z.object({
    // Files validation will be handled by multer middleware
    // Maximum 5 files, each up to 10MB
  }).optional(),
});

// File type validation utilities
export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg', 
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export const ALLOWED_EXPORT_FORMATS = [
  'pdf',
  'csv', 
  'xlsx',
  'json',
] as const;

// File size limits (in bytes)
export const FILE_SIZE_LIMITS = {
  AVATAR: 10 * 1024 * 1024,      // 10MB
  JOURNAL_PHOTO: 10 * 1024 * 1024, // 10MB per photo
  EXPORT: 100 * 1024 * 1024,     // 100MB for exports
  BACKUP: 10 * 1024 * 1024 * 1024, // 10GB for backups
} as const;

// Analytics export request validation
export const AnalyticsExportRequestSchema = z.object({
  body: z.object({
    type: z.enum(['analytics', 'consumption', 'costs', 'full', 'dashboard', 'trends', 'insights']),
    period: z.string().optional(),
    startDate: z.string().datetime().optional(), // NOTE: Request body - keeping .datetime() as this file doesn't import timestamp()
    endDate: z.string().datetime().optional(), // NOTE: Request body - keeping .datetime() as this file doesn't import timestamp()
    format: z.enum(ALLOWED_EXPORT_FORMATS),
    includeCharts: z.boolean().optional().default(false),
    email: z.string().email().optional(),
  }).refine((data) => {
    // If period is custom, startDate and endDate are required
    if (data.period === 'custom') {
      return data.startDate && data.endDate;
    }
    return true;
  }, {
    message: 'startDate and endDate are required when period is custom',
  }),
});

// Avatar upload URL generation request validation
export const AvatarUploadUrlSchema = z.object({
  query: z.object({
    contentType: z.enum(ALLOWED_IMAGE_TYPES).default('image/jpeg'),
  }),
});

// User preferences update schema
// NOTE: Must stay in sync with UserController.updateMyPreferences validation schema
export const UserPreferencesUpdateSchema = z.object({
  body: z.object({
    wellnessPreferences: z.string().optional(),
    userType: z.enum(['CONSUMER', 'MEDICAL', 'RESEARCHER', 'ADMIN']).optional(),
    privacySettings: z.object({
      allowAnalytics: z.boolean().optional(),
      shareUsageData: z.boolean().optional(),
      marketingEmails: z.boolean().optional(),
      dataRetentionPeriod: z.number().int().min(0).optional(),
    }).optional(),
    notificationSettings: z.object({
      pushNotifications: z.boolean().optional(),
      emailNotifications: z.boolean().optional(),
      achievementAlerts: z.boolean().optional(),
      goalReminders: z.boolean().optional(),
    }).optional(),
    // Onboarding questionnaire preferences - deep merged with existing answers
    onboardingPreferences: OnboardingPreferencesUpdateSchema.optional(),
  }).refine((data) => {
    // At least one field must be provided
    return Object.keys(data).length > 0;
  }, {
    message: 'At least one preference field must be provided',
  }),
});

// Password change validation
export const ChangePasswordSchema = z.object({
  body: z.object({
    oldPassword: z.string().min(1, 'Old password is required'),
    newPassword: z.string()
      .min(8, 'New password must be at least 8 characters')
      .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, 
        'New password must contain at least one uppercase letter, one lowercase letter, and one number'),
  }),
});

// User data export request schema (GDPR)
export const UserDataExportSchema = z.object({
  query: z.object({
    format: z.enum(['json', 'csv']).default('json'),
    includeAnalytics: z.boolean().optional().default(true),
    includeJournalEntries: z.boolean().optional().default(true),
  }).optional(),
});

// File validation helper function
export function validateFileUpload(
  file: Express.Multer.File,
  allowedTypes: readonly string[],
  maxSize: number,
): { valid: boolean; error?: string } {
  // Check if file exists
  if (!file) {
    return { valid: false, error: 'No file uploaded' };
  }

  // Check file type
  if (!allowedTypes.includes(file.mimetype)) {
    return { 
      valid: false, 
      error: `Invalid file type. Allowed types: ${allowedTypes.join(', ')}`, 
    };
  }

  // Check file size
  if (file.size > maxSize) {
    const maxSizeMB = Math.round(maxSize / (1024 * 1024));
    return { 
      valid: false, 
      error: `File size exceeds ${maxSizeMB}MB limit`, 
    };
  }

  return { valid: true };
}

// Multiple files validation helper
export function validateMultipleFileUploads(
  files: Express.Multer.File[],
  allowedTypes: readonly string[],
  maxSize: number,
  maxCount: number,
): { valid: boolean; error?: string } {
  // Check file count
  if (!files || files.length === 0) {
    return { valid: false, error: 'No files uploaded' };
  }

  if (files.length > maxCount) {
    return { 
      valid: false, 
      error: `Too many files. Maximum ${maxCount} files allowed`, 
    };
  }

  // Validate each file
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) {
      return {
        valid: false,
        error: `File ${i + 1}: Missing file data`,
      };
    }

    const validation = validateFileUpload(file, allowedTypes, maxSize);
    if (!validation.valid) {
      return {
        valid: false,
        error: `File ${i + 1}: ${validation.error}`,
      };
    }
  }

  // Check total size
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const maxTotalSize = maxSize * maxCount;
  
  if (totalSize > maxTotalSize) {
    const maxTotalSizeMB = Math.round(maxTotalSize / (1024 * 1024));
    return { 
      valid: false, 
      error: `Total file size exceeds ${maxTotalSizeMB}MB limit`, 
    };
  }

  return { valid: true };
}
