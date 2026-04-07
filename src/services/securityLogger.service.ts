import * as fs from 'fs';
import * as path from 'path';
import { LoggerService, LogLevel, LogCategory } from './logger.service';
import { generateSecureId } from '../utils/secure-id.utils';

// CloudWatch integration (optional - only if AWS SDK is available)
interface CloudWatchLogsClients {
  CloudWatchLogsClient: typeof import('@aws-sdk/client-cloudwatch-logs').CloudWatchLogsClient;
  PutLogEventsCommand: typeof import('@aws-sdk/client-cloudwatch-logs').PutLogEventsCommand;
  CreateLogStreamCommand: typeof import('@aws-sdk/client-cloudwatch-logs').CreateLogStreamCommand;
}

let CloudWatchLogs: CloudWatchLogsClients | null = null;
try {
  const { CloudWatchLogsClient, PutLogEventsCommand, CreateLogStreamCommand } = require('@aws-sdk/client-cloudwatch-logs');
  CloudWatchLogs = { CloudWatchLogsClient, PutLogEventsCommand, CreateLogStreamCommand };
} catch (error) {
  // CloudWatch SDK not available - will use file logging only
}

export interface SecurityEvent {
  id: string;
  timestamp: Date;
  type: SecurityEventType;
  severity: SecurityEventSeverity;
  source: string;
  message: string;
  details: SecurityEventDetails;
  userContext?: {
    userId?: string;
    ip?: string;
    userAgent?: string;
  };
  metadata?: Record<string, unknown>;
}

export enum SecurityEventType {
  AUTHENTICATION_FAILURE = 'AUTHENTICATION_FAILURE',
  AUTHENTICATION_SUCCESS = 'AUTHENTICATION_SUCCESS',
  AUTHORIZATION_FAILURE = 'AUTHORIZATION_FAILURE',
  TOKEN_VALIDATION_FAILURE = 'TOKEN_VALIDATION_FAILURE',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  TOKEN_MALFORMED = 'TOKEN_MALFORMED',
  SESSION_CREATED = 'SESSION_CREATED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  SESSION_REVOKED = 'SESSION_REVOKED',
  PASSWORD_RESET_REQUESTED = 'PASSWORD_RESET_REQUESTED',
  PASSWORD_CHANGED = 'PASSWORD_CHANGED',
  MFA_CHALLENGE_INITIATED = 'MFA_CHALLENGE_INITIATED',
  MFA_VERIFICATION_SUCCESS = 'MFA_VERIFICATION_SUCCESS',
  MFA_VERIFICATION_FAILURE = 'MFA_VERIFICATION_FAILURE',
  ACCOUNT_LOCKED = 'ACCOUNT_LOCKED',
  ACCOUNT_UNLOCKED = 'ACCOUNT_UNLOCKED',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  CORS_VIOLATION = 'CORS_VIOLATION',
  INVALID_REQUEST = 'INVALID_REQUEST',
  SUSPICIOUS_ACTIVITY = 'SUSPICIOUS_ACTIVITY',
  CONFIG_SECURITY_VIOLATION = 'CONFIG_SECURITY_VIOLATION',
  API_KEY_EXPOSURE_ATTEMPT = 'API_KEY_EXPOSURE_ATTEMPT',
  MALFORMED_REQUEST = 'MALFORMED_REQUEST',
  SECURITY_HEADER_VIOLATION = 'SECURITY_HEADER_VIOLATION',
  BRUTE_FORCE_ATTEMPT = 'BRUTE_FORCE_ATTEMPT',
  DEVICE_FINGERPRINT_MISMATCH = 'DEVICE_FINGERPRINT_MISMATCH',
  CONCURRENT_SESSION_LIMIT_EXCEEDED = 'CONCURRENT_SESSION_LIMIT_EXCEEDED',
  GEOLOCATION_ANOMALY = 'GEOLOCATION_ANOMALY'
}

export enum SecurityEventSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL'
}

export interface SecurityEventDetails {
  endpoint?: string;
  method?: string;
  statusCode?: number;
  responseTime?: number;
  requestSize?: number;
  errorMessage?: string;
  errorCode?: string; // Machine-readable error code (e.g., GOOGLE_TOKEN_INVALID)
  attemptCount?: number;
  blockedReason?: string;
  cognitoSub?: string; // Cognito user identifier for auth events
  username?: string; // Username from Cognito token
  email?: string; // Email from Cognito token
}

export interface SecurityEventPattern {
  type: SecurityEventType;
  threshold: number;
  timeWindow: number; // in milliseconds
  action: 'LOG' | 'ALERT' | 'BLOCK';
}

export interface SecurityMetrics {
  totalEvents: number;
  eventsByType: Record<SecurityEventType, number>;
  eventsBySeverity: Record<SecurityEventSeverity, number>;
  recentEvents: SecurityEvent[];
  suspiciousIPs: string[];
  topEndpoints: Array<{ endpoint: string; count: number }>;
}

export class SecurityLoggerService {
  private events: SecurityEvent[] = [];
  private logFilePath: string;
  private maxLogSize: number = 10 * 1024 * 1024; // 10MB
  private maxEventsInMemory: number = 1000;
  private logger: LoggerService;
  private cloudWatchClient: InstanceType<typeof import('@aws-sdk/client-cloudwatch-logs').CloudWatchLogsClient> | null = null;
  private cloudWatchLogGroup: string = '/ecs/app-platform-backend/security';
  private cloudWatchLogStream: string = `security-${new Date().toISOString().split('T')[0]}`;
  private suspiciousActivityPatterns: SecurityEventPattern[] = [
    {
      type: SecurityEventType.AUTHENTICATION_FAILURE,
      threshold: 5,
      timeWindow: 15 * 60 * 1000, // 15 minutes
      action: 'ALERT',
    },
    {
      type: SecurityEventType.RATE_LIMIT_EXCEEDED,
      threshold: 10,
      timeWindow: 60 * 60 * 1000, // 1 hour
      action: 'LOG',
    },
    {
      type: SecurityEventType.CORS_VIOLATION,
      threshold: 3,
      timeWindow: 5 * 60 * 1000, // 5 minutes
      action: 'ALERT',
    },
    {
      type: SecurityEventType.BRUTE_FORCE_ATTEMPT,
      threshold: 1,
      timeWindow: 1000, // 1 second
      action: 'BLOCK',
    },
  ];

  /**
   * Constructor with explicit dependency injection
   * @param logger - LoggerService instance for internal logging
   */
  public constructor(logger: LoggerService) {
    this.logger = logger;
    this.logFilePath = path.join(process.cwd(), 'logs', 'security.log');
    this.ensureLogDirectory();
    this.initializeCloudWatch();
  }

  /**
   * Log a security event
   */
  public logSecurityEvent(
    type: SecurityEventType,
    severity: SecurityEventSeverity,
    message: string,
    details: SecurityEventDetails = {},
    userContext?: SecurityEvent['userContext'],
    metadata?: Record<string, unknown>,
  ): void {
    // Logger is already injected via constructor
    
    const event: SecurityEvent = {
      id: this.generateEventId(),
      timestamp: new Date(),
      type,
      severity,
      source: 'app-platform-backend',
      message: this.sanitizeMessage(message),
      details: this.sanitizeDetails(details),
      userContext: this.sanitizeUserContext(userContext),
      metadata: this.sanitizeMetadata(metadata),
    };

    // Add to in-memory storage
    this.events.push(event);
    this.trimEventsInMemory();

    // Write to log file
    this.writeToLogFile(event);

    // Send to CloudWatch (async, don't wait)
    this.sendToCloudWatch(event).catch(error => {
      // Log CloudWatch errors but don't fail the main logging
      this.logger.log(
        LogLevel.WARN,
        LogCategory.SYSTEM,
        'Failed to send security event to CloudWatch',
        { error: error instanceof Error ? error.message : 'Unknown error' },
      );
    });

    // Check for suspicious patterns
    this.checkSuspiciousPatterns(event);

    // Console logging based on severity
    this.logToConsole(event);
  }

  /**
   * Log authentication events
   */
  public logAuthenticationEvent(
    success: boolean,
    userId?: string,
    ip?: string,
    userAgent?: string,
    details: Partial<SecurityEventDetails> = {},
  ): void {
    const type = success ? SecurityEventType.AUTHENTICATION_SUCCESS : SecurityEventType.AUTHENTICATION_FAILURE;
    const severity = success ? SecurityEventSeverity.LOW : SecurityEventSeverity.MEDIUM;
    const message = success ? 'User authentication successful' : 'User authentication failed';

    this.logSecurityEvent(
      type,
      severity,
      message,
      details,
      { userId, ip, userAgent },
    );
  }

  /**
   * Log rate limiting events
   */
  public logRateLimitEvent(
    ip: string,
    endpoint: string,
    limit: number,
    windowMs: number,
    userAgent?: string,
  ): void {
    this.logSecurityEvent(
      SecurityEventType.RATE_LIMIT_EXCEEDED,
      SecurityEventSeverity.MEDIUM,
      'Rate limit exceeded',
      {
        endpoint,
        attemptCount: limit,
      },
      { ip, userAgent },
      { limit, windowMs },
    );
  }

  /**
   * Log CORS violations
   */
  public logCorsViolation(
    origin: string,
    ip: string,
    endpoint: string,
    userAgent?: string,
  ): void {
    this.logSecurityEvent(
      SecurityEventType.CORS_VIOLATION,
      SecurityEventSeverity.HIGH,
      'CORS policy violation detected',
      {
        endpoint,
        blockedReason: `Origin ${origin} not allowed`,
      },
      { ip, userAgent },
      { origin },
    );
  }

  /**
   * Log suspicious activity
   */
  public logSuspiciousActivity(
    description: string,
    ip: string,
    endpoint?: string,
    userAgent?: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.logSecurityEvent(
      SecurityEventType.SUSPICIOUS_ACTIVITY,
      SecurityEventSeverity.HIGH,
      `Suspicious activity detected: ${description}`,
      { endpoint },
      { ip, userAgent },
      metadata,
    );
  }

  /**
   * Log configuration security violations
   */
  public logConfigSecurityViolation(
    violation: string,
    severity: SecurityEventSeverity = SecurityEventSeverity.HIGH,
    metadata?: Record<string, unknown>,
  ): void {
    this.logSecurityEvent(
      SecurityEventType.CONFIG_SECURITY_VIOLATION,
      severity,
      `Configuration security violation: ${violation}`,
      {},
      undefined,
      metadata,
    );
  }

  /**
   * Log token validation events
   */
  public logTokenValidationEvent(
    success: boolean,
    tokenType: 'id' | 'access' | 'refresh',
    errorCode?: string,
    userId?: string,
    ip?: string,
    userAgent?: string,
    details: Partial<SecurityEventDetails> = {},
  ): void {
    if (success) {
      this.logSecurityEvent(
        SecurityEventType.AUTHENTICATION_SUCCESS,
        SecurityEventSeverity.LOW,
        `Token validation successful: ${tokenType} token`,
        { ...details, method: 'TOKEN_VALIDATION' },
        { userId, ip, userAgent },
        { tokenType },
      );
    } else {
      let eventType = SecurityEventType.TOKEN_VALIDATION_FAILURE;
      let severity = SecurityEventSeverity.MEDIUM;

      if (errorCode === 'EXPIRED_TOKEN') {
        eventType = SecurityEventType.TOKEN_EXPIRED;
        severity = SecurityEventSeverity.LOW;
      } else if (errorCode === 'MALFORMED_TOKEN') {
        eventType = SecurityEventType.TOKEN_MALFORMED;
        severity = SecurityEventSeverity.MEDIUM;
      }

      this.logSecurityEvent(
        eventType,
        severity,
        `Token validation failed: ${tokenType} token${errorCode ? ` (${errorCode})` : ''}`,
        { ...details, method: 'TOKEN_VALIDATION', errorMessage: errorCode },
        { userId, ip, userAgent },
        { tokenType, errorCode },
      );
    }
  }

  /**
   * Log session events
   */
  public logSessionEvent(
    eventType: 'created' | 'expired' | 'revoked',
    userId: string,
    sessionId?: string,
    ip?: string,
    userAgent?: string,
    metadata?: Record<string, unknown>,
  ): void {
    const eventTypeMap = {
      created: SecurityEventType.SESSION_CREATED,
      expired: SecurityEventType.SESSION_EXPIRED,
      revoked: SecurityEventType.SESSION_REVOKED,
    };

    const messageMap = {
      created: 'User session created',
      expired: 'User session expired',
      revoked: 'User session revoked',
    };

    this.logSecurityEvent(
      eventTypeMap[eventType],
      SecurityEventSeverity.LOW,
      messageMap[eventType],
      { method: 'SESSION_MANAGEMENT' },
      { userId, ip, userAgent },
      { sessionId, ...metadata },
    );
  }

  /**
   * Log MFA events
   */
  public logMFAEvent(
    eventType: 'challenge_initiated' | 'verification_success' | 'verification_failure',
    userId: string,
    mfaMethod: string,
    ip?: string,
    userAgent?: string,
    details: Partial<SecurityEventDetails> = {},
  ): void {
    const eventTypeMap = {
      challenge_initiated: SecurityEventType.MFA_CHALLENGE_INITIATED,
      verification_success: SecurityEventType.MFA_VERIFICATION_SUCCESS,
      verification_failure: SecurityEventType.MFA_VERIFICATION_FAILURE,
    };

    const severityMap = {
      challenge_initiated: SecurityEventSeverity.LOW,
      verification_success: SecurityEventSeverity.LOW,
      verification_failure: SecurityEventSeverity.MEDIUM,
    };

    const messageMap = {
      challenge_initiated: `MFA challenge initiated: ${mfaMethod}`,
      verification_success: `MFA verification successful: ${mfaMethod}`,
      verification_failure: `MFA verification failed: ${mfaMethod}`,
    };

    this.logSecurityEvent(
      eventTypeMap[eventType],
      severityMap[eventType],
      messageMap[eventType],
      { ...details, method: 'MFA' },
      { userId, ip, userAgent },
      { mfaMethod },
    );
  }

  /**
   * Log account security events
   */
  public logAccountSecurityEvent(
    eventType: 'locked' | 'unlocked' | 'password_reset_requested' | 'password_changed',
    userId: string,
    ip?: string,
    userAgent?: string,
    metadata?: Record<string, unknown>,
  ): void {
    const eventTypeMap = {
      locked: SecurityEventType.ACCOUNT_LOCKED,
      unlocked: SecurityEventType.ACCOUNT_UNLOCKED,
      password_reset_requested: SecurityEventType.PASSWORD_RESET_REQUESTED,
      password_changed: SecurityEventType.PASSWORD_CHANGED,
    };

    const severityMap = {
      locked: SecurityEventSeverity.HIGH,
      unlocked: SecurityEventSeverity.MEDIUM,
      password_reset_requested: SecurityEventSeverity.MEDIUM,
      password_changed: SecurityEventSeverity.MEDIUM,
    };

    const messageMap = {
      locked: 'User account locked due to security policy',
      unlocked: 'User account unlocked',
      password_reset_requested: 'Password reset requested',
      password_changed: 'User password changed',
    };

    this.logSecurityEvent(
      eventTypeMap[eventType],
      severityMap[eventType],
      messageMap[eventType],
      { method: 'ACCOUNT_SECURITY' },
      { userId, ip, userAgent },
      metadata,
    );
  }

  /**
   * Log device and session security events
   */
  public logDeviceSecurityEvent(
    eventType: 'fingerprint_mismatch' | 'concurrent_session_limit' | 'geolocation_anomaly',
    userId: string,
    ip?: string,
    userAgent?: string,
    metadata?: Record<string, unknown>,
  ): void {
    const eventTypeMap = {
      fingerprint_mismatch: SecurityEventType.DEVICE_FINGERPRINT_MISMATCH,
      concurrent_session_limit: SecurityEventType.CONCURRENT_SESSION_LIMIT_EXCEEDED,
      geolocation_anomaly: SecurityEventType.GEOLOCATION_ANOMALY,
    };

    const messageMap = {
      fingerprint_mismatch: 'Device fingerprint mismatch detected',
      concurrent_session_limit: 'Concurrent session limit exceeded',
      geolocation_anomaly: 'Unusual geolocation detected for user session',
    };

    this.logSecurityEvent(
      eventTypeMap[eventType],
      SecurityEventSeverity.HIGH,
      messageMap[eventType],
      { method: 'DEVICE_SECURITY' },
      { userId, ip, userAgent },
      metadata,
    );
  }

  /**
   * Get security metrics
   */
  public getSecurityMetrics(timeWindow?: number): SecurityMetrics {
    const now = Date.now();
    const windowStart = timeWindow ? now - timeWindow : 0;
    
    const relevantEvents = this.events.filter(event =>
      event.timestamp.getTime() >= windowStart,
    );

    const eventsByType: Partial<Record<SecurityEventType, number>> = {};
    const eventsBySeverity: Partial<Record<SecurityEventSeverity, number>> = {};
    const endpointCounts: Record<string, number> = {};
    const ipCounts: Record<string, number> = {};

    // Initialize counters
    (Object.values(SecurityEventType) as SecurityEventType[]).forEach(type => {
      eventsByType[type] = 0;
    });
    (Object.values(SecurityEventSeverity) as SecurityEventSeverity[]).forEach(severity => {
      eventsBySeverity[severity] = 0;
    });

    // Count events
    relevantEvents.forEach(event => {
      eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
      eventsBySeverity[event.severity] = (eventsBySeverity[event.severity] || 0) + 1;
      
      if (event.details.endpoint) {
        endpointCounts[event.details.endpoint] = (endpointCounts[event.details.endpoint] || 0) + 1;
      }
      
      if (event.userContext?.ip) {
        ipCounts[event.userContext.ip] = (ipCounts[event.userContext.ip] || 0) + 1;
      }
    });

    // Find suspicious IPs (more than 10 events in time window)
    const suspiciousIPs = Object.entries(ipCounts)
      .filter(([, count]) => count > 10)
      .map(([ip]) => ip);

    // Top endpoints by event count
    const topEndpoints = Object.entries(endpointCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([endpoint, count]) => ({ endpoint, count }));

    return {
      totalEvents: relevantEvents.length,
      eventsByType: eventsByType as Record<SecurityEventType, number>,
      eventsBySeverity: eventsBySeverity as Record<SecurityEventSeverity, number>,
      recentEvents: relevantEvents.slice(-20), // Last 20 events
      suspiciousIPs,
      topEndpoints,
    };
  }

  /**
   * Get events by type
   */
  public getEventsByType(type: SecurityEventType, limit: number = 100): SecurityEvent[] {
    return this.events
      .filter(event => event.type === type)
      .slice(-limit);
  }

  /**
   * Get events by severity
   */
  public getEventsBySeverity(severity: SecurityEventSeverity, limit: number = 100): SecurityEvent[] {
    return this.events
      .filter(event => event.severity === severity)
      .slice(-limit);
  }

  /**
   * Check for suspicious patterns
   */
  private checkSuspiciousPatterns(event: SecurityEvent): void {
    this.suspiciousActivityPatterns.forEach(pattern => {
      if (pattern.type === event.type) {
        const recentEvents = this.getRecentEventsByType(pattern.type, pattern.timeWindow);
        
        if (recentEvents.length >= pattern.threshold) {
          this.handleSuspiciousPattern(pattern, recentEvents);
        }
      }
    });
  }

  /**
   * Handle suspicious pattern detection
   */
  private handleSuspiciousPattern(pattern: SecurityEventPattern, events: SecurityEvent[]): void {
    const message = `Suspicious pattern detected: ${pattern.threshold} ${pattern.type} events in ${pattern.timeWindow}ms`;
    
    switch (pattern.action) {
      case 'ALERT':
        this.logSecurityEvent(
          SecurityEventType.SUSPICIOUS_ACTIVITY,
          SecurityEventSeverity.HIGH,
          message,
          {},
          undefined,
          { pattern, eventCount: events.length },
        );
        break;
      case 'BLOCK':
        this.logSecurityEvent(
          SecurityEventType.SUSPICIOUS_ACTIVITY,
          SecurityEventSeverity.CRITICAL,
          `${message} - Blocking recommended`,
          {},
          undefined,
          { pattern, eventCount: events.length, action: 'BLOCK_RECOMMENDED' },
        );
        break;
      case 'LOG':
      default:
        // Already logged, no additional action needed
        break;
    }
  }

  /**
   * Get recent events by type within time window
   */
  private getRecentEventsByType(type: SecurityEventType, timeWindow: number): SecurityEvent[] {
    const now = Date.now();
    const windowStart = now - timeWindow;
    
    return this.events.filter(event => 
      event.type === type && 
      event.timestamp.getTime() >= windowStart,
    );
  }

  /**
   * Sanitize message to prevent log injection
   */
  private sanitizeMessage(message: string): string {
    return message
      .replace(/[\r\n]/g, ' ')
      .replace(/\t/g, ' ')
      .substring(0, 500); // Limit message length
  }

  /**
   * Sanitize event details
   */
  private sanitizeDetails(details: SecurityEventDetails): SecurityEventDetails {
    const sanitized = { ...details };
    
    // Remove or mask sensitive information
    if (sanitized.errorMessage) {
      sanitized.errorMessage = this.sanitizeMessage(sanitized.errorMessage);
    }
    
    return sanitized;
  }

  /**
   * Sanitize user context
   */
  private sanitizeUserContext(userContext?: SecurityEvent['userContext']): SecurityEvent['userContext'] {
    if (!userContext) return undefined;
    
    return {
      userId: userContext.userId ? this.maskSensitiveData(userContext.userId) : undefined,
      ip: userContext.ip,
      userAgent: userContext.userAgent ? userContext.userAgent.substring(0, 200) : undefined,
    };
  }

  /**
   * Sanitize metadata
   */
  private sanitizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!metadata) return undefined;
    
    const sanitized: Record<string, unknown> = {};
    
    Object.entries(metadata).forEach(([key, value]) => {
      // Skip sensitive keys
      if (this.isSensitiveKey(key)) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'string') {
        sanitized[key] = value.substring(0, 200);
      } else {
        sanitized[key] = value;
      }
    });
    
    return sanitized;
  }

  /**
   * Check if key contains sensitive information
   */
  private isSensitiveKey(key: string): boolean {
    const sensitivePatterns = [
      /password/i,
      /secret/i,
      /key/i,
      /token/i,
      /auth/i,
      /credential/i,
    ];
    
    return sensitivePatterns.some(pattern => pattern.test(key));
  }

  /**
   * Mask sensitive data
   */
  private maskSensitiveData(data: string): string {
    if (data.length <= 4) return '***';
    return data.substring(0, 2) + '*'.repeat(data.length - 4) + data.substring(data.length - 2);
  }

  /**
   * Generate unique event ID
   */
  private generateEventId(): string {
    return generateSecureId('sec', 9);
  }

  /**
   * Write event to log file
   */
  private writeToLogFile(event: SecurityEvent): void {
    try {
      const logEntry = `${JSON.stringify(event)  }\n`;
      
      // Check log file size and rotate if necessary
      this.rotateLogFileIfNeeded();
      
      fs.appendFileSync(this.logFilePath, logEntry);
    } catch (error) {
      console.error('Failed to write security event to log file:', error);
    }
  }

  /**
   * Log to console based on severity
   */
  private logToConsole(event: SecurityEvent): void {
    const logMessage = `[SECURITY] ${event.severity} - ${event.type}: ${event.message}`;
    
    switch (event.severity) {
      case SecurityEventSeverity.CRITICAL:
        console.error(logMessage);
        break;
      case SecurityEventSeverity.HIGH:
        console.warn(logMessage);
        break;
      case SecurityEventSeverity.MEDIUM:
        console.log(logMessage);
        break;
      case SecurityEventSeverity.LOW:
        // Only log in development or verbose mode
        if (process.env.NODE_ENV === 'development' || process.env.VERBOSE_LOGGING === 'true') {
          console.log(logMessage);
        }
        break;
    }
  }

  /**
   * Ensure log directory exists
   */
  private ensureLogDirectory(): void {
    const logDir = path.dirname(this.logFilePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  /**
   * Rotate log file if it exceeds max size
   */
  private rotateLogFileIfNeeded(): void {
    try {
      if (fs.existsSync(this.logFilePath)) {
        const stats = fs.statSync(this.logFilePath);
        if (stats.size > this.maxLogSize) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const rotatedPath = this.logFilePath.replace('.log', `_${timestamp}.log`);
          fs.renameSync(this.logFilePath, rotatedPath);
        }
      }
    } catch (error) {
      console.error('Failed to rotate log file:', error);
    }
  }

  /**
   * Initialize CloudWatch integration
   */
  private initializeCloudWatch(): void {
    if (CloudWatchLogs && process.env.AWS_REGION) {
      try {
        this.cloudWatchClient = new CloudWatchLogs.CloudWatchLogsClient({
          region: process.env.AWS_REGION,
        });
        
        this.logger.log(
          LogLevel.INFO,
          LogCategory.SYSTEM,
          'CloudWatch integration initialized for security logging',
          { logGroup: this.cloudWatchLogGroup, logStream: this.cloudWatchLogStream },
        );
      } catch (error) {
        this.logger.log(
          LogLevel.WARN,
          LogCategory.SYSTEM,
          'Failed to initialize CloudWatch integration',
          { error: error instanceof Error ? error.message : 'Unknown error' },
        );
      }
    }
  }

  /**
   * Send security event to CloudWatch
   */
  private async sendToCloudWatch(event: SecurityEvent): Promise<void> {
    if (!this.cloudWatchClient) return;

    try {
      const logEvent = {
        timestamp: event.timestamp.getTime(),
        message: JSON.stringify({
          ...event,
          timestamp: event.timestamp.toISOString(),
        }),
      };

      if (!CloudWatchLogs) return;

      const command = new CloudWatchLogs.PutLogEventsCommand({
        logGroupName: this.cloudWatchLogGroup,
        logStreamName: this.cloudWatchLogStream,
        logEvents: [logEvent],
      });

      await this.cloudWatchClient.send(command);
    } catch (error: unknown) {
      // If log stream doesn't exist, try to create it
      if (error && typeof error === 'object' && 'name' in error && error.name === 'ResourceNotFoundException') {
        try {
          await this.createCloudWatchLogStream();
          // Retry sending the event
          if (!CloudWatchLogs) return;

          const command = new CloudWatchLogs.PutLogEventsCommand({
            logGroupName: this.cloudWatchLogGroup,
            logStreamName: this.cloudWatchLogStream,
            logEvents: [{
              timestamp: event.timestamp.getTime(),
              message: JSON.stringify({
                ...event,
                timestamp: event.timestamp.toISOString(),
              }),
            }],
          });
          await this.cloudWatchClient.send(command);
        } catch (createError) {
          this.logger.log(
            LogLevel.ERROR,
            LogCategory.SYSTEM,
            'Failed to create CloudWatch log stream',
            { error: createError instanceof Error ? createError.message : 'Unknown error' },
          );
        }
      } else {
        this.logger.log(
          LogLevel.ERROR,
          LogCategory.SYSTEM,
          'Failed to send security event to CloudWatch',
          { error: error instanceof Error ? error.message : 'Unknown error' },
        );
      }
    }
  }

  /**
   * Create CloudWatch log stream
   */
  private async createCloudWatchLogStream(): Promise<void> {
    if (!this.cloudWatchClient || !CloudWatchLogs) return;

    const command = new CloudWatchLogs.CreateLogStreamCommand({
      logGroupName: this.cloudWatchLogGroup,
      logStreamName: this.cloudWatchLogStream,
    });

    await this.cloudWatchClient.send(command);

    this.logger.log(
      LogLevel.INFO,
      LogCategory.SYSTEM,
      'CloudWatch log stream created',
      { logGroup: this.cloudWatchLogGroup, logStream: this.cloudWatchLogStream },
    );
  }

  /**
   * Get security alerts for suspicious activities
   */
  public getSecurityAlerts(timeWindow: number = 24 * 60 * 60 * 1000): Array<{
    type: SecurityEventType;
    count: number;
    severity: SecurityEventSeverity;
    lastOccurrence: Date;
    affectedIPs: string[];
  }> {
    const now = Date.now();
    const windowStart = now - timeWindow;
    
    const recentEvents = this.events.filter(event =>
      event.timestamp.getTime() >= windowStart &&
      event.severity !== SecurityEventSeverity.LOW,
    );

    const alertMap: Partial<Record<SecurityEventType, {
      count: number;
      severity: SecurityEventSeverity;
      lastOccurrence: Date;
      ips: Set<string>;
    }>> = {};

    recentEvents.forEach(event => {
      if (!alertMap[event.type]) {
        alertMap[event.type] = {
          count: 0,
          severity: event.severity,
          lastOccurrence: event.timestamp,
          ips: new Set(),
        };
      }

      const alert = alertMap[event.type]!; // Non-null assertion after initialization
      alert.count++;
      if (event.timestamp > alert.lastOccurrence) {
        alert.lastOccurrence = event.timestamp;
        alert.severity = event.severity;
      }

      if (event.userContext?.ip) {
        alert.ips.add(event.userContext.ip);
      }
    });

    type AlertData = {
      count: number;
      severity: SecurityEventSeverity;
      lastOccurrence: Date;
      ips: Set<string>;
    };

    return (Object.entries(alertMap) as [SecurityEventType, AlertData][])
      .map(([type, data]) => ({
        type,
        count: data.count,
        severity: data.severity,
        lastOccurrence: data.lastOccurrence,
        affectedIPs: Array.from(data.ips),
      }))
      .sort((a, b) => {
        // Sort by severity first, then by count
        const severityOrder = {
          [SecurityEventSeverity.CRITICAL]: 4,
          [SecurityEventSeverity.HIGH]: 3,
          [SecurityEventSeverity.MEDIUM]: 2,
          [SecurityEventSeverity.LOW]: 1,
        };
        
        const severityDiff = severityOrder[b.severity] - severityOrder[a.severity];
        return severityDiff !== 0 ? severityDiff : b.count - a.count;
      });
  }

  /**
   * Export security events for analysis
   */
  public exportSecurityEvents(
    timeWindow?: number,
    eventTypes?: SecurityEventType[],
    format: 'json' | 'csv' = 'json',
  ): string {
    const now = Date.now();
    const windowStart = timeWindow ? now - timeWindow : 0;
    
    let relevantEvents = this.events.filter(event => 
      event.timestamp.getTime() >= windowStart,
    );

    if (eventTypes && eventTypes.length > 0) {
      relevantEvents = relevantEvents.filter(event => 
        eventTypes.includes(event.type),
      );
    }

    if (format === 'json') {
      return JSON.stringify(relevantEvents, null, 2);
    } else {
      // CSV format
      const headers = [
        'timestamp', 'type', 'severity', 'message', 'endpoint', 
        'method', 'userId', 'ip', 'userAgent', 'errorMessage',
      ];
      const csvRows = [headers.join(',')];
      
      relevantEvents.forEach(event => {
        const row = [
          event.timestamp.toISOString(),
          event.type,
          event.severity,
          `"${event.message.replace(/"/g, '""')}"`,
          event.details.endpoint || '',
          event.details.method || '',
          event.userContext?.userId || '',
          event.userContext?.ip || '',
          event.userContext?.userAgent ? `"${event.userContext.userAgent.replace(/"/g, '""')}"` : '',
          event.details.errorMessage ? `"${event.details.errorMessage.replace(/"/g, '""')}"` : '',
        ];
        csvRows.push(row.join(','));
      });
      
      return csvRows.join('\n');
    }
  }

  /**
   * Clear old security events
   */
  public clearOldEvents(olderThanDays: number = 30): number {
    const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
    const initialCount = this.events.length;
    
    this.events = this.events.filter(event => 
      event.timestamp.getTime() > cutoffTime,
    );

    const removedCount = initialCount - this.events.length;
    
    if (removedCount > 0) {
      this.logger.log(
        LogLevel.INFO,
        LogCategory.SYSTEM,
        `Cleared ${removedCount} old security events`,
        { olderThanDays, remainingEvents: this.events.length },
      );
    }

    return removedCount;
  }

  /**
   * Trim events in memory to prevent memory leaks
   */
  private trimEventsInMemory(): void {
    if (this.events.length > this.maxEventsInMemory) {
      this.events = this.events.slice(-this.maxEventsInMemory);
    }
  }

  /**
   * Reset instance for testing - REMOVED (no longer needed with pure DI)
   * Tests should instantiate new instances directly via constructor
   */
}

export default SecurityLoggerService;