/**
 * Server-Time Header Middleware
 *
 * BACKEND FIX #5: Server-Time Header for Clock Offset Calculation
 *
 * Adds a `Server-Time` header to all HTTP responses containing the server's
 * current UTC timestamp in ISO 8601 format. This enables frontend clients to:
 *
 * 1. Calculate clock offset: `serverTime - clientTime`
 * 2. Correct optimistic timestamps for accurate ordering
 * 3. Handle "just now" labels correctly
 * 4. Prevent stale update detection issues
 *
 * Header Format:
 * ```
 * Server-Time: 2025-01-15T10:30:45.123Z
 * ```
 *
 * Frontend Usage (already implemented in BackendAPIClient):
 * ```typescript
 * const serverTime = new Date(response.headers.get('Server-Time')).getTime();
 * const clientTime = Date.now();
 * const offset = serverTime - clientTime; // Store and apply to future timestamps
 * ```
 *
 * Performance: ~0.1ms overhead per request (negligible)
 */

import { Request, Response, NextFunction } from 'express';

/**
 * Add Server-Time header to all responses
 *
 * BACKEND FIX #5: Enables frontend clock offset calculation
 *
 * @param req - Express request
 * @param res - Express response
 * @param next - Next middleware
 */
export function serverTimeMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Capture server time at the start of request processing
  const serverTime = new Date().toISOString();

  // Set Server-Time header
  res.setHeader('Server-Time', serverTime);

  // Continue to next middleware
  next();
}
