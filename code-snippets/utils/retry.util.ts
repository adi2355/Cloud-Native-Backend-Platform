/**
 * Retry Utility
 * Provides retry logic with exponential backoff for resilient operations
 * 
 * Features:
 * - Exponential backoff with jitter
 * - Circuit breaker pattern
 * - Configurable retry policies
 * - Error classification
 */

import { LoggerService } from '../services/logger.service';
import { getErrorMessage } from './error-handler';
import { generateSecureJitter } from './secure-id.utils';

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterEnabled?: boolean;
  retryableErrors?: string[];
  onRetry?: (attempt: number, error: unknown) => void;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeMs?: number;
  halfOpenAttempts?: number;
}

/**
 * Default retry options
 */
const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitterEnabled: true,
  retryableErrors: [
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'NetworkingError',
    'ProvisionedThroughputExceededException',
    'ThrottlingException',
    'ServiceUnavailable',
    'RequestLimitExceeded',
  ],
  onRetry: () => {},
};

/**
 * Circuit breaker state
 */
enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

/**
 * Circuit breaker for external service calls
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  constructor(
    private serviceName: string,
    private options: Required<CircuitBreakerOptions>,
    private logger: LoggerService,
  ) {}
  
  /**
   * Execute function with circuit breaker protection
   */
  public async execute<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    // Check if circuit is open
    if (this.state === CircuitState.OPEN) {
      const timeSinceFailure = Date.now() - this.lastFailureTime;
      
      if (timeSinceFailure < this.options.resetTimeMs) {
        throw new Error(`Circuit breaker is OPEN for ${this.serviceName}`);
      }
      
      // Try half-open state
      this.state = CircuitState.HALF_OPEN;
      this.logger.info('Circuit breaker entering HALF_OPEN state', {
        context: 'CircuitBreaker',
        service: this.serviceName,
      });
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      
      if (this.successCount >= this.options.halfOpenAttempts) {
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        
        this.logger.info('Circuit breaker CLOSED', {
          context: 'CircuitBreaker',
          service: this.serviceName,
        });
      }
    } else {
      this.failureCount = 0;
    }
  }
  
  /**
   * Handle failed execution
   */
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN;
      this.successCount = 0;
      
      this.logger.warn('Circuit breaker OPEN (from HALF_OPEN)', {
        context: 'CircuitBreaker',
        service: this.serviceName,
        failures: this.failureCount,
      });
    } else if (this.failureCount >= this.options.failureThreshold) {
      this.state = CircuitState.OPEN;
      
      this.logger.warn('Circuit breaker OPEN', {
        context: 'CircuitBreaker',
        service: this.serviceName,
        failures: this.failureCount,
      });
    }
  }
  
  /**
   * Get current circuit state
   */
  public getState(): CircuitState {
    return this.state;
  }
  
  /**
   * Reset circuit breaker
   */
  public reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }
}

/**
 * Create default circuit breaker options
 */
export function getDefaultCircuitBreakerOptions(): Required<CircuitBreakerOptions> {
  return {
    failureThreshold: 5,
    resetTimeMs: 60000, // 1 minute
    halfOpenAttempts: 3,
  };
}

/**
 * Retry with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
  logger?: LoggerService,
): Promise<T> {
  const config = { ...DEFAULT_RETRY_OPTIONS, ...options };

  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      // Check if error is retryable
      if (!isRetryableError(error, config.retryableErrors)) {
        throw error;
      }

      // Don't retry on last attempt
      if (attempt === config.maxAttempts) {
        break;
      }

      // Calculate delay with exponential backoff
      const baseDelay = Math.min(
        config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1),
        config.maxDelayMs,
      );

      // Add jitter if enabled (cryptographically secure)
      const delay = config.jitterEnabled
        ? baseDelay * (generateSecureJitter(50, 100) / 100) // 0.5 to 1.0 multiplier
        : baseDelay;

      if (logger) {
        logger.debug('Retrying operation', {
          context: 'RetryUtil',
          attempt,
          maxAttempts: config.maxAttempts,
          delayMs: Math.round(delay),
          error: getErrorMessage(error),
        });
      }

      // Call retry callback
      config.onRetry(attempt, error);

      // Wait before retry
      await sleep(delay);
    }
  }

  // All retries exhausted
  if (logger) {
    logger.error('All retry attempts exhausted', {
      context: 'RetryUtil',
      attempts: config.maxAttempts,
      error: getErrorMessage(lastError),
    });
  }

  throw lastError;
}

/**
 * Check if error is retryable
 */
function isRetryableError(error: unknown, retryableErrors: string[]): boolean {
  if (!error) return false;

  const errorMessage = getErrorMessage(error);

  // Safely extract error code with type narrowing
  const hasCodeProperty = (err: unknown): err is { code: string | number } => {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (typeof (err as Record<string, unknown>).code === 'string' || typeof (err as Record<string, unknown>).code === 'number')
    );
  };

  const hasNameProperty = (err: unknown): err is { name: string } => {
    return (
      typeof err === 'object' &&
      err !== null &&
      'name' in err &&
      typeof (err as Record<string, unknown>).name === 'string'
    );
  };

  const errorCode = hasCodeProperty(error) ? String(error.code) : (hasNameProperty(error) ? error.name : '');

  // Check if error matches any retryable pattern
  return retryableErrors.some(pattern =>
    errorMessage.includes(pattern) ||
    errorCode.includes(pattern),
  );
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry specifically for DynamoDB operations
 */
export async function retryDynamoDB<T>(
  operation: () => Promise<T>,
  operationName?: string,
  logger?: LoggerService,
): Promise<T> {
  return retryWithBackoff(operation, {
    maxAttempts: 5,
    initialDelayMs: 50,
    maxDelayMs: 2000,
    backoffMultiplier: 2,
    jitterEnabled: true,
    retryableErrors: [
      'ProvisionedThroughputExceededException',
      'ThrottlingException',
      'ServiceUnavailable',
      'RequestLimitExceeded',
      'ItemCollectionSizeLimitExceededException',
      'LimitExceededException',
      'RequestTimeout',
      'ServiceUnavailableException',
      'InternalServerError',
    ],
    onRetry: (attempt, error) => {
      if (logger) {
        logger.warn('DynamoDB operation retry', {
          context: 'DynamoDBRetry',
          operation: operationName,
          attempt,
          error: getErrorMessage(error),
        });
      }
    },
  }, logger);
}

/**
 * Create a circuit breaker for a service
 */
export function createCircuitBreaker(
  serviceName: string,
  logger: LoggerService,
  options?: CircuitBreakerOptions,
): CircuitBreaker {
  const config = { ...getDefaultCircuitBreakerOptions(), ...options };
  return new CircuitBreaker(serviceName, config, logger);
}

/**
 * Retry with circuit breaker
 */
export async function retryWithCircuitBreaker<T>(
  circuitBreaker: CircuitBreaker,
  fn: () => Promise<T>,
  retryOptions?: RetryOptions,
): Promise<T> {
  return circuitBreaker.execute(() => 
    retryWithBackoff(fn, retryOptions),
  );
}