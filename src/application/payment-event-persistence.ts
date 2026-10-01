import { applyPaymentEvent } from '../domain/payment-events.ts';
import type { PaymentEvent, PaymentEventDecision } from '../domain/types.ts';
import type { IsoTimestamp, OrderRecord, PaymentRecord } from './ports/records.ts';
import type { DataStore } from './ports/repositories.ts';

export interface PersistPaymentEventInput {
  order: OrderRecord;
  payment: PaymentRecord;
  event: PaymentEvent;
  now: IsoTimestamp;
}

/**
 * Asks the domain what a payment event means, then saves the decision: status changes (with optimistic
 * concurrency), audit events and review flags. Shared by provider responses, webhooks and reconciliation,
 * so every source of payment truth goes through the same rules.
 *
 * Must be called inside `dataStore.runInTransaction`.
 */
export function persistPaymentEvent(dataStore: DataStore, input: PersistPaymentEventInput): PaymentEventDecision {
  const { order, payment, event, now } = input;
  const decision = applyPaymentEvent(order, payment, event);

  if (decision.outcome === 'applied') {
    if (decision.paymentStatus !== payment.status) {
      dataStore.payments.update(payment.id, { status: decision.paymentStatus }, payment.version, now);
      dataStore.orderEvents.append({
        orderId: order.id,
        type: event.type,
        data: { paymentId: payment.id, from: payment.status, to: decision.paymentStatus },
        occurredAt: now,
      });
    }
    // Payment events can only move an order to Paid (the domain never does anything else).
    if (decision.orderStatus !== order.status && decision.orderStatus === 'Paid') {
      dataStore.orders.updateStatus(order.id, decision.orderStatus, order.version, now);
      dataStore.orderEvents.append({
        orderId: order.id,
        type: 'OrderPaid',
        data: { paymentId: payment.id },
        occurredAt: now,
      });
    }
  }

  for (const flag of decision.reviewFlags) {
    dataStore.reviewFlags.insert({
      orderId: order.id,
      paymentId: payment.id,
      reason: flag.reason,
      details: flag.details,
      createdAt: now,
    });
  }

  return decision;
}
