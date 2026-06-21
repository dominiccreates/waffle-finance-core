/**
 * Tests for refund-watchdog instrumentation.
 *
 * Strategy: each describe block creates a fresh prom-client Registry so
 * counter values never bleed between tests. We achieve this by importing
 * the metric constructors directly and building per-test instances,
 * injecting them into a thin wrapper around the watchdog's internal tick
 * logic.
 *
 * Coverage:
 *  - isXlmToEthAwaitingEth eligibility filter
 *  - toMillis timestamp normalisation
 *  - successful refund: success counter, gauges, timestamp updated
 *  - failed refund: failure counter, backoff written to order
 *  - missing stellarAddress: failure counter with reason=missing_address
 *  - back-off skip: backoff skip counter, refund NOT attempted
 *  - not-yet-stale order: refund NOT attempted
 *  - multiple orders in one tick: each path counted independently
 *  - metrics endpoint returns text/plain Prometheus format
 *  - registry.metrics() output contains expected metric names
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Registry,
  Counter,
  Gauge,
  Histogram,
} from 'prom-client';
import { isXlmToEthAwaitingEth, toMillis } from '../src/services/refund-watchdog.js';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

/** Build a fresh isolated Registry + metric set for one test. */
function makeTestMetrics() {
  const reg = new Registry();
  return {
    reg,
    runsTotal: new Counter({
      name: 'test_watchdog_runs_total',
      help: 'test',
      registers: [reg],
    }),
    successTotal: new Counter({
      name: 'test_watchdog_success_total',
      help: 'test',
      labelNames: ['network_mode'] as const,
      registers: [reg],
    }),
    failureTotal: new Counter({
      name: 'test_watchdog_failure_total',
      help: 'test',
      labelNames: ['reason', 'network_mode'] as const,
      registers: [reg],
    }),
    staleDetected: new Counter({
      name: 'test_watchdog_stale_total',
      help: 'test',
      registers: [reg],
    }),
    backoffSkips: new Counter({
      name: 'test_watchdog_backoff_total',
      help: 'test',
      registers: [reg],
    }),
    lastRunTs: new Gauge({
      name: 'test_watchdog_last_run_ts',
      help: 'test',
      registers: [reg],
    }),
    maxStaleAge: new Gauge({
      name: 'test_watchdog_max_stale_age',
      help: 'test',
      registers: [reg],
    }),
    pendingRefunds: new Gauge({
      name: 'test_watchdog_pending_refunds',
      help: 'test',
      registers: [reg],
    }),
    tickDuration: new Histogram({
      name: 'test_watchdog_tick_duration',
      help: 'test',
      registers: [reg],
    }),
  };
}

/** Counter value helper — avoids async registry.getSingleMetricAsString. */
async function counterValue(
  counter: Counter<string>,
  labels: Record<string, string> = {}
): Promise<number> {
  const json = await counter.get();
  const found = json.values.find((v) => {
    const keys = Object.keys(labels);
    return keys.every((k) => v.labels[k] === labels[k]);
  });
  return found?.value ?? 0;
}

async function gaugeValue(gauge: Gauge<string>): Promise<number> {
  const json = await gauge.get();
  return json.values[0]?.value ?? 0;
}

/** Minimal tick implementation reusing the same logic as the real watchdog
 *  but injecting test-scoped metrics. */
interface TickDeps {
  activeOrders: Map<string, Record<string, unknown>>;
  staleAfterMs: number;
  networkMode: 'mainnet' | 'testnet';
  refundFn: (args: unknown) => Promise<{ hash: string; amount: string }>;
  m: ReturnType<typeof makeTestMetrics>;
}

async function runTick(deps: TickDeps): Promise<void> {
  const { activeOrders, staleAfterMs, networkMode, refundFn, m } = deps;
  const tickEnd = m.tickDuration.startTimer();
  const now = Date.now();

  let maxStaleAgeMs = 0;
  let pendingCount = 0;

  try {
    for (const [orderId, order] of activeOrders.entries()) {
      try {
        if (!isXlmToEthAwaitingEth(order as any)) continue;
        pendingCount++;

        if (
          order['watchdogFailedAt'] &&
          now - (order['watchdogFailedAt'] as number) < 10 * 60_000
        ) {
          m.backoffSkips.inc();
          continue;
        }

        const startedAt =
          toMillis(order['xlmReceivedAt'] as any) ??
          toMillis(order['created'] as any);
        if (!startedAt) continue;

        const age = now - startedAt;
        if (age < staleAfterMs) continue;

        maxStaleAgeMs = Math.max(maxStaleAgeMs, age);
        m.staleDetected.inc();

        const stellarAddress = order['stellarAddress'] as string | undefined;
        if (!stellarAddress) {
          m.failureTotal.inc({ reason: 'missing_address', network_mode: networkMode });
          continue;
        }

        const refund = await refundFn({ orderId, stellarAddress });
        order['status'] = 'refunded';
        order['refundTxHash'] = refund.hash;
        order['refundedAt'] = Date.now();
        m.successTotal.inc({ network_mode: networkMode });
      } catch (err: unknown) {
        order['watchdogFailedAt'] = Date.now();
        order['watchdogFailureReason'] =
          err instanceof Error ? err.message : String(err);
        m.failureTotal.inc({ reason: 'refund_error', network_mode: networkMode });
      }
    }
  } finally {
    tickEnd();
    m.runsTotal.inc();
    m.lastRunTs.set(Math.floor(Date.now() / 1000));
    m.maxStaleAge.set(maxStaleAgeMs / 1000);
    m.pendingRefunds.set(pendingCount);
  }
}

// ---------------------------------------------------------------------------
// Unit: isXlmToEthAwaitingEth
// ---------------------------------------------------------------------------

describe('isXlmToEthAwaitingEth', () => {
  it('returns true for a pending xlm_to_eth order with stellarTxHash', () => {
    expect(
      isXlmToEthAwaitingEth({
        direction: 'xlm_to_eth',
        stellarTxHash: '0xabc',
        status: 'pending',
      })
    ).toBe(true);
  });

  it('returns false for eth_to_xlm direction', () => {
    expect(
      isXlmToEthAwaitingEth({ direction: 'eth_to_xlm', stellarTxHash: '0xabc' })
    ).toBe(false);
  });

  it('returns false when stellarTxHash is missing', () => {
    expect(isXlmToEthAwaitingEth({ direction: 'xlm_to_eth' })).toBe(false);
  });

  it('returns false when already refunded (refundTxHash set)', () => {
    expect(
      isXlmToEthAwaitingEth({
        direction: 'xlm_to_eth',
        stellarTxHash: '0xabc',
        refundTxHash: '0xdef',
      })
    ).toBe(false);
  });

  it('returns false when status is completed', () => {
    expect(
      isXlmToEthAwaitingEth({
        direction: 'xlm_to_eth',
        stellarTxHash: '0xabc',
        status: 'completed',
      })
    ).toBe(false);
  });

  it('returns false when status is eth_tx_sent', () => {
    expect(
      isXlmToEthAwaitingEth({
        direction: 'xlm_to_eth',
        stellarTxHash: '0xabc',
        status: 'eth_tx_sent',
      })
    ).toBe(false);
  });

  it('returns false when status is refunded', () => {
    expect(
      isXlmToEthAwaitingEth({
        direction: 'xlm_to_eth',
        stellarTxHash: '0xabc',
        status: 'refunded',
      })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit: toMillis
// ---------------------------------------------------------------------------

describe('toMillis', () => {
  it('returns null for null/undefined', () => {
    expect(toMillis(undefined)).toBeNull();
    expect(toMillis(null as any)).toBeNull();
  });

  it('returns ms-range number as-is when > 1e12', () => {
    const ts = Date.now();
    expect(toMillis(ts)).toBe(ts);
  });

  it('converts seconds-range number to ms', () => {
    const sec = Math.floor(Date.now() / 1000);
    expect(toMillis(sec)).toBe(sec * 1000);
  });

  it('parses ISO date string to ms', () => {
    const iso = new Date(2024, 0, 15).toISOString();
    expect(toMillis(iso)).toBe(Date.parse(iso));
  });

  it('returns null for unparseable string', () => {
    expect(toMillis('not-a-date')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: tick metrics — success path
// ---------------------------------------------------------------------------

describe('watchdog tick: successful refund', () => {
  it('increments success counter and records gauges', async () => {
    const m = makeTestMetrics();
    const refundFn = vi.fn().mockResolvedValue({ hash: '0xhash1', amount: '10' });

    const order = {
      direction: 'xlm_to_eth',
      stellarTxHash: '0xstellar',
      stellarAddress: 'GABC123',
      xlmReceivedAt: Date.now() - 10 * 60_000, // 10 min ago → stale
    };
    const orders = new Map([['order-1', order as any]]);

    await runTick({
      activeOrders: orders,
      staleAfterMs: 5 * 60_000,
      networkMode: 'testnet',
      refundFn,
      m,
    });

    expect(await counterValue(m.successTotal, { network_mode: 'testnet' })).toBe(1);
    expect(await counterValue(m.failureTotal)).toBe(0);
    expect(await counterValue(m.staleDetected)).toBe(1);
    expect(await counterValue(m.runsTotal)).toBe(1);
    expect(await gaugeValue(m.pendingRefunds)).toBe(1);
    expect(await gaugeValue(m.maxStaleAge)).toBeGreaterThan(0);
    expect(await gaugeValue(m.lastRunTs)).toBeGreaterThan(0);
    expect(order.status).toBe('refunded');
    expect(order.refundTxHash).toBe('0xhash1');
    expect(refundFn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Integration: tick metrics — failure path
// ---------------------------------------------------------------------------

describe('watchdog tick: failed refund', () => {
  it('increments failure counter and stamps order with backoff fields', async () => {
    const m = makeTestMetrics();
    const refundFn = vi.fn().mockRejectedValue(new Error('horizon timeout'));

    const order: Record<string, unknown> = {
      direction: 'xlm_to_eth',
      stellarTxHash: '0xstellar',
      stellarAddress: 'GABC123',
      xlmReceivedAt: Date.now() - 10 * 60_000,
    };
    const orders = new Map([['order-1', order]]);

    await runTick({
      activeOrders: orders,
      staleAfterMs: 5 * 60_000,
      networkMode: 'mainnet',
      refundFn,
      m,
    });

    expect(
      await counterValue(m.failureTotal, { reason: 'refund_error', network_mode: 'mainnet' })
    ).toBe(1);
    expect(await counterValue(m.successTotal)).toBe(0);
    expect(await counterValue(m.runsTotal)).toBe(1);
    expect(order['watchdogFailedAt']).toBeTypeOf('number');
    expect(order['watchdogFailureReason']).toBe('horizon timeout');
  });
});

// ---------------------------------------------------------------------------
// Integration: tick metrics — missing address
// ---------------------------------------------------------------------------

describe('watchdog tick: missing stellarAddress', () => {
  it('records failure with reason=missing_address, does not call refund', async () => {
    const m = makeTestMetrics();
    const refundFn = vi.fn();

    const order = {
      direction: 'xlm_to_eth',
      stellarTxHash: '0xstellar',
      // stellarAddress intentionally absent
      xlmReceivedAt: Date.now() - 10 * 60_000,
    };
    const orders = new Map([['order-2', order as any]]);

    await runTick({
      activeOrders: orders,
      staleAfterMs: 5 * 60_000,
      networkMode: 'testnet',
      refundFn,
      m,
    });

    expect(
      await counterValue(m.failureTotal, { reason: 'missing_address', network_mode: 'testnet' })
    ).toBe(1);
    expect(await counterValue(m.successTotal)).toBe(0);
    expect(refundFn).not.toHaveBeenCalled();
    expect(await counterValue(m.staleDetected)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: tick metrics — back-off skip
// ---------------------------------------------------------------------------

describe('watchdog tick: back-off skip', () => {
  it('increments backoff counter and does not attempt refund', async () => {
    const m = makeTestMetrics();
    const refundFn = vi.fn();

    const order = {
      direction: 'xlm_to_eth',
      stellarTxHash: '0xstellar',
      stellarAddress: 'GABC123',
      xlmReceivedAt: Date.now() - 10 * 60_000,
      watchdogFailedAt: Date.now() - 60_000, // only 1 min ago → still in 10-min back-off
    };
    const orders = new Map([['order-3', order as any]]);

    await runTick({
      activeOrders: orders,
      staleAfterMs: 5 * 60_000,
      networkMode: 'testnet',
      refundFn,
      m,
    });

    expect(await counterValue(m.backoffSkips)).toBe(1);
    expect(await counterValue(m.successTotal)).toBe(0);
    expect(refundFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Integration: tick metrics — not yet stale
// ---------------------------------------------------------------------------

describe('watchdog tick: not yet stale', () => {
  it('does not attempt refund when order is younger than staleAfterMs', async () => {
    const m = makeTestMetrics();
    const refundFn = vi.fn();

    const order = {
      direction: 'xlm_to_eth',
      stellarTxHash: '0xstellar',
      stellarAddress: 'GABC123',
      xlmReceivedAt: Date.now() - 60_000, // only 1 min ago
    };
    const orders = new Map([['order-4', order as any]]);

    await runTick({
      activeOrders: orders,
      staleAfterMs: 5 * 60_000,
      networkMode: 'testnet',
      refundFn,
      m,
    });

    expect(await counterValue(m.staleDetected)).toBe(0);
    expect(await counterValue(m.successTotal)).toBe(0);
    expect(refundFn).not.toHaveBeenCalled();
    // runs counter still increments — tick completed
    expect(await counterValue(m.runsTotal)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: multiple orders in one tick
// ---------------------------------------------------------------------------

describe('watchdog tick: multiple orders', () => {
  it('counts each path independently across orders', async () => {
    const m = makeTestMetrics();
    const refundFn = vi
      .fn()
      .mockResolvedValueOnce({ hash: '0xhash-a', amount: '5' })
      .mockRejectedValueOnce(new Error('rpc error'));

    const staleTime = Date.now() - 10 * 60_000;

    const orders = new Map<string, Record<string, unknown>>([
      // order-a: will succeed
      ['order-a', { direction: 'xlm_to_eth', stellarTxHash: '0xsa', stellarAddress: 'GA1', xlmReceivedAt: staleTime }],
      // order-b: will fail
      ['order-b', { direction: 'xlm_to_eth', stellarTxHash: '0xsb', stellarAddress: 'GB1', xlmReceivedAt: staleTime }],
      // order-c: already completed — should be skipped
      ['order-c', { direction: 'xlm_to_eth', stellarTxHash: '0xsc', stellarAddress: 'GC1', status: 'completed', xlmReceivedAt: staleTime }],
      // order-d: eth_to_xlm — ignored
      ['order-d', { direction: 'eth_to_xlm', stellarTxHash: '0xsd', stellarAddress: 'GD1', xlmReceivedAt: staleTime }],
    ]);

    await runTick({ activeOrders: orders, staleAfterMs: 5 * 60_000, networkMode: 'testnet', refundFn, m });

    expect(await counterValue(m.successTotal, { network_mode: 'testnet' })).toBe(1);
    expect(await counterValue(m.failureTotal, { reason: 'refund_error', network_mode: 'testnet' })).toBe(1);
    expect(await counterValue(m.staleDetected)).toBe(2);
    expect(await counterValue(m.runsTotal)).toBe(1);
    expect(await gaugeValue(m.pendingRefunds)).toBe(2);
    expect(refundFn).toHaveBeenCalledTimes(2);
    expect(orders.get('order-a')?.['status']).toBe('refunded');
  });
});

// ---------------------------------------------------------------------------
// Integration: back-off expires — refund retried after 10 min
// ---------------------------------------------------------------------------

describe('watchdog tick: back-off expired', () => {
  it('retries after 10-minute back-off window passes', async () => {
    const m = makeTestMetrics();
    const refundFn = vi.fn().mockResolvedValue({ hash: '0xretry', amount: '3' });

    const order: Record<string, unknown> = {
      direction: 'xlm_to_eth',
      stellarTxHash: '0xstellar',
      stellarAddress: 'GABC',
      xlmReceivedAt: Date.now() - 20 * 60_000,
      watchdogFailedAt: Date.now() - 11 * 60_000, // 11 min ago → back-off expired
    };
    const orders = new Map([['order-retry', order]]);

    await runTick({ activeOrders: orders, staleAfterMs: 5 * 60_000, networkMode: 'testnet', refundFn, m });

    expect(await counterValue(m.successTotal, { network_mode: 'testnet' })).toBe(1);
    expect(await counterValue(m.backoffSkips)).toBe(0);
    expect(refundFn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Integration: empty order map
// ---------------------------------------------------------------------------

describe('watchdog tick: empty order map', () => {
  it('completes cleanly with zero counts', async () => {
    const m = makeTestMetrics();
    const refundFn = vi.fn();

    await runTick({
      activeOrders: new Map(),
      staleAfterMs: 5 * 60_000,
      networkMode: 'testnet',
      refundFn,
      m,
    });

    expect(await counterValue(m.runsTotal)).toBe(1);
    expect(await counterValue(m.successTotal)).toBe(0);
    expect(await counterValue(m.failureTotal)).toBe(0);
    expect(await gaugeValue(m.pendingRefunds)).toBe(0);
    expect(await gaugeValue(m.maxStaleAge)).toBe(0);
    expect(refundFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Metrics module: registry output
// ---------------------------------------------------------------------------

describe('relayer metrics registry', () => {
  it('exports Prometheus text with all watchdog metric names', async () => {
    // Import the real registry — module is already loaded, metrics are registered
    const { registry } = await import('../src/metrics.js');
    const output = await registry.metrics();

    const expectedNames = [
      'relayer_refund_watchdog_runs_total',
      'relayer_refund_watchdog_success_total',
      'relayer_refund_watchdog_failure_total',
      'relayer_refund_watchdog_stale_orders_detected_total',
      'relayer_refund_watchdog_backoff_skips_total',
      'relayer_refund_watchdog_last_run_timestamp_seconds',
      'relayer_refund_watchdog_max_stale_age_seconds',
      'relayer_refund_watchdog_pending_refunds',
      'relayer_refund_watchdog_tick_duration_seconds',
    ];

    for (const name of expectedNames) {
      expect(output, `missing metric: ${name}`).toContain(name);
    }
  });

  it('content type is text/plain Prometheus format', async () => {
    const { registry } = await import('../src/metrics.js');
    expect(registry.contentType).toMatch(/text\/plain/);
  });
});

// ---------------------------------------------------------------------------
// Metrics HTTP route
// ---------------------------------------------------------------------------

describe('metrics HTTP route', () => {
  it('GET /metrics returns 200 with Prometheus text body', async () => {
    const express = (await import('express')).default;
    const { metricsRouter } = await import('../src/routes/metrics.js');

    const app = express();
    app.use(metricsRouter());

    const { default: supertest } = await import('supertest');
    const res = await supertest(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('relayer_refund_watchdog_runs_total');
  });
});
