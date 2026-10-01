import type Database from 'better-sqlite3';
import { ConcurrencyError } from '../../application/errors.ts';
import type {
  IdempotencyRecord,
  OrderEventRecord,
  OrderRecord,
  PaymentEventRecord,
  PaymentRecord,
  ReviewFlagRecord,
} from '../../application/ports/records.ts';
import type {
  IdempotencyRepository,
  ListOptions,
  OrderEventRepository,
  OrderRepository,
  PaymentEventRepository,
  PaymentRepository,
  ReviewFlagRepository,
} from '../../application/ports/repositories.ts';

type Row = Record<string, unknown>;

/** SQLite treats LIMIT -1 as "no limit". */
const noLimit = -1;

function listQuery<TStatus>(
  db: Database.Database,
  table: string,
  statusColumn: string,
  orderBy: string,
  options: ListOptions<TStatus>,
): Row[] {
  const hasStatusFilter = options.status !== undefined;
  const where = hasStatusFilter ? `WHERE ${statusColumn} = @status` : '';
  return db
    .prepare(`SELECT * FROM ${table} ${where} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`)
    .all({ status: options.status ?? null, limit: options.limit ?? noLimit, offset: options.offset ?? 0 }) as Row[];
}

// ---------- orders ----------

const toOrder = (row: Row): OrderRecord => ({
  id: row.id as string,
  venueId: row.venue_id as string,
  tableRef: row.table_ref as string,
  items: JSON.parse(row.items as string),
  totalMinor: row.total_minor as number,
  currency: row.currency as string,
  status: row.status as OrderRecord['status'],
  version: row.version as number,
  createdAt: row.created_at as string,
  updatedAt: row.updated_at as string,
});

export function createOrderRepository(db: Database.Database): OrderRepository {
  return {
    insert(order) {
      db.prepare(
        `INSERT INTO orders (id, venue_id, table_ref, items, total_minor, currency, status, version, created_at, updated_at)
         VALUES (@id, @venueId, @tableRef, @items, @totalMinor, @currency, @status, @version, @createdAt, @updatedAt)`,
      ).run({ ...order, items: JSON.stringify(order.items) });
    },

    findById(id) {
      const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Row | undefined;
      return row ? toOrder(row) : null;
    },

    updateStatus(id, status, expectedVersion, updatedAt) {
      const result = db
        .prepare(
          `UPDATE orders SET status = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(status, updatedAt, id, expectedVersion);
      if (result.changes === 0) throw new ConcurrencyError('Order', id, expectedVersion);
      return expectedVersion + 1;
    },

    list(options = {}) {
      return listQuery(db, 'orders', 'status', 'created_at, id', options).map(toOrder);
    },
  };
}

// ---------- payments ----------

const toPayment = (row: Row): PaymentRecord => ({
  id: row.id as string,
  orderId: row.order_id as string,
  providerPaymentId: (row.provider_payment_id as string | null) ?? null,
  amountMinor: row.amount_minor as number,
  currency: row.currency as string,
  status: row.status as PaymentRecord['status'],
  providerIdempotencyKey: row.provider_idempotency_key as string,
  version: row.version as number,
  createdAt: row.created_at as string,
  updatedAt: row.updated_at as string,
});

export function createPaymentRepository(db: Database.Database): PaymentRepository {
  return {
    insert(payment) {
      db.prepare(
        `INSERT INTO payments (id, order_id, provider_payment_id, amount_minor, currency, status,
                               provider_idempotency_key, version, created_at, updated_at)
         VALUES (@id, @orderId, @providerPaymentId, @amountMinor, @currency, @status,
                 @providerIdempotencyKey, @version, @createdAt, @updatedAt)`,
      ).run(payment);
    },

    findById(id) {
      const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as Row | undefined;
      return row ? toPayment(row) : null;
    },

    findByOrderId(orderId) {
      return (db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at, id').all(orderId) as Row[]).map(
        toPayment,
      );
    },

    update(id, changes, expectedVersion, updatedAt) {
      const result = db
        .prepare(
          `UPDATE payments
           SET status = COALESCE(@status, status),
               provider_payment_id = COALESCE(@providerPaymentId, provider_payment_id),
               version = version + 1,
               updated_at = @updatedAt
           WHERE id = @id AND version = @expectedVersion`,
        )
        .run({
          id,
          expectedVersion,
          updatedAt,
          status: changes.status ?? null,
          providerPaymentId: changes.providerPaymentId ?? null,
        });
      if (result.changes === 0) throw new ConcurrencyError('Payment', id, expectedVersion);
      return expectedVersion + 1;
    },

    list(options = {}) {
      return listQuery(db, 'payments', 'status', 'created_at, id', options).map(toPayment);
    },
  };
}

// ---------- payment events ----------

const toPaymentEvent = (row: Row): PaymentEventRecord => ({
  providerEventId: row.provider_event_id as string,
  paymentId: (row.payment_id as string | null) ?? null,
  type: row.type as string,
  payload: row.payload as string,
  outcome: row.outcome as PaymentEventRecord['outcome'],
  reason: (row.reason as string | null) ?? null,
  deliveryCount: row.delivery_count as number,
  firstReceivedAt: row.first_received_at as string,
  lastReceivedAt: row.last_received_at as string,
});

export function createPaymentEventRepository(db: Database.Database): PaymentEventRepository {
  return {
    recordDelivery(input) {
      // Single atomic statement: the primary key on provider_event_id is the dedupe point.
      const row = db
        .prepare(
          `INSERT INTO payment_events (provider_event_id, payment_id, type, payload, outcome, reason,
                                       delivery_count, first_received_at, last_received_at)
           VALUES (@providerEventId, @paymentId, @type, @payload, 'pending', NULL, 1, @receivedAt, @receivedAt)
           ON CONFLICT (provider_event_id) DO UPDATE
             SET delivery_count = delivery_count + 1,
                 last_received_at = excluded.last_received_at
           RETURNING *`,
        )
        .get(input) as Row;
      const record = toPaymentEvent(row);
      return { isFirstDelivery: record.deliveryCount === 1, record };
    },

    setOutcome(providerEventId, outcome, reason) {
      db.prepare('UPDATE payment_events SET outcome = ?, reason = ? WHERE provider_event_id = ?').run(
        outcome,
        reason,
        providerEventId,
      );
    },

    findByProviderEventId(providerEventId) {
      const row = db.prepare('SELECT * FROM payment_events WHERE provider_event_id = ?').get(providerEventId) as
        | Row
        | undefined;
      return row ? toPaymentEvent(row) : null;
    },

    listByPaymentId(paymentId) {
      return (
        db
          .prepare('SELECT * FROM payment_events WHERE payment_id = ? ORDER BY first_received_at, provider_event_id')
          .all(paymentId) as Row[]
      ).map(toPaymentEvent);
    },

    list(options = {}) {
      return listQuery(db, 'payment_events', 'outcome', 'first_received_at, provider_event_id', options).map(
        toPaymentEvent,
      );
    },
  };
}

// ---------- order events ----------

const toOrderEvent = (row: Row): OrderEventRecord => ({
  id: row.id as number,
  orderId: row.order_id as string,
  type: row.type as OrderEventRecord['type'],
  data: JSON.parse(row.data as string),
  occurredAt: row.occurred_at as string,
});

export function createOrderEventRepository(db: Database.Database): OrderEventRepository {
  return {
    append(event) {
      const row = db
        .prepare(
          `INSERT INTO order_events (order_id, type, data, occurred_at)
           VALUES (@orderId, @type, @data, @occurredAt)
           RETURNING *`,
        )
        .get({ ...event, data: JSON.stringify(event.data) }) as Row;
      return toOrderEvent(row);
    },

    listByOrderId(orderId) {
      return (db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id').all(orderId) as Row[]).map(
        toOrderEvent,
      );
    },
  };
}

// ---------- idempotency keys ----------

const toIdempotency = (row: Row): IdempotencyRecord => ({
  scope: row.scope as string,
  key: row.key as string,
  requestHash: row.request_hash as string,
  status: row.status as IdempotencyRecord['status'],
  responseCode: (row.response_code as number | null) ?? null,
  responseBody: (row.response_body as string | null) ?? null,
  createdAt: row.created_at as string,
});

export function createIdempotencyRepository(db: Database.Database): IdempotencyRepository {
  return {
    tryBegin(input) {
      const inserted = db
        .prepare(
          `INSERT INTO idempotency_keys (scope, key, request_hash, status, created_at)
           VALUES (@scope, @key, @requestHash, 'in_progress', @createdAt)
           ON CONFLICT (scope, key) DO NOTHING`,
        )
        .run(input);
      if (inserted.changes === 1) return null;
      const row = db
        .prepare('SELECT * FROM idempotency_keys WHERE scope = ? AND key = ?')
        .get(input.scope, input.key) as Row;
      return toIdempotency(row);
    },

    complete(scope, key, responseCode, responseBody) {
      db.prepare(
        `UPDATE idempotency_keys SET status = 'completed', response_code = ?, response_body = ?
         WHERE scope = ? AND key = ?`,
      ).run(responseCode, responseBody, scope, key);
    },

    release(scope, key) {
      db.prepare(`DELETE FROM idempotency_keys WHERE scope = ? AND key = ? AND status = 'in_progress'`).run(scope, key);
    },
  };
}

// ---------- review flags ----------

const toReviewFlag = (row: Row): ReviewFlagRecord => ({
  id: row.id as number,
  orderId: row.order_id as string,
  paymentId: (row.payment_id as string | null) ?? null,
  reason: row.reason as ReviewFlagRecord['reason'],
  details: row.details as string,
  createdAt: row.created_at as string,
  resolvedAt: (row.resolved_at as string | null) ?? null,
});

export function createReviewFlagRepository(db: Database.Database): ReviewFlagRepository {
  return {
    insert(flag) {
      const row = db
        .prepare(
          `INSERT INTO review_flags (order_id, payment_id, reason, details, created_at)
           VALUES (@orderId, @paymentId, @reason, @details, @createdAt)
           RETURNING *`,
        )
        .get(flag) as Row;
      return toReviewFlag(row);
    },

    listOpen() {
      return (db.prepare('SELECT * FROM review_flags WHERE resolved_at IS NULL ORDER BY id').all() as Row[]).map(
        toReviewFlag,
      );
    },

    listByOrderId(orderId) {
      return (db.prepare('SELECT * FROM review_flags WHERE order_id = ? ORDER BY id').all(orderId) as Row[]).map(
        toReviewFlag,
      );
    },

    resolve(id, resolvedAt) {
      const result = db
        .prepare('UPDATE review_flags SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL')
        .run(resolvedAt, id);
      return result.changes === 1;
    },
  };
}
