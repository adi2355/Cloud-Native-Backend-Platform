import { SecurityLoggerService, SecurityEvent, SecurityEventType, SecurityEventSeverity } from './securityLogger.service';
import { LoggerService, LogLevel, LogCategory } from './logger.service';
import { generateSecureId } from '../utils/secure-id.utils';

export interface SecurityAlert {
  id: string;
  timestamp: Date;
  type: SecurityAlertType;
  severity: SecurityEventSeverity;
  title: string;
  description: string;
  affectedResource?: string;
  sourceIP?: string;
  userId?: string;
  eventCount: number;
  timeWindow: number;
  actions: SecurityAction[];
  metadata: Record<string, unknown>;
  resolved: boolean;
  resolvedAt?: Date;
  resolvedBy?: string;
}

export enum SecurityAlertType {
  BRUTE_FORCE_ATTACK = 'BRUTE_FORCE_ATTACK',
  SUSPICIOUS_IP_ACTIVITY = 'SUSPICIOUS_IP_ACTIVITY',
  RATE_LIMIT_ABUSE = 'RATE_LIMIT_ABUSE',
  AUTHENTICATION_ANOMALY = 'AUTHENTICATION_ANOMALY',
  API_ABUSE = 'API_ABUSE',
  CORS_VIOLATION_PATTERN = 'CORS_VIOLATION_PATTERN',
  CONFIGURATION_SECURITY_ISSUE = 'CONFIGURATION_SECURITY_ISSUE',
  SYSTEM_HEALTH_DEGRADATION = 'SYSTEM_HEALTH_DEGRADATION',
  EXTERNAL_API_FAILURE = 'EXTERNAL_API_FAILURE',
  DATA_EXPOSURE_RISK = 'DATA_EXPOSURE_RISK',
  API_KEY_EXPOSURE_ATTEMPT = 'API_KEY_EXPOSURE_ATTEMPT',
  MALFORMED_REQUEST_PATTERN = 'MALFORMED_REQUEST_PATTERN'
}

export enum SecurityAction {
  LOG_ONLY = 'LOG_ONLY',
  NOTIFY_ADMIN = 'NOTIFY_ADMIN',
  RATE_LIMIT_IP = 'RATE_LIMIT_IP',
  BLOCK_IP = 'BLOCK_IP',
  DISABLE_USER = 'DISABLE_USER',
  ROTATE_SECRETS = 'ROTATE_SECRETS',
  SCALE_RESOURCES = 'SCALE_RESOURCES',
  INVESTIGATE = 'INVESTIGATE',
  TRIGGER_MFA = 'TRIGGER_MFA'
}

export interface SecurityMonitoringRule {
  id: string;
  name: string;
  description: string;
  eventType: SecurityEventType;
  threshold: number;
  timeWindow: number; // in milliseconds
  severity: SecurityEventSeverity;
  alertType: SecurityAlertType;
  actions: SecurityAction[];
  enabled: boolean;
  conditions?: SecurityRuleCondition[];
}

export interface SecurityRuleCondition {
  field: string;
  operator: 'equals' | 'contains' | 'greater_than' | 'less_than' | 'regex';
  value: unknown;
}

export interface SecurityDashboard {
  timestamp: Date;
  systemHealth: {
    status: 'healthy' | 'warning' | 'critical';
    score: number;
    issues: string[];
  };
  activeAlerts: SecurityAlert[];
  recentEvents: SecurityEvent[];
  threatLevel: 'low' | 'medium' | 'high' | 'critical';
  metrics: {
    totalEvents: number;
    alertsGenerated: number;
    threatsBlocked: number;
    averageResponseTime: number;
    errorRate: number;
  };
  topThreats: Array<{
    type: SecurityAlertType;
    count: number;
    lastSeen: Date;
  }>;
  suspiciousIPs: Array<{
    ip: string;
    eventCount: number;
    threatScore: number;
    lastActivity: Date;
  }>;
}

export class SecurityMonitoringService {
  private alerts: SecurityAlert[] = [];
  private rules: SecurityMonitoringRule[] = [];
  private maxAlertsInMemory: number = 1000;
  private monitoringInterval: NodeJS.Timeout | null = null;

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private securityLogger: SecurityLoggerService,
    private logger: LoggerService,
  ) {
    // Lightweight constructor - all dependencies injected explicitly
    // No internal service resolution needed
    this.initializeDefaultRules();
    this.startMonitoring();
  }

  /**
   * Initialize default security monitoring rules
   */
  private initializeDefaultRules(): void {
    // Dependencies are already injected via constructor
    
    this.rules = [
      {
        id: 'brute_force_auth',
        name: 'Brute Force Authentication Detection',
        description: 'Detect multiple failed authentication attempts from same IP',
        eventType: SecurityEventType.AUTHENTICATION_FAILURE,
        threshold: 5,
        timeWindow: 15 * 60 * 1000, // 15 minutes
        severity: SecurityEventSeverity.HIGH,
        alertType: SecurityAlertType.BRUTE_FORCE_ATTACK,
        actions: [SecurityAction.NOTIFY_ADMIN, SecurityAction.RATE_LIMIT_IP, SecurityAction.TRIGGER_MFA],
        enabled: true,
      },
      {
        id: 'rate_limit_abuse',
        name: 'Rate Limit Abuse Detection',
        description: 'Detect excessive rate limiting from same IP or user',
        eventType: SecurityEventType.RATE_LIMIT_EXCEEDED,
        threshold: 10,
        timeWindow: 60 * 60 * 1000, // 1 hour
        severity: SecurityEventSeverity.MEDIUM,
        alertType: SecurityAlertType.RATE_LIMIT_ABUSE,
        actions: [SecurityAction.LOG_ONLY, SecurityAction.RATE_LIMIT_IP, SecurityAction.INVESTIGATE],
        enabled: true,
      },
      {
        id: 'cors_violation_pattern',
        name: 'CORS Violation Pattern Detection',
        description: 'Detect repeated CORS violations from same origin or IP',
        eventType: SecurityEventType.CORS_VIOLATION,
        threshold: 3,
        timeWindow: 5 * 60 * 1000, // 5 minutes
        severity: SecurityEventSeverity.HIGH,
        alertType: SecurityAlertType.CORS_VIOLATION_PATTERN,
        actions: [SecurityAction.NOTIFY_ADMIN, SecurityAction.BLOCK_IP, SecurityAction.INVESTIGATE],
        enabled: true,
      },
      {
        id: 'suspicious_activity_pattern',
        name: 'Suspicious Activity Pattern Detection',
        description: 'Detect patterns of suspicious activity (e.g., rapid failed requests, multiple user agents from one IP)',
        eventType: SecurityEventType.SUSPICIOUS_ACTIVITY,
        threshold: 3,
        timeWindow: 10 * 60 * 1000, // 10 minutes
        severity: SecurityEventSeverity.HIGH,
        alertType: SecurityAlertType.SUSPICIOUS_IP_ACTIVITY,
        actions: [SecurityAction.NOTIFY_ADMIN, SecurityAction.BLOCK_IP, SecurityAction.INVESTIGATE],
        enabled: true,
      },
      {
        id: 'config_security_violation',
        name: 'Configuration Security Violation',
        description: 'Detect critical configuration security violations (e.g., hardcoded secrets in production, insecure defaults)',
        eventType: SecurityEventType.CONFIG_SECURITY_VIOLATION,
        threshold: 1,
        timeWindow: 1000, // Immediate
        severity: SecurityEventSeverity.CRITICAL,
        alertType: SecurityAlertType.CONFIGURATION_SECURITY_ISSUE,
        actions: [SecurityAction.NOTIFY_ADMIN, SecurityAction.ROTATE_SECRETS, SecurityAction.INVESTIGATE],
        enabled: true,
      },
      {
        id: 'api_key_exposure_attempt',
        name: 'API Key Exposure Attempt Detection',
        description: 'Detect attempts to expose API keys (e.g., in URL parameters, error messages, or response bodies)',
        eventType: SecurityEventType.API_KEY_EXPOSURE_ATTEMPT,
        threshold: 1, // Trigger immediately on any attempt
        timeWindow: 1000, // Immediate
        severity: SecurityEventSeverity.CRITICAL,
        alertType: SecurityAlertType.API_KEY_EXPOSURE_ATTEMPT,
        actions: [SecurityAction.NOTIFY_ADMIN, SecurityAction.BLOCK_IP, SecurityAction.ROTATE_SECRETS, SecurityAction.INVESTIGATE],
        enabled: true,
      },
      {
        id: 'malformed_request_pattern',
        name: 'Malformed Request Pattern Detection',
        description: 'Detect high volume of malformed requests that could indicate probing or attack attempts',
        eventType: SecurityEventType.MALFORMED_REQUEST,
        threshold: 10,
        timeWindow: 5 * 60 * 1000, // 5 minutes
        severity: SecurityEventSeverity.MEDIUM,
        alertType: SecurityAlertType.MALFORMED_REQUEST_PATTERN,
        actions: [SecurityAction.NOTIFY_ADMIN, SecurityAction.RATE_LIMIT_IP, SecurityAction.INVESTIGATE],
        enabled: true,
      },
    ];
  }

  /**
   * Start continuous security monitoring
   */
  private startMonitoring(): void {
    // Run monitoring checks every 30 seconds
    this.monitoringInterval = setInterval(() => {
      this.runMonitoringChecks();
    }, 30 * 1000);

    this.logger.log(
      LogLevel.INFO,
      LogCategory.SECURITY,
      'Security monitoring service started',
      { rulesCount: this.rules.length },
    );
  }

  /**
   * Stop security monitoring
   */
  public stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    this.logger.log(
      LogLevel.INFO,
      LogCategory.SECURITY,
      'Security monitoring service stopped',
    );
  }

  /**
   * Run all monitoring checks
   */
  private runMonitoringChecks(): void {
    this.rules.forEach(rule => {
      if (rule.enabled) {
        this.checkRule(rule);
      }
    });

    // Clean up old alerts
    this.cleanupOldAlerts();
  }

  /**
   * Check a specific monitoring rule
   */
  private checkRule(rule: SecurityMonitoringRule): void {
    try {
      const now = Date.now();
      const windowStart = now - rule.timeWindow;
      
      // Get security metrics for the time window
      const metrics = this.securityLogger.getSecurityMetrics(rule.timeWindow);
      const eventCount = metrics.eventsByType[rule.eventType] || 0;

      if (eventCount >= rule.threshold) {
        // Get recent events of this type for analysis
        const recentEvents = this.securityLogger.getEventsByType(rule.eventType, 100)
          .filter(event => event.timestamp.getTime() >= windowStart);

        // Check if we already have an active alert for this pattern
        const existingAlert = this.findActiveAlert(rule.alertType, recentEvents);
        
        if (!existingAlert) {
          this.generateAlert(rule, recentEvents, eventCount);
        } else {
          // Update existing alert
          this.updateAlert(existingAlert, recentEvents, eventCount);
        }
      }
    } catch (error) {
      this.logger.log(
        LogLevel.ERROR,
        LogCategory.SECURITY,
        `Failed to check monitoring rule: ${rule.name}`,
        { ruleId: rule.id, error: error instanceof Error ? error.message : 'Unknown error' },
      );
    }
  }

  /**
   * Generate a new security alert
   */
  private generateAlert(
    rule: SecurityMonitoringRule,
    events: SecurityEvent[],
    eventCount: number,
  ): void {
    const alert: SecurityAlert = {
      id: this.generateAlertId(),
      timestamp: new Date(),
      type: rule.alertType,
      severity: rule.severity,
      title: rule.name,
      description: this.generateAlertDescription(rule, events, eventCount),
      affectedResource: this.extractAffectedResource(events),
      sourceIP: this.extractSourceIP(events),
      userId: this.extractUserId(events),
      eventCount,
      timeWindow: rule.timeWindow,
      actions: rule.actions,
      metadata: this.extractAlertMetadata(events),
      resolved: false,
    };

    this.alerts.push(alert);
    this.trimAlertsInMemory();

    // Execute alert actions
    this.executeAlertActions(alert);

    // Log the alert generation
    this.logger.log(
      LogLevel.WARN,
      LogCategory.SECURITY,
      `Security alert generated: ${alert.title}`,
      {
        alertId: alert.id,
        type: alert.type,
        severity: alert.severity,
        eventCount: alert.eventCount,
        sourceIP: alert.sourceIP,
        actions: alert.actions,
      },
    );
  }

  /**
   * Update an existing alert
   */
  private updateAlert(
    alert: SecurityAlert,
    events: SecurityEvent[],
    eventCount: number,
  ): void {
    alert.eventCount = eventCount;
    alert.timestamp = new Date();
    alert.metadata = { ...alert.metadata, ...this.extractAlertMetadata(events) };

    this.logger.log(
      LogLevel.INFO,
      LogCategory.SECURITY,
      `Security alert updated: ${alert.title}`,
      {
        alertId: alert.id,
        newEventCount: eventCount,
        sourceIP: alert.sourceIP,
      },
    );
  }

  /**
   * Execute actions for a security alert
   */
  private executeAlertActions(alert: SecurityAlert): void {
    alert.actions.forEach(action => {
      try {
        switch (action) {
          case SecurityAction.LOG_ONLY:
            // Already logged above
            break;
          
          case SecurityAction.NOTIFY_ADMIN:
            this.notifyAdmin(alert);
            break;
          
          case SecurityAction.RATE_LIMIT_IP:
            if (alert.sourceIP) {
              this.rateLimitIP(alert.sourceIP, alert);
            }
            break;
          
          case SecurityAction.BLOCK_IP:
            if (alert.sourceIP) {
              this.blockIP(alert.sourceIP, alert);
            }
            break;
          
          case SecurityAction.INVESTIGATE:
            this.initiateInvestigation(alert);
            break;
          
          default:
            this.logger.log(
              LogLevel.WARN,
              LogCategory.SECURITY,
              `Unknown security action: ${action}`,
              { alertId: alert.id },
            );
        }
      } catch (error) {
        this.logger.log(
          LogLevel.ERROR,
          LogCategory.SECURITY,
          `Failed to execute security action: ${action}`,
          {
            alertId: alert.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        );
      }
    });
  }

  /**
   * Get security dashboard data
   */
  public getSecurityDashboard(timeWindow: number = 24 * 60 * 60 * 1000): SecurityDashboard {
    const now = Date.now();
    const windowStart = now - timeWindow;
    
    const metrics = this.securityLogger.getSecurityMetrics(timeWindow);
    const logMetrics = this.logger.getLogMetrics(timeWindow);
    
    const activeAlerts = this.alerts.filter(alert => 
      !alert.resolved && alert.timestamp.getTime() >= windowStart,
    );

    const recentEvents = this.securityLogger.getEventsByType(
      SecurityEventType.SUSPICIOUS_ACTIVITY, 
      20,
    ).filter(event => event.timestamp.getTime() >= windowStart);

    // Calculate threat level
    const threatLevel = this.calculateThreatLevel(activeAlerts, metrics);

    // Calculate system health
    const systemHealth = this.calculateSystemHealth(metrics, logMetrics);

    // Get top threats
    const topThreats = this.getTopThreats(timeWindow);

    // Get suspicious IPs with threat scores
    const suspiciousIPs = this.getSuspiciousIPs(timeWindow);

    return {
      timestamp: new Date(),
      systemHealth,
      activeAlerts: activeAlerts.slice(0, 10), // Limit to 10 most recent
      recentEvents: recentEvents.slice(0, 20),
      threatLevel,
      metrics: {
        totalEvents: metrics.totalEvents,
        alertsGenerated: this.alerts.filter(a => a.timestamp.getTime() >= windowStart).length,
        threatsBlocked: this.countThreatsBlocked(timeWindow),
        averageResponseTime: logMetrics.averageResponseTime,
        errorRate: logMetrics.errorRate,
      },
      topThreats,
      suspiciousIPs,
    };
  }

  /**
   * Get active alerts
   */
  public getActiveAlerts(): SecurityAlert[] {
    return this.alerts.filter(alert => !alert.resolved);
  }

  /**
   * Resolve an alert
   */
  public resolveAlert(alertId: string, resolvedBy?: string): boolean {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert && !alert.resolved) {
      alert.resolved = true;
      alert.resolvedAt = new Date();
      alert.resolvedBy = resolvedBy;

      this.logger.log(
        LogLevel.INFO,
        LogCategory.SECURITY,
        `Security alert resolved: ${alert.title}`,
        {
          alertId: alert.id,
          resolvedBy,
          duration: alert.resolvedAt.getTime() - alert.timestamp.getTime(),
        },
      );

      return true;
    }
    return false;
  }

  /**
   * Add custom monitoring rule
   */
  public addMonitoringRule(rule: Omit<SecurityMonitoringRule, 'id'>): string {
    const ruleWithId: SecurityMonitoringRule = {
      ...rule,
      id: this.generateRuleId(),
    };

    this.rules.push(ruleWithId);

    this.logger.log(
      LogLevel.INFO,
      LogCategory.SECURITY,
      `Security monitoring rule added: ${rule.name}`,
      { ruleId: ruleWithId.id },
    );

    return ruleWithId.id;
  }

  /**
   * Remove monitoring rule
   */
  public removeMonitoringRule(ruleId: string): boolean {
    const index = this.rules.findIndex(r => r.id === ruleId);
    if (index !== -1) {
      const rule = this.rules[index];
      if (!rule) {
        return false;
      }
      this.rules.splice(index, 1);

      this.logger.log(
        LogLevel.INFO,
        LogCategory.SECURITY,
        `Security monitoring rule removed: ${rule.name}`,
        { ruleId },
      );

      return true;
    }
    return false;
  }

  // Private helper methods

  private findActiveAlert(
    alertType: SecurityAlertType,
    events: SecurityEvent[],
  ): SecurityAlert | undefined {
    const sourceIP = this.extractSourceIP(events);
    return this.alerts.find(alert => 
      !alert.resolved && 
      alert.type === alertType && 
      alert.sourceIP === sourceIP,
    );
  }

  private generateAlertDescription(
    rule: SecurityMonitoringRule,
    events: SecurityEvent[],
    eventCount: number,
  ): string {
    const sourceIP = this.extractSourceIP(events);
    const timeWindowMinutes = Math.round(rule.timeWindow / (60 * 1000));
    
    return `${rule.description}. Detected ${eventCount} events in ${timeWindowMinutes} minutes${sourceIP ? ` from IP ${sourceIP}` : ''}.`;
  }

  private extractAffectedResource(events: SecurityEvent[]): string | undefined {
    const endpoints = events
      .map(e => e.details.endpoint)
      .filter(Boolean)
      .reduce((acc: Record<string, number>, endpoint) => {
        acc[endpoint!] = (acc[endpoint!] || 0) + 1;
        return acc;
      }, {});

    const mostAffected = Object.entries(endpoints)
      .sort(([, a], [, b]) => b - a)[0];

    return mostAffected ? mostAffected[0] : undefined;
  }

  private extractSourceIP(events: SecurityEvent[]): string | undefined {
    const ips = events
      .map(e => e.userContext?.ip)
      .filter(Boolean)
      .reduce((acc: Record<string, number>, ip) => {
        acc[ip!] = (acc[ip!] || 0) + 1;
        return acc;
      }, {});

    const mostFrequent = Object.entries(ips)
      .sort(([, a], [, b]) => b - a)[0];

    return mostFrequent ? mostFrequent[0] : undefined;
  }

  private extractUserId(events: SecurityEvent[]): string | undefined {
    const userIds = events
      .map(e => e.userContext?.userId)
      .filter(Boolean);

    return userIds.length > 0 ? userIds[0] : undefined;
  }

  private extractAlertMetadata(events: SecurityEvent[]): Record<string, unknown> {
    const endpoints = events.map(e => e.details.endpoint).filter(Boolean);
    const userAgents = events.map(e => e.userContext?.userAgent).filter(Boolean);

    return {
      uniqueEndpoints: [...new Set(endpoints)],
      uniqueUserAgents: [...new Set(userAgents)],
      eventTimespan: {
        first: events[0]?.timestamp,
        last: events[events.length - 1]?.timestamp,
      },
    };
  }

  private notifyAdmin(alert: SecurityAlert): void {
    // In a real implementation, this would send notifications via email, Slack, etc.
    this.logger.log(
      LogLevel.ERROR,
      LogCategory.SECURITY,
      `ADMIN NOTIFICATION: ${alert.title}`,
      {
        alertId: alert.id,
        severity: alert.severity,
        description: alert.description,
        sourceIP: alert.sourceIP,
        eventCount: alert.eventCount,
      },
    );
  }

  private rateLimitIP(ip: string, alert: SecurityAlert): void {
    // In a real implementation, this would integrate with rate limiting middleware
    this.logger.log(
      LogLevel.WARN,
      LogCategory.SECURITY,
      `Rate limiting IP: ${ip}`,
      { alertId: alert.id, reason: alert.title },
    );
  }

  private blockIP(ip: string, alert: SecurityAlert): void {
    // In a real implementation, this would integrate with firewall/blocking system
    this.logger.log(
      LogLevel.ERROR,
      LogCategory.SECURITY,
      `Blocking IP: ${ip}`,
      { alertId: alert.id, reason: alert.title },
    );
  }

  private initiateInvestigation(alert: SecurityAlert): void {
    this.logger.log(
      LogLevel.WARN,
      LogCategory.SECURITY,
      `Investigation initiated for alert: ${alert.title}`,
      {
        alertId: alert.id,
        investigationStarted: new Date().toISOString(),
      },
    );
  }

  private calculateThreatLevel(
    activeAlerts: SecurityAlert[],
    metrics: { totalEvents: number; eventsByType: Record<string, number> },
  ): 'low' | 'medium' | 'high' | 'critical' {
    const criticalAlerts = activeAlerts.filter(a => a.severity === SecurityEventSeverity.CRITICAL).length;
    const highAlerts = activeAlerts.filter(a => a.severity === SecurityEventSeverity.HIGH).length;
    
    if (criticalAlerts > 0) return 'critical';
    if (highAlerts > 2) return 'high';
    if (activeAlerts.length > 5) return 'medium';
    return 'low';
  }

  private calculateSystemHealth(
    securityMetrics: { totalEvents: number; eventsByType: Record<string, number> },
    logMetrics: { errorRate: number; averageResponseTime: number }
  ): { status: 'healthy' | 'warning' | 'critical'; score: number; issues: string[] } {
    let score = 100;
    const issues: string[] = [];

    // Deduct for high error rates
    if (logMetrics.errorRate > 10) {
      score -= 30;
      issues.push('High error rate detected');
    } else if (logMetrics.errorRate > 5) {
      score -= 15;
      issues.push('Elevated error rate');
    }

    // Deduct for security events
    const eventCounts = Object.values(securityMetrics.eventsByType) as number[];
    const securityEventCount = eventCounts.reduce((a: number, b: number) => a + b, 0);
    if (securityEventCount > 50) {
      score -= 20;
      issues.push('High security event volume');
    }

    // Deduct for slow response times
    if (logMetrics.averageResponseTime > 5000) {
      score -= 25;
      issues.push('Slow response times');
    }

    const status = score >= 90 ? 'healthy' : score >= 70 ? 'warning' : 'critical';

    return { status, score: Math.max(0, score), issues };
  }

  private getTopThreats(timeWindow: number): Array<{ type: SecurityAlertType; count: number; lastSeen: Date }> {
    const now = Date.now();
    const windowStart = now - timeWindow;

    const recentAlerts = this.alerts.filter(alert =>
      alert.timestamp.getTime() >= windowStart,
    );

    const threatCounts: Partial<Record<SecurityAlertType, { count: number; lastSeen: Date }>> = {};

    recentAlerts.forEach(alert => {
      if (!threatCounts[alert.type]) {
        threatCounts[alert.type] = { count: 0, lastSeen: alert.timestamp };
      }
      const threatData = threatCounts[alert.type];
      if (threatData) {
        threatData.count++;
        if (alert.timestamp > threatData.lastSeen) {
          threatData.lastSeen = alert.timestamp;
        }
      }
    });

    return Object.entries(threatCounts)
      .map(([type, data]) => ({ type: type as SecurityAlertType, ...data }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }

  private getSuspiciousIPs(timeWindow: number): Array<{ ip: string; eventCount: number; threatScore: number; lastActivity: Date }> {
    const metrics = this.securityLogger.getSecurityMetrics(timeWindow);
    
    return metrics.suspiciousIPs.map(ip => {
      const ipAlerts = this.alerts.filter(alert => 
        alert.sourceIP === ip && 
        alert.timestamp.getTime() >= Date.now() - timeWindow,
      );
      
      const threatScore = this.calculateIPThreatScore(ip, ipAlerts);
      const lastActivity = ipAlerts.length > 0 
        ? new Date(Math.max(...ipAlerts.map(a => a.timestamp.getTime())))
        : new Date();

      return {
        ip,
        eventCount: ipAlerts.reduce((sum, alert) => sum + alert.eventCount, 0),
        threatScore,
        lastActivity,
      };
    }).sort((a, b) => b.threatScore - a.threatScore);
  }

  private calculateIPThreatScore(ip: string, alerts: SecurityAlert[]): number {
    let score = 0;
    
    alerts.forEach(alert => {
      switch (alert.severity) {
        case SecurityEventSeverity.CRITICAL:
          score += 10;
          break;
        case SecurityEventSeverity.HIGH:
          score += 5;
          break;
        case SecurityEventSeverity.MEDIUM:
          score += 2;
          break;
        case SecurityEventSeverity.LOW:
          score += 1;
          break;
      }
    });

    return Math.min(100, score);
  }

  private countThreatsBlocked(timeWindow: number): number {
    const now = Date.now();
    const windowStart = now - timeWindow;
    
    return this.alerts.filter(alert => 
      alert.timestamp.getTime() >= windowStart &&
      (alert.actions.includes(SecurityAction.BLOCK_IP) || 
       alert.actions.includes(SecurityAction.RATE_LIMIT_IP)),
    ).length;
  }

  private cleanupOldAlerts(): void {
    const cutoffTime = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 days
    this.alerts = this.alerts.filter(alert => 
      alert.timestamp.getTime() > cutoffTime,
    );
  }

  private trimAlertsInMemory(): void {
    if (this.alerts.length > this.maxAlertsInMemory) {
      this.alerts = this.alerts.slice(-this.maxAlertsInMemory);
    }
  }

  private generateAlertId(): string {
    return generateSecureId('alert', 9);
  }

  private generateRuleId(): string {
    return generateSecureId('rule', 9);
  }
}

export default SecurityMonitoringService;