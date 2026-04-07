import * as fs from 'fs';
import * as path from 'path';
import { Request, Response } from 'express';
import { generateSecureId } from '../utils/secure-id.utils';
import type { CloudWatchLogsService, CloudWatchLogEntry } from './cloudwatch-logs.service';
import { hasErrorCode } from '../utils/error-handler';

/**
 * Extended Request interface for authenticated requests
 * Auth middleware attaches user context to Request object
 */
interface AuthenticatedRequest {
  user?: { id?: string };
  userId?: string;
}

/**
 * Type guard to check if request has authentication properties
 */
function isAuthenticatedRequest(req: unknown): req is AuthenticatedRequest {
  return (
    typeof req === 'object' &&
    req !== null &&
    ('user' in req || 'userId' in req)
  );
}

export interface LogEntry {
  id: string;
  timestamp: Date;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data?: Record<string, unknown>;
  requestId?: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  duration?: number;
  error?: LogError;
}

export interface LogError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

export interface APIRequestLog {
  requestId: string;
  method: string;
  url: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, string>;
  body?: unknown;
  ip: string;
  userAgent?: string;
  userId?: string;
  timestamp: Date;
  size: number;
}

export interface APIResponseLog {
  requestId: string;
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
  size: number;
  duration: number;
  timestamp: Date;
  cached?: boolean;
  error?: LogError;
}

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  FATAL = 'FATAL'
}

export enum LogCategory {
  API_REQUEST = 'API_REQUEST',
  API_RESPONSE = 'API_RESPONSE',
  SECURITY = 'SECURITY',
  AUTHENTICATION = 'AUTHENTICATION',
  AUTHORIZATION = 'AUTHORIZATION',
  DATABASE = 'DATABASE',
  EXTERNAL_API = 'EXTERNAL_API',
  PERFORMANCE = 'PERFORMANCE',
  SYSTEM = 'SYSTEM',
  ERROR = 'ERROR',
  CONFIGURATION = 'CONFIGURATION',
  STORAGE = 'STORAGE'
}

export interface LoggerConfig {
  level: LogLevel;
  enableConsole: boolean;
  enableFile: boolean;
  logDirectory: string;
  maxFileSize: number;
  maxFiles: number;
  enableStructuredLogging: boolean;
  sanitizeData: boolean;
  includeStackTrace: boolean;
}

export interface LogMetrics {
  totalLogs: number;
  logsByLevel: Record<LogLevel, number>;
  logsByCategory: Record<LogCategory, number>;
  errorRate: number;
  averageResponseTime: number;
  recentErrors: LogEntry[];
  performanceMetrics: {
    slowestRequests: Array<{ path: string; duration: number; timestamp: Date }>;
    mostFrequentErrors: Array<{ error: string; count: number }>;
    apiUsageStats: Array<{ endpoint: string; count: number; avgDuration: number }>;
  };
}

export class LoggerService {
  private config: LoggerConfig;
  private logs: LogEntry[] = [];
  private apiRequests: Map<string, APIRequestLog> = new Map();
  private apiResponses: APIResponseLog[] = [];
  private maxLogsInMemory: number = 5000;
  private cloudWatchLogsService: CloudWatchLogsService | null = null;
  private logFiles: {
    general: string;
    api: string;
    security: string;
    error: string;
  };

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(contextOrConfig?: string | Partial<LoggerConfig>) {
    // Handle both context string (for compatibility) and config object
    const config = typeof contextOrConfig === 'string'
      ? {}
      : (contextOrConfig || {});
    this.config = {
      level: LogLevel.INFO,
      enableConsole: true,
      enableFile: true,
      logDirectory: path.join(process.cwd(), 'logs'),
      maxFileSize: 10 * 1024 * 1024, // 10MB
      maxFiles: 10,
      enableStructuredLogging: true,
      sanitizeData: true,
      includeStackTrace: process.env.NODE_ENV === 'development',
      ...config,
    };

    this.logFiles = {
      general: path.join(this.config.logDirectory, 'app.log'),
      api: path.join(this.config.logDirectory, 'api.log'),
      security: path.join(this.config.logDirectory, 'security.log'),
      error: path.join(this.config.logDirectory, 'error.log'),
    };

    // Only create log directory if file logging is enabled
    if (this.config.enableFile) {
      this.ensureLogDirectory();
    }
  }

  /**
   * Set CloudWatch Logs service for cloud logging
   * Called after LoggerService is initialized to inject CloudWatch integration
   *
   * @param cloudWatchLogsService - CloudWatch Logs service instance
   */
  public setCloudWatchLogsService(cloudWatchLogsService: CloudWatchLogsService | null): void {
    this.cloudWatchLogsService = cloudWatchLogsService;
    if (cloudWatchLogsService && cloudWatchLogsService.isReady()) {
      this.info('CloudWatch Logs integration enabled', {
        context: 'LoggerService.setCloudWatchLogsService',
      });
    }
  }

  /**
   * Convenience method: Log info level message
   */
  public info(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, LogCategory.SYSTEM, message, data);
  }

  /**
   * Convenience method: Log error level message
   */
  public error(message: string, error?: unknown): void {
    const errorData = error instanceof Error
      ? { error: error.message, stack: error.stack }
      : error;
    this.log(LogLevel.ERROR, LogCategory.ERROR, message, errorData as Record<string, unknown>, undefined, undefined, error instanceof Error ? error : undefined);
  }

  /**
   * Convenience method: Log warning level message
   */
  public warn(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, LogCategory.SYSTEM, message, data);
  }

  /**
   * Convenience method: Log debug level message
   */
  public debug(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, LogCategory.SYSTEM, message, data);
  }

  /**
   * Log a general message
   */
  public log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    data?: Record<string, unknown>,
    requestId?: string,
    userId?: string,
    error?: Error,
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const logEntry: LogEntry = {
      id: this.generateLogId(),
      timestamp: new Date(),
      level,
      category,
      message: this.sanitizeMessage(message),
      data: this.sanitizeData(data),
      requestId,
      userId: this.sanitizeUserId(userId),
      error: error ? this.sanitizeError(error) : undefined,
    };

    this.addLogEntry(logEntry);
    this.writeToFile(logEntry);
    this.logToConsole(logEntry);
  }

  /**
   * Log API request
   */
  public logAPIRequest(req: Request, requestId: string): void {
    const requestLog: APIRequestLog = {
      requestId,
      method: req.method,
      url: req.url,
      path: req.path,
      query: this.sanitizeQuery(req.query),
      headers: this.sanitizeHeaders(req.headers),
      body: this.sanitizeRequestBody(req.body),
      ip: this.getClientIP(req),
      userAgent: req.get('User-Agent'),
      userId: this.extractUserId(req),
      timestamp: new Date(),
      size: this.calculateRequestSize(req),
    };

    this.apiRequests.set(requestId, requestLog);

    this.log(
      LogLevel.INFO,
      LogCategory.API_REQUEST,
      `${req.method} ${req.path}`,
      {
        requestId,
        method: req.method,
        path: req.path,
        query: requestLog.query,
        ip: requestLog.ip,
        userAgent: requestLog.userAgent,
        size: requestLog.size,
      },
      requestId,
      requestLog.userId,
    );
  }

  /**
   * Log API response
   */
  public logAPIResponse(
    res: Response,
    requestId: string,
    startTime: number,
    body?: unknown,
    error?: Error,
  ): void {
    const duration = Date.now() - startTime;
    const responseLog: APIResponseLog = {
      requestId,
      statusCode: res.statusCode,
      headers: this.sanitizeHeaders(res.getHeaders()),
      body: this.sanitizeResponseBody(body),
      size: this.calculateResponseSize(body),
      duration,
      timestamp: new Date(),
      error: error ? this.sanitizeError(error) : undefined,
    };

    this.apiResponses.push(responseLog);
    this.trimAPIResponses();

    const requestLog = this.apiRequests.get(requestId);
    const level = res.statusCode >= 400 ? LogLevel.ERROR : LogLevel.INFO;

    this.log(
      level,
      LogCategory.API_RESPONSE,
      `${requestLog?.method || 'UNKNOWN'} ${requestLog?.path || 'UNKNOWN'} - ${res.statusCode}`,
      {
        requestId,
        statusCode: res.statusCode,
        duration,
        size: responseLog.size,
        error: error?.message,
      },
      requestId,
      requestLog?.userId,
    );

    // Clean up request log after response is logged
    this.apiRequests.delete(requestId);
  }

  /**
   * Log performance metrics
   */
  public logPerformance(
    operation: string,
    duration: number,
    metadata?: Record<string, unknown>,
    requestId?: string,
  ): void {
    const level = duration > 5000 ? LogLevel.WARN : LogLevel.INFO; // Warn if operation takes > 5s

    this.log(
      level,
      LogCategory.PERFORMANCE,
      `Performance: ${operation} took ${duration}ms`,
      {
        operation,
        duration,
        ...metadata,
      },
      requestId,
    );
  }

  /**
   * Log external API calls
   */
  public logExternalAPI(
    service: string,
    endpoint: string,
    method: string,
    duration: number,
    statusCode?: number,
    error?: Error,
    requestId?: string,
  ): void {
    const level = error || (statusCode && statusCode >= 400) ? LogLevel.ERROR : LogLevel.INFO;

    this.log(
      level,
      LogCategory.EXTERNAL_API,
      `External API: ${service} ${method} ${endpoint}`,
      {
        service,
        endpoint,
        method,
        duration,
        statusCode,
        error: error?.message,
      },
      requestId,
    );
  }

  /**
   * Log database operations
   */
  public logDatabase(
    operation: string,
    table?: string,
    duration?: number,
    error?: Error,
    requestId?: string,
  ): void {
    const level = error ? LogLevel.ERROR : LogLevel.DEBUG;

    this.log(
      level,
      LogCategory.DATABASE,
      `Database: ${operation}${table ? ` on ${table}` : ''}`,
      {
        operation,
        table,
        duration,
        error: error?.message,
      },
      requestId,
    );
  }

  /**
   * Get log metrics
   */
  public getLogMetrics(timeWindow?: number): LogMetrics {
    const now = Date.now();
    const windowStart = timeWindow ? now - timeWindow : 0;
    
    const relevantLogs = this.logs.filter(log => 
      log.timestamp.getTime() >= windowStart,
    );

    const relevantResponses = this.apiResponses.filter(response =>
      response.timestamp.getTime() >= windowStart,
    );

    // Initialize counters with explicit enum keys
    const logsByLevel: Record<LogLevel, number> = {
      [LogLevel.DEBUG]: 0,
      [LogLevel.INFO]: 0,
      [LogLevel.WARN]: 0,
      [LogLevel.ERROR]: 0,
      [LogLevel.FATAL]: 0,
    };
    const logsByCategory: Record<LogCategory, number> = {
      [LogCategory.API_REQUEST]: 0,
      [LogCategory.API_RESPONSE]: 0,
      [LogCategory.SECURITY]: 0,
      [LogCategory.AUTHENTICATION]: 0,
      [LogCategory.AUTHORIZATION]: 0,
      [LogCategory.DATABASE]: 0,
      [LogCategory.EXTERNAL_API]: 0,
      [LogCategory.PERFORMANCE]: 0,
      [LogCategory.SYSTEM]: 0,
      [LogCategory.ERROR]: 0,
      [LogCategory.CONFIGURATION]: 0,
      [LogCategory.STORAGE]: 0,
    };

    // Count logs
    relevantLogs.forEach(log => {
      logsByLevel[log.level]++;
      logsByCategory[log.category]++;
    });

    // Calculate error rate
    const totalRequests = relevantResponses.length;
    const errorRequests = relevantResponses.filter(r => r.statusCode >= 400).length;
    const errorRate = totalRequests > 0 ? (errorRequests / totalRequests) * 100 : 0;

    // Calculate average response time
    const totalDuration = relevantResponses.reduce((sum, r) => sum + r.duration, 0);
    const averageResponseTime = totalRequests > 0 ? totalDuration / totalRequests : 0;

    // Get recent errors
    const recentErrors = relevantLogs
      .filter(log => log.level === LogLevel.ERROR || log.level === LogLevel.FATAL)
      .slice(-10);

    // Performance metrics
    const slowestRequests = relevantResponses
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10)
      .map(r => {
        const requestLog = Array.from(this.apiRequests.values())
          .find(req => req.requestId === r.requestId);
        return {
          path: requestLog?.path || 'unknown',
          duration: r.duration,
          timestamp: r.timestamp,
        };
      });

    // Most frequent errors
    const errorCounts: Record<string, number> = {};
    recentErrors.forEach(log => {
      const errorKey = log.error?.name || log.message;
      errorCounts[errorKey] = (errorCounts[errorKey] || 0) + 1;
    });

    const mostFrequentErrors = Object.entries(errorCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([error, count]) => ({ error, count }));

    // API usage stats
    const endpointStats: Record<string, { count: number; totalDuration: number }> = {};
    relevantResponses.forEach(response => {
      const requestLog = Array.from(this.apiRequests.values())
        .find(req => req.requestId === response.requestId);
      const endpoint = requestLog?.path || 'unknown';
      
      if (!endpointStats[endpoint]) {
        endpointStats[endpoint] = { count: 0, totalDuration: 0 };
      }
      endpointStats[endpoint].count++;
      endpointStats[endpoint].totalDuration += response.duration;
    });

    const apiUsageStats = Object.entries(endpointStats)
      .map(([endpoint, stats]) => ({
        endpoint,
        count: stats.count,
        avgDuration: stats.totalDuration / stats.count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalLogs: relevantLogs.length,
      logsByLevel,
      logsByCategory,
      errorRate,
      averageResponseTime,
      recentErrors,
      performanceMetrics: {
        slowestRequests,
        mostFrequentErrors,
        apiUsageStats,
      },
    };
  }

  /**
   * Get logs by criteria
   */
  public getLogs(
    level?: LogLevel,
    category?: LogCategory,
    limit: number = 100,
    timeWindow?: number,
  ): LogEntry[] {
    const now = Date.now();
    const windowStart = timeWindow ? now - timeWindow : 0;
    
    return this.logs
      .filter(log => {
        if (timeWindow && log.timestamp.getTime() < windowStart) return false;
        if (level && log.level !== level) return false;
        if (category && log.category !== category) return false;
        return true;
      })
      .slice(-limit);
  }

  /**
   * Search logs by message content
   */
  public searchLogs(
    searchTerm: string,
    limit: number = 100,
    timeWindow?: number,
  ): LogEntry[] {
    const now = Date.now();
    const windowStart = timeWindow ? now - timeWindow : 0;
    
    return this.logs
      .filter(log => {
        if (timeWindow && log.timestamp.getTime() < windowStart) return false;
        return log.message.toLowerCase().includes(searchTerm.toLowerCase());
      })
      .slice(-limit);
  }

  /**
   * Export logs for analysis
   */
  public exportLogs(
    format: 'json' | 'csv' = 'json',
    timeWindow?: number,
  ): string {
    const now = Date.now();
    const windowStart = timeWindow ? now - timeWindow : 0;
    
    const relevantLogs = this.logs.filter(log => 
      !timeWindow || log.timestamp.getTime() >= windowStart,
    );

    if (format === 'json') {
      return JSON.stringify(relevantLogs, null, 2);
    } else {
      // CSV format
      const headers = ['timestamp', 'level', 'category', 'message', 'requestId', 'userId'];
      const csvRows = [headers.join(',')];
      
      relevantLogs.forEach(log => {
        const row = [
          log.timestamp.toISOString(),
          log.level,
          log.category,
          `"${log.message.replace(/"/g, '""')}"`,
          log.requestId || '',
          log.userId || '',
        ];
        csvRows.push(row.join(','));
      });
      
      return csvRows.join('\n');
    }
  }

  // Private helper methods

  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR, LogLevel.FATAL];
    const configLevelIndex = levels.indexOf(this.config.level);
    const logLevelIndex = levels.indexOf(level);
    return logLevelIndex >= configLevelIndex;
  }

  private addLogEntry(logEntry: LogEntry): void {
    this.logs.push(logEntry);
    this.trimLogsInMemory();

    // Send to CloudWatch if configured
    if (this.cloudWatchLogsService && this.cloudWatchLogsService.isReady()) {
      const cloudWatchEntry: CloudWatchLogEntry = {
        timestamp: logEntry.timestamp.getTime(),
        message: logEntry.message,
        level: logEntry.level,
        context: String(logEntry.category),
        userId: logEntry.userId,
        requestId: logEntry.requestId,
        correlationId: logEntry.requestId, // Use requestId as correlationId for now
        error: logEntry.error,
        metadata: logEntry.data,
      };

      // Send asynchronously without waiting (fire-and-forget)
      this.cloudWatchLogsService.sendLog(cloudWatchEntry).catch((error) => {
        // Log CloudWatch failures to console only (avoid infinite loop)
        console.error('Failed to send log to CloudWatch:', error);
      });
    }
  }

  private trimLogsInMemory(): void {
    if (this.logs.length > this.maxLogsInMemory) {
      this.logs = this.logs.slice(-this.maxLogsInMemory);
    }
  }

  private trimAPIResponses(): void {
    if (this.apiResponses.length > 1000) {
      this.apiResponses = this.apiResponses.slice(-1000);
    }
  }

  private writeToFile(logEntry: LogEntry): void {
    if (!this.config.enableFile) return;

    try {
      let logFile = this.logFiles.general;
      
      // Route to specific log files based on category
      switch (logEntry.category) {
        case LogCategory.API_REQUEST:
        case LogCategory.API_RESPONSE:
          logFile = this.logFiles.api;
          break;
        case LogCategory.SECURITY:
        case LogCategory.AUTHENTICATION:
        case LogCategory.AUTHORIZATION:
          logFile = this.logFiles.security;
          break;
        case LogCategory.ERROR:
          if (logEntry.level === LogLevel.ERROR || logEntry.level === LogLevel.FATAL) {
            logFile = this.logFiles.error;
          }
          break;
      }

      const logLine = this.config.enableStructuredLogging
        ? `${JSON.stringify(logEntry)  }\n`
        : `${this.formatLogLine(logEntry)  }\n`;

      this.rotateLogFileIfNeeded(logFile);
      fs.appendFileSync(logFile, logLine);
    } catch (error) {
      // INTENTIONAL: Console fallback when file system logging fails
      // This prevents infinite recursion and ensures critical errors are still visible
      console.error('Failed to write log to file:', error);
    }
  }

  private logToConsole(logEntry: LogEntry): void {
    if (!this.config.enableConsole) return;

    const message = this.formatLogLine(logEntry);
    
    switch (logEntry.level) {
      case LogLevel.FATAL:
      case LogLevel.ERROR:
        // INTENTIONAL: Console output for structured logging service
        console.error(message);
        break;
      case LogLevel.WARN:
        // INTENTIONAL: Console output for structured logging service
        console.warn(message);
        break;
      case LogLevel.INFO:
        // INTENTIONAL: Console output for structured logging service
        console.info(message);
        break;
      case LogLevel.DEBUG:
        // INTENTIONAL: Console output for structured logging service
        console.debug(message);
        break;
    }
  }

  private formatLogLine(logEntry: LogEntry): string {
    const timestamp = logEntry.timestamp.toISOString();
    const level = logEntry.level.padEnd(5);
    const category = logEntry.category.padEnd(15);
    const requestId = logEntry.requestId ? `[${logEntry.requestId}]` : '';
    
    return `${timestamp} ${level} ${category} ${requestId} ${logEntry.message}`;
  }

  private sanitizeMessage(message: string): string {
    return message
      .replace(/[\r\n]/g, ' ')
      .replace(/\t/g, ' ')
      .substring(0, 1000); // Limit message length
  }

  private sanitizeData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!data || !this.config.sanitizeData) return data;

    const sanitized: Record<string, unknown> = {};

    Object.entries(data).forEach(([key, value]) => {
      if (this.isSensitiveKey(key)) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'string' && value.length > 500) {
        sanitized[key] = `${value.substring(0, 500)}...`;
      } else {
        sanitized[key] = value;
      }
    });

    return sanitized;
  }

  private sanitizeUserId(userId?: string): string | undefined {
    if (!userId) return undefined;
    return this.config.sanitizeData ? this.maskSensitiveData(userId) : userId;
  }

  private sanitizeError(error: Error): LogError {
    return {
      name: error.name,
      message: error.message,
      stack: this.config.includeStackTrace ? error.stack : undefined,
      code: hasErrorCode(error) ? error.code : undefined,
    };
  }

  private sanitizeQuery(query: unknown): Record<string, unknown> {
    if (!query || typeof query !== 'object') return {};

    const sanitized: Record<string, unknown> = {};
    Object.entries(query).forEach(([key, value]) => {
      if (this.isSensitiveKey(key)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    });

    return sanitized;
  }

  private sanitizeHeaders(headers: unknown): Record<string, string> {
    if (!headers || typeof headers !== 'object') return {};

    const sanitized: Record<string, string> = {};

    Object.entries(headers).forEach(([key, value]) => {
      const lowerKey = key.toLowerCase();
      if (this.isSensitiveHeader(lowerKey)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = String(value);
      }
    });

    return sanitized;
  }

  private sanitizeRequestBody(body: unknown): unknown {
    if (!body) return undefined;
    if (!this.config.sanitizeData) return body;

    // Don't log large request bodies
    const bodyStr = JSON.stringify(body);
    if (bodyStr.length > 1000) {
      return '[BODY_TOO_LARGE]';
    }

    // Only sanitize if body is an object
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      return this.sanitizeData(body as Record<string, unknown>);
    }

    return body;
  }

  private sanitizeResponseBody(body: unknown): unknown {
    if (!body) return undefined;
    if (!this.config.sanitizeData) return body;

    // Don't log large response bodies
    const bodyStr = JSON.stringify(body);
    if (bodyStr.length > 1000) {
      return '[BODY_TOO_LARGE]';
    }

    return body;
  }

  private isSensitiveKey(key: string): boolean {
    const sensitivePatterns = [
      /password/i,
      /secret/i,
      /key/i,
      /token/i,
      /auth/i,
      /credential/i,
      /api[_-]?key/i,
    ];
    
    return sensitivePatterns.some(pattern => pattern.test(key));
  }

  private isSensitiveHeader(header: string): boolean {
    const sensitiveHeaders = [
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'x-auth-token',
    ];
    
    return sensitiveHeaders.includes(header);
  }

  private maskSensitiveData(data: string): string {
    if (data.length <= 4) return '***';
    return data.substring(0, 2) + '*'.repeat(data.length - 4) + data.substring(data.length - 2);
  }

  private getClientIP(req: Request): string {
    return (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           'unknown';
  }

  private extractUserId(req: Request): string | undefined {
    if (isAuthenticatedRequest(req)) {
      return req.user?.id || req.userId;
    }
    return undefined;
  }

  private calculateRequestSize(req: Request): number {
    const bodySize = req.body ? JSON.stringify(req.body).length : 0;
    const headersSize = JSON.stringify(req.headers).length;
    return bodySize + headersSize;
  }

  private calculateResponseSize(body: unknown): number {
    return body ? JSON.stringify(body).length : 0;
  }

  private generateLogId(): string {
    return generateSecureId('log', 9);
  }

  private ensureLogDirectory(): void {
    if (!fs.existsSync(this.config.logDirectory)) {
      fs.mkdirSync(this.config.logDirectory, { recursive: true });
    }
  }

  private rotateLogFileIfNeeded(logFile: string): void {
    try {
      if (fs.existsSync(logFile)) {
        const stats = fs.statSync(logFile);
        if (stats.size > this.config.maxFileSize) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const rotatedPath = logFile.replace('.log', `_${timestamp}.log`);
          fs.renameSync(logFile, rotatedPath);
          
          // Clean up old log files
          this.cleanupOldLogFiles(path.dirname(logFile));
        }
      }
    } catch (error) {
      // INTENTIONAL: Console fallback when log rotation fails
      // This prevents infinite recursion and ensures critical errors are still visible
      console.error('Failed to rotate log file:', error);
    }
  }

  private cleanupOldLogFiles(logDir: string): void {
    try {
      const files = fs.readdirSync(logDir)
        .filter(file => file.endsWith('.log'))
        .map(file => ({
          name: file,
          path: path.join(logDir, file),
          stats: fs.statSync(path.join(logDir, file)),
        }))
        .sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime());

      // Keep only the most recent files
      if (files.length > this.config.maxFiles) {
        const filesToDelete = files.slice(this.config.maxFiles);
        filesToDelete.forEach(file => {
          fs.unlinkSync(file.path);
        });
      }
    } catch (error) {
      // INTENTIONAL: Console fallback when log cleanup fails
      // This prevents infinite recursion and ensures critical errors are still visible
      console.error('Failed to cleanup old log files:', error);
    }
  }
}

export default LoggerService;