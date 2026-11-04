/**
 * `@bridgistic/crypto` — credentials at rest.
 *
 * Byte-compatible with the pinned engine's envelope. The compatibility test is
 * the contract: change this format and every credential already stored becomes
 * unreadable.
 */

export { encryptSecret, decryptSecret, isEnvelope, envelopeVersion, reseal } from "./envelope.ts";
