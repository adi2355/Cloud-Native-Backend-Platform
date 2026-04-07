import https from 'https';
import { URL } from 'url';
import type { TLSSocket } from 'tls';

/**
 * Certificate information interface
 */
export interface CertificateInfo {
  valid: boolean;
  tlsVersion?: string;
  cipher?: string;
  issuer?: string;
  validFrom?: Date;
  validTo?: Date;
  fingerprint?: string;
  serialNumber?: string;
}

/**
 * HTTPS validation result interface
 */
export interface HTTPSValidationResult {
  isSecure: boolean;
  certificateValid: boolean;
  tlsVersion?: string;
  cipher?: string;
  issuer?: string;
  validFrom?: Date;
  validTo?: Date;
  warnings: string[];
  errors: string[];
}

/**
 * Network security configuration interface
 */
export interface NetworkSecurityConfig {
  enforceHTTPS: boolean;
  allowSelfSignedCerts: boolean;
  minTLSVersion: string;
  requiredCiphers?: string[];
  certificateValidation: boolean;
}

/**
 * HTTPS Validation Service
 * Provides utilities for validating HTTPS connections and certificate security
 * Stateless service with configuration-based initialization
 */
export class HTTPSValidationService {
  private config: NetworkSecurityConfig;

  /**
   * Constructor - initializes HTTPS validation configuration based on environment
   */
  public constructor() {
    this.config = {
      enforceHTTPS: process.env.NODE_ENV === 'production',
      allowSelfSignedCerts: process.env.NODE_ENV === 'development',
      minTLSVersion: 'TLSv1.2',
      certificateValidation: true,
      requiredCiphers: [
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
      ],
    };
  }

  /**
   * Validate HTTPS connection to a given URL
   */
  public async validateHTTPSConnection(url: string): Promise<HTTPSValidationResult> {
    const result: HTTPSValidationResult = {
      isSecure: false,
      certificateValid: false,
      warnings: [],
      errors: [],
    };

    try {
      const parsedUrl = new URL(url);

      // Check if URL uses HTTPS
      if (parsedUrl.protocol !== 'https:') {
        result.errors.push('URL does not use HTTPS protocol');
        if (this.config.enforceHTTPS) {
          result.errors.push('HTTPS is required in production environment');
        }
        return result;
      }

      result.isSecure = true;

      // Validate certificate and connection
      const certificateInfo = await this.getCertificateInfo(parsedUrl.hostname, parsedUrl.port || '443');
      
      if (certificateInfo) {
        result.certificateValid = certificateInfo.valid;
        result.tlsVersion = certificateInfo.tlsVersion;
        result.cipher = certificateInfo.cipher;
        result.issuer = certificateInfo.issuer;
        result.validFrom = certificateInfo.validFrom;
        result.validTo = certificateInfo.validTo;

        // Check certificate expiration
        if (certificateInfo.validTo && certificateInfo.validTo < new Date()) {
          result.errors.push('Certificate has expired');
        } else if (certificateInfo.validTo && certificateInfo.validTo < new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)) {
          result.warnings.push('Certificate expires within 30 days');
        }

        // Check TLS version
        if (certificateInfo.tlsVersion && this.isTLSVersionInsecure(certificateInfo.tlsVersion)) {
          result.warnings.push(`TLS version ${certificateInfo.tlsVersion} is not recommended`);
        }

        // Check cipher strength
        if (certificateInfo.cipher && this.isCipherWeak(certificateInfo.cipher)) {
          result.warnings.push(`Cipher ${certificateInfo.cipher} may be weak`);
        }
      }

    } catch (error) {
      result.errors.push(`HTTPS validation failed: ${(error as Error).message}`);
    }

    return result;
  }

  /**
   * Get certificate information for a hostname
   */
  private async getCertificateInfo(hostname: string, port: string): Promise<CertificateInfo> {
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname,
        port: parseInt(port),
        method: 'GET',
        rejectUnauthorized: !this.config.allowSelfSignedCerts,
      };
      
      // SECURITY FIX: Use minVersion instead of hardcoded secureProtocol
      // This allows automatic negotiation of newer TLS versions
      if (this.config.minTLSVersion) {
        (options as { minVersion?: string }).minVersion = this.config.minTLSVersion;
      }

      const req = https.request(options, (res) => {
        const socket = res.socket as TLSSocket;
        const cert = socket.getPeerCertificate();
        const cipher = socket.getCipher();
        const protocol = socket.getProtocol();

        resolve({
          valid: socket.authorized || false,
          tlsVersion: protocol || undefined,
          cipher: cipher?.name,
          issuer: cert?.issuer?.CN,
          validFrom: cert?.valid_from ? new Date(cert.valid_from) : undefined,
          validTo: cert?.valid_to ? new Date(cert.valid_to) : undefined,
          fingerprint: cert?.fingerprint,
          serialNumber: cert?.serialNumber,
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Connection timeout'));
      });

      req.end();
    });
  }

  /**
   * Check if TLS version is insecure
   */
  private isTLSVersionInsecure(version: string): boolean {
    const insecureVersions = ['SSLv2', 'SSLv3', 'TLSv1', 'TLSv1.1'];
    return insecureVersions.some(insecure => version.includes(insecure));
  }

  /**
   * Check if cipher is weak
   */
  private isCipherWeak(cipher: string): boolean {
    const weakCiphers = ['RC4', 'DES', '3DES', 'MD5', 'SHA1'];
    return weakCiphers.some(weak => cipher.toUpperCase().includes(weak));
  }

  /**
   * Validate API endpoint URLs for HTTPS compliance
   */
  public async validateAPIEndpoints(endpoints: string[]): Promise<{ [url: string]: HTTPSValidationResult }> {
    const results: { [url: string]: HTTPSValidationResult } = {};

    for (const endpoint of endpoints) {
      try {
        results[endpoint] = await this.validateHTTPSConnection(endpoint);
      } catch (error) {
        results[endpoint] = {
          isSecure: false,
          certificateValid: false,
          warnings: [],
          errors: [`Validation failed: ${(error as Error).message}`],
        };
      }
    }

    return results;
  }

  /**
   * Generate security headers for HTTPS enforcement
   */
  public getSecurityHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};

    if (this.config.enforceHTTPS) {
      // Strict Transport Security
      headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains; preload';
      
      // Upgrade insecure requests
      headers['Content-Security-Policy'] = 'upgrade-insecure-requests';
    }

    return headers;
  }

  /**
   * Create HTTPS agent with secure configuration
   */
  public createSecureAgent(): https.Agent {
    const agentOptions: https.AgentOptions = {
      rejectUnauthorized: !this.config.allowSelfSignedCerts,
      ciphers: this.config.requiredCiphers?.join(':'),
      honorCipherOrder: true,
      checkServerIdentity: this.config.certificateValidation ? undefined : () => undefined,
    };
    
    // SECURITY FIX: Use minVersion for TLS version negotiation
    // This allows automatic negotiation of the highest supported version
    if (this.config.minTLSVersion) {
      (agentOptions as { minVersion?: string }).minVersion = this.config.minTLSVersion;
    }
    
    return new https.Agent(agentOptions);
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<NetworkSecurityConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  public getConfig(): NetworkSecurityConfig {
    return { ...this.config };
  }

  /**
   * Validate production readiness
   */
  public validateProductionReadiness(): { ready: boolean; issues: string[] } {
    const issues: string[] = [];

    if (!this.config.enforceHTTPS) {
      issues.push('HTTPS enforcement is disabled');
    }

    if (this.config.allowSelfSignedCerts) {
      issues.push('Self-signed certificates are allowed');
    }

    if (!this.config.certificateValidation) {
      issues.push('Certificate validation is disabled');
    }

    if (this.config.minTLSVersion !== 'TLSv1.2' && this.config.minTLSVersion !== 'TLSv1.3') {
      issues.push('Minimum TLS version should be 1.2 or higher');
    }

    return {
      ready: issues.length === 0,
      issues,
    };
  }
}