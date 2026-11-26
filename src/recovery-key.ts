import type { CheckIdentity } from './types.js';

// GitHub treats commit status contexts as case-insensitive, so normalize them here and
// wherever a recovery key read from an existing alert needs to match a freshly computed one.
export const normalizeRecoveryCheckKey = (key: string): string => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(key, 'base64url').toString());
    if (!Array.isArray(parsed) || parsed.length !== 3) return key;
    const [source, name, id]: unknown[] = parsed;
    if (source !== 'status' || typeof name !== 'string') return key;
    return Buffer.from(JSON.stringify([source, name.toLowerCase(), id])).toString('base64url');
  } catch {
    return key;
  }
};

export const recoveryCheckKey = ({ name, source, workflowId, publisherId }: CheckIdentity): string | undefined => {
  const id = source === 'check' ? workflowId : publisherId;
  if (id === undefined || !Number.isSafeInteger(id) || id <= 0) return undefined;
  return normalizeRecoveryCheckKey(Buffer.from(JSON.stringify([source, name, id])).toString('base64url'));
};
