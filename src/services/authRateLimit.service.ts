import { SecurityLoggerService, SecurityEventType, SecurityEventSeverity } from './securityLogger.service';
import { LoggerService, LogLevel, LogCategory } from './logger.service';
import { generateSecureId } from '../utils/secure-id.utils';

export interface AuthAttempt {
  timestamp: number;
  success: boolean;
  ip: string;
  userAgent?: string;
  userId?: string;
  endpoint: string;
  errorType?: string;
}

export interface BruteForceConfig {
  maxFailedAttempts: number;
  windowMs: number;
  lockoutDurationMs: number;
  progressiveLockout: boolean;
  maxLockoutDurationMs: number;
  lockoutMultiplier: number;
  enableCaptcha: boolean;
  captchaThreshold: number;
  whitelistedIPs: string[];
  enableGeolocationCheck: boolean;
}

export interface AccountLockoutInfo {
  userId: string;
  lockedAt: number;
  unlockAt: number;
  failedAttempts: number;
  lockoutReason: string;
  lockoutLevel: number;
  requiresCaptcha: boolean;
  requiresAdminUnlock: boolean;
}

export interface IPBanInfo {
  ip: string;
  bannedAt: number;
  unbanAt: number;
  reason: string;
  attemptCount: number;
  severity: 'temporary' | 'extended' | 'permanent';
}

export interface AuthRateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfter?: number;
  requiresCaptcha: boolean;
  remainingAttempts?: number;
  lockoutInfo?: AccountLockoutInfo;
  suspiciousActivity: boolean;
}

export interface CaptchaChallenge {
  challengeId: string;
  userId?: string;
  ip: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  maxAttempts: number;
  solved: boolean;
}

export class AuthRateLimitService {
  private cleanupInterval: NodeJS.Timeout | null = null;

  // Storage for tracking attempts
  private authAttempts: Map<string, AuthAttempt[]> = new Map(); // key: ip or userId
  private accountLockouts: Map<string, AccountLockoutInfo> = new Map(); // key: userId
  private lockoutHistory: Map<string, number> = new Map(); // key: userId, value: lockout level
  private ipBans: Map<string, IPBanInfo> = new Map(); // key: ip
  private captchaChallenges: Map<string, CaptchaChallenge> = new Map(); // key: challengeId
  private suspiciousIPs: Set<string> = new Set();

  private config: BruteForceConfig = {
    maxFailedAttempts: 5,
    windowMs: 15 * 60 * 1000, // 15 minutes
    lockoutDurationMs: 30 * 60 * 1000, // 30 minutes
    progressiveLockout: true,
    maxLockoutDurationMs: 24 * 60 * 60 * 1000, // 24 hours
    lockoutMultiplier: 2,
    enableCaptcha: true,
    captchaThreshold: 3,
    whitelistedIPs: ['127.0.0.1', '::1'],
    enableGeolocationCheck: true,
  };

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private logger: LoggerService,
    private securityLogger: SecurityLoggerService,
  ) {
    // Lightweight constructor - all dependencies injected explicitly
    // Clean up expired entries periodically
    this.cleanupInterval = setInterval(() => this.cleanupExpiredEntries(), 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Check if authentication attempt is allowed
   */
  public checkAuthAttempt(
    ip: string,
    userId?: string,
    userAgent?: string,
    endpoint: string = '/auth/login',
  ): AuthRateLimitResult {
    // Check if IP is whitelisted
    if (this.config.whitelistedIPs.includes(ip)) {
      return {
        allowed: true,
        requiresCaptcha: false,
        suspiciousActivity: false,
      };
    }

    // Check if IP is banned
    const ipBan = this.ipBans.get(ip);
    if (ipBan && Date.now() < ipBan.unbanAt) {
      this.securityLogger.logSecurityEvent(
        SecurityEventType.BRUTE_FORCE_ATTEMPT,
        SecurityEventSeverity.HIGH,
        'Authentication attempt from banned IP',
        { endpoint, method: 'POST' },
        { ip, userAgent },
        { banReason: ipBan.reason, unbanAt: new Date(ipBan.unbanAt).toISOString() },
      );

      return {
        allowed: false,
        reason: 'IP_BANNED',
        retryAfter: Math.ceil((ipBan.unbanAt - Date.now()) / 1000),
        requiresCaptcha: false,
        suspiciousActivity: true,
      };
    }

    // Check account lockout if userId is provided
    if (userId) {
      const lockout = this.accountLockouts.get(userId);
      if (lockout && Date.now() < lockout.unlockAt) {
        return {
          allowed: false,
          reason: 'ACCOUNT_LOCKED',
          retryAfter: Math.ceil((lockout.unlockAt - Date.now()) / 1000),
          requiresCaptcha: lockout.requiresCaptcha,
          lockoutInfo: lockout,
          suspiciousActivity: false,
        };
      }
    }

    // Check recent failed attempts for IP
    const ipAttempts = this.getRecentAttempts(ip);
    const ipFailedAttempts = ipAttempts.filter(attempt => !attempt.success);

    // Check recent failed attempts for user
    let userFailedAttempts: AuthAttempt[] = [];
    if (userId) {
      const userAttempts = this.getRecentAttempts(userId);
      userFailedAttempts = userAttempts.filter(attempt => !attempt.success);
    }

    // Determine if CAPTCHA is required
    const requiresCaptcha = this.shouldRequireCaptcha(ipFailedAttempts, userFailedAttempts);

    // Check for suspicious activity patterns
    const suspiciousActivity = this.detectSuspiciousActivity(ip, ipAttempts, userAgent);

    // Check if attempts exceed threshold (prioritize user-specific limits over IP limits)
    const userAttemptCount = userFailedAttempts.length;
    const ipAttemptCount = ipFailedAttempts.length;
    
    // If we have a userId, check user attempts first
    if (userId && userAttemptCount >= this.config.maxFailedAttempts) {
      return {
        allowed: false,
        reason: 'TOO_MANY_ATTEMPTS',
        retryAfter: Math.ceil(this.config.windowMs / 1000),
        requiresCaptcha: true,
        remainingAttempts: 0,
        suspiciousActivity,
      };
    }
    
    // Then check IP attempts
    if (ipAttemptCount >= this.config.maxFailedAttempts) {
      return {
        allowed: false,
        reason: 'TOO_MANY_ATTEMPTS',
        retryAfter: Math.ceil(this.config.windowMs / 1000),
        requiresCaptcha: true,
        remainingAttempts: 0,
        suspiciousActivity,
      };
    }

    const maxAttempts = Math.max(userAttemptCount, ipAttemptCount);
    
    return {
      allowed: true,
      requiresCaptcha,
      remainingAttempts: this.config.maxFailedAttempts - maxAttempts,
      suspiciousActivity,
    };
  }

  /**
   * Record authentication attempt
   */
  public recordAuthAttempt(
    success: boolean,
    ip: string,
    userId?: string,
    userAgent?: string,
    endpoint: string = '/auth/login',
    errorType?: string,
  ): void {
    const attempt: AuthAttempt = {
      timestamp: Date.now(),
      success,
      ip,
      userAgent,
      userId,
      endpoint,
      errorType,
    };

    // Record attempt for IP
    this.addAttempt(ip, attempt);

    // Record attempt for user if provided
    if (userId) {
      this.addAttempt(userId, attempt);
    }

    if (!success) {
      this.handleFailedAttempt(ip, attempt, userId);
    } else {
      this.handleSuccessfulAttempt(ip, userId);
    }

    // Log the attempt
    this.securityLogger.logAuthenticationEvent(
      success,
      userId,
      ip,
      userAgent,
      { endpoint, method: 'POST', errorMessage: errorType },
    );
  }

  /**
   * Handle failed authentication attempt
   */
  private handleFailedAttempt(ip: string, attempt: AuthAttempt, userId?: string): void {
    const ipAttempts = this.getRecentAttempts(ip);
    const ipFailedAttempts = ipAttempts.filter(a => !a.success);

    // Check for account-specific attacks first (prioritize account lockout over IP ban)
    if (userId) {
      const userAttempts = this.getRecentAttempts(userId);
      const userFailedAttempts = userAttempts.filter(a => !a.success);

      if (userFailedAttempts.length >= this.config.maxFailedAttempts) {
        this.lockAccount(userId, userFailedAttempts);
      }
    }

    // Only check for IP-based brute force if no account lockout occurred
    // and if IP attempts are significantly higher (indicating distributed attack)
    if (ipFailedAttempts.length >= this.config.maxFailedAttempts * 1.5) {
      this.handleBruteForceDetection(ip, ipFailedAttempts, userId);
    }

    // Check for suspicious patterns
    if (this.detectSuspiciousActivity(ip, ipAttempts, attempt.userAgent)) {
      this.markIPAsSuspicious(ip);
    }
  }

  /**
   * Handle successful authentication attempt
   */
  private handleSuccessfulAttempt(ip: string, userId?: string): void {
    // Clear failed attempts on successful login
    if (userId) {
      const lockout = this.accountLockouts.get(userId);
      if (lockout && !lockout.requiresAdminUnlock) {
        this.unlockAccount(userId);
      }
      
      // Clear failed attempts for the user
      const userAttempts = this.authAttempts.get(userId) || [];
      const successfulAttempts = userAttempts.filter(a => a.success);
      this.authAttempts.set(userId, successfulAttempts);
    }

    // Clear failed attempts for the IP
    const ipAttempts = this.authAttempts.get(ip) || [];
    const successfulAttempts = ipAttempts.filter(a => a.success);
    this.authAttempts.set(ip, successfulAttempts);

    // Remove IP from suspicious list on successful login
    this.suspiciousIPs.delete(ip);
  }

  /**
   * Handle brute force attack detection
   */
  private handleBruteForceDetection(ip: string, failedAttempts: AuthAttempt[], userId?: string): void {
    this.securityLogger.logSecurityEvent(
      SecurityEventType.BRUTE_FORCE_ATTEMPT,
      SecurityEventSeverity.HIGH,
      `Brute force attack detected from IP ${ip}`,
      { endpoint: failedAttempts[0]?.endpoint, method: 'POST' },
      { ip, userId, userAgent: failedAttempts[0]?.userAgent },
      { attemptCount: failedAttempts.length, timeWindow: this.config.windowMs },
    );

    // Determine ban duration based on severity
    let banDuration = this.config.lockoutDurationMs;
    const existingBan = this.ipBans.get(ip);
    
    if (existingBan && this.config.progressiveLockout) {
      banDuration = Math.min(
        banDuration * this.config.lockoutMultiplier,
        this.config.maxLockoutDurationMs,
      );
    }

    // Ban the IP
    this.banIP(ip, banDuration, 'BRUTE_FORCE_ATTACK', failedAttempts.length);
  }

  /**
   * Lock user account
   */
  private lockAccount(userId: string, failedAttempts: AuthAttempt[]): void {
    const existingLockout = this.accountLockouts.get(userId);
    const previousLockoutLevel = this.lockoutHistory.get(userId) || 0;
    const lockoutLevel = previousLockoutLevel + 1;
    let lockoutDuration = this.config.lockoutDurationMs;

    // Apply progressive lockout if enabled
    if (this.config.progressiveLockout && lockoutLevel > 1) {
      lockoutDuration = Math.min(
        lockoutDuration * Math.pow(this.config.lockoutMultiplier, lockoutLevel - 1),
        this.config.maxLockoutDurationMs,
      );
    }

    const lockoutInfo: AccountLockoutInfo = {
      userId,
      lockedAt: Date.now(),
      unlockAt: Date.now() + lockoutDuration,
      failedAttempts: failedAttempts.length,
      lockoutReason: 'EXCESSIVE_FAILED_ATTEMPTS',
      lockoutLevel,
      requiresCaptcha: true,
      requiresAdminUnlock: lockoutLevel >= 3, // Require admin unlock after 3rd lockout
    };

    this.accountLockouts.set(userId, lockoutInfo);
    this.lockoutHistory.set(userId, lockoutLevel); // Store lockout level for progressive lockout

    this.securityLogger.logAccountSecurityEvent(
      'locked',
      userId,
      failedAttempts[0]?.ip,
      failedAttempts[0]?.userAgent,
      {
        lockoutLevel,
        lockoutDuration,
        failedAttempts: failedAttempts.length,
        requiresAdminUnlock: lockoutInfo.requiresAdminUnlock,
      },
    );

    this.logger.log(
      LogLevel.WARN,
      LogCategory.SECURITY,
      `Account locked due to excessive failed attempts: ${userId}`,
      {
        userId,
        lockoutLevel,
        lockoutDuration,
        failedAttempts: failedAttempts.length,
        unlockAt: new Date(lockoutInfo.unlockAt).toISOString(),
      },
    );
  }

  /**
   * Ban IP address
   */
  private banIP(ip: string, duration: number, reason: string, attemptCount: number): void {
    let severity: 'temporary' | 'extended' | 'permanent' = 'temporary';
    
    if (duration >= 24 * 60 * 60 * 1000) { // 24 hours or more
      severity = 'extended';
    }
    if (duration >= 7 * 24 * 60 * 60 * 1000) { // 7 days or more
      severity = 'permanent';
    }

    const banInfo: IPBanInfo = {
      ip,
      bannedAt: Date.now(),
      unbanAt: Date.now() + duration,
      reason,
      attemptCount,
      severity,
    };

    this.ipBans.set(ip, banInfo);

    this.logger.log(
      LogLevel.ERROR,
      LogCategory.SECURITY,
      `IP banned: ${ip}`,
      {
        ip,
        reason,
        duration,
        severity,
        attemptCount,
        unbanAt: new Date(banInfo.unbanAt).toISOString(),
      },
    );
  }

  /**
   * Detect suspicious activity patterns
   */
  private detectSuspiciousActivity(ip: string, attempts: AuthAttempt[], userAgent?: string): boolean {
    if (attempts.length < 2) return false;

    // Check for rapid-fire attempts
    const recentAttempts = attempts.filter(a => Date.now() - a.timestamp < 60000); // Last minute
    if (recentAttempts.length >= 10) {
      return true;
    }

    // Check for multiple user agents from same IP
    const userAgents = new Set(attempts.map(a => a.userAgent).filter(Boolean));
    if (userAgents.size >= 5) {
      return true;
    }

    // Check for attempts across multiple endpoints
    const endpoints = new Set(attempts.map(a => a.endpoint));
    if (endpoints.size >= 3) {
      return true;
    }

    // Check for distributed timing patterns (possible bot)
    const timings = attempts.map(a => a.timestamp).sort();
    let consistentIntervals = 0;
    for (let i = 1; i < timings.length; i++) {
      const currentTiming = timings[i];
      const previousTiming = timings[i - 1];
      if (currentTiming !== undefined && previousTiming !== undefined) {
        const interval = currentTiming - previousTiming;
        if (interval >= 1000 && interval <= 5000) { // 1-5 second intervals
          consistentIntervals++;
        }
      }
    }
    if (consistentIntervals >= 5) {
      return true;
    }

    return false;
  }

  /**
   * Mark IP as suspicious
   */
  private markIPAsSuspicious(ip: string): void {
    this.suspiciousIPs.add(ip);
    
    this.securityLogger.logSuspiciousActivity(
      'IP marked as suspicious due to attack patterns',
      ip,
      undefined,
      undefined,
      { reason: 'ATTACK_PATTERN_DETECTED' },
    );
  }

  /**
   * Check if CAPTCHA should be required
   */
  private shouldRequireCaptcha(ipFailedAttempts: AuthAttempt[], userFailedAttempts: AuthAttempt[]): boolean {
    if (!this.config.enableCaptcha) return false;

    const maxFailedAttempts = Math.max(ipFailedAttempts.length, userFailedAttempts.length);
    return maxFailedAttempts >= this.config.captchaThreshold;
  }

  /**
   * Create CAPTCHA challenge
   */
  public createCaptchaChallenge(ip: string, userId?: string): CaptchaChallenge {
    const challengeId = this.generateChallengeId();
    const challenge: CaptchaChallenge = {
      challengeId,
      userId,
      ip,
      createdAt: Date.now(),
      expiresAt: Date.now() + (10 * 60 * 1000), // 10 minutes
      attempts: 0,
      maxAttempts: 3,
      solved: false,
    };

    this.captchaChallenges.set(challengeId, challenge);

    this.logger.log(
      LogLevel.INFO,
      LogCategory.SECURITY,
      'CAPTCHA challenge created',
      { challengeId, ip, userId },
    );

    return challenge;
  }

  /**
   * Verify CAPTCHA challenge
   */
  public verifyCaptchaChallenge(challengeId: string, solution: string): boolean {
    const challenge = this.captchaChallenges.get(challengeId);
    if (!challenge) return false;

    if (Date.now() > challenge.expiresAt) {
      this.captchaChallenges.delete(challengeId);
      return false;
    }

    challenge.attempts++;

    // In a real implementation, this would verify against the actual CAPTCHA solution
    // For now, we'll simulate verification
    const isValid = this.simulateCaptchaVerification(solution);

    if (isValid) {
      challenge.solved = true;
      this.logger.log(
        LogLevel.INFO,
        LogCategory.SECURITY,
        'CAPTCHA challenge solved',
        { challengeId, ip: challenge.ip, userId: challenge.userId },
      );
    } else if (challenge.attempts >= challenge.maxAttempts) {
      this.captchaChallenges.delete(challengeId);
      this.logger.log(
        LogLevel.WARN,
        LogCategory.SECURITY,
        'CAPTCHA challenge failed - max attempts exceeded',
        { challengeId, ip: challenge.ip, userId: challenge.userId },
      );
    }

    return isValid;
  }

  /**
   * Simulate CAPTCHA verification (replace with real implementation)
   */
  private simulateCaptchaVerification(solution: string): boolean {
    // In a real implementation, this would integrate with a CAPTCHA service
    // like Google reCAPTCHA, hCaptcha, etc.
    return solution.length >= 4; // Simple simulation
  }

  /**
   * Unlock account (admin function)
   */
  public unlockAccount(userId: string): boolean {
    const lockout = this.accountLockouts.get(userId);
    if (!lockout) return false;

    // Remove from active lockouts
    this.accountLockouts.delete(userId);
    
    // Clear failed attempts for the user to prevent immediate re-lockout
    const userAttempts = this.authAttempts.get(userId) || [];
    const successfulAttempts = userAttempts.filter(a => a.success);
    this.authAttempts.set(userId, successfulAttempts);
    
    this.securityLogger.logAccountSecurityEvent(
      'unlocked',
      userId,
      undefined,
      undefined,
      { unlockReason: 'ADMIN_UNLOCK' },
    );

    this.logger.log(
      LogLevel.INFO,
      LogCategory.SECURITY,
      `Account unlocked: ${userId}`,
      { userId, previousLockoutLevel: lockout.lockoutLevel },
    );

    return true;
  }

  /**
   * Unban IP address (admin function)
   */
  public unbanIP(ip: string): boolean {
    const ban = this.ipBans.get(ip);
    if (!ban) return false;

    this.ipBans.delete(ip);
    this.suspiciousIPs.delete(ip);
    
    // Clear failed attempts for the IP to prevent immediate re-ban
    const ipAttempts = this.authAttempts.get(ip) || [];
    const successfulAttempts = ipAttempts.filter(a => a.success);
    this.authAttempts.set(ip, successfulAttempts);

    this.logger.log(
      LogLevel.INFO,
      LogCategory.SECURITY,
      `IP unbanned: ${ip}`,
      { ip, previousBanReason: ban.reason },
    );

    return true;
  }

  /**
   * Get recent attempts for a key (IP or userId)
   */
  private getRecentAttempts(key: string): AuthAttempt[] {
    const attempts = this.authAttempts.get(key) || [];
    const cutoff = Date.now() - this.config.windowMs;
    return attempts.filter(attempt => attempt.timestamp > cutoff);
  }

  /**
   * Add attempt to storage
   */
  private addAttempt(key: string, attempt: AuthAttempt): void {
    const attempts = this.authAttempts.get(key) || [];
    attempts.push(attempt);
    
    // Keep only recent attempts to prevent memory leaks
    const cutoff = Date.now() - this.config.windowMs;
    const recentAttempts = attempts.filter(a => a.timestamp > cutoff);
    
    this.authAttempts.set(key, recentAttempts);
  }

  /**
   * Clean up expired entries
   */
  private cleanupExpiredEntries(): void {
    // Dependencies are already injected via constructor - no need for getInstance() calls
    
    const now = Date.now();
    let cleanedCount = 0;

    // Clean up auth attempts
    for (const [key, attempts] of this.authAttempts.entries()) {
      const cutoff = now - this.config.windowMs;
      const recentAttempts = attempts.filter(a => a.timestamp > cutoff);
      
      if (recentAttempts.length === 0) {
        this.authAttempts.delete(key);
        cleanedCount++;
      } else if (recentAttempts.length !== attempts.length) {
        this.authAttempts.set(key, recentAttempts);
      }
    }

    // Clean up expired lockouts
    for (const [userId, lockout] of this.accountLockouts.entries()) {
      if (now > lockout.unlockAt && !lockout.requiresAdminUnlock) {
        this.accountLockouts.delete(userId);
        cleanedCount++;
      }
    }

    // Clean up expired IP bans
    for (const [ip, ban] of this.ipBans.entries()) {
      if (now > ban.unbanAt) {
        this.ipBans.delete(ip);
        this.suspiciousIPs.delete(ip);
        cleanedCount++;
      }
    }

    // Clean up expired CAPTCHA challenges
    for (const [challengeId, challenge] of this.captchaChallenges.entries()) {
      if (now > challenge.expiresAt) {
        this.captchaChallenges.delete(challengeId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(
        LogLevel.DEBUG,
        LogCategory.SYSTEM,
        `Cleaned up ${cleanedCount} expired auth rate limit entries`,
      );
    }
  }

  /**
   * Generate unique challenge ID
   */
  private generateChallengeId(): string {
    return generateSecureId('captcha', 9);
  }

  /**
   * Get authentication statistics
   */
  public getAuthStats(): {
    totalAttempts: number;
    failedAttempts: number;
    successRate: number;
    lockedAccounts: number;
    bannedIPs: number;
    suspiciousIPs: number;
    activeCaptchas: number;
  } {
    let totalAttempts = 0;
    let failedAttempts = 0;

    for (const attempts of this.authAttempts.values()) {
      totalAttempts += attempts.length;
      failedAttempts += attempts.filter(a => !a.success).length;
    }

    const successRate = totalAttempts > 0 ? ((totalAttempts - failedAttempts) / totalAttempts) * 100 : 100;

    return {
      totalAttempts,
      failedAttempts,
      successRate: Math.round(successRate * 100) / 100,
      lockedAccounts: this.accountLockouts.size,
      bannedIPs: this.ipBans.size,
      suspiciousIPs: this.suspiciousIPs.size,
      activeCaptchas: this.captchaChallenges.size,
    };
  }

  /**
   * Get locked accounts
   */
  public getLockedAccounts(): AccountLockoutInfo[] {
    return Array.from(this.accountLockouts.values());
  }

  /**
   * Get banned IPs
   */
  public getBannedIPs(): IPBanInfo[] {
    return Array.from(this.ipBans.values());
  }

  /**
   * Get suspicious IPs
   */
  public getSuspiciousIPs(): string[] {
    return Array.from(this.suspiciousIPs);
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<BruteForceConfig>): void {
    this.config = { ...this.config, ...config };
    
    this.logger.log(
      LogLevel.INFO,
      LogCategory.SYSTEM,
      'Auth rate limit configuration updated',
      { config },
    );
  }

  /**
   * Get current configuration
   */
  public getConfig(): BruteForceConfig {
    return { ...this.config };
  }

  /**
   * Cleanup method for testing (clears intervals and resets state)
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

export default AuthRateLimitService;