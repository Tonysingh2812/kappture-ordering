import type { OrderStatus, PaymentStatus } from '../../domain/types.ts';
import type {
  IdempotencyRecord,
  IsoTimestamp,
  OrderEventRecord,
  OrderRecord,
  PaymentEventOutcome,
  PaymentEventRecord,
  PaymentRecord,
  ReviewFlagRecord,
} from './records.ts';

/*
 * Repository ports are synchronous on purpose: better-sqlite3 transactions must be synchronous, which
 * lets "dedupe event + change state + write audit rows" happen in one guaranteed transaction.
 * Moving to an async database (e.g. Postgres) would mean making these async. See README "Design decisions".
 */

export interface ListOptions<TStatus> {
  status?: TStatus;
  limit?: number;
  offset?: number;
}

export interface OrderRepository {
  insert(order: OrderRecord): void;
  findById(id: string): OrderRecord | null;
  /** Throws ConcurrencyError if the stored version is not `expectedVersion`. Returns the new version. */
  updateStatus(id: string, status: OrderStatus, expectedVersion: number, updatedAt: IsoTimestamp): number;
  list(options?: ListOptions<OrderStatus>): OrderRecord[];
}

export interface PaymentUpdate {
  status?: PaymentStatus;
  providerPaymentId?: string;
}

export interface PaymentRepository {
  insert(payment: PaymentRecord): void;
  findById(id: string): PaymentRecord | null;
  findByOrderId(orderId: string): PaymentRecord[];
  /** Throws ConcurrencyError if the stored version is not `expectedVersion`. Returns the new version. */
  update(id: string, changes: PaymentUpdate, expectedVersion: number, updatedAt: IsoTimestamp): number;
  list(options?: ListOptions<PaymentStatus>): PaymentRecord[];
}

export interface RecordDeliveryInput {
  providerEventId: string;
  paymentId: string | null;
  type: string;
  payload: string;
  receivedAt: IsoTimestamp;
}

export interface RecordDeliveryResult {
  /** True the first time this provider event id is seen; false for a redelivery. */
  isFirstDelivery: boolean;
  record: PaymentEventRecord;
}

export interface PaymentEventRepository {
  /** Atomically inserts the event, or increments its delivery count if the provider event id was already seen. */
  recordDelivery(input: RecordDeliveryInput): RecordDeliveryResult;
  setOutcome(providerEventId: string, outcome: PaymentEventOutcome, reason: string | null): void;
  findByProviderEventId(providerEventId: string): PaymentEventRecord | null;
  listByPaymentId(paymentId: string): PaymentEventRecord[];
  list(options?: ListOptions<PaymentEventOutcome>): PaymentEventRecord[];
}

export interface OrderEventRepository {
  append(event: Omit<OrderEventRecord, 'id'>): OrderEventRecord;
  listByOrderId(orderId: string): OrderEventRecord[];
}

export interface BeginIdempotentRequestInput {
  scope: string;
  key: string;
  requestHash: string;
  createdAt: IsoTimestamp;
}

export interface IdempotencyRepository {
  /** Claims the key. Returns null if newly claimed, or the existing record if the key was already used. */
  tryBegin(input: BeginIdempotentRequestInput): IdempotencyRecord | null;
  complete(scope: string, key: string, result: string): void;
  /** Releases a claim whose request failed unexpectedly, so the client can retry. */
  release(scope: string, key: string): void;
}

export interface ReviewFlagRepository {
  insert(flag: Omit<ReviewFlagRecord, 'id' | 'resolvedAt'>): ReviewFlagRecord;
  listOpen(): ReviewFlagRecord[];
  listByOrderId(orderId: string): ReviewFlagRecord[];
  resolve(id: number, resolvedAt: IsoTimestamp): boolean;
}

export interface DataStore {
  orders: OrderRepository;
  payments: PaymentRepository;
  paymentEvents: PaymentEventRepository;
  orderEvents: OrderEventRepository;
  idempotency: IdempotencyRepository;
  reviewFlags: ReviewFlagRepository;
  /** Runs `work` in a single transaction; any thrown error rolls everything back. */
  runInTransaction<T>(work: () => T): T;
}
