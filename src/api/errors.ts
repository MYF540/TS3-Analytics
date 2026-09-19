import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

/** Uniform error body of every API response with status >= 400. */
export interface ApiErrorBody {
  error: {
    /** Stable machine-readable code; the frontend maps it to a (German) message. */
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Throw from route handlers for expected errors (not found, forbidden, conflict, …). */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

function codeForStatus(status: number): string {
  if (status === 404) return 'NOT_FOUND';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 415) return 'UNSUPPORTED_MEDIA_TYPE';
  if (status === 429) return 'RATE_LIMITED';
  return 'BAD_REQUEST';
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send(
        errorBody(
          'VALIDATION_ERROR',
          'Request validation failed',
          error.validation.map((issue) => ({
            location: error.validationContext,
            path: issue.instancePath || '/',
            message: issue.message,
          })),
        ),
      );
    }
    if (error instanceof ApiError) {
      return reply
        .status(error.statusCode)
        .send(errorBody(error.code, error.message, error.details));
    }
    const status = error.statusCode ?? 500;
    if (status < 500) {
      return reply.status(status).send(errorBody(codeForStatus(status), error.message));
    }
    // Never leak internals (stack, SQL, paths) to the client; the log has the details.
    request.log.error({ err: error, url: request.url }, 'Unhandled API error');
    return reply.status(500).send(errorBody('INTERNAL_ERROR', 'Internal server error'));
  });
}
