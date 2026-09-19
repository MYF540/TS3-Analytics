import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../context.js';
import { ANONYMOUS_ACTOR, writeAudit, type AuditEntry } from './audit.js';

/** What a handler knows about its action; everything else is filled in by the plugin. */
export type AuditInfo = Partial<
  Pick<AuditEntry, 'action' | 'targetType' | 'targetId' | 'details' | 'actorId' | 'actorName'>
>;

declare module 'fastify' {
  interface FastifyRequest {
    /** Describe the action for the audit log (optional; a generic entry is written anyway). */
    audit: (info: AuditInfo) => void;
    auditInfo: AuditInfo | undefined;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Writes an audit entry after every state-changing `/api` request (AGENTS.md rule 10) – also
 * for failed or rejected ones. Request bodies are never copied automatically, so passwords
 * cannot end up in the log; handlers add safe details via `request.audit()`.
 */
export function registerAudit(app: FastifyInstance, context: ApiContext): void {
  app.decorateRequest('auditInfo', undefined);
  app.decorateRequest(
    'audit',
    function (this: { auditInfo: AuditInfo | undefined }, info: AuditInfo) {
      this.auditInfo = { ...this.auditInfo, ...info };
    },
  );

  app.addHook('onResponse', (request, reply, done) => {
    if (SAFE_METHODS.has(request.method) || !request.url.startsWith('/api/')) {
      done();
      return;
    }
    const info = request.auditInfo ?? {};
    const route = request.routeOptions.url ?? request.url.split('?')[0] ?? request.url;
    try {
      writeAudit(context.database.db, {
        at: context.now(),
        actorId: info.actorId ?? request.user?.id ?? null,
        actorName: info.actorName ?? request.user?.username ?? ANONYMOUS_ACTOR,
        action: info.action ?? `${request.method} ${route}`,
        targetType: info.targetType,
        targetId: info.targetId,
        details: info.details,
        status: reply.statusCode,
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to write audit entry');
    }
    done();
  });
}
