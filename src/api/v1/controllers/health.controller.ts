/**
 * Health Samples Controller
 * Handles HTTP requests for health data uploads from HealthKit/Health Connect
 *
 * ARCHITECTURE:
 * - Push-only sync (device → server, no pull)
 * - Two-layer idempotency: requestId + (userId, sourceId, sourceRecordId)
 * - Partial success handling (some samples may fail while others succeed)
 *
 * - This is SEPARATE from entity sync (uses HealthSampleRepository, not OutboxRepository)
 * - No compaction (all samples are retained indefinitely)
 *
 * @see HEALTHKITPLANFINAL.md for architectural decisions
 */

import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../../types/authenticated-request.types';
import { getUserId, getCorrelationId, getDeviceId } from '../../../utils/auth-guards';
import { HealthSampleService } from '../../../services/healthSample.service';
import { HealthIngestQueueService } from '../../../services/healthIngestQueue.service';
import { LoggerService } from '../../../services/logger.service';
import { AppError, ErrorCodes } from '../../../utils/AppError';
import { getErrorMessage, getErrorStack } from '../../../utils/error-handler';
import type { BatchUpsertSamplesRequest, HealthMetricCode } from '@shared/contracts';
import {
  decodeHealthSampleCursor,
  CursorCodecError,
  GetSamplesQuerySchema,
  GetSamplesCursorQuerySchema,
  toHealthSampleResponseDto,
  filterValidMetricCodes,
  GetRollupsQuerySchema,
  GetSleepSummariesQuerySchema,
  GetSessionImpactQuerySchema,
  GetRecentSessionImpactQuerySchema,
  GetProductImpactQuerySchema,
  GetInsightsQuerySchema,
} from '@shared/contracts';
import { HealthProjectionReadService } from '../../../services/health-projection-read.service';

/**
 * Health Samples Controller
 * Handles batch upload of health samples with idempotency
 */
export class HealthController {
  private initialized: boolean = false;

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private healthSampleService: HealthSampleService,
    private healthIngestQueueService: HealthIngestQueueService,
    private logger: LoggerService,
    private healthProjectionReadService: HealthProjectionReadService,
  ) {
    if (!healthSampleService || !healthIngestQueueService || !logger || !healthProjectionReadService) {
      throw new Error('HealthController: All dependencies (HealthSampleService, HealthIngestQueueService, LoggerService, HealthProjectionReadService) must be provided');
    }
    this.initialized = true;
  }

  /**
   * Batch upsert health samples
   * POST /api/v1/health/samples/batch-upsert
   *
   * Two-layer idempotency:
   * 1. requestId + payloadHash: Request-level idempotency (handled atomically by service)
   * 2. (userId, sourceId, sourceRecordId): Sample-level deduplication
   *
   * ARCHITECTURE:
   * - Validation is handled by middleware (validateBody with BatchUpsertSamplesRequestSchema)
   * - Idempotency is handled atomically by service.batchUpsertWithIdempotency()
   * - Controller is thin: extract params, call service, format response
   *
   *
   * @returns Partial success response with accepted/rejected samples per BatchUpsertSamplesResponseSchema
   */
  public async batchUpsertSamples(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      const userId = getUserId(req);
      const correlationId = getCorrelationId(req);
      // Device ID is extracted by requireDeviceId middleware and available on req.deviceId
      // This is used for audit trail and debugging device-specific issues
      const deviceId = getDeviceId(req);
      const contentEncodingHeader = req.headers['content-encoding'];
      const contentEncoding = Array.isArray(contentEncodingHeader)
        ? contentEncodingHeader[0]
        : contentEncodingHeader;
      const normalizedEncoding = contentEncoding ? String(contentEncoding).toLowerCase() : 'identity';

      if (normalizedEncoding !== 'identity' && normalizedEncoding !== 'gzip') {
        throw new AppError(
          415,
          ErrorCodes.INVALID_INPUT,
          `Unsupported Content-Encoding: ${normalizedEncoding}`,
          true,
          { supportedEncodings: ['identity', 'gzip'] }
        );
      }

      // CHAOS TESTING: Optional delay to simulate slow DB/processing.
      // Guarded by feature flag to avoid any production impact.
      if (process.env.FF_HEALTH_CHAOS === 'true') {
        const delayHeader = req.headers['x-chaos-delay-ms'];
        const delayValue = Array.isArray(delayHeader) ? delayHeader[0] : delayHeader;
        const delayMs = delayValue ? Number(delayValue) : 0;
        if (Number.isFinite(delayMs) && delayMs > 0) {
          const clampedMs = Math.min(delayMs, 10_000);
          this.logger.warn('Applying chaos delay for health upload', {
            context: 'HealthController.batchUpsertSamples',
            userId,
            delayMs: clampedMs,
          });
          await new Promise((resolve) => setTimeout(resolve, clampedMs));
        }
      }

      // Request body is already validated by middleware (validateBody with BatchUpsertSamplesRequestSchema)
      const request = req.body as BatchUpsertSamplesRequest;
      const contentLengthHeader = req.headers['content-length'];
      const parsedContentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
      const contentLengthBytes = Number.isFinite(parsedContentLength)
        ? parsedContentLength
        : undefined;
      const rawBody = (req as { rawBody?: Buffer }).rawBody;
      const uncompressedBytes = rawBody ? rawBody.length : JSON.stringify(request).length;

      // Extract deletions from request (optional, defaults to empty array per contract)
      const deletions = request.deleted || [];

      // P0-E: Extract timezone offset from header for correct local date computation
      // Header value is minutes from UTC (negative = west of UTC, e.g., -300 for EST)
      // Falls back to undefined which service layer handles per-metric:
      //   - Sleep metrics: rejected with TIMEZONE_REQUIRED (unless per-sample TZ is provided)
      //   - Other metrics: defaulted to 0 (UTC) for backward compatibility
      //
      // GAP B FIX: Validate range (-720 to +840), integer, and finite.
      // Previously accepted any numeric value including Infinity, NaN edge cases.
      const timezoneOffsetHeader = req.headers['x-timezone-offset'];
      const timezoneOffsetStr = Array.isArray(timezoneOffsetHeader)
        ? timezoneOffsetHeader[0]
        : timezoneOffsetHeader;
      let timezoneOffsetMinutes: number | undefined;
      if (timezoneOffsetStr) {
        const parsed = Number(timezoneOffsetStr);
        if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= -720 && parsed <= 840) {
          timezoneOffsetMinutes = parsed;
        } else if (!isNaN(parsed)) {
          // Value is a number but outside valid range or not an integer — log and reject
          this.logger.warn('X-Timezone-Offset header out of valid range, ignoring', {
            context: 'HealthController.batchUpsertSamples',
            rawValue: timezoneOffsetStr,
            parsed,
            validRange: '[-720, 840]',
            userId,
          });
        }
        // If NaN (non-numeric string): silently ignore (undefined)
      }

      const queueDecision = await this.healthIngestQueueService.maybeQueueBatch({
        userId,
        requestId: request.requestId,
        payloadHash: request.payloadHash,
        samples: request.samples,
        deletions,
        correlationId,
        deviceId,
        // Propagate request-level timezone so queued batches retain
        // the X-Timezone-Offset header context for correct date bucketing
        timezoneOffsetMinutes,
      });

      if (queueDecision.action === 'CACHED') {
        const cachedResult = queueDecision.result;
        const cachedFailures = (cachedResult.failed?.length ?? 0) + (cachedResult.deletions?.failed?.length ?? 0);

        res.status(cachedFailures > 0 ? 207 : 200).json({
          success: true,
          data: cachedResult,
          metadata: {
            requestId: request.requestId,
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      if (queueDecision.action === 'QUEUED') {
        res.status(202).json({
          success: true,
          data: {
            processing: true,
            retryAfterMs: queueDecision.retryAfterMs,
          },
          metadata: {
            requestId: request.requestId,
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      this.logger.info('Processing batch upsert request', {
        context: 'HealthController.batchUpsertSamples',
        userId,
        correlationId,
        deviceId, // Include device ID for audit trail
        requestId: request.requestId,
        sampleCount: request.samples.length,
        deletionCount: deletions.length,
      });

      // The service.batchUpsertSamples() calls repository.batchUpsertWithIdempotency()
      // which handles idempotency ATOMICALLY using HealthIngestRequest table.
      //
      // DO NOT add a TOCTOU check here (isRequestProcessed → batchUpsertSamples).
      // That pattern creates a race condition where:
      // 1. Thread A checks: isRequestProcessed() → false
      // 2. Thread B checks: isRequestProcessed() → false
      // 3. Thread A starts processing
      // 4. Thread B starts processing (DUPLICATE!)
      //
      // The repository uses a single transaction with INSERT ON CONFLICT to prevent this.
      //
      // STOP-SHIP #1 FIX:
      // Deletions are now passed to the service and processed INSIDE the idempotency boundary.
      // The cached responseJson includes both sample results AND deletion results.
      // This ensures that retries with the same requestId return identical responses,
      // including deletion results (not just sample results).
      //
      // TRUST BOUNDARY: The payloadHash has been validated by middleware
      // (validateBatchUpsertRequestWithHash in createBatchUpsertValidationMiddleware).
      // The middleware verifies that the hash matches the samples AND deletions using the
      // canonical computeBatchPayloadHash() function from @shared/health-config/payload-hash.ts.
      // We pass it through to the service/repository stack without recomputation.
      const result = await this.healthSampleService.batchUpsertSamples(
        userId,
        request.samples,
        request.requestId,
        request.payloadHash, // Pre-validated by middleware - DO NOT recompute
        correlationId,
        deviceId, // Pass device ID to service for audit
        deletions.length > 0 ? deletions : undefined, // STOP-SHIP #1 FIX: Pass deletions for unified idempotency
        {
          requestMeta: {
            contentEncoding: normalizedEncoding,
            contentLengthBytes,
            uncompressedBytes,
          },
          // P0-E: Pass timezone offset for correct local date computation in event payload
          timezoneOffsetMinutes,
        }
      );

      const durationMs = Date.now() - startTime;

      // Log with idempotency status from service
      // STOP-SHIP #1 FIX: Deletion results are now included in the unified result
      this.logger.info('Batch upsert complete', {
        context: 'HealthController.batchUpsertSamples',
        userId,
        correlationId,
        deviceId,
        requestId: request.requestId,
        idempotencyStatus: result.idempotencyStatus,
        successfulCount: result.successful.length,
        failedCount: result.failed.length,
        deletedCount: result.metrics.deletedCount ?? 0,
        hasDeletions: !!result.deletions,
        durationMs,
      });

      // Build response conforming to BatchUpsertSamplesResponseSchema.strict()
      // STOP-SHIP #1 FIX: Response now includes deletion results from the unified
      // idempotency-cached result. This ensures retries return identical responses.
      const deletionFailures = result.deletions?.failed.length ?? 0;
      const hasFailures = result.failed.length > 0 || deletionFailures > 0;

      // Build metrics - include deletedCount if deletions were processed
      const metrics: Record<string, number> = {
        totalReceived: request.samples.length,
        successfulCount: result.successful.length,
        failedCount: result.failed.length,
        durationMs,
      };
      if (result.deletions) {
        metrics.deletedCount = result.metrics.deletedCount ?? 0;
      }

      // Build data object - include deletions only if result has deletion data
      // STOP-SHIP #1 FIX: Deletions come from the unified result (idempotency-cached)
      const data: Record<string, unknown> = {
        successful: result.successful,
        failed: result.failed,
        metrics,
      };
      if (result.deletions) {
        // Map deletion results to contract shape (SuccessfulDeletionResultSchema.strict()).
        // Repository returns extra fields (endAt, metricCode, timezoneOffsetMin) for
        // internal projection targeting (P0-G FIX), but these MUST be stripped before
        // serialization to comply with the strict schema contract.
        data.deletions = {
          successful: result.deletions.successful.map(d => ({
            sourceId: d.sourceId,
            sourceRecordId: d.sourceRecordId,
            ...(d.startAt !== undefined && { startAt: d.startAt }),
            ...(d.alreadyDeleted !== undefined && { alreadyDeleted: d.alreadyDeleted }),
          })),
          failed: result.deletions.failed,
        };
      }

      res.status(hasFailures ? 207 : 200).json({
        success: true,
        data,
        metadata: {
          requestId: request.requestId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      this.logger.error('Failed to process batch upsert', {
        context: 'HealthController.batchUpsertSamples',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get health samples for a user
   * GET /api/v1/health/samples
   *
   * STOP-SHIP #4 FIX: Now uses shared GetSamplesQuerySchema for validation.
   * STOP-SHIP #5 FIX: Now uses toHealthSampleResponseDto for proper DTO mapping.
   *
   * Query parameters:
   * - startTime: ISO timestamp for range start (required with endTime, or both omitted)
   * - endTime: ISO timestamp for range end (required with startTime, or both omitted)
   * - metricCode: Optional filter by metric type (validated against registry)
   * - page: Page number (default: 1)
   * - pageSize: Items per page (default: 100, max: 500)
   *
   * DEFAULT BEHAVIOR (when times omitted):
   * - Server applies last 24 hours as default range
   */
  public async getSamples(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = getCorrelationId(req);

      // STOP-SHIP #4 FIX: Validate query parameters using shared schema
      // This ensures consistent validation between frontend and backend,
      // and enforces the "both-or-none" rule for startTime/endTime.
      const parseResult = GetSamplesQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        throw new AppError(
          400,
          ErrorCodes.INVALID_INPUT,
          `Invalid query parameters: ${parseResult.error.message}`,
          true,
          { errors: parseResult.error.errors }
        );
      }

      const validatedQuery = parseResult.data;

      // Apply server defaults when both times are omitted (valid per schema)
      const now = new Date();
      const startTime = validatedQuery.startTime
        ? new Date(validatedQuery.startTime)
        : new Date(now.getTime() - 24 * 60 * 60 * 1000); // Default: last 24 hours
      const endTime = validatedQuery.endTime
        ? new Date(validatedQuery.endTime)
        : now;

      this.logger.debug('Querying health samples', {
        context: 'HealthController.getSamples',
        userId,
        correlationId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        metricCode: validatedQuery.metricCode,
        page: validatedQuery.page,
        pageSize: validatedQuery.pageSize,
        usingDefaults: !validatedQuery.startTime,
      });

      const result = await this.healthSampleService.getSamples(
        userId,
        startTime,
        endTime,
        validatedQuery.metricCode,
        { page: validatedQuery.page, pageSize: validatedQuery.pageSize },
      );

      // DEPRECATION: Offset pagination has O(n) performance degradation at scale.
      // Add deprecation headers to encourage migration to cursor-based pagination.
      // RFC 8594 Sunset header indicates when this endpoint may be removed.
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', 'Sat, 01 Mar 2025 00:00:00 GMT');
      res.setHeader('Link', '</api/v1/health/samples/cursor>; rel="successor-version"');

      // STOP-SHIP #5 FIX: Convert items to DTOs with proper Decimal → number
      // This ensures `value` is serialized as a number (not a Decimal string)
      // and excludes internal fields (requestId, uploadedAt, isDeleted, deletedAt).
      const items = result.items.map(sample => toHealthSampleResponseDto(sample));

      res.status(200).json({
        success: true,
        data: {
          items,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          hasMore: result.hasMore,
          totalPages: result.totalPages,
        },
        metadata: {
          timestamp: new Date().toISOString(),
          correlationId,
        },
      });
    } catch (error) {
      this.logger.error('Failed to get health samples', {
        context: 'HealthController.getSamples',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get health samples with cursor-based (keyset) pagination.
   * GET /api/v1/health/samples/cursor
   *
   * STOP-SHIP #4 FIX: Now uses shared GetSamplesCursorQuerySchema for validation.
   * STOP-SHIP #5 FIX: Now uses toHealthSampleResponseDto for proper DTO mapping.
   *
   * PERFORMANCE:
   * - O(log n) via B-tree index traversal regardless of page depth
   * - No COUNT(*) query (uses limit+1 technique for hasMore detection)
   *
   * Query parameters:
   * - startTime: ISO timestamp for range start (REQUIRED)
   * - endTime: ISO timestamp for range end (REQUIRED)
   * - metricCode: Optional filter by metric type (validated against registry)
   * - limit: Items per page (default: 100, max: 500)
   * - cursor: Base64url-encoded cursor from previous page (optional for first page)
   *
   * CURSOR FORMAT:
   * - Base64url-encoded JSON: { s: startAt, i: id }
   * - Decoded and validated before use
   * - Invalid cursor returns 400 Bad Request (fail-fast)
   */
  public async getSamplesCursor(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = getCorrelationId(req);

      // STOP-SHIP #4 FIX: Validate query parameters using shared schema
      const parseResult = GetSamplesCursorQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        throw new AppError(
          400,
          ErrorCodes.INVALID_INPUT,
          `Invalid query parameters: ${parseResult.error.message}`,
          true,
          { errors: parseResult.error.errors }
        );
      }

      const validatedQuery = parseResult.data;
      const startTime = new Date(validatedQuery.startTime);
      const endTime = new Date(validatedQuery.endTime);

      // Decode cursor if provided (fail-fast on invalid cursor)
      let cursor = undefined;
      if (validatedQuery.cursor) {
        try {
          cursor = decodeHealthSampleCursor(validatedQuery.cursor);
        } catch (error) {
          if (error instanceof CursorCodecError) {
            // FAIL-FAST: Return 400 Bad Request for invalid cursor
            this.logger.warn('Invalid cursor in request', {
              context: 'HealthController.getSamplesCursor',
              userId,
              correlationId,
              errorCode: error.code,
              errorMessage: error.message,
            });

            res.status(400).json({
              success: false,
              error: error.message,
              code: error.code,
              metadata: {
                timestamp: new Date().toISOString(),
                correlationId,
              },
            });
            return;
          }
          throw error;
        }
      }

      this.logger.debug('Querying health samples with cursor pagination', {
        context: 'HealthController.getSamplesCursor',
        userId,
        correlationId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        metricCode: validatedQuery.metricCode,
        limit: validatedQuery.limit,
        hasCursor: !!cursor,
      });

      const result = await this.healthSampleService.getSamplesCursor(
        userId,
        startTime,
        endTime,
        validatedQuery.limit,
        cursor,
        validatedQuery.metricCode,
      );

      // STOP-SHIP #5 FIX: Convert items to DTOs with proper Decimal → number
      const items = result.items.map(sample => toHealthSampleResponseDto(sample));

      // Response conforms to GetSamplesCursorResponseSchema
      res.status(200).json({
        success: true,
        data: {
          items,
          pagination: result.pagination,
        },
        metadata: {
          timestamp: new Date().toISOString(),
          correlationId,
        },
      });
    } catch (error) {
      this.logger.error('Failed to get health samples with cursor pagination', {
        context: 'HealthController.getSamplesCursor',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get distinct metric codes for a user
   * GET /api/v1/health/metrics
   *
   * STOP-SHIP #6 FIX: Now filters codes against the registry for API stability.
   *
   * SEMANTICS: Returns codes from the HEALTH_METRIC_CODES registry for which
   * the user has at least one active (non-deleted) sample. Invalid/legacy codes
   * that may exist in the database are filtered out.
   */
  public async getMetricCodes(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = getCorrelationId(req);

      const rawMetricCodes = await this.healthSampleService.getDistinctMetricCodes(userId);

      // STOP-SHIP #6 FIX: Filter codes against the registry
      // This ensures only valid registry codes are returned, filtering out any
      // invalid/legacy codes that may exist in the database.
      const validMetricCodes = filterValidMetricCodes(rawMetricCodes);

      // Log if any codes were filtered out (indicates data quality issue)
      const filteredCount = rawMetricCodes.length - validMetricCodes.length;
      if (filteredCount > 0) {
        this.logger.warn('Filtered invalid metric codes from response', {
          context: 'HealthController.getMetricCodes',
          userId,
          correlationId,
          totalCodes: rawMetricCodes.length,
          validCodes: validMetricCodes.length,
          filteredCodes: rawMetricCodes.filter(
            code => !validMetricCodes.includes(code as HealthMetricCode)
          ),
        });
      }

      res.status(200).json({
        success: true,
        data: {
          metricCodes: validMetricCodes,
        },
        metadata: {
          timestamp: new Date().toISOString(),
          correlationId,
        },
      });
    } catch (error) {
      this.logger.error('Failed to get metric codes', {
        context: 'HealthController.getMetricCodes',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  // Projection Latency Instrumentation

  /**
   * P99 latency targets (ms) per projection endpoint.
   * Source: internal design spec § PERFORMANCE BUDGETS.
   *
   * Exceeding these triggers a warning log with structured fields for
   * alerting pipelines to consume.
   */
  private static readonly P99_TARGETS_MS: Record<string, number> = {
    'health.rollups': 100,
    'health.sleep': 100,
    'health.session-impact': 50,
    'health.session-impact.recent': 50,
    'health.product-impact': 100,
    'health.insights': 120,
  };

  /**
   * Measure and log a projection query's latency, item count, and summary state.
   *
   * PURE INSTRUMENTATION: no side effects beyond logging.
   *
   * @param endpointLabel - Dot-delimited endpoint label (e.g. 'health.rollups')
   * @param correlationId - Request correlation ID for trace linking
   * @param userId - User ID for scoping
   * @param fn - Async function that performs the actual query
   * @returns The query result, unmodified
   */
  private async measureProjectionQuery<T extends { summary: { state: string; totalItems: number; statusCounts: Record<string, number> } }>(
    endpointLabel: string,
    correlationId: string | undefined,
    userId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startMs = performance.now();
    const result = await fn();
    const durationMs = Math.round((performance.now() - startMs) * 100) / 100;

    const p99Target = HealthController.P99_TARGETS_MS[endpointLabel];
    const exceeded = p99Target != null && durationMs > p99Target;

    const logPayload = {
      context: `HealthController.${endpointLabel}`,
      correlationId,
      userId,
      durationMs,
      itemCount: result.summary.totalItems,
      summaryState: result.summary.state,
      statusCounts: result.summary.statusCounts,
      ...(p99Target != null ? { p99TargetMs: p99Target, p99Exceeded: exceeded } : {}),
    };

    if (exceeded) {
      this.logger.warn('Projection query exceeded P99 target', logPayload);
    } else {
      this.logger.info('Projection query completed', logPayload);
    }

    return result;
  }

  /**
   * Get daily health rollups for a user/metric.
   * GET /api/v1/health/rollups
   *
   * Query parameters (validated by GetRollupsQuerySchema):
   * - metricCode: Metric code to query
   * - startDate: Start date (YYYY-MM-DD, inclusive)
   * - endDate: End date (YYYY-MM-DD, inclusive, max 365 day range)
   * - cursor: Optional opaque cursor for keyset pagination
   * - limit: Optional page size (default 500, max 1000)
   */
  public async getRollups(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = getCorrelationId(req);

      const parseResult = GetRollupsQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        throw new AppError(
          400,
          ErrorCodes.INVALID_INPUT,
          `Invalid query parameters: ${parseResult.error.message}`,
          true,
          { errors: parseResult.error.errors }
        );
      }

      const { metricCode, startDate, endDate, cursor, limit } = parseResult.data;

      this.logger.debug('Querying health rollups', {
        context: 'HealthController.getRollups',
        userId,
        correlationId,
        metricCode,
        startDate,
        endDate,
        hasCursor: cursor != null,
        limit,
      });

      const result = await this.measureProjectionQuery(
        'health.rollups', correlationId, userId,
        () => this.healthProjectionReadService.getRollups(
          userId, metricCode, startDate, endDate, cursor, limit,
        ),
      );

      res.status(200).json({
        success: true,
        data: {
          items: result.items,
          summary: result.summary,
          ...('pagination' in result ? { pagination: result.pagination } : {}),
        },
        metadata: {
          timestamp: new Date().toISOString(),
          correlationId,
        },
      });
    } catch (error) {
      this.logger.error('Failed to get health rollups', {
        context: 'HealthController.getRollups',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get sleep night summaries for a user.
   * GET /api/v1/health/sleep
   *
   * Query parameters (validated by GetSleepSummariesQuerySchema):
   * - startDate: Start night date (YYYY-MM-DD, inclusive)
   * - endDate: End night date (YYYY-MM-DD, inclusive, max 365 day range)
   */
  public async getSleepSummaries(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = getCorrelationId(req);

      const parseResult = GetSleepSummariesQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        throw new AppError(
          400,
          ErrorCodes.INVALID_INPUT,
          `Invalid query parameters: ${parseResult.error.message}`,
          true,
          { errors: parseResult.error.errors }
        );
      }

      const { startDate, endDate } = parseResult.data;

      this.logger.debug('Querying sleep summaries', {
        context: 'HealthController.getSleepSummaries',
        userId,
        correlationId,
        startDate,
        endDate,
      });

      const result = await this.measureProjectionQuery(
        'health.sleep', correlationId, userId,
        () => this.healthProjectionReadService.getSleepSummaries(userId, startDate, endDate),
      );

      res.status(200).json({
        success: true,
        data: { items: result.items, summary: result.summary },
        metadata: {
          timestamp: new Date().toISOString(),
          correlationId,
        },
      });
    } catch (error) {
      this.logger.error('Failed to get sleep summaries', {
        context: 'HealthController.getSleepSummaries',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get session impact summaries for a specific session.
   * GET /api/v1/health/session-impact
   *
   * Query parameters (validated by GetSessionImpactQuerySchema):
   * - sessionId: Session UUID
   */
  public async getSessionImpact(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = getCorrelationId(req);

      const parseResult = GetSessionImpactQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        throw new AppError(
          400,
          ErrorCodes.INVALID_INPUT,
          `Invalid query parameters: ${parseResult.error.message}`,
          true,
          { errors: parseResult.error.errors }
        );
      }

      const { sessionId } = parseResult.data;

      this.logger.debug('Querying session impact', {
        context: 'HealthController.getSessionImpact',
        userId,
        correlationId,
        sessionId,
      });

      const result = await this.measureProjectionQuery(
        'health.session-impact', correlationId, userId,
        () => this.healthProjectionReadService.getSessionImpact(sessionId, userId),
      );

      res.status(200).json({
        success: true,
        data: { items: result.items, summary: result.summary },
        metadata: {
          timestamp: new Date().toISOString(),
          correlationId,
        },
      });
    } catch (error) {
      this.logger.error('Failed to get session impact', {
        context: 'HealthController.getSessionImpact',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get recent session impact summaries for a metric.
   * GET /api/v1/health/session-impact/recent
   *
   * Returns recent session impacts enriched with session timestamps
   * and product context. Only includes COMPLETED sessions.
   * Ordered by session start time (most recent first).
   *
   * Query parameters (validated by GetRecentSessionImpactQuerySchema):
   * - metricCode: Metric code to query (required, validated against registry)
   * - limit: Optional result limit (default 10, max 50)
   */
  public async getRecentSessionImpact(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = getCorrelationId(req);

      const parseResult = GetRecentSessionImpactQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        throw new AppError(
          400,
          ErrorCodes.INVALID_INPUT,
          `Invalid query parameters: ${parseResult.error.message}`,
          true,
          { errors: parseResult.error.errors }
        );
      }

      const { metricCode, limit } = parseResult.data;

      this.logger.debug('Querying recent session impacts', {
        context: 'HealthController.getRecentSessionImpact',
        userId,
        correlationId,
        metricCode,
        limit,
      });

      const result = await this.measureProjectionQuery(
        'health.session-impact.recent', correlationId, userId,
        () => this.healthProjectionReadService.getRecentSessionImpacts(
          userId, metricCode, limit,
        ),
      );

      res.status(200).json({
        success: true,
        data: { items: result.items, summary: result.summary },
        metadata: {
          timestamp: new Date().toISOString(),
          correlationId,
        },
      });
    } catch (error) {
      this.logger.error('Failed to get recent session impacts', {
        context: 'HealthController.getRecentSessionImpact',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get product impact rollups for a user and metric.
   * GET /api/v1/health/impact/by-product
   *
   * Returns per-product health impact aggregates, ranked by impact magnitude.
   * Answers "Which products affect my heart rate / HRV / sleep most?"
   *
   * Query parameters (validated by GetProductImpactQuerySchema):
   * - metricCode: Metric code to query (required, validated against registry)
   * - productId: Optional single-product detail filter (UUID)
   * - minSessions: Optional minimum session count for inclusion (default: 3)
   * - limit: Optional result limit (default: 20, max: 50)
   */
  public async getProductImpact(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = getCorrelationId(req);

      const parseResult = GetProductImpactQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        throw new AppError(
          400,
          ErrorCodes.INVALID_INPUT,
          `Invalid query parameters: ${parseResult.error.message}`,
          true,
          { errors: parseResult.error.errors }
        );
      }

      const { metricCode, metricCodes, period, productId, minSessions, limit } = parseResult.data;

      this.logger.debug('Querying product impact rollups', {
        context: 'HealthController.getProductImpact',
        userId,
        correlationId,
        metricCode: metricCode ?? null,
        metricCodes: metricCodes ?? null,
        period,
        productId: productId ?? null,
        minSessions: minSessions ?? 3,
        limit: limit ?? 20,
      });

      const result = await this.measureProjectionQuery(
        'health.product-impact', correlationId, userId,
        () => this.healthProjectionReadService.getProductImpact(
          userId, { metricCode, metricCodes, period, productId, minSessions, limit },
        ),
      );

      res.status(200).json({
        success: true,
        data: { items: result.items, summary: result.summary },
        metadata: {
          timestamp: new Date().toISOString(),
          correlationId,
        },
      });
    } catch (error) {
      this.logger.error('Failed to get product impact rollups', {
        context: 'HealthController.getProductImpact',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  // Health Insights (Phase F: read-time computed)

  /**
   * GET /health/insights
   *
   * Deterministic health insights computed at read-time from rollups,
   * session impacts, and product impacts. No AI/LLM — rule-based only.
   *
   * Query parameters:
   * - domain: Required. Insight domain (hrv, sleep, respiratory)
   * - startDate: Required. Start date (YYYY-MM-DD)
   * - endDate: Required. End date (YYYY-MM-DD)
   * - limit: Optional. Max insights (default: 5, max: 20)
   */
  public async getInsights(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = getCorrelationId(req);

      const parseResult = GetInsightsQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        throw new AppError(
          400,
          ErrorCodes.INVALID_INPUT,
          `Invalid query parameters: ${parseResult.error.message}`,
          true,
          { errors: parseResult.error.errors }
        );
      }

      const { domain, startDate, endDate, limit } = parseResult.data;

      this.logger.debug('Querying health insights', {
        context: 'HealthController.getInsights',
        userId,
        correlationId,
        domain,
        startDate,
        endDate,
        limit: limit ?? 5,
      });

      const result = await this.measureProjectionQuery(
        'health.insights', correlationId, userId,
        () => this.healthProjectionReadService.getInsights(
          userId, domain, startDate, endDate, limit,
        ),
      );

      res.status(200).json({
        success: true,
        data: { items: result.items, summary: result.summary },
        metadata: {
          timestamp: new Date().toISOString(),
          correlationId,
        },
      });
    } catch (error) {
      this.logger.error('Failed to get health insights', {
        context: 'HealthController.getInsights',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }
}
