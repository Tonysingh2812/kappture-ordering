import { describe, expect, it } from 'vitest';
import { applyPaymentEvent } from '../../src/domain/payment-events.js';
import type {
  DecisionOutcome,
  OrderSnapshot,
  OrderStatus,
  PaymentEvent,
  PaymentEventType,
  PaymentSnapshot,
  PaymentStatus,
  ReviewReason,
} from '../../src/domain/types.js';

const order = (status: OrderStatus = 'AwaitingPayment'): OrderSnapshot => ({
  id: 'order-1',
  status,
  totalMinor: 2500,
  currency: 'GBP',
});

const payment = (status: PaymentStatus = 'Initiated'): PaymentSnapshot => ({
  id: 'pay-1',
  orderId: 'order-1',
  status,
  amountMinor: 2500,
  currency: 'GBP',
});

const event = (type: PaymentEventType, overrides: Partial<PaymentEvent> = {}): PaymentEvent => ({
  type,
  paymentId: 'pay-1',
  amountMinor: 2500,
  currency: 'GBP',
  ...overrides,
});

const flagReasons = (d: { reviewFlags: { reason: ReviewReason }[] }) => d.reviewFlags.map((f) => f.reason);

describe('applyPaymentEvent: full transition table (matching amounts)', () => {
  type Row = [
    from: PaymentStatus,
    orderStatus: OrderStatus,
    eventType: PaymentEventType,
    outcome: DecisionOutcome,
    paymentStatus: PaymentStatus,
    newOrderStatus: OrderStatus,
    flags: ReviewReason[],
  ];

  // prettier-ignore
  const table: Row[] = [
    // from Initiated
    ['Initiated',  'AwaitingPayment', 'PaymentAuthorised', 'applied',   'Authorised', 'AwaitingPayment', []],
    ['Initiated',  'AwaitingPayment', 'PaymentCaptured',   'applied',   'Captured',   'Paid',            ['CAPTURE_WITHOUT_AUTHORISATION']],
    ['Initiated',  'AwaitingPayment', 'PaymentFailed',     'applied',   'Failed',     'AwaitingPayment', []],
    ['Initiated',  'AwaitingPayment', 'PaymentCancelled',  'applied',   'Cancelled',  'AwaitingPayment', []],
    // from Authorised
    ['Authorised', 'AwaitingPayment', 'PaymentAuthorised', 'duplicate', 'Authorised', 'AwaitingPayment', []],
    ['Authorised', 'AwaitingPayment', 'PaymentCaptured',   'applied',   'Captured',   'Paid',            []],
    ['Authorised', 'AwaitingPayment', 'PaymentFailed',     'applied',   'Failed',     'AwaitingPayment', []],
    ['Authorised', 'AwaitingPayment', 'PaymentCancelled',  'applied',   'Cancelled',  'AwaitingPayment', []],
    // from Captured (order already Paid): nothing moves a capture backwards
    ['Captured',   'Paid',            'PaymentAuthorised', 'stale',     'Captured',   'Paid',            []],
    ['Captured',   'Paid',            'PaymentCaptured',   'duplicate', 'Captured',   'Paid',            []],
    ['Captured',   'Paid',            'PaymentFailed',     'stale',     'Captured',   'Paid',            ['CONFLICTING_EVENT_AFTER_CAPTURE']],
    ['Captured',   'Paid',            'PaymentCancelled',  'stale',     'Captured',   'Paid',            ['CONFLICTING_EVENT_AFTER_CAPTURE']],
    // from Failed: terminal, except a capture (money moved) wins
    ['Failed',     'AwaitingPayment', 'PaymentAuthorised', 'stale',     'Failed',     'AwaitingPayment', []],
    ['Failed',     'AwaitingPayment', 'PaymentCaptured',   'applied',   'Captured',   'Paid',            ['CAPTURE_AFTER_TERMINAL']],
    ['Failed',     'AwaitingPayment', 'PaymentFailed',     'duplicate', 'Failed',     'AwaitingPayment', []],
    ['Failed',     'AwaitingPayment', 'PaymentCancelled',  'stale',     'Failed',     'AwaitingPayment', []],
    // from Cancelled: same as Failed
    ['Cancelled',  'AwaitingPayment', 'PaymentAuthorised', 'stale',     'Cancelled',  'AwaitingPayment', []],
    ['Cancelled',  'AwaitingPayment', 'PaymentCaptured',   'applied',   'Captured',   'Paid',            ['CAPTURE_AFTER_TERMINAL']],
    ['Cancelled',  'AwaitingPayment', 'PaymentFailed',     'stale',     'Cancelled',  'AwaitingPayment', []],
    ['Cancelled',  'AwaitingPayment', 'PaymentCancelled',  'duplicate', 'Cancelled',  'AwaitingPayment', []],
  ];

  it.each(table)(
    'payment %s (order %s) + %s → %s, payment %s, order %s, flags %j',
    (from, orderStatus, eventType, outcome, paymentStatus, newOrderStatus, flags) => {
      const decision = applyPaymentEvent(order(orderStatus), payment(from), event(eventType));

      expect(decision.outcome).toBe(outcome);
      expect(decision.paymentStatus).toBe(paymentStatus);
      expect(decision.orderStatus).toBe(newOrderStatus);
      expect(flagReasons(decision)).toEqual(flags);
      expect(decision.reason).toEqual(expect.any(String));
    },
  );
});

describe('applyPaymentEvent: capture against order state', () => {
  it('does not release a cancelled order, but records the capture and flags it for refund', () => {
    const decision = applyPaymentEvent(order('Cancelled'), payment('Authorised'), event('PaymentCaptured'));

    expect(decision.outcome).toBe('applied');
    expect(decision.paymentStatus).toBe('Captured');
    expect(decision.orderStatus).toBe('Cancelled');
    expect(flagReasons(decision)).toEqual(['CAPTURE_ON_CANCELLED_ORDER']);
  });

  it.each<OrderStatus>(['Paid', 'Completed'])(
    'flags a second captured payment on an already %s order without changing the order',
    (orderStatus) => {
      const decision = applyPaymentEvent(order(orderStatus), payment('Authorised'), event('PaymentCaptured'));

      expect(decision.outcome).toBe('applied');
      expect(decision.paymentStatus).toBe('Captured');
      expect(decision.orderStatus).toBe(orderStatus);
      expect(flagReasons(decision)).toEqual(['DUPLICATE_PAYMENT_CAPTURED']);
    },
  );

  it('combines flags when an early capture lands on a cancelled order', () => {
    const decision = applyPaymentEvent(order('Cancelled'), payment('Initiated'), event('PaymentCaptured'));

    expect(decision.orderStatus).toBe('Cancelled');
    expect(flagReasons(decision)).toEqual(
      expect.arrayContaining(['CAPTURE_WITHOUT_AUTHORISATION', 'CAPTURE_ON_CANCELLED_ORDER']),
    );
  });
});

describe('applyPaymentEvent: confident matching', () => {
  it.each<[string, Partial<PaymentEvent>]>([
    ['amount differs', { amountMinor: 2499 }],
    ['currency differs', { currency: 'EUR' }],
  ])('rejects and flags a capture whose %s, leaving state unchanged', (_label, overrides) => {
    const decision = applyPaymentEvent(order(), payment('Authorised'), event('PaymentCaptured', overrides));

    expect(decision.outcome).toBe('rejected');
    expect(decision.paymentStatus).toBe('Authorised');
    expect(decision.orderStatus).toBe('AwaitingPayment');
    expect(flagReasons(decision)).toEqual(['AMOUNT_MISMATCH']);
  });

  it('rejects and flags a capture with no amount, since it cannot be confidently matched', () => {
    const { amountMinor: _a, currency: _c, ...noAmount } = event('PaymentCaptured');
    const decision = applyPaymentEvent(order(), payment('Authorised'), noAmount);

    expect(decision.outcome).toBe('rejected');
    expect(decision.orderStatus).toBe('AwaitingPayment');
    expect(flagReasons(decision)).toEqual(['AMOUNT_MISMATCH']);
  });

  it('rejects and flags an authorisation whose amount differs', () => {
    const decision = applyPaymentEvent(order(), payment('Initiated'), event('PaymentAuthorised', { amountMinor: 1 }));

    expect(decision.outcome).toBe('rejected');
    expect(decision.paymentStatus).toBe('Initiated');
    expect(flagReasons(decision)).toEqual(['AMOUNT_MISMATCH']);
  });

  it('accepts a failure event without an amount', () => {
    const { amountMinor: _a, currency: _c, ...noAmount } = event('PaymentFailed');
    const decision = applyPaymentEvent(order(), payment('Initiated'), noAmount);

    expect(decision.outcome).toBe('applied');
    expect(decision.paymentStatus).toBe('Failed');
  });

  it('rejects an event addressed to a different payment', () => {
    const decision = applyPaymentEvent(order(), payment(), event('PaymentCaptured', { paymentId: 'pay-other' }));

    expect(decision.outcome).toBe('rejected');
    expect(decision.paymentStatus).toBe('Initiated');
    expect(decision.orderStatus).toBe('AwaitingPayment');
  });

  it('rejects when the payment does not belong to the order', () => {
    const decision = applyPaymentEvent(
      { ...order(), id: 'order-other' },
      payment(),
      event('PaymentCaptured'),
    );

    expect(decision.outcome).toBe('rejected');
    expect(decision.orderStatus).toBe('AwaitingPayment');
  });
});

describe('applyPaymentEvent: purity', () => {
  it('does not mutate its inputs', () => {
    const o = order();
    const p = payment();
    const e = event('PaymentCaptured');
    const snapshot = structuredClone({ o, p, e });

    applyPaymentEvent(o, p, e);

    expect({ o, p, e }).toEqual(snapshot);
  });
});

describe('applyPaymentEvent: arrival order does not change the outcome', () => {
  const permutations = <T>(items: T[]): T[][] =>
    items.length <= 1
      ? [items]
      : items.flatMap((item, i) =>
          permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
        );

  const fold = (types: PaymentEventType[]) => {
    let o = order();
    let p = payment();
    for (const type of types) {
      const d = applyPaymentEvent(o, p, event(type));
      o = { ...o, status: d.orderStatus };
      p = { ...p, status: d.paymentStatus };
    }
    return { orderStatus: o.status, paymentStatus: p.status };
  };

  const allOrders = permutations<PaymentEventType>([
    'PaymentAuthorised',
    'PaymentCaptured',
    'PaymentFailed',
    'PaymentCaptured', // duplicate delivery
  ]);
  const unique = new Map(allOrders.map((s) => [s.join(' → '), s] as const));

  it.each([...unique.entries()])(
    'a matching capture always ends Captured/Paid: %s',
    (_label, sequence) => {
      expect(fold([...sequence])).toEqual({ orderStatus: 'Paid', paymentStatus: 'Captured' });
    },
  );
});
