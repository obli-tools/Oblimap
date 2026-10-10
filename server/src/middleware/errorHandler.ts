import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Client errors raised by body-parser (express.json): answered as such, not as a 500. */
const BODY_PARSER_ERRORS: Record<string, { status: number; error: string }> = {
  'entity.too.large': { status: 413, error: 'Payload too large' },
  'entity.parse.failed': { status: 400, error: 'Invalid JSON body' },
  'entity.verify.failed': { status: 400, error: 'Invalid body' },
  'request.aborted': { status: 400, error: 'Request aborted' },
  'request.size.invalid': { status: 400, error: 'Invalid body size' },
  'encoding.unsupported': { status: 415, error: 'Unsupported content encoding' },
  'charset.unsupported': { status: 415, error: 'Unsupported charset' },
};

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Probe endpoints: older probes decode any non-401 JSON body as a config, so
  // an error body must carry `config: false` (never an empty config that
  // would wipe their subnet exclusions).
  const probeExtra = req.originalUrl?.startsWith('/api/probe/') ? { config: false } : {};

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
      ...probeExtra,
    });
    return;
  }

  const parserType = (err as { type?: unknown }).type;
  const parserError = typeof parserType === 'string' ? BODY_PARSER_ERRORS[parserType] : undefined;
  if (parserError) {
    logger.warn({ type: parserType, path: req.path }, 'Rejected request body');
    res.status(parserError.status).json({ success: false, error: parserError.error, ...probeExtra });
    return;
  }

  logger.error(err, 'Unhandled error');
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    ...probeExtra,
  });
}
