/**
 * Type Guards for Runtime Type Safety
 * Provides runtime validation for optional services and dependencies
 *
 * This module ensures type safety at runtime for optional services
 * and provides safe access patterns for nullable dependencies.
 */

import type { InitializedServices } from '../bootstrap';
import type { AnyController } from './controller.types';


/**
 * Check if S3 service is available and initialized
 */
export function isS3ServiceAvailable(
  services: InitializedServices,
): services is InitializedServices & { s3Service: NonNullable<InitializedServices['s3Service']> } {
  return services.s3Service !== null &&
         services.s3Service !== undefined &&
         typeof services.s3Service === 'object';
}


/**
 * Validate controller instance has proper structure
 * Performs comprehensive runtime checks to ensure controller validity
 *
 * A valid controller must:
 * - Be a non-null object
 * - Have a constructor function
 * - Optionally have an initialize method (if present, must be a function)
 *
 * @param controller - Unknown value to validate
 * @returns Type predicate indicating if controller is valid
 */
export function isValidController(controller: unknown): controller is AnyController {
  // Null/undefined check
  if (controller === null || controller === undefined) {
    return false;
  }

  // Must be an object
  if (typeof controller !== 'object') {
    return false;
  }

  // Must have a constructor (all objects do, but being explicit)
  if (!('constructor' in controller) || typeof controller.constructor !== 'function') {
    return false;
  }

  // If initialize exists, it must be a function (optional method)
  if ('initialize' in controller && typeof (controller as Record<string, unknown>).initialize !== 'function') {
    return false;
  }

  // All checks passed
  return true;
}

/**
 * Assert required service is available (throws if not)
 */
export function assertServiceAvailable<K extends keyof InitializedServices>(
  services: InitializedServices,
  serviceName: K,
  operationName: string,
): asserts services is InitializedServices & { [P in K]: NonNullable<InitializedServices[P]> } {
  const service = services[serviceName];
  if (service === null || service === undefined) {
    throw new Error(`${operationName} requires ${String(serviceName)} but service is not available`);
  }
}

/**
 * Safe service access with fallback
 */
export function withServiceSafety<T, R>(
  service: T | null | undefined,
  operation: (service: T) => R,
  fallback: R,
): R {
  if (service === null || service === undefined) {
    return fallback;
  }
  try {
    return operation(service);
  } catch {
    return fallback;
  }
}

/**
 * Type guard for checking if a service is a function
 */
export function isServiceFunction(fn: unknown): fn is Function {
  return typeof fn === 'function';
}

/**
 * Type guard for checking if an object has a specific method
 */
export function hasMethod<T extends string>(
  obj: unknown,
  methodName: T,
): obj is Record<T, Function> {
  return obj !== null &&
         obj !== undefined &&
         typeof obj === 'object' &&
         methodName in obj &&
         typeof (obj as Record<string, unknown>)[methodName] === 'function';
}

/**
 * Convert null to undefined for service compatibility
 * This is needed because our interface uses null for clarity,
 * but services expect undefined for optional parameters
 */
export function nullToUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}