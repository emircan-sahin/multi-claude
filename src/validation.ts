// ─── Config ───────────────────────────────────────────────
export const CONFIG = {
  heartbeatIntervalMs: 5000,
  peerNameMaxLength: 32,
  peerNamePattern: /^[a-zA-Z0-9_ -]+$/,
  messageMaxLength: 10000,
} as const;

// ─── Validation ───────────────────────────────────────────
export function validatePeerName(name: string): string | null {
  if (!name || name.length > CONFIG.peerNameMaxLength) {
    return `Name must be 1-${CONFIG.peerNameMaxLength} characters.`;
  }
  if (!CONFIG.peerNamePattern.test(name)) {
    return 'Name must contain only letters, numbers, spaces, hyphens, and underscores.';
  }
  return null;
}

export function validateMessage(message: string): string | null {
  if (!message || message.trim().length === 0) {
    return 'Message cannot be empty.';
  }
  if (message.length > CONFIG.messageMaxLength) {
    return `Message too long (max ${CONFIG.messageMaxLength} characters).`;
  }
  return null;
}
