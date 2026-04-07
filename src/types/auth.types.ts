/**
 * Authentication types and interfaces for the AppPlatform application
 * Supports JWT token validation and AWS Cognito integration
 */

/**
 * JWT token payload structure
 * Contains standard JWT claims and custom AppPlatform user data
 */
export interface JWTPayload {
  /** User ID (subject) */
  sub: string;
  /** Token issuer */
  iss?: string;
  /** Token audience */
  aud?: string | string[];
  /** Issued at timestamp */
  iat?: number;
  /** Expiration timestamp */
  exp?: number;
  /** Email address */
  email?: string;
  /** Email verification status */
  email_verified?: boolean;
  /** Username */
  username?: string;
  /** Cognito groups */
  'cognito:groups'?: string[];
  /** Custom user roles */
  roles?: string[];
  /** Custom permissions */
  permissions?: string[];
  /** User type */
  userType?: string;
}

export interface UserContext {
  id: string;
  email?: string;
  emailVerified?: boolean;
  username?: string;
  groups?: string[];
  roles?: string[];
  permissions?: string[];
  userType?: string; // User type (e.g., 'ADMIN', 'USER', 'PREMIUM')
  isAuthenticated: boolean;
  tokenType?: 'cognito';
  expiresAt?: Date;
}

export interface AuthToken {
  token: string;
  type: 'Bearer' | 'JWT';
  payload?: JWTPayload;
}

export interface TokenValidationResult {
  isValid: boolean;
  user?: UserContext;
  error?: string;
  expiresAt?: Date;
}

export interface AuthenticationConfig {
  cognitoUserPoolId?: string;
  cognitoClientId?: string;
  cognitoRegion?: string;
  tokenExpirationBuffer?: number; // seconds before expiration to consider token invalid
  jwtSecret?: string; // JWT secret for WebSocket authentication
}

export interface AuthenticationError extends Error {
  code: 'INVALID_TOKEN' | 'EXPIRED_TOKEN' | 'MISSING_TOKEN' | 'MALFORMED_TOKEN' | 'UNAUTHORIZED';
  statusCode: number;
}

// Note: Express Request interface extensions are now handled in express.d.ts
// to avoid conflicts with the new typed request system


/**
 * Token refresh response structure
 */
export interface RefreshTokenResponse {
  /** Access token for API requests */
  accessToken: string;
  /** ID token containing user claims */
  idToken: string;
  /** Refresh token for obtaining new access tokens */
  refreshToken: string;
  /** Token expiration time in seconds */
  expiresIn: number;
  /** Token type (usually 'Bearer') */
  tokenType: string;
}

export interface AuthenticationService {
  validateToken(token: string): Promise<TokenValidationResult>;
  extractUserContext(token: string): Promise<UserContext | null>;
  refreshToken?(refreshToken: string): Promise<RefreshTokenResponse>;
}