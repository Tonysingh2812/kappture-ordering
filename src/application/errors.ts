/**
 * Thrown when a row changed between read and write. Unexpected within a single process (transactions
 * are serialised), so it's thrown rather than returned: the transaction rolls back and the caller may retry.
 */
export class ConcurrencyError extends Error {
  constructor(entity: string, id: string, expectedVersion: number) {
    super(`${entity} ${id} was modified concurrently (expected version ${expectedVersion})`);
    this.name = 'ConcurrencyError';
  }
}
