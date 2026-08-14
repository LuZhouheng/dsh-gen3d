// Audit — append-only JSONL trail of provider activity (ADR-0002).
// Records timing and outcome only; NEVER writes the api key, full request
// payload, or raw provider response. Appends to the workspace's flat
// <root>/.dsh-gen3d/audit.jsonl — the same file storage.ts owns — so it stays
// out of source control.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { GenerationMode, ProviderId } from '../shared/manifest.js';

export type AuditEvent =
  | 'submit'
  | 'poll_succeeded'
  | 'poll_failed'
  | 'poll_timeout'
  | 'cache_hit'
  | 'rate_blocked'
  | 'rest_succeeded'
  | 'rest_failed'
  | 'rest_no_output'
  | 'asset_deleted';

export interface AuditRecord {
  ts: string;
  provider: ProviderId;
  mode: GenerationMode;
  event: AuditEvent;
  sourceJobId?: string | null;
  assetPath?: string;
  cacheKey?: string;
  model?: string;
  httpStatus?: number;
  durationMs?: number;
  errorCode?: string;
  // Short, non-secret detail (e.g. status string, error class). Never payloads.
  detail?: string;
}

// Workspace root — same semantics as src/storage.ts: GEN3D_WORKSPACE_ROOT
// overrides, otherwise the caller's cwd.
function projectRoot(): string {
  return process.env.GEN3D_WORKSPACE_ROOT ?? process.cwd();
}

// Path-traversal guard, retained for signature compatibility and defense in
// depth: the audit file itself no longer derives from slug (storage.ts owns
// the flat <root>/.dsh-gen3d/audit.jsonl), but callers still pass a slug.
function safeSlug(slug: string): string {
  if (!slug || slug.includes('/') || slug.includes('\\') || slug === '..' || slug.includes('\0')) {
    throw Object.assign(new Error(`unsafe slug ${JSON.stringify(slug)}`), { code: 'invalid_slug' });
  }
  return slug;
}

function auditPath(slug: string): string {
  safeSlug(slug);
  return resolve(projectRoot(), '.dsh-gen3d', 'audit.jsonl');
}

export async function audit(slug: string, record: AuditRecord): Promise<void> {
  const path = auditPath(slug);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}
