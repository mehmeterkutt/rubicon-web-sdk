/**
 * The two remote switches that apply at once, outside the snapshot (Configuration 1, rule 3): the
 * kill switch and network request capture. Within a page they only ever turn off; turning back on
 * waits for the next page load, like every other remote value (Web Configuration 5).
 *
 * The pipeline checks {@link collecting} before it creates or uploads an event (steps 6.3a, 6.4),
 * and `createTrackedFetch` checks {@link capturingNetworkRequests} on every request (step 7.7).
 */
export class RuntimeFlags {
  private collectingNow: boolean;
  private capturingNow: boolean;

  constructor(options: { readonly collecting?: boolean; readonly capturingNetworkRequests?: boolean } = {}) {
    this.collectingNow = options.collecting ?? true;
    this.capturingNow = options.capturingNetworkRequests ?? true;
  }

  /** `false` after the kill switch, or on a device outside `sample_rate`. */
  get collecting(): boolean {
    return this.collectingNow;
  }

  get capturingNetworkRequests(): boolean {
    return this.capturingNow;
  }

  stopCollecting(): void {
    this.collectingNow = false;
  }

  stopCapturingNetworkRequests(): void {
    this.capturingNow = false;
  }
}
