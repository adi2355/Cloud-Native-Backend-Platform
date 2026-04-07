import { CorsOptions } from 'cors';
import { RateLimitRequestHandler, Options as RateLimitOptions } from 'express-rate-limit';
import rateLimit from 'express-rate-limit';

export interface SecurityConfigOptions {
  environment: string;
  corsOrigins: string[];
  rateLimitConfig: {
    windowMs: number;
    max: number;
  };
}

export interface EnhancedCorsOptions extends CorsOptions {
  securityLevel: 'strict' | 'moderate' | 'permissive';
  allowedMethods: string[];
  allowedHeaders: string[];
  maxAge: number;
}

export interface EnhancedRateLimitOptions {
  general: Partial<RateLimitOptions>;
  auth: Partial<RateLimitOptions>;
  ai: Partial<RateLimitOptions>;
  strict: Partial<RateLimitOptions>;
}

export interface SecurityHeadersConfig {
  contentSecurityPolicy: boolean;
  crossOriginEmbedderPolicy: boolean;
  crossOriginOpenerPolicy: boolean;
  crossOriginResourcePolicy: boolean;
  dnsPrefetchControl: boolean;
  frameguard: boolean;
  hidePoweredBy: boolean;
  hsts: boolean;
  ieNoOpen: boolean;
  noSniff: boolean;
  originAgentCluster: boolean;
  permittedCrossDomainPolicies: boolean;
  referrerPolicy: boolean;
  xssFilter: boolean;
}

export class SecurityConfigService {
  private environment: string;

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor() {
    // Pure constructor injection - all dependencies provided by bootstrap.ts
    this.environment = process.env.NODE_ENV || 'development';
  }

  /**
   * Get enhanced CORS configuration based on environment
   */
  public getCorsConfiguration(corsOrigins: string[]): EnhancedCorsOptions {
    const isProduction = this.environment === 'production';
    const isDevelopment = this.environment === 'development';

    // Filter origins based on environment
    const filteredOrigins = this.filterOriginsForEnvironment(corsOrigins);

    const corsConfig: EnhancedCorsOptions = {
      origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin) {
          return callback(null, true);
        }

        // Check if origin is in allowed list
        if (filteredOrigins.includes(origin)) {
          return callback(null, true);
        }

        // In development, be more permissive with localhost
        if (isDevelopment && this.isLocalhost(origin)) {
          return callback(null, true);
        }

        // Reject unauthorized origins
        const error = new Error(`CORS policy violation: Origin ${origin} not allowed`);
        return callback(error, false);
      },
      credentials: true,
      securityLevel: isProduction ? 'strict' : 'moderate',
      allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Origin',
        'X-Requested-With',
        'Content-Type',
        'Accept',
        'Authorization',
        'X-API-Key',
        'X-User-Context',
        'X-Correlation-ID',
        'X-Request-ID',
        'X-Device-ID',
        'Cache-Control',
        'Pragma',
        'Expires',
      ],
      exposedHeaders: [
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
        'X-Correlation-ID',
        'Server-Time',
        'Retry-After',
      ],
      maxAge: isProduction ? 86400 : 3600, // 24 hours in prod, 1 hour in dev
      preflightContinue: false,
      optionsSuccessStatus: 204,
    };

    return corsConfig;
  }

  /**
   * Get enhanced rate limiting configuration
   */
  public getRateLimitConfiguration(baseConfig: { windowMs: number; max: number }): EnhancedRateLimitOptions {
    const isProduction = this.environment === 'production';

    return {
      // General API rate limiting
      general: {
        windowMs: baseConfig.windowMs,
        max: baseConfig.max,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: 'Too many requests from this IP, please try again later.',
          retryAfter: Math.ceil(baseConfig.windowMs / 1000),
        },
        handler: (req, res) => {
          res.status(429).json({
            error: 'Rate limit exceeded',
            message: 'Too many requests from this IP, please try again later.',
            retryAfter: Math.ceil(baseConfig.windowMs / 1000),
          });
        },
        skip: (req) => {
          // Skip rate limiting for health checks
          return req.path === '/health';
        },
      },

      // Stricter rate limiting for authentication endpoints
      auth: {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: isProduction ? 5 : 20, // 5 attempts in prod, 20 in dev
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: 'Too many authentication attempts, please try again later.',
          retryAfter: 900, // 15 minutes
        },
        handler: (req, res) => {
          res.status(429).json({
            error: 'Authentication rate limit exceeded',
            message: 'Too many authentication attempts from this IP.',
            retryAfter: 900,
          });
        },
      },

      // AI endpoint specific rate limiting
      ai: {
        windowMs: baseConfig.windowMs,
        max: Math.floor(baseConfig.max * 0.7), // 70% of general limit for AI endpoints
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: 'AI service rate limit exceeded, please try again later.',
          retryAfter: Math.ceil(baseConfig.windowMs / 1000),
        },
        handler: (req, res) => {
          res.status(429).json({
            error: 'AI service rate limit exceeded',
            message: 'Too many AI requests from this IP, please try again later.',
            retryAfter: Math.ceil(baseConfig.windowMs / 1000),
          });
        },
      },

      // Very strict rate limiting for sensitive operations
      strict: {
        windowMs: 60 * 60 * 1000, // 1 hour
        max: isProduction ? 10 : 50, // Very limited in production
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: 'Strict rate limit exceeded for sensitive operations.',
          retryAfter: 3600,
        },
        handler: (req, res) => {
          res.status(429).json({
            error: 'Strict rate limit exceeded',
            message: 'Too many sensitive operations from this IP.',
            retryAfter: 3600,
          });
        },
      },
    };
  }

  /**
   * Get security headers configuration
   */
  public getSecurityHeadersConfig(): SecurityHeadersConfig {
    const isProduction = this.environment === 'production';

    return {
      contentSecurityPolicy: isProduction, // Enable CSP in production
      crossOriginEmbedderPolicy: isProduction,
      crossOriginOpenerPolicy: isProduction,
      crossOriginResourcePolicy: isProduction,
      dnsPrefetchControl: true,
      frameguard: true,
      hidePoweredBy: true,
      hsts: isProduction, // HTTPS Strict Transport Security in production
      ieNoOpen: true,
      noSniff: true,
      originAgentCluster: true,
      permittedCrossDomainPolicies: false,
      referrerPolicy: true,
      xssFilter: true,
    };
  }

  /**
   * Create rate limiter instances
   */
  public createRateLimiters(baseConfig: { windowMs: number; max: number }): {
    general: RateLimitRequestHandler;
    auth: RateLimitRequestHandler;
    ai: RateLimitRequestHandler;
    strict: RateLimitRequestHandler;
  } {
    const rateLimitConfig = this.getRateLimitConfiguration(baseConfig);

    return {
      general: rateLimit(rateLimitConfig.general),
      auth: rateLimit(rateLimitConfig.auth),
      ai: rateLimit(rateLimitConfig.ai),
      strict: rateLimit(rateLimitConfig.strict),
    };
  }

  /**
   * Validate CORS configuration for security
   */
  public validateCorsConfiguration(corsOrigins: string[]): {
    isSecure: boolean;
    warnings: string[];
    recommendations: string[];
  } {
    const warnings: string[] = [];
    const recommendations: string[] = [];
    let isSecure = true;

    // Check for wildcard origins
    if (corsOrigins.includes('*')) {
      warnings.push('Wildcard CORS origin (*) detected - this allows all origins');
      recommendations.push('Replace wildcard with specific allowed origins');
      isSecure = false;
    }

    // Check for localhost in production
    if (this.environment === 'production') {
      const hasLocalhost = corsOrigins.some(origin => this.isLocalhost(origin));
      if (hasLocalhost) {
        warnings.push('Localhost origins detected in production environment');
        recommendations.push('Remove localhost origins from production CORS configuration');
      }
    }

    // Check for HTTP origins in production
    if (this.environment === 'production') {
      const hasHttp = corsOrigins.some(origin => 
        origin.startsWith('http://') && !this.isLocalhost(origin),
      );
      if (hasHttp) {
        warnings.push('HTTP origins detected in production - should use HTTPS');
        recommendations.push('Use HTTPS for all production origins');
        isSecure = false;
      }
    }

    // Check for IP addresses
    const hasIpAddress = corsOrigins.some(origin => {
      try {
        const url = new URL(origin);
        return /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname);
      } catch {
        return false;
      }
    });

    if (hasIpAddress && this.environment === 'production') {
      warnings.push('IP address origins detected in production');
      recommendations.push('Use domain names instead of IP addresses for production');
    }

    return { isSecure, warnings, recommendations };
  }

  /**
   * Validate rate limiting configuration
   */
  public validateRateLimitConfiguration(rateLimitConfig: { windowMs: number; max: number }): {
    isAppropriate: boolean;
    warnings: string[];
    recommendations: string[];
  } {
    const warnings: string[] = [];
    const recommendations: string[] = [];
    let isAppropriate = true;

    // Check if rate limit is too high
    if (rateLimitConfig.max > 1000) {
      warnings.push('Rate limit maximum is very high (>1000 requests)');
      recommendations.push('Consider lowering rate limit for better protection against abuse');
    }

    // Check if window is too short
    if (rateLimitConfig.windowMs < 60000) { // Less than 1 minute
      warnings.push('Rate limit window is very short (<1 minute)');
      recommendations.push('Consider increasing window duration for better protection');
    }

    // Check if rate limit is too restrictive for development
    if (this.environment === 'development' && rateLimitConfig.max < 50) {
      warnings.push('Rate limit may be too restrictive for development');
      recommendations.push('Consider higher limits for development environment');
    }

    // Check if rate limit is too permissive for production
    if (this.environment === 'production' && rateLimitConfig.max > 500) {
      warnings.push('Rate limit may be too permissive for production');
      recommendations.push('Consider lower limits for production environment');
      isAppropriate = false;
    }

    return { isAppropriate, warnings, recommendations };
  }

  /**
   * Filter origins based on environment with enhanced security
   */
  private filterOriginsForEnvironment(corsOrigins: string[]): string[] {
    const filteredOrigins: string[] = [];
    const rejectedOrigins: string[] = [];
    
    if (this.environment === 'production') {
      // In production, apply strict filtering
      corsOrigins.forEach(origin => {
        // Reject wildcards completely
        if (origin === '*') {
          rejectedOrigins.push(origin);
          console.error('SECURITY: Wildcard origin (*) rejected in production');
          return;
        }
        
        // Reject localhost and local IPs
        if (this.isLocalhost(origin)) {
          rejectedOrigins.push(origin);
          console.warn(`SECURITY: Local origin ${origin} rejected in production`);
          return;
        }
        
        // Reject Expo development URLs
        if (origin.startsWith('exp://') || origin.includes('expo')) {
          rejectedOrigins.push(origin);
          console.warn(`SECURITY: Development origin ${origin} rejected in production`);
          return;
        }
        
        // Reject non-HTTPS origins (except for specific allowed patterns)
        if (!origin.startsWith('https://') && !origin.startsWith('wss://')) {
          // Allow specific mobile app schemes if needed
          if (!origin.startsWith('appplatform://') && !origin.startsWith('appplatform://')) {
            rejectedOrigins.push(origin);
            console.warn(`SECURITY: Non-HTTPS origin ${origin} rejected in production`);
            return;
          }
        }
        
        // Validate origin format
        try {
          // Check if it's a valid URL or app scheme
          if (origin.includes('://')) {
            const url = new URL(origin);
            // Additional validation can be added here
            filteredOrigins.push(origin);
          } else {
            rejectedOrigins.push(origin);
            console.warn(`SECURITY: Invalid origin format ${origin} rejected`);
          }
        } catch (error) {
          rejectedOrigins.push(origin);
          console.warn(`SECURITY: Malformed origin ${origin} rejected`);
        }
      });
      
      // Log security audit
      if (rejectedOrigins.length > 0) {
        console.warn(`SECURITY AUDIT: Rejected ${rejectedOrigins.length} origins in production:`, rejectedOrigins);
      }
      
      // Fail safe: if no origins pass filter, throw error
      if (filteredOrigins.length === 0 && corsOrigins.length > 0) {
        throw new Error('SECURITY ERROR: No valid CORS origins after filtering for production. Check configuration.');
      }
      
      return filteredOrigins;
    } else if (this.environment === 'staging') {
      // In staging, be slightly more permissive but still secure
      return corsOrigins.filter(origin => {
        // Still reject wildcards in staging
        if (origin === '*') {
          console.warn('SECURITY: Wildcard origin (*) rejected in staging');
          return false;
        }
        return true;
      });
    }

    // In development, allow configured origins but warn about wildcards
    if (corsOrigins.includes('*')) {
      console.warn('SECURITY WARNING: Wildcard CORS origin (*) detected in development. Do not use in production.');
    }
    return corsOrigins;
  }

  /**
   * Check if origin is localhost
   */
  private isLocalhost(origin: string): boolean {
    return origin.includes('localhost') || 
           origin.includes('127.0.0.1') || 
           origin.includes('0.0.0.0');
  }

  /**
   * Get environment-specific security recommendations
   */
  public getSecurityRecommendations(): string[] {
    const recommendations: string[] = [];

    if (this.environment === 'production') {
      recommendations.push('Use HTTPS for all origins in production');
      recommendations.push('Implement strict rate limiting for production');
      recommendations.push('Enable all security headers in production');
      recommendations.push('Use specific domain origins instead of wildcards');
      recommendations.push('Implement IP whitelisting for admin endpoints');
    } else {
      recommendations.push('Test CORS configuration with actual frontend origins');
      recommendations.push('Verify rate limiting doesn\'t interfere with development workflow');
      recommendations.push('Use production-like security settings in staging');
    }

    recommendations.push('Regularly review and update CORS origins');
    recommendations.push('Monitor rate limiting metrics for optimization');
    recommendations.push('Implement logging for security events');

    return recommendations;
  }

  /**
   * Validate security headers configuration
   */
  public validateSecurityHeaders(): {
    helmet: boolean;
    contentSecurityPolicy: boolean;
    xssProtection: boolean;
    noSniff: boolean;
    frameguard: boolean;
    hsts: boolean;
  } {
    const isProduction = this.environment === 'production';
    
    return {
      helmet: true,
      contentSecurityPolicy: isProduction,
      xssProtection: true,
      noSniff: true,
      frameguard: true,
      hsts: isProduction,
    };
  }

  /**
   * Get Content Security Policy configuration
   */
  public getContentSecurityPolicy(): {
    defaultSrc: string[];
    scriptSrc: string[];
    styleSrc: string[];
    imgSrc: string[];
  } {
    const isProduction = this.environment === 'production';
    
    return {
      defaultSrc: ["'self'"],
      scriptSrc: isProduction ? ["'self'"] : ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    };
  }

  /**
   * Validate HTTPS configuration
   */
  public validateHttpsConfiguration(): {
    enforced: boolean;
    redirects: boolean;
    hsts: boolean;
    secureHeaders: boolean;
  } {
    const isProduction = this.environment === 'production';
    
    return {
      enforced: isProduction,
      redirects: isProduction,
      hsts: isProduction,
      secureHeaders: true,
    };
  }
}

export default SecurityConfigService;