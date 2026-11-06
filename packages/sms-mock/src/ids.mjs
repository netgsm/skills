import { randomBytes, randomUUID } from 'node:crypto';

/** SMS API isteğe özgü kimlik: 32 küçük onaltılık karakter. */
export function smsRequestId() { return randomBytes(16).toString('hex'); }

/** Identity API isteğe özgü kimlik: UUID v4. */
export function identityRequestId() { return randomUUID(); }
