import { Request, Response, NextFunction } from 'express';
import { HTTPSValidationService } from '../../../services/httpsValidation.service';
import { LoggerService } from '../../../services/logger.service';

/**
 * Extended request interface with security information
 */
export interface SecurityEnhancedRequest extends Request {
  securityInfo?: {
    protocol: string;
    secure: boolean;
    forwardedProto?: string | string[];
    host?: string;
    userAgent?: string;
    ip?: string;
  };
}

/**
 * HTTPS Enforcement Middleware
 * Ensures all requests use HTTPS in production environments
 */
export class HTTPSEnforcementMiddleware {
  constructor(
    private httpsValidationService: HTTPSValidationService,
    private logger: LoggerService,
  ) {}

  /**
   * Middleware to enforce HTTPS connections
   */
  public enforceHTTPS = (req: Request, res: Response, next: NextFunction): void => {
    const isProduction = process.env.NODE_ENV === 'production';
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';

    // Add security headers
    const securityHeaders = this.httpsValidationService.getSecurityHeaders();
    Object.entries(securityHeaders).forEach(([key, value]) => {
      res.setHeader(key, value);
    });

    // Enforce HTTPS in production
    if (isProduction && !isSecure) {
      try {
        // Use injected logger: this.logger
        this.logger.warn('HTTPS enforcement: Redirecting insecure request', {
          url: req.url,
          method: req.method,
          ip: req.ip,
          userAgent: req.get('User-Agent'),
          timestamp: new Date().toISOString(),
        });
      } catch {
        console.warn('HTTPS enforcement: Redirecting insecure request', {
          url: req.url,
          method: req.method,
          ip: req.ip,
          userAgent: req.get('User-Agent'),
        });
      }

      // Redirect to HTTPS
      const httpsUrl = `https://${req.get('host')}${req.url}`;
      return res.redirect(301, httpsUrl);
    }

    // Log security information in development
    if (!isProduction) {
      try {
        // Use injected logger: this.logger
        this.logger.debug('HTTPS enforcement: Development mode', {
          secure: isSecure,
          protocol: req.protocol,
          forwardedProto: req.headers['x-forwarded-proto'],
          timestamp: new Date().toISOString(),
        });
      } catch {
        console.debug('HTTPS enforcement: Development mode', {
          secure: isSecure,
          protocol: req.protocol,
          forwardedProto: req.headers['x-forwarded-proto'],
        });
      }
    }

    next();
  };

  /**
   * Middleware to validate request security
   */
  public validateRequestSecurity = (req: Request, res: Response, next: NextFunction): void => {
    const securityInfo = {
      protocol: req.protocol,
      secure: req.secure,
      forwardedProto: req.headers['x-forwarded-proto'],
      host: req.get('host'),
      userAgent: req.get('User-Agent'),
      ip: req.ip,
    };

    // Add security info to request for logging
    // Attach security info to request for downstream middleware
    const typedReq = req as SecurityEnhancedRequest;
    typedReq.securityInfo = securityInfo;

    // Check for suspicious patterns
    const suspiciousPatterns = [
      /\.\./,  // Path traversal
      /<script/i,  // XSS attempts
      /union.*select/i,  // SQL injection
      /javascript:/i,  // JavaScript injection
      /data:.*base64/i,  // Data URI attacks
    ];

    const url = req.url.toLowerCase();
    const userAgent = (req.get('User-Agent') || '').toLowerCase();

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(url) || pattern.test(userAgent)) {
        try {
          // Use injected logger: this.logger
          this.logger.warn('HTTPS enforcement: Suspicious request detected', {
            pattern: pattern.toString(),
            url: req.url,
            userAgent: req.get('User-Agent'),
            ip: req.ip,
            timestamp: new Date().toISOString(),
          });
        } catch {
          console.warn('HTTPS enforcement: Suspicious request detected', {
            pattern: pattern.toString(),
            url: req.url,
            userAgent: req.get('User-Agent'),
            ip: req.ip,
          });
        }

        res.status(400).json({
          success: false,
          error: 'Invalid request format',
          code: 'INVALID_REQUEST',
        });
        return;
      }
    }

    next();
  };

  /**
   * Middleware to add security response headers
   */
  public addSecurityHeaders = (req: Request, res: Response, next: NextFunction): void => {
    // Security headers for all responses
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // HTTPS-specific headers
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    }

    // Content Security Policy
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self' https://api.anthropic.com",
      "font-src 'self'",
      "object-src 'none'",
      "media-src 'self'",
      "frame-src 'none'",
    ].join('; ');

    res.setHeader('Content-Security-Policy', csp);

    next();
  };
}

// Factory function to create HTTPSEnforcementMiddleware with dependency injection
export function createHTTPSEnforcementMiddleware(
  httpsValidationService: HTTPSValidationService,
  logger: LoggerService,
): HTTPSEnforcementMiddleware {
  return new HTTPSEnforcementMiddleware(httpsValidationService, logger);
}

// Legacy exports removed - Use factory functions instead:
// - Use createHTTPSEnforcementMiddleware() factory function with explicit dependencies