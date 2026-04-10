import { SecurityLoggerService, SecurityEventType, SecurityEventSeverity } from './securityLogger.service';
import { LoggerService, LogLevel, LogCategory } from './logger.service';
import crypto from 'crypto';

export interface DeviceInfo {
  screenResolution?: string;
  timezone?: string;
  language?: string;
  platform?: string;
}

export interface DeviceFingerprint {
  id: string;
  userAgent: string;
  platform: string;
  screenResolution?: string;
  timezone: string;
  language: string;
  ipAddress: string;
  browserFingerprint: string;
  createdAt: number;
  lastSeen: number;
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  deviceFingerprint: DeviceFingerprint;
  createdAt: number;
  lastActivity: number;
  expiresAt: number;
  ipAddress: string;
  userAgent: string;
  isActive: boolean;
  location?: GeoLocation;
  riskScore: number;
  flags: SessionFlag[];
}

export interface GeoLocation {
  country: string;
  region: string;
  city: string;
  latitude?: number;
  longitude?: number;
  timezone: string;
}

export enum SessionFlag {
  NEW_DEVICE = 'NEW_DEVICE',
  NEW_LOCATION = 'NEW_LOCATION',
  SUSPICIOUS_ACTIVITY = 'SUSPICIOUS_ACTIVITY',
  CONCURRENT_LIMIT_EXCEEDED = 'CONCURRENT_LIMIT_EXCEEDED',
  DEVICE_MISMATCH = 'DEVICE_MISMATCH',
  GEOLOCATION_ANOMALY = 'GEOLOCATION_ANOMALY',
  RAPID_LOCATION_CHANGE = 'RAPID_LOCATION_CHANGE',
  UNUSUAL_ACTIVITY_PATTERN = 'UNUSUAL_ACTIVITY_PATTERN'
}

export interface SessionSecurityConfig {
  maxConcurrentSessions: number;
  sessionTimeoutMs: number;
  deviceFingerprintRequired: boolean;
  enableGeolocationTracking: boolean;
  enableDeviceBinding: boolean;
  suspiciousActivityThreshold: number;
  maxLocationChangeSpeed: number; // km/h
  enableSessionMonitoring: boolean;
  autoLogoutOnSuspiciousActivity: boolean;
}

export interface SessionSecurityResult {
  allowed: boolean;
  sessionInfo?: SessionInfo;
  reason?: string;
  flags: SessionFlag[];
  riskScore: number;
  requiresAdditionalAuth?: boolean;
}

export interface SessionActivity {
  sessionId: string;
  timestamp: number;
  activity: string;
  endpoint: string;
  method: string;
  ipAddress: string;
  userAgent: string;
  responseTime: number;
  statusCode: number;
}

export class SessionSecurityService {
  private initialized: boolean = false;

  // Storage for session data
  private activeSessions: Map<string, SessionInfo> = new Map(); // key: sessionId
  private userSessions: Map<string, Set<string>> = new Map(); // key: userId, value: Set of sessionIds
  private deviceFingerprints: Map<string, DeviceFingerprint> = new Map(); // key: deviceId
  private sessionActivities: Map<string, SessionActivity[]> = new Map(); // key: sessionId
  private suspiciousActivities: Map<string, number> = new Map(); // key: sessionId, value: score

  private config: SessionSecurityConfig = {
    maxConcurrentSessions: 3,
    sessionTimeoutMs: 24 * 60 * 60 * 1000, // 24 hours
    deviceFingerprintRequired: true,
    enableGeolocationTracking: true,
    enableDeviceBinding: true,
    suspiciousActivityThreshold: 75,
    maxLocationChangeSpeed: 1000, // km/h (reasonable for air travel)
    enableSessionMonitoring: true,
    autoLogoutOnSuspiciousActivity: true,
  };

  private cleanupInterval: NodeJS.Timeout | null = null;

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private logger: LoggerService,
    private securityLogger: SecurityLoggerService,
  ) {
    // Lightweight constructor - all dependencies injected explicitly
  }

  /**
   * Initialize the session security service
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Dependencies are already injected via constructor
    // Clean up expired sessions periodically
    this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000); // Every 5 minutes

    this.initialized = true;
    this.logger.info('SessionSecurityService initialized', {
      context: 'SessionSecurityService',
      config: this.config,
    });
  }

  /**
   * Safe logging helper that checks if logger is initialized
   */
  private safeLog(level: LogLevel, category: LogCategory, message: string, data?: Record<string, unknown>): void {
    if (this.logger) {
      this.logger.log(level, category, message, data);
    }
  }

  /**
   * Safe security logging helper
   */
  private safeSecurityLog(event: 'created' | 'expired' | 'revoked' | string, userId?: string, sessionId?: string, ipAddress?: string, metadata?: Record<string, unknown>): void {
    if (this.securityLogger && userId) {
      const metadataString = metadata ? JSON.stringify(metadata) : undefined;
      this.securityLogger.logSessionEvent(event as 'created' | 'expired' | 'revoked', userId, sessionId, ipAddress, metadataString);
    }
  }

  /**
   * Create a new session with security checks
   */
  public async createSession(
    userId: string,
    ipAddress: string,
    userAgent: string,
    deviceInfo?: DeviceInfo,
    location?: GeoLocation,
  ): Promise<SessionSecurityResult> {
    try {
      // Generate device fingerprint
      const deviceFingerprint = this.generateDeviceFingerprint(
        userAgent,
        ipAddress,
        deviceInfo,
      );

      // Check concurrent session limits
      const concurrentCheck = this.checkConcurrentSessions(userId);
      if (!concurrentCheck.allowed) {
        return concurrentCheck;
      }

      // Check device binding if enabled
      let flags: SessionFlag[] = [];
      let riskScore = 0;
      
      if (this.config.enableDeviceBinding) {
        const deviceCheck = this.checkDeviceBinding(userId, deviceFingerprint);
        if (!deviceCheck.allowed) {
          return deviceCheck;
        }
        // Merge device binding flags and risk score
        flags = flags.concat(deviceCheck.flags);
        riskScore += deviceCheck.riskScore;
      }

      // Check geolocation anomalies if enabled
      
      if (this.config.enableGeolocationTracking && location) {
        const geoCheck = this.checkGeolocationAnomaly(userId, location);
        flags = flags.concat(geoCheck.flags);
        riskScore += geoCheck.riskScore;
      }

      // Create session
      const sessionId = this.generateSessionId();
      const now = Date.now();
      
      const sessionInfo: SessionInfo = {
        sessionId,
        userId,
        deviceFingerprint,
        createdAt: now,
        lastActivity: now,
        expiresAt: now + this.config.sessionTimeoutMs,
        ipAddress,
        userAgent,
        isActive: true,
        location,
        riskScore,
        flags,
      };

      // Store session
      this.activeSessions.set(sessionId, sessionInfo);
      
      // Update user sessions
      if (!this.userSessions.has(userId)) {
        this.userSessions.set(userId, new Set());
      }
      this.userSessions.get(userId)!.add(sessionId);

      // Store device fingerprint
      this.deviceFingerprints.set(deviceFingerprint.id, deviceFingerprint);

      // Log session creation
      this.securityLogger.logSessionEvent(
        'created',
        userId,
        sessionId,
        ipAddress,
        userAgent,
        {
          deviceId: deviceFingerprint.id,
          riskScore,
          flags: flags.join(','),
          location: location ? `${location.city}, ${location.country}` : undefined,
        },
      );

      // Log security events for flagged sessions
      if (flags.length > 0) {
        this.logSessionFlags(sessionInfo, flags);
      }

      return {
        allowed: true,
        sessionInfo,
        flags,
        riskScore,
        requiresAdditionalAuth: riskScore > this.config.suspiciousActivityThreshold,
      };

    } catch (error) {
      this.logger.log(
        LogLevel.ERROR,
        LogCategory.SECURITY,
        'Failed to create session',
        { userId, error: error instanceof Error ? error.message : 'Unknown error' },
      );

      return {
        allowed: false,
        reason: 'SESSION_CREATION_FAILED',
        flags: [],
        riskScore: 100,
      };
    }
  }

  /**
   * Validate and update existing session
   */
  public validateSession(
    sessionId: string,
    ipAddress: string,
    userAgent: string,
    endpoint?: string,
  ): SessionSecurityResult {
    const session = this.activeSessions.get(sessionId);
    
    if (!session) {
      return {
        allowed: false,
        reason: 'SESSION_NOT_FOUND',
        flags: [],
        riskScore: 100,
      };
    }

    if (!session.isActive) {
      return {
        allowed: false,
        reason: 'SESSION_INACTIVE',
        flags: [],
        riskScore: 100,
      };
    }

    const now = Date.now();
    
    // Check session expiration
    if (now > session.expiresAt) {
      this.expireSession(sessionId, 'TIMEOUT');
      return {
        allowed: false,
        reason: 'SESSION_EXPIRED',
        flags: [],
        riskScore: 100,
      };
    }

    // Check device fingerprint consistency
    const flags: SessionFlag[] = [];
    let riskScore = session.riskScore;

    if (this.config.enableDeviceBinding) {
      const deviceCheck = this.validateDeviceFingerprint(session, userAgent, ipAddress);
      if (!deviceCheck.valid) {
        flags.push(SessionFlag.DEVICE_MISMATCH);
        riskScore += 30;
        
        this.securityLogger.logDeviceSecurityEvent(
          'fingerprint_mismatch',
          session.userId,
          ipAddress,
          userAgent,
          {
            sessionId,
            expectedFingerprint: session.deviceFingerprint.browserFingerprint,
            actualFingerprint: this.generateBrowserFingerprint(userAgent, ipAddress),
          },
        );
      }
    }

    // Check for suspicious activity patterns
    if (this.config.enableSessionMonitoring) {
      const activityCheck = this.checkSuspiciousActivity(session, endpoint);
      if (activityCheck.suspicious) {
        flags.push(SessionFlag.SUSPICIOUS_ACTIVITY);
        riskScore += activityCheck.riskIncrease;
      }
    }

    // Update session activity
    session.lastActivity = now;
    session.riskScore = riskScore;
    session.flags = [...new Set([...session.flags, ...flags])]; // Merge flags, remove duplicates

    // Record activity
    if (endpoint) {
      this.recordSessionActivity(sessionId, endpoint, 'GET', ipAddress, userAgent, 200, 0);
    }

    // Auto-logout on high risk
    if (this.config.autoLogoutOnSuspiciousActivity && riskScore > this.config.suspiciousActivityThreshold) {
      this.expireSession(sessionId, 'SUSPICIOUS_ACTIVITY');
      return {
        allowed: false,
        reason: 'SESSION_TERMINATED_SUSPICIOUS',
        flags,
        riskScore,
      };
    }

    return {
      allowed: true,
      sessionInfo: session,
      flags,
      riskScore,
      requiresAdditionalAuth: riskScore > this.config.suspiciousActivityThreshold * 0.8,
    };
  }

  /**
   * Expire a session
   */
  public expireSession(sessionId: string, reason: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;

    session.isActive = false;
    
    // Remove from user sessions
    const userSessions = this.userSessions.get(session.userId);
    if (userSessions) {
      userSessions.delete(sessionId);
      if (userSessions.size === 0) {
        this.userSessions.delete(session.userId);
      }
    }

    // Log session expiration
    this.securityLogger.logSessionEvent(
      'expired',
      session.userId,
      sessionId,
      session.ipAddress,
      session.userAgent,
      { reason, duration: Date.now() - session.createdAt },
    );

    this.logger.log(
      LogLevel.INFO,
      LogCategory.SECURITY,
      `Session expired: ${sessionId}`,
      { userId: session.userId, reason, sessionDuration: Date.now() - session.createdAt },
    );

    return true;
  }

  /**
   * Revoke all sessions for a user
   */
  public revokeUserSessions(userId: string, exceptSessionId?: string): number {
    const userSessions = this.userSessions.get(userId);
    if (!userSessions) return 0;

    let revokedCount = 0;
    const sessionsToRevoke = Array.from(userSessions).filter(id => id !== exceptSessionId);

    sessionsToRevoke.forEach(sessionId => {
      if (this.expireSession(sessionId, 'ADMIN_REVOKED')) {
        revokedCount++;
      }
    });

    this.logger.log(
      LogLevel.INFO,
      LogCategory.SECURITY,
      `Revoked ${revokedCount} sessions for user: ${userId}`,
      { userId, revokedCount, exceptSessionId },
    );

    return revokedCount;
  }

  /**
   * Check concurrent session limits
   */
  private checkConcurrentSessions(userId: string): SessionSecurityResult {
    const userSessions = this.userSessions.get(userId);
    const activeSessionCount = userSessions ? userSessions.size : 0;

    if (activeSessionCount >= this.config.maxConcurrentSessions) {
      this.securityLogger.logDeviceSecurityEvent(
        'concurrent_session_limit',
        userId,
        undefined,
        undefined,
        {
          currentSessions: activeSessionCount,
          maxSessions: this.config.maxConcurrentSessions,
        },
      );

      return {
        allowed: false,
        reason: 'CONCURRENT_SESSION_LIMIT_EXCEEDED',
        flags: [SessionFlag.CONCURRENT_LIMIT_EXCEEDED],
        riskScore: 50,
      };
    }

    return {
      allowed: true,
      flags: [],
      riskScore: 0,
    };
  }

  /**
   * Check device binding
   */
  private checkDeviceBinding(userId: string, deviceFingerprint: DeviceFingerprint): SessionSecurityResult {
    const existingDevice = this.deviceFingerprints.get(deviceFingerprint.id);
    const flags: SessionFlag[] = [];
    let riskScore = 0;

    if (!existingDevice) {
      // New device - always flag as new device
      flags.push(SessionFlag.NEW_DEVICE);
      riskScore += 20;

      this.logger.log(
        LogLevel.INFO,
        LogCategory.SECURITY,
        `New device detected for user: ${userId}`,
        { userId, deviceId: deviceFingerprint.id },
      );
    } else {
      // Update last seen
      existingDevice.lastSeen = Date.now();
    }

    return {
      allowed: true,
      flags,
      riskScore,
    };
  }

  /**
   * Check geolocation anomalies
   */
  private checkGeolocationAnomaly(userId: string, location: GeoLocation): { flags: SessionFlag[]; riskScore: number } {
    const flags: SessionFlag[] = [];
    let riskScore = 0;

    // Get user's recent sessions to check for location changes
    const userSessions = this.userSessions.get(userId);
    if (!userSessions) {
      flags.push(SessionFlag.NEW_LOCATION);
      return { flags, riskScore: 10 };
    }

    const recentSessions = Array.from(userSessions)
      .map(sessionId => this.activeSessions.get(sessionId))
      .filter(session => session && session.location)
      .sort((a, b) => b!.lastActivity - a!.lastActivity);

    if (recentSessions.length === 0) {
      flags.push(SessionFlag.NEW_LOCATION);
      return { flags, riskScore: 10 };
    }

    const lastSession = recentSessions[0]!;
    const lastLocation = lastSession.location!;

    // Check if location is significantly different
    if (location.country !== lastLocation.country) {
      flags.push(SessionFlag.NEW_LOCATION);
      riskScore += 25;

      // Check for rapid location changes (impossible travel)
      const timeDiff = Date.now() - lastSession.lastActivity;
      const distance = this.calculateDistance(
        lastLocation.latitude || 0,
        lastLocation.longitude || 0,
        location.latitude || 0,
        location.longitude || 0,
      );

      const speed = distance / (timeDiff / (1000 * 60 * 60)); // km/h
      if (speed > this.config.maxLocationChangeSpeed) {
        flags.push(SessionFlag.RAPID_LOCATION_CHANGE);
        riskScore += 40;

        this.securityLogger.logDeviceSecurityEvent(
          'geolocation_anomaly',
          userId,
          undefined,
          undefined,
          {
            previousLocation: `${lastLocation.city}, ${lastLocation.country}`,
            currentLocation: `${location.city}, ${location.country}`,
            distance: `${distance.toFixed(2)} km`,
            timeDifference: `${(timeDiff / (1000 * 60)).toFixed(2)} minutes`,
            calculatedSpeed: `${speed.toFixed(2)} km/h`,
          },
        );
      }
    }

    return { flags, riskScore };
  }

  /**
   * Validate device fingerprint consistency
   */
  private validateDeviceFingerprint(
    session: SessionInfo,
    userAgent: string,
    ipAddress: string,
  ): { valid: boolean; reason?: string } {
    const currentFingerprint = this.generateBrowserFingerprint(userAgent, ipAddress);
    const expectedFingerprint = session.deviceFingerprint.browserFingerprint;

    // Allow some flexibility for minor changes (browser updates, etc.)
    const similarity = this.calculateFingerprintSimilarity(currentFingerprint, expectedFingerprint);
    
    if (similarity < 0.9) { // More strict threshold for better security
      return {
        valid: false,
        reason: 'FINGERPRINT_MISMATCH',
      };
    }

    return { valid: true };
  }

  /**
   * Check for suspicious activity patterns
   */
  private checkSuspiciousActivity(
    session: SessionInfo,
    endpoint?: string,
  ): { suspicious: boolean; riskIncrease: number } {
    const activities = this.sessionActivities.get(session.sessionId) || [];
    const recentActivities = activities.filter(a => Date.now() - a.timestamp < 5 * 60 * 1000); // Last 5 minutes

    let riskIncrease = 0;
    let suspicious = false;

    // Check for rapid requests
    if (recentActivities.length > 100) {
      suspicious = true;
      riskIncrease += 30;
    }

    // Check for unusual endpoint patterns
    const uniqueEndpoints = new Set(recentActivities.map(a => a.endpoint));
    if (uniqueEndpoints.size > 20) {
      suspicious = true;
      riskIncrease += 20;
    }

    // Check for error patterns
    const errorCount = recentActivities.filter(a => a.statusCode >= 400).length;
    if (errorCount > 10) {
      suspicious = true;
      riskIncrease += 15;
    }

    return { suspicious, riskIncrease };
  }

  /**
   * Record session activity
   */
  public recordSessionActivity(
    sessionId: string,
    endpoint: string,
    method: string,
    ipAddress: string,
    userAgent: string,
    statusCode: number,
    responseTime: number,
  ): void {
    const activity: SessionActivity = {
      sessionId,
      timestamp: Date.now(),
      activity: `${method} ${endpoint}`,
      endpoint,
      method,
      ipAddress,
      userAgent,
      responseTime,
      statusCode,
    };

    if (!this.sessionActivities.has(sessionId)) {
      this.sessionActivities.set(sessionId, []);
    }

    const activities = this.sessionActivities.get(sessionId)!;
    activities.push(activity);

    // Keep only recent activities to prevent memory leaks
    const cutoff = Date.now() - (60 * 60 * 1000); // 1 hour
    const recentActivities = activities.filter(a => a.timestamp > cutoff);
    this.sessionActivities.set(sessionId, recentActivities);
  }

  /**
   * Generate device fingerprint
   */
  private generateDeviceFingerprint(
    userAgent: string,
    ipAddress: string,
    deviceInfo?: DeviceInfo,
  ): DeviceFingerprint {
    const id = this.generateDeviceId(userAgent, ipAddress, deviceInfo);
    const browserFingerprint = this.generateBrowserFingerprint(userAgent, ipAddress);

    return {
      id,
      userAgent,
      platform: this.extractPlatform(userAgent),
      screenResolution: deviceInfo?.screenResolution,
      timezone: deviceInfo?.timezone || 'UTC',
      language: deviceInfo?.language || 'en',
      ipAddress,
      browserFingerprint,
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
  }

  /**
   * Generate unique device ID
   */
  private generateDeviceId(userAgent: string, ipAddress: string, deviceInfo?: DeviceInfo): string {
    const components = [
      userAgent,
      deviceInfo?.screenResolution || '',
      deviceInfo?.timezone || '',
      deviceInfo?.language || '',
      this.extractPlatform(userAgent),
    ].join('|');

    return crypto.createHash('sha256').update(components).digest('hex').substring(0, 16);
  }

  /**
   * Generate browser fingerprint
   */
  private generateBrowserFingerprint(userAgent: string, ipAddress: string): string {
    const components = [
      userAgent,
      this.extractPlatform(userAgent),
      ipAddress.split('.').slice(0, 3).join('.'), // Partial IP for some stability
    ].join('|');

    return crypto.createHash('md5').update(components).digest('hex');
  }

  /**
   * Extract platform from user agent
   */
  private extractPlatform(userAgent: string): string {
    if (userAgent.includes('Windows')) return 'Windows';
    if (userAgent.includes('Macintosh')) return 'macOS';
    if (userAgent.includes('Linux')) return 'Linux';
    if (userAgent.includes('iPhone')) return 'iOS';
    if (userAgent.includes('Android')) return 'Android';
    return 'Unknown';
  }

  /**
   * Calculate fingerprint similarity
   */
  private calculateFingerprintSimilarity(fp1: string, fp2: string): number {
    if (fp1 === fp2) return 1.0;
    
    // More strict similarity calculation - check for exact hash match first
    if (fp1.length !== fp2.length) return 0.0;
    
    // Count matching characters at same positions
    let matches = 0;
    for (let i = 0; i < fp1.length; i++) {
      if (fp1[i] === fp2[i]) {
        matches++;
      }
    }
    
    return matches / fp1.length;
  }

  /**
   * Calculate distance between two coordinates
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's radius in km
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Convert degrees to radians
   */
  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    return `sess_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`;
  }

  /**
   * Log session flags
   */
  private logSessionFlags(session: SessionInfo, flags: SessionFlag[]): void {
    flags.forEach(flag => {
      let eventType = SecurityEventType.SUSPICIOUS_ACTIVITY;
      let severity = SecurityEventSeverity.MEDIUM;

      switch (flag) {
        case SessionFlag.DEVICE_MISMATCH:
          eventType = SecurityEventType.DEVICE_FINGERPRINT_MISMATCH;
          severity = SecurityEventSeverity.HIGH;
          break;
        case SessionFlag.CONCURRENT_LIMIT_EXCEEDED:
          eventType = SecurityEventType.CONCURRENT_SESSION_LIMIT_EXCEEDED;
          severity = SecurityEventSeverity.HIGH;
          break;
        case SessionFlag.GEOLOCATION_ANOMALY:
        case SessionFlag.RAPID_LOCATION_CHANGE:
          eventType = SecurityEventType.GEOLOCATION_ANOMALY;
          severity = SecurityEventSeverity.HIGH;
          break;
        case SessionFlag.NEW_DEVICE:
        case SessionFlag.NEW_LOCATION:
          severity = SecurityEventSeverity.LOW;
          break;
      }

      this.securityLogger.logSecurityEvent(
        eventType,
        severity,
        `Session flag detected: ${flag}`,
        { method: 'SESSION_SECURITY' },
        { userId: session.userId, ip: session.ipAddress, userAgent: session.userAgent },
        { sessionId: session.sessionId, flag, riskScore: session.riskScore },
      );
    });
  }

  /**
   * Clean up expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [sessionId, session] of this.activeSessions.entries()) {
      if (now > session.expiresAt || !session.isActive) {
        this.activeSessions.delete(sessionId);
        this.sessionActivities.delete(sessionId);
        
        // Remove from user sessions
        const userSessions = this.userSessions.get(session.userId);
        if (userSessions) {
          userSessions.delete(sessionId);
          if (userSessions.size === 0) {
            this.userSessions.delete(session.userId);
          }
        }
        
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(
        LogLevel.DEBUG,
        LogCategory.SYSTEM,
        `Cleaned up ${cleanedCount} expired sessions`,
      );
    }
  }

  /**
   * Get session statistics
   */
  public getSessionStats(): {
    totalActiveSessions: number;
    totalUsers: number;
    averageSessionsPerUser: number;
    sessionsWithFlags: number;
    highRiskSessions: number;
    deviceCount: number;
  } {
    const totalActiveSessions = this.activeSessions.size;
    const totalUsers = this.userSessions.size;
    const averageSessionsPerUser = totalUsers > 0 ? totalActiveSessions / totalUsers : 0;
    
    let sessionsWithFlags = 0;
    let highRiskSessions = 0;
    
    for (const session of this.activeSessions.values()) {
      if (session.flags.length > 0) sessionsWithFlags++;
      if (session.riskScore > this.config.suspiciousActivityThreshold) highRiskSessions++;
    }

    return {
      totalActiveSessions,
      totalUsers,
      averageSessionsPerUser: Math.round(averageSessionsPerUser * 100) / 100,
      sessionsWithFlags,
      highRiskSessions,
      deviceCount: this.deviceFingerprints.size,
    };
  }

  /**
   * Get user sessions
   */
  public getUserSessions(userId: string): SessionInfo[] {
    const userSessionIds = this.userSessions.get(userId);
    if (!userSessionIds) return [];

    return Array.from(userSessionIds)
      .map(sessionId => this.activeSessions.get(sessionId))
      .filter(session => session !== undefined) as SessionInfo[];
  }

  /**
   * Get session by ID
   */
  public getSession(sessionId: string): SessionInfo | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<SessionSecurityConfig>): void {
    this.config = { ...this.config, ...config };
    
    this.logger.log(
      LogLevel.INFO,
      LogCategory.SYSTEM,
      'Session security configuration updated',
      { config },
    );
  }

  /**
   * Get current configuration
   */
  public getConfig(): SessionSecurityConfig {
    return { ...this.config };
  }

  /**
   * Cleanup method for testing
   */
  public cleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Reset instance for testing - REMOVED (no longer needed with pure DI)
   * Tests should instantiate new instances directly via constructor
   */
}

export default SessionSecurityService;