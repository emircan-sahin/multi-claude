import { describe, it, expect } from 'vitest';
import { validatePeerName, validateMessage, CONFIG } from './validation';

describe('validatePeerName', () => {
  it('accepts valid names', () => {
    expect(validatePeerName('alice')).toBeNull();
    expect(validatePeerName('bob-123')).toBeNull();
    expect(validatePeerName('dev_team')).toBeNull();
  });

  it('rejects empty name', () => {
    expect(validatePeerName('')).toContain('1-');
  });

  it('rejects names that are too long', () => {
    const long = 'a'.repeat(CONFIG.peerNameMaxLength + 1);
    expect(validatePeerName(long)).toContain('characters');
  });

  it('rejects names with special characters', () => {
    expect(validatePeerName('alice bob')).toContain('letters');
    expect(validatePeerName('alice@bob')).toContain('letters');
    expect(validatePeerName('alice/bob')).toContain('letters');
  });
});

describe('validateMessage', () => {
  it('accepts valid messages', () => {
    expect(validateMessage('hello')).toBeNull();
    expect(validateMessage('How did you set up Stripe?')).toBeNull();
  });

  it('rejects empty messages', () => {
    expect(validateMessage('')).toContain('empty');
    expect(validateMessage('   ')).toContain('empty');
  });

  it('rejects messages that are too long', () => {
    const long = 'a'.repeat(CONFIG.messageMaxLength + 1);
    expect(validateMessage(long)).toContain('too long');
  });
});
