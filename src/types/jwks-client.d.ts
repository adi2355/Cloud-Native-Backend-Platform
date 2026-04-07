declare module 'jwks-client' {
  export interface JwksClient {
    getSigningKey(kid: string): Promise<{
      getPublicKey(): string;
    }>;
  }

  export interface JwksClientOptions {
    jwksUri: string;
    requestHeaders?: Record<string, string>;
    timeout?: number;
    cache?: boolean;
    cacheMaxEntries?: number;
    cacheMaxAge?: number;
    rateLimit?: boolean;
    jwksRequestsPerMinute?: number;
  }

  export default function jwksClient(options: JwksClientOptions): JwksClient;
}