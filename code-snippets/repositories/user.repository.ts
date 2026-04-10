/**
 * User Repository
 * 
 * Implements the Repository Pattern for User entity database operations
 * All user-related database interactions go through this repository
 * Following AppPlatform architectural standards for production deployment
 * 
 * @see https://docs.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/infrastructure-persistence-layer-design
 */

import {
  User,
  Prisma,
  PrismaClient,
  AccountStatus,
  AuthProvider,
  UserType,
} from '@prisma/client';
import { BaseRepository, PaginatedResponse } from './base.repository';
import {
  UserPrivacySettingsSchema,
  UserNotificationSettingsSchema,
} from '../models';
import { OnboardingPreferencesSchema } from '@shared/contracts';
import { z } from 'zod';
import { LoggerService } from '../services/logger.service';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * Input types for repository methods
 */
export type CreateUserInput = Omit<Prisma.UserUncheckedCreateInput, 'id' | 'createdAt' | 'updatedAt'>;

export interface UpdateUserInput {
  email?: string | null;
  emailVerified?: boolean;
  phoneNumber?: string | null;
  phoneNumberVerified?: boolean;
  passwordHash?: string | null;
  name?: string;
  givenName?: string | null;
  familyName?: string | null;
  dateOfBirth?: Date | null;
  authProvider?: AuthProvider;
  cognitoSub?: string | null;
  googleId?: string | null;
  mfaEnabled?: boolean;
  lastSignIn?: Date | null;
  signInCount?: number;
  wellnessPreferences?: string | null;
  userType?: UserType;
  privacySettings?: z.infer<typeof UserPrivacySettingsSchema>;
  notificationSettings?: z.infer<typeof UserNotificationSettingsSchema>;
  onboardingPreferences?: z.infer<typeof OnboardingPreferencesSchema>;
  avatarUrl?: string | null;
  accountStatus?: AccountStatus;
}

export interface UserFilters {
  search?: string;
  email?: string;
  phoneNumber?: string;
  userType?: UserType;
  accountStatus?: AccountStatus;
  authProvider?: AuthProvider;
  emailVerified?: boolean;
  phoneNumberVerified?: boolean;
  mfaEnabled?: boolean;
  excludeDeactivated?: boolean;
}

/**
 * Validation schemas removed - validation now handled at controller layer
 * Controllers validate using schemas from src/models before calling repositories
 * This ensures repositories focus solely on data access, following Repository Pattern
 */

/**
 * User Repository - Handles all database operations for User entity
 * Extends BaseRepository to inherit common functionality
 */
export class UserRepository extends BaseRepository<User> {
  constructor(prisma: PrismaClient, entityName: string, logger: LoggerService) {
    super(prisma, entityName, logger);
  }

  /**
   * Create a new user
   * Validates input and handles unique constraint checks
   * 
   * @param data - User creation data
   * @returns Created user
   * @throws AppError if validation fails or user already exists
   */
  async create(data: CreateUserInput): Promise<User> {
    try {
      // Controllers already validate input - repositories trust validated data

      // Create user with explicit version for optimistic locking
      const user = await this.prisma.user.create({
        data: {
          ...data,
          version: 1, // Explicit initial version for optimistic locking
        },
      });

      this.logSuccess('create', { userId: user.id });
      return user;
    } catch (error) {
      throw this.handleError(error, 'create');
    }
  }

  /**
   * Find user by ID with authorization check
   * Users can only access their own data unless admin access is used
   *
   * @param id - User ID
   * @param requestingUserId - ID of the user making the request
   * @param options - Query options including include, select, etc.
   * @returns User or null if not found
   * @throws AppError if access denied
   */
  async findById(
    id: string,
    requestingUserId: string,
    options?: Prisma.UserFindUniqueArgs,
  ): Promise<User | null> {
    try {
      // SECURITY: Users can only access their own data
      if (id !== requestingUserId) {
        throw new Error('Access denied: Users can only access their own data');
      }

      const baseOptions: Prisma.UserFindUniqueArgs = {
        where: { id },
        ...options,
      };

      const user = await this.prisma.user.findUnique(baseOptions);

      if (user) {
        this.logSuccess('findById', { userId: id, requestingUserId, found: true });
      }

      return user;
    } catch (error) {
      throw this.handleError(error, 'findById');
    }
  }

  /**
   * Find user by ID - ADMIN ONLY
   * Allows admin users to access any user's data
   *
   * @param id - User ID
   * @param options - Query options including include, select, etc.
   * @returns User or null if not found
   */
  async findByIdAdmin(
    id: string,
    options?: Prisma.UserFindUniqueArgs,
  ): Promise<User | null> {
    try {
      const baseOptions: Prisma.UserFindUniqueArgs = {
        where: { id },
        ...options,
      };

      const user = await this.prisma.user.findUnique(baseOptions);

      if (user) {
        this.logSuccess('findByIdAdmin', { userId: id, found: true });
      }

      return user;
    } catch (error) {
      throw this.handleError(error, 'findByIdAdmin');
    }
  }

  /**
   * Find user by email
   * 
   * @param email - User email
   * @returns User or null if not found
   */
  async findByEmail(email: string): Promise<User | null> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { email },
      });

      if (user) {
        this.logSuccess('findByEmail', { email, found: true });
      }

      return user;
    } catch (error) {
      throw this.handleError(error, 'findByEmail');
    }
  }

  /**
   * Find user by phone number
   * 
   * @param phoneNumber - User phone number
   * @returns User or null if not found
   */
  async findByPhoneNumber(phoneNumber: string): Promise<User | null> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { phoneNumber },
      });

      if (user) {
        this.logSuccess('findByPhoneNumber', { phoneNumber, found: true });
      }

      return user;
    } catch (error) {
      throw this.handleError(error, 'findByPhoneNumber');
    }
  }

  /**
   * Find user by email or phone number
   * Used for authentication and duplicate checking
   * 
   * @param email - User email
   * @param phoneNumber - User phone number
   * @returns User or null if not found
   */
  async findByEmailOrPhone(
    email?: string | null,
    phoneNumber?: string | null,
  ): Promise<User | null> {
    try {
      if (!email && !phoneNumber) {
        return null;
      }

      const conditions: Prisma.UserWhereInput[] = [];
      if (email) {
        conditions.push({ email });
      }
      if (phoneNumber) {
        conditions.push({ phoneNumber });
      }

      const user = await this.prisma.user.findFirst({
        where: {
          OR: conditions,
        },
      });

      if (user) {
        this.logSuccess('findByEmailOrPhone', { 
          email, 
          phoneNumber, 
          found: true, 
        });
      }

      return user;
    } catch (error) {
      throw this.handleError(error, 'findByEmailOrPhone');
    }
  }

  /**
   * Find user by Cognito sub
   * Used for AWS Cognito authentication
   * 
   * @param cognitoSub - AWS Cognito subject ID
   * @returns User or null if not found
   */
  async findByCognitoSub(cognitoSub: string): Promise<User | null> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { cognitoSub },
      });

      if (user) {
        this.logSuccess('findByCognitoSub', { cognitoSub, found: true });
      }

      return user;
    } catch (error) {
      throw this.handleError(error, 'findByCognitoSub');
    }
  }

  /**
   * Find user by Google ID
   * Used for Google OAuth authentication
   * 
   * @param googleId - Google OAuth ID
   * @returns User or null if not found
   */
  async findByGoogleId(googleId: string): Promise<User | null> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { googleId },
      });

      if (user) {
        this.logSuccess('findByGoogleId', { googleId, found: true });
      }

      return user;
    } catch (error) {
      throw this.handleError(error, 'findByGoogleId');
    }
  }

  /**
   * Update user with authorization check
   * Users can only update their own data
   *
   * @param id - User ID
   * @param requestingUserId - ID of the user making the request
   * @param data - Update data
   * @returns Updated user
   * @throws AppError if user not found, validation fails, or access denied
   */
  async update(id: string, requestingUserId: string, data: UpdateUserInput): Promise<User> {
    try {
      // SECURITY: Users can only update their own data
      if (id !== requestingUserId) {
        throw new Error('Access denied: Users can only update their own data');
      }

      // Controllers already validate input - repositories trust validated data

      // First get current version for optimistic locking
      const existing = await this.findById(id, requestingUserId);
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'User not found',
          true,
        );
      }

      // Optimistic locking: Update only if version matches + atomically increment version
      const user = await this.prisma.user.update({
        where: {
          id,
          version: existing.version, // Optimistic lock check
        },
        data: {
          ...data,
          version: { increment: 1 }, // Atomic version increment
        },
      });

      this.logSuccess('update', { userId: id, requestingUserId });
      return user;
    } catch (error) {
      throw this.handleError(error, 'update');
    }
  }

  /**
   * Update user - ADMIN ONLY
   * Allows admin users to update any user's data
   *
   * @param id - User ID
   * @param data - Update data
   * @returns Updated user
   * @throws AppError if user not found or validation fails
   */
  async updateAdmin(id: string, data: UpdateUserInput): Promise<User> {
    try {
      // Controllers already validate input - repositories trust validated data

      // First get current version for optimistic locking
      const existing = await this.findByIdAdmin(id);
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'User not found',
          true,
        );
      }

      // Optimistic locking: Update only if version matches + atomically increment version
      const user = await this.prisma.user.update({
        where: {
          id,
          version: existing.version, // Optimistic lock check
        },
        data: {
          ...data,
          version: { increment: 1 }, // Atomic version increment
        },
      });

      this.logSuccess('updateAdmin', { userId: id });
      return user;
    } catch (error) {
      throw this.handleError(error, 'updateAdmin');
    }
  }

  /**
   * Soft delete user with authorization check
   * Users can only delete their own account
   *
   * @param id - User ID
   * @param requestingUserId - ID of the user making the request
   * @returns Updated user with DELETED status
   * @throws AppError if access denied
   */
  async delete(id: string, requestingUserId: string): Promise<User> {
    try {
      // SECURITY: Users can only delete their own account
      if (id !== requestingUserId) {
        throw new Error('Access denied: Users can only delete their own account');
      }

      // First get current version for optimistic locking
      const existing = await this.findById(id, requestingUserId);
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'User not found',
          true,
        );
      }

      // Optimistic locking: Update only if version matches + atomically increment version
      const user = await this.prisma.user.update({
        where: {
          id,
          version: existing.version, // Optimistic lock check
        },
        data: {
          accountStatus: AccountStatus.DELETED,
          version: { increment: 1 }, // Atomic version increment
        },
      });

      this.logSuccess('delete', { userId: id, requestingUserId });
      return user;
    } catch (error) {
      throw this.handleError(error, 'delete');
    }
  }

  /**
   * Soft delete user - ADMIN ONLY
   * Allows admin users to delete any user account
   *
   * @param id - User ID
   * @returns Updated user with DELETED status
   * @throws AppError if user not found or version conflict
   */
  async deleteAdmin(id: string): Promise<User> {
    try {
      // First get current version for optimistic locking
      const existing = await this.findByIdAdmin(id);
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'User not found',
          true,
        );
      }

      // Optimistic locking: Update only if version matches + atomically increment version
      const user = await this.prisma.user.update({
        where: {
          id,
          version: existing.version, // Optimistic lock check
        },
        data: {
          accountStatus: AccountStatus.DELETED,
          version: { increment: 1 }, // Atomic version increment
        },
      });

      this.logSuccess('deleteAdmin', { userId: id, oldVersion: existing.version, newVersion: user.version });
      return user;
    } catch (error) {
      throw this.handleError(error, 'deleteAdmin', { isOptimisticUpdate: true });
    }
  }

  /**
   * Update last sign in timestamp and increment sign in count
   * Users can only update their own sign-in data
   *
   * @param id - User ID
   * @param requestingUserId - ID of the user making the request
   * @returns Updated user
   * @throws AppError if access denied, user not found, or version conflict
   */
  async updateLastSignIn(id: string, requestingUserId: string): Promise<User> {
    try {
      // SECURITY: Users can only update their own sign-in data
      if (id !== requestingUserId) {
        throw new AppError(
          403,
          ErrorCodes.FORBIDDEN,
          'Access denied: Users can only update their own sign-in data',
          true,
        );
      }

      // First get current version for optimistic locking
      const existing = await this.findById(id, requestingUserId);
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'User not found',
          true,
        );
      }

      // Optimistic locking: Update only if version matches + atomically increment version
      const user = await this.prisma.user.update({
        where: {
          id,
          version: existing.version, // Optimistic lock check
        },
        data: {
          lastSignIn: new Date(),
          signInCount: { increment: 1 },
          version: { increment: 1 }, // Atomic version increment
        },
      });

      this.logSuccess('updateLastSignIn', { userId: id, requestingUserId, oldVersion: existing.version, newVersion: user.version });
      return user;
    } catch (error) {
      throw this.handleError(error, 'updateLastSignIn', { isOptimisticUpdate: true });
    }
  }

  /**
   * Update email verified status with authorization check
   * Users can only update their own email verification status
   *
   * @param id - User ID
   * @param requestingUserId - ID of the user making the request
   * @param verified - Verification status
   * @returns Updated user
   * @throws AppError if access denied, user not found, or version conflict
   */
  async updateEmailVerified(id: string, requestingUserId: string, verified: boolean = true): Promise<User> {
    try {
      // SECURITY: Users can only update their own email verification
      if (id !== requestingUserId) {
        throw new AppError(
          403,
          ErrorCodes.FORBIDDEN,
          'Access denied: Users can only update their own email verification',
          true,
        );
      }

      // First get current user for optimistic locking + conditional logic
      const existing = await this.findByIdAdmin(id); // Use admin method for internal lookup
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'User not found',
          true,
        );
      }

      const updateData: Prisma.UserUpdateInput = {
        emailVerified: verified,
        version: { increment: 1 }, // Atomic version increment
      };

      // If verifying email, also activate account if it's pending
      if (verified && existing.accountStatus === AccountStatus.PENDING_VERIFICATION) {
        updateData.accountStatus = AccountStatus.ACTIVE;
      }

      // Optimistic locking: Update only if version matches + atomically increment version
      const updatedUser = await this.prisma.user.update({
        where: {
          id,
          version: existing.version, // Optimistic lock check
        },
        data: updateData,
      });

      this.logSuccess('updateEmailVerified', { userId: id, requestingUserId, verified, oldVersion: existing.version, newVersion: updatedUser.version });
      return updatedUser;
    } catch (error) {
      throw this.handleError(error, 'updateEmailVerified', { isOptimisticUpdate: true });
    }
  }

  /**
   * Update phone number verified status with authorization check
   * Users can only update their own phone verification status
   *
   * @param id - User ID
   * @param requestingUserId - ID of the user making the request
   * @param verified - Verification status
   * @returns Updated user
   * @throws AppError if access denied, user not found, or version conflict
   */
  async updatePhoneNumberVerified(id: string, requestingUserId: string, verified: boolean = true): Promise<User> {
    try {
      // SECURITY: Users can only update their own phone verification
      if (id !== requestingUserId) {
        throw new AppError(
          403,
          ErrorCodes.FORBIDDEN,
          'Access denied: Users can only update their own phone verification',
          true,
        );
      }

      // First get current user for optimistic locking + conditional logic
      const existing = await this.findByIdAdmin(id); // Use admin method for internal lookup
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'User not found',
          true,
        );
      }

      const updateData: Prisma.UserUpdateInput = {
        phoneNumberVerified: verified,
        version: { increment: 1 }, // Atomic version increment
      };

      // If verifying phone, also activate account if it's pending
      if (verified && existing.accountStatus === AccountStatus.PENDING_VERIFICATION) {
        updateData.accountStatus = AccountStatus.ACTIVE;
      }

      // Optimistic locking: Update only if version matches + atomically increment version
      const updatedUser = await this.prisma.user.update({
        where: {
          id,
          version: existing.version, // Optimistic lock check
        },
        data: updateData,
      });

      this.logSuccess('updatePhoneNumberVerified', { userId: id, requestingUserId, verified, oldVersion: existing.version, newVersion: updatedUser.version });
      return updatedUser;
    } catch (error) {
      throw this.handleError(error, 'updatePhoneNumberVerified', { isOptimisticUpdate: true });
    }
  }

  /**
   * Get user's password hash for authentication with authorization
   * Users can only access their own password hash
   *
   * @param id - User ID
   * @param requestingUserId - ID of the user making the request
   * @returns Password hash or null
   * @throws AppError if access denied
   */
  async getPasswordHash(id: string, requestingUserId: string): Promise<string | null> {
    try {
      // SECURITY: Users can only access their own password hash
      if (id !== requestingUserId) {
        throw new Error('Access denied: Users can only access their own password hash');
      }

      const user = await this.prisma.user.findUnique({
        where: { id },
        select: { passwordHash: true },
      });

      this.logSuccess('getPasswordHash', { userId: id, requestingUserId, found: !!user });
      return user?.passwordHash || null;
    } catch (error) {
      throw this.handleError(error, 'getPasswordHash');
    }
  }

  /**
   * Update user's password hash with authorization check
   * Users can only update their own password hash
   *
   * @param id - User ID
   * @param requestingUserId - ID of the user making the request
   * @param passwordHash - New password hash (already hashed)
   * @returns Updated user
   * @throws AppError if access denied, user not found, or version conflict
   */
  async updatePasswordHash(id: string, requestingUserId: string, passwordHash: string): Promise<User> {
    try {
      // SECURITY: Users can only update their own password hash
      if (id !== requestingUserId) {
        throw new AppError(
          403,
          ErrorCodes.FORBIDDEN,
          'Access denied: Users can only update their own password hash',
          true,
        );
      }

      // First get current version for optimistic locking
      const existing = await this.findByIdAdmin(id); // Use admin method for internal lookup
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'User not found',
          true,
        );
      }

      // Optimistic locking: Update only if version matches + atomically increment version
      const user = await this.prisma.user.update({
        where: {
          id,
          version: existing.version, // Optimistic lock check
        },
        data: {
          passwordHash,
          version: { increment: 1 }, // Atomic version increment
        },
      });

      this.logSuccess('updatePasswordHash', { userId: id, requestingUserId, oldVersion: existing.version, newVersion: user.version });
      return user;
    } catch (error) {
      throw this.handleError(error, 'updatePasswordHash', { isOptimisticUpdate: true });
    }
  }

  /**
   * List users - ADMIN ONLY
   * Supports search, filtering by user type, account status, etc.
   * Only accessible to admin users
   *
   * @param params - Pagination and filter parameters
   * @returns Paginated list of users
   */
  async listAdmin(params: {
    page?: number;
    pageSize?: number;
    orderBy?: Record<string, 'asc' | 'desc'>;
    filters?: UserFilters;
  }): Promise<PaginatedResponse<User>> {
    try {
      const { filters = {} } = params;
      const where: Prisma.UserWhereInput = {};

      // Apply search filter
      if (filters.search) {
        where.OR = [
          { email: { contains: filters.search, mode: 'insensitive' } },
          { name: { contains: filters.search, mode: 'insensitive' } },
          { phoneNumber: { contains: filters.search } },
          { username: { contains: filters.search, mode: 'insensitive' } },
        ];
      }

      // Apply specific filters
      if (filters.email) {
        where.email = filters.email;
      }

      if (filters.phoneNumber) {
        where.phoneNumber = filters.phoneNumber;
      }

      if (filters.userType) {
        where.userType = filters.userType;
      }

      if (filters.accountStatus) {
        where.accountStatus = filters.accountStatus;
      }

      if (filters.authProvider) {
        where.authProvider = filters.authProvider;
      }

      if (filters.emailVerified !== undefined) {
        where.emailVerified = filters.emailVerified;
      }

      if (filters.phoneNumberVerified !== undefined) {
        where.phoneNumberVerified = filters.phoneNumberVerified;
      }

      if (filters.mfaEnabled !== undefined) {
        where.mfaEnabled = filters.mfaEnabled;
      }

      // Exclude deactivated users by default
      if (filters.excludeDeactivated !== false) {
        where.accountStatus = {
          not: AccountStatus.DELETED,
        };
      }

      // Use the base repository's pagination helper with proper typing
      const result = await this.findManyWithPagination<
        Prisma.UserFindManyArgs,
        Prisma.UserCountArgs
      >(
        (args) => this.prisma.user.findMany(args),
        (args) => this.prisma.user.count(args),
        {
          ...params,
          where,
          orderBy: params.orderBy || { createdAt: 'desc' },
        },
      );

      this.logSuccess('listAdmin', {
        page: params.page,
        pageSize: params.pageSize,
        totalResults: result.total,
      });

      return result;
    } catch (error) {
      throw this.handleError(error, 'listAdmin');
    }
  }

  /**
   * Check if a user exists by ID
   * 
   * @param id - User ID
   * @returns True if user exists
   */
  async exists(id: string): Promise<boolean> {
    try {
      const count = await this.prisma.user.count({
        where: { id },
      });

      const exists = count > 0;
      this.logSuccess('exists', { userId: id, exists });
      return exists;
    } catch (error) {
      throw this.handleError(error, 'exists');
    }
  }

  /**
   * Check if email is already taken
   * 
   * @param email - Email to check
   * @param excludeUserId - Exclude this user ID from check (for updates)
   * @returns True if email is taken
   */
  async isEmailTaken(email: string, excludeUserId?: string): Promise<boolean> {
    try {
      const where: Prisma.UserWhereInput = { email };
      if (excludeUserId) {
        where.NOT = { id: excludeUserId };
      }

      const count = await this.prisma.user.count({ where });
      const taken = count > 0;

      this.logSuccess('isEmailTaken', { email, taken, excludeUserId });
      return taken;
    } catch (error) {
      throw this.handleError(error, 'isEmailTaken');
    }
  }

  /**
   * Check if phone number is already taken
   * 
   * @param phoneNumber - Phone number to check
   * @param excludeUserId - Exclude this user ID from check (for updates)
   * @returns True if phone number is taken
   */
  async isPhoneNumberTaken(phoneNumber: string, excludeUserId?: string): Promise<boolean> {
    try {
      const where: Prisma.UserWhereInput = { phoneNumber };
      if (excludeUserId) {
        where.NOT = { id: excludeUserId };
      }

      const count = await this.prisma.user.count({ where });
      const taken = count > 0;

      this.logSuccess('isPhoneNumberTaken', { phoneNumber, taken, excludeUserId });
      return taken;
    } catch (error) {
      throw this.handleError(error, 'isPhoneNumberTaken');
    }
  }

  /**
   * Update account status with authorization check
   * Users can only update their own account status
   *
   * @param id - User ID
   * @param requestingUserId - ID of the user making the request
   * @param status - New account status
   * @returns Updated user
   * @throws AppError if access denied
   */
  async updateAccountStatus(id: string, requestingUserId: string, status: AccountStatus): Promise<User> {
    try {
      // SECURITY: Users can only update their own account status
      if (id !== requestingUserId) {
        throw new AppError(
          403,
          ErrorCodes.FORBIDDEN,
          'Access denied: Users can only update their own account status',
          true,
        );
      }

      // First get current version for optimistic locking
      const existing = await this.findById(id, requestingUserId);
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'User not found',
          true,
        );
      }

      // Optimistic locking: Update only if version matches + atomically increment version
      const user = await this.prisma.user.update({
        where: {
          id,
          version: existing.version, // Optimistic lock check
        },
        data: {
          accountStatus: status,
          version: { increment: 1 }, // Atomic version increment
        },
      });

      this.logSuccess('updateAccountStatus', { userId: id, requestingUserId, status, oldVersion: existing.version, newVersion: user.version });
      return user;
    } catch (error) {
      throw this.handleError(error, 'updateAccountStatus', { isOptimisticUpdate: true });
    }
  }

  /**
   * Update account status - ADMIN ONLY
   * Allows admin users to update any user's account status
   *
   * @param id - User ID
   * @param status - New account status
   * @returns Updated user
   * @throws AppError if user not found or version conflict
   */
  async updateAccountStatusAdmin(id: string, status: AccountStatus): Promise<User> {
    try {
      // First get current version for optimistic locking
      const existing = await this.findByIdAdmin(id);
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'User not found',
          true,
        );
      }

      // Optimistic locking: Update only if version matches + atomically increment version
      const user = await this.prisma.user.update({
        where: {
          id,
          version: existing.version, // Optimistic lock check
        },
        data: {
          accountStatus: status,
          version: { increment: 1 }, // Atomic version increment
        },
      });

      this.logSuccess('updateAccountStatusAdmin', { userId: id, status, oldVersion: existing.version, newVersion: user.version });
      return user;
    } catch (error) {
      throw this.handleError(error, 'updateAccountStatusAdmin', { isOptimisticUpdate: true });
    }
  }

  /**
   * Update MFA status with authorization check
   * Users can only update their own MFA status
   *
   * @param id - User ID
   * @param requestingUserId - ID of the user making the request
   * @param enabled - MFA enabled status
   * @returns Updated user
   * @throws AppError if access denied, user not found, or version conflict
   */
  async updateMfaStatus(id: string, requestingUserId: string, enabled: boolean): Promise<User> {
    try {
      // SECURITY: Users can only update their own MFA status
      if (id !== requestingUserId) {
        throw new AppError(
          403,
          ErrorCodes.FORBIDDEN,
          'Access denied: Users can only update their own MFA status',
          true,
        );
      }

      // First get current version for optimistic locking
      const existing = await this.findById(id, requestingUserId);
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'User not found',
          true,
        );
      }

      // Optimistic locking: Update only if version matches + atomically increment version
      const user = await this.prisma.user.update({
        where: {
          id,
          version: existing.version, // Optimistic lock check
        },
        data: {
          mfaEnabled: enabled,
          version: { increment: 1 }, // Atomic version increment
        },
      });

      this.logSuccess('updateMfaStatus', { userId: id, requestingUserId, enabled, oldVersion: existing.version, newVersion: user.version });
      return user;
    } catch (error) {
      throw this.handleError(error, 'updateMfaStatus', { isOptimisticUpdate: true });
    }
  }

  /**
   * Update privacy settings with authorization check
   * Users can only update their own privacy settings
   *
   * @param id - User ID
   * @param requestingUserId - ID of the user making the request
   * @param privacySettings - Privacy settings to merge
   * @returns Updated user
   * @throws AppError if access denied, user not found, or version conflict
   */
  async updatePrivacySettings(id: string, requestingUserId: string, privacySettings: Prisma.JsonValue): Promise<User> {
    try {
      // SECURITY: Users can only update their own privacy settings
      if (id !== requestingUserId) {
        throw new AppError(
          403,
          ErrorCodes.FORBIDDEN,
          'Access denied: Users can only update their own privacy settings',
          true,
        );
      }

      // Controllers already validate input - repositories trust validated data

      // Get existing user for version + to merge settings
      const existingUser = await this.findByIdAdmin(id); // Use admin method for internal lookup
      if (!existingUser) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'User not found',
          true,
        );
      }

      // Merge settings
      const mergedSettings = {
        ...(existingUser.privacySettings as object || {}),
        ...(privacySettings as object),
      };

      // Optimistic locking: Update only if version matches + atomically increment version
      const user = await this.prisma.user.update({
        where: {
          id,
          version: existingUser.version, // Optimistic lock check
        },
        data: {
          privacySettings: mergedSettings,
          version: { increment: 1 }, // Atomic version increment
        },
      });

      this.logSuccess('updatePrivacySettings', { userId: id, requestingUserId, oldVersion: existingUser.version, newVersion: user.version });
      return user;
    } catch (error) {
      throw this.handleError(error, 'updatePrivacySettings', { isOptimisticUpdate: true });
    }
  }

  /**
   * Get users by IDs - ADMIN ONLY
   * Useful for fetching multiple users in a single query
   * Only accessible to admin users
   *
   * @param ids - Array of user IDs
   * @returns Array of users
   */
  async findManyByIdsAdmin(ids: string[]): Promise<User[]> {
    try {
      const users = await this.prisma.user.findMany({
        where: {
          id: { in: ids },
        },
      });

      this.logSuccess('findManyByIdsAdmin', {
        requestedCount: ids.length,
        foundCount: users.length,
      });

      return users;
    } catch (error) {
      throw this.handleError(error, 'findManyByIdsAdmin');
    }
  }

  /**
   * Count users by filter criteria - ADMIN ONLY
   * Useful for analytics and reporting
   * Only accessible to admin users
   *
   * @param filters - Filter criteria
   * @returns Count of matching users
   */
  async countAdmin(filters?: UserFilters): Promise<number> {
    try {
      const where: Prisma.UserWhereInput = {};

      if (filters) {
        if (filters.userType) {
          where.userType = filters.userType;
        }

        if (filters.accountStatus) {
          where.accountStatus = filters.accountStatus;
        }

        if (filters.authProvider) {
          where.authProvider = filters.authProvider;
        }

        if (filters.emailVerified !== undefined) {
          where.emailVerified = filters.emailVerified;
        }

        if (filters.phoneNumberVerified !== undefined) {
          where.phoneNumberVerified = filters.phoneNumberVerified;
        }

        if (filters.mfaEnabled !== undefined) {
          where.mfaEnabled = filters.mfaEnabled;
        }

        if (filters.excludeDeactivated !== false) {
          where.accountStatus = {
            not: AccountStatus.DELETED,
          };
        }
      }

      const count = await this.prisma.user.count({ where });

      this.logSuccess('countAdmin', { filters, count });
      return count;
    } catch (error) {
      throw this.handleError(error, 'countAdmin');
    }
  }

  /**
   * Get user statistics with authorization check
   * Users can only get their own statistics
   *
   * @param userId - User ID
   * @param requestingUserId - ID of the user making the request
   * @returns User statistics
   * @throws AppError if access denied
   */
  async getUserStatistics(userId: string, requestingUserId: string): Promise<{
    consumptionCount: number;
    purchaseCount: number;
    productCount: number;
    sessionCount: number;
    journalEntryCount: number;
    goalCount: number;
    achievementCount: number;
    lastConsumption: Date | null;
  }> {
    try {
      // SECURITY: Users can only get their own statistics
      if (userId !== requestingUserId) {
        throw new Error('Access denied: Users can only get their own statistics');
      }

      const [
        consumptionCount,
        purchaseCount,
        productCount,
        sessionCount,
        journalEntryCount,
        goalCount,
        achievementCount,
        lastConsumption,
      ] = await Promise.all([
        this.prisma.consumption.count({ where: { userId } }),
        this.prisma.purchase.count({ where: { userId } }),
        this.prisma.product.count({ where: { userId, deletedAt: null } }),
        this.prisma.consumptionSession.count({ where: { userId } }),
        this.prisma.journalEntry.count({ where: { userId } }),
        this.prisma.goal.count({ where: { userId } }),
        this.prisma.userAchievement.count({ where: { userId } }),
        this.prisma.consumption.findFirst({
          where: { userId },
          orderBy: { timestamp: 'desc' },
          select: { timestamp: true },
        }),
      ]);

      const statistics = {
        consumptionCount,
        purchaseCount,
        productCount,
        sessionCount,
        journalEntryCount,
        goalCount,
        achievementCount,
        lastConsumption: lastConsumption?.timestamp || null,
      };

      this.logSuccess('getUserStatistics', { userId, requestingUserId, statistics });
      return statistics;
    } catch (error) {
      throw this.handleError(error, 'getUserStatistics');
    }
  }

  /**
   * Get user statistics - ADMIN ONLY
   * Allows admin users to get statistics for any user
   *
   * @param userId - User ID
   * @returns User statistics
   */
  async getUserStatisticsAdmin(userId: string): Promise<{
    consumptionCount: number;
    purchaseCount: number;
    productCount: number;
    sessionCount: number;
    journalEntryCount: number;
    goalCount: number;
    achievementCount: number;
    lastConsumption: Date | null;
  }> {
    try {
      const [
        consumptionCount,
        purchaseCount,
        productCount,
        sessionCount,
        journalEntryCount,
        goalCount,
        achievementCount,
        lastConsumption,
      ] = await Promise.all([
        this.prisma.consumption.count({ where: { userId } }),
        this.prisma.purchase.count({ where: { userId } }),
        this.prisma.product.count({ where: { userId, deletedAt: null } }),
        this.prisma.consumptionSession.count({ where: { userId } }),
        this.prisma.journalEntry.count({ where: { userId } }),
        this.prisma.goal.count({ where: { userId } }),
        this.prisma.userAchievement.count({ where: { userId } }),
        this.prisma.consumption.findFirst({
          where: { userId },
          orderBy: { timestamp: 'desc' },
          select: { timestamp: true },
        }),
      ]);

      const statistics = {
        consumptionCount,
        purchaseCount,
        productCount,
        sessionCount,
        journalEntryCount,
        goalCount,
        achievementCount,
        lastConsumption: lastConsumption?.timestamp || null,
      };

      this.logSuccess('getUserStatisticsAdmin', { userId, statistics });
      return statistics;
    } catch (error) {
      throw this.handleError(error, 'getUserStatisticsAdmin');
    }
  }

  /**
   * Batch update multiple users - ADMIN ONLY
   * Used for administrative bulk operations
   * Only accessible to admin users
   *
   * @param updates - Array of updates with user IDs and data
   * @returns Number of users updated
   */
  async batchUpdateAdmin(
    updates: Array<{ id: string; data: UpdateUserInput }>,
  ): Promise<number> {
    try {
      // Use transaction for atomicity
      const result = await this.executeTransaction(async (tx) => {
        let updateCount = 0;

        for (const update of updates) {
          // Controllers already validate input - repositories trust validated data

          await tx.user.update({
            where: { id: update.id },
            data: update.data,
          });

          updateCount++;
        }

        return updateCount;
      });

      this.logSuccess('batchUpdateAdmin', {
        updateCount: result,
        userIds: updates.map(u => u.id),
      });

      return result;
    } catch (error) {
      throw this.handleError(error, 'batchUpdateAdmin');
    }
  }

  /**
   * Override supportsSoftDelete to indicate User entity uses soft delete
   * Users have an accountStatus field that can be set to DELETED
   *
   * @returns True as User supports soft delete via accountStatus
   */
  protected override supportsSoftDelete(): boolean {
    return true; // User entity uses accountStatus for soft delete
  }

  /**
   * Build WHERE clause for User queries
   * Automatically excludes deactivated users unless explicitly included
   * 
   * @param where - Original where clause
   * @param includeDeactivated - Whether to include deactivated users
   * @returns Modified where clause
   */
  protected buildUserWhereClause(
    where: Prisma.UserWhereInput = {},
    includeDeactivated: boolean = false,
  ): Prisma.UserWhereInput {
    if (!includeDeactivated) {
      return {
        ...where,
        accountStatus: {
          not: AccountStatus.DELETED,
        },
      };
    }
    return where;
  }
}
