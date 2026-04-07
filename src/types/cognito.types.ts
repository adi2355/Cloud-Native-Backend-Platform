/**
 * AWS Cognito Type Definitions for Backend Services
 * 
 * This file contains all TypeScript interfaces and types needed for
 * AWS Cognito integration in the backend services.
 */

export interface CognitoConfig {
  userPoolId: string;
  clientId: string;
  region: string;
}

export interface CognitoTokenValidationResult {
  isValid: boolean;
  payload?: CognitoJWTPayload;
  user?: CognitoUser;
  error?: string;
  errorCode?: string;
}

export interface CognitoUser {
  id: string;
  username: string;
  email?: string;
  emailVerified?: boolean;
  phoneNumber?: string;
  phoneNumberVerified?: boolean;
  name?: string;
  groups?: string[];
  attributes?: Record<string, string>;
  enabled?: boolean;
  status?: string;
}

export interface CognitoGroupInfo {
  groupName: string;
  description?: string;
  precedence?: number;
  roleArn?: string;
}

export interface CognitoError {
  name: string;
  message: string;
  code: string;
  statusCode?: number;
  retryable?: boolean;
}

export interface CognitoRefreshTokenResult {
  accessToken: string;
  idToken: string;
  expiresAt: number;
}

export interface CognitoService {
  validateToken(token: string): Promise<CognitoTokenValidationResult>;
  getUserInfo(accessToken: string): Promise<CognitoUser>;
  getUserGroups(username: string): Promise<CognitoGroupInfo[]>;
  refreshToken(refreshToken: string): Promise<CognitoRefreshTokenResult>;
  revokeToken(token: string): Promise<void>;
}

// JWT Token payload structure from Cognito
export interface CognitoJWTPayload {
  sub: string;
  'cognito:username': string;
  'cognito:groups'?: string[];
  email?: string;
  email_verified?: boolean;
  phone_number?: string;
  phone_number_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  aud: string;
  iss: string;
  iat: number;
  exp: number;
  token_use: 'id' | 'access';
  auth_time?: number;
  [key: string]: unknown; // Allow custom claims with unknown type
}

// User context for request processing
export interface UserContext {
  userId: string;
  username: string;
  email?: string;
  groups: string[];
  roles: string[];
  permissions: string[];
  tokenPayload: CognitoJWTPayload;
}

// Authentication middleware types
export interface AuthenticatedRequest extends Request {
  user?: UserContext;
  token?: string;
}

export interface AuthMiddlewareOptions {
  required?: boolean;
  roles?: string[];
  permissions?: string[];
}

// Error types for authentication
export enum CognitoErrorCode {
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  TOKEN_INVALID = 'TOKEN_INVALID',
  TOKEN_MALFORMED = 'TOKEN_MALFORMED',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  ACCESS_DENIED = 'ACCESS_DENIED',
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
  SERVICE_ERROR = 'SERVICE_ERROR',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR'
}

// Token validation options
export interface TokenValidationOptions {
  audience?: string;
  issuer?: string;
  clockTolerance?: number;
  maxAge?: number;
}