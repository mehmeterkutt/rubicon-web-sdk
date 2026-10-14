import type { Event } from './event';

/**
 * A hook set in `beforeSend`: it sees each event before it is stored and returns the event, a copy
 * of it, or `null` to drop it (Public API 4, Web Public API 5). Hooks run in order, synchronously, on
 * a deep copy; the result rules arrive with the event model in step 3.2.
 */
export type BeforeSend = (event: Event) => Event | null;
