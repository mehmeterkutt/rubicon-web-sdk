/**
 * An event as the SDK made it, handed to `beforeSend` hooks and to the event observer.
 *
 * A placeholder so that `EventUpdate` can name it (step 2.2).
 */
// TODO(step 3.2) the discriminated union of readonly interfaces of Web Event Model 1 replaces this.
export interface Event {
  /** The event's type: `track`, `screen` or `identify`. */
  readonly type: string;
}
