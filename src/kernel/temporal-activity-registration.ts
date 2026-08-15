import type { WorkerOptions } from '@temporalio/worker';

export type TemporalActivityProjectionFactory = () => WorkerOptions['activities'];

let registeredFactory: TemporalActivityProjectionFactory | null = null;

export function registerTemporalActivityProjection(factory: TemporalActivityProjectionFactory) {
  if (registeredFactory && registeredFactory !== factory) {
    throw new Error('Temporal activity projection is already registered for this worker process.');
  }
  registeredFactory = factory;
}

export function resolveTemporalActivityProjection() {
  return registeredFactory?.() ?? null;
}
