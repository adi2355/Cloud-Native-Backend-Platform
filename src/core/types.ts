/**
 * Shared Type Definitions
 *
 * Central location for shared types used across the AppPlatform backend modules.
 * This prevents duplication and ensures consistency across the codebase.
 *
 * @module core/types
 */

import type { AppConfig } from '../config';

/**
 * Application configuration type
 *
 *
 * This is an alias to AppConfig, which is derived from AppConfigSchema (Zod)
 * in ConfigSecurityService. The type chain is:
 *
 * 1. AppConfigSchema (Zod) in ConfigSecurityService - SOURCE OF TRUTH
 * 2. export type AppConfig = z.infer<typeof AppConfigSchema> - DERIVED TYPE
 * 3. Re-exported from config/index.ts for convenience
 * 4. Aliased here as Config for backward compatibility
 *
 * To modify configuration structure:
 * - Edit AppConfigSchema in src/services/configSecurity.service.ts
 * - Type propagates automatically: Schema → AppConfig → Config
 *
 * This ensures:
 * - Type definitions always match runtime validation
 * - No duplication between types and validation
 * - Single source of truth for configuration
 *
 * @see {@link AppConfig} in ../config/index.ts
 * @see {@link ConfigSecurityService} for the Zod schema definition
 */
export type Config = AppConfig;

// AuthenticationConfig is imported from auth.types.ts to avoid duplication

/**
 * Service initialization status
 */
export interface ServiceStatus {
  name: string;
  initialized: boolean;
  error?: Error;
  dependencies?: string[];
}

/**
 * Dependency injection container interface
 */
export interface ServiceContainer {
  register<T>(name: string, factory: () => T | Promise<T>): void;
  get<T>(name: string): T;
  has(name: string): boolean;
  initialize(): Promise<void>;
}

// Type exports are already provided above via export interface
// No default export needed for TypeScript type definitions