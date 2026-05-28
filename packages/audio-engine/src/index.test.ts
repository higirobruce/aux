import { describe, expect, it } from 'vitest';
import { AudioHost } from './host.js';

describe('AudioHost', () => {
  it('is constructible without touching the AudioContext until start()', () => {
    const host = new AudioHost({ workletUrl: 'about:blank' });
    expect(host).toBeInstanceOf(AudioHost);
    expect(host.context).toBeNull();
  });

  it('keeps a no-op listener registry until events arrive', () => {
    const host = new AudioHost({ workletUrl: 'about:blank' });
    const unsubscribe = host.onEvent(() => {});
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });

  it('send() throws before start() is called', () => {
    const host = new AudioHost({ workletUrl: 'about:blank' });
    expect(() => host.send({ type: 'transport', action: 'stop' })).toThrow(
      /AudioHost not started/
    );
  });
});
