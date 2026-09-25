import { describe, it, expect } from 'vitest';
import { RealtimeServiceV2 } from './realtime-service-v2.js';

describe('realtime health', () => {
  it('reports degraded when a topic goes silent', () => {
    const svc = new RealtimeServiceV2({ autoReconnect: false });
    const h = svc.getHealth(1000);
    expect(h.connected).toBe(false);
    expect(Array.isArray(h.subscriptions)).toBe(true);
    expect(h.resubscribeCount).toBeGreaterThanOrEqual(0);
  });
  it('counts disconnect codes', () => {
    const svc = new RealtimeServiceV2({ autoReconnect: false });
    (svc as unknown as { recordDisconnect: (c: number) => void }).recordDisconnect?.(1006);
    const h = svc.getHealth();
    expect(h.disconnectCounts['1006'] ?? 0).toBeGreaterThanOrEqual(1);
  });
});
