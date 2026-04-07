import express, { type RequestHandler, type Request } from 'express';
import { AppError, ErrorCodes } from '../../../utils/AppError';
import { parseByteSize } from '../../../utils/parseByteSize';
import type { LoggerService } from '../../../services/logger.service';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
  rawBodyBytes?: number;
  rawBodyLimitBytes?: number;
}

export interface JsonBodyParserOptions {
  readonly jsonLimit: string;
  readonly inflatedJsonLimit: string;
  readonly logger: LoggerService;
}

export function createJsonBodyParser(options: JsonBodyParserOptions): RequestHandler {
  const maxInflatedBytes = parseByteSize(options.inflatedJsonLimit);

  return express.json({
    limit: options.jsonLimit,
    inflate: true,
    verify: (req, _res, buf) => {
      const request = req as RawBodyRequest;
      request.rawBody = buf;
      request.rawBodyBytes = buf.length;
      request.rawBodyLimitBytes = maxInflatedBytes;

      if (buf.length > maxInflatedBytes) {
        options.logger.warn('Request body exceeds inflated size limit', {
          context: 'jsonBodyParser',
          // Note: Express verify callback receives http.IncomingMessage, not Express.Request
          // IncomingMessage has 'url' property, not 'path'
          url: req.url,
          method: req.method,
          contentEncoding: req.headers['content-encoding'] ?? 'identity',
          contentLength: req.headers['content-length'],
          inflatedBytes: buf.length,
          inflatedLimitBytes: maxInflatedBytes,
        });

        throw new AppError(
          413,
          ErrorCodes.INVALID_INPUT,
          'Request body too large after decompression',
          true,
          {
            maxBytes: maxInflatedBytes,
            actualBytes: buf.length,
          }
        );
      }
    },
  });
}
