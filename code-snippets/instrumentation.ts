/**
 * OpenTelemetry Instrumentation Preload
 * 
 * This file MUST be loaded before any other application code to ensure
 * proper instrumentation of express, ioredis, socket.io, and other libraries.
 * 
 * Usage:
 *   node -r ./dist/instrumentation.js ./dist/index.js
 *   ts-node-dev -r ./src/instrumentation.ts ./src/index.ts
 * 
 * Why this is needed:
 * OpenTelemetry auto-instrumentations must be registered BEFORE the target
 * modules are imported. If express/ioredis/socket.io are imported first,
 * they won't be instrumented properly.
 * 
 * @module instrumentation
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

// Configuration from environment
const serviceName = process.env.OTEL_SERVICE_NAME || 'app-platform-backend';
const environment = process.env.NODE_ENV || 'development';
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 
                     process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

// Set up OpenTelemetry diagnostics (reduced verbosity for production)
diag.setLogger(
  new DiagConsoleLogger(),
  environment === 'development' ? DiagLogLevel.WARN : DiagLogLevel.ERROR
);

// Create resource with service identification
const resource = new Resource({
  [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
  [SemanticResourceAttributes.SERVICE_VERSION]: process.env.API_VERSION || '1.0.0',
  [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: environment,
  [SemanticResourceAttributes.CLOUD_PROVIDER]: 'aws',
  [SemanticResourceAttributes.CLOUD_REGION]: process.env.AWS_REGION || 'us-east-1',
});

// Configure span processors
const spanProcessors: BatchSpanProcessor[] = [];

// OTLP Exporter (only if endpoint is configured)
if (otlpEndpoint) {
  // Parse headers from environment variable
  const headers: Record<string, string> = {};
  const headersEnv = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (headersEnv) {
    headersEnv.split(',').forEach(header => {
      const [key, value] = header.split('=');
      if (key && value) {
        headers[key.trim()] = value.trim();
      }
    });
  }

  const otlpExporter = new OTLPTraceExporter({
    url: otlpEndpoint,
    headers,
  });
  spanProcessors.push(new BatchSpanProcessor(otlpExporter));
  
  // eslint-disable-next-line no-console
  console.log('OpenTelemetry OTLP exporter configured', { endpoint: otlpEndpoint });
}

// Initialize SDK with auto-instrumentations
const sdk = new NodeSDK({
  resource,
  spanProcessors,
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable noisy instrumentations
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      // Enable useful instrumentations
      '@opentelemetry/instrumentation-http': { enabled: true },
      '@opentelemetry/instrumentation-express': { enabled: true },
      '@opentelemetry/instrumentation-pg': { enabled: true },
      '@opentelemetry/instrumentation-redis': { enabled: true },
      '@opentelemetry/instrumentation-ioredis': { enabled: true },
      '@opentelemetry/instrumentation-socket.io': { enabled: true },
    }),
  ],
  idGenerator: new AWSXRayIdGenerator(),
  textMapPropagator: new AWSXRayPropagator(),
});

// Start SDK synchronously (this is safe in a preload script)
sdk.start();

// eslint-disable-next-line no-console
console.log('OpenTelemetry instrumentation initialized (preload)', {
  serviceName,
  environment,
  hasOtlpEndpoint: !!otlpEndpoint,
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  try {
    await sdk.shutdown();
    // eslint-disable-next-line no-console
    console.log('OpenTelemetry SDK shut down');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Error shutting down OpenTelemetry SDK', error);
  }
});



