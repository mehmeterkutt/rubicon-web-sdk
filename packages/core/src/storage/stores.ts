import type { Log } from '../log';
import type { Clock, KeyValueStorage } from '../platform';
import { ConsentStore } from './consent-store';
import { DeviceStore } from './device-store';
import { PauseStore } from './pause-store';
import { PersonStore } from './person-store';
import { RemoteStore } from './remote-store';
import type { StoreAccess } from './store-record';

/** What {@link Stores} are made of. */
export interface StoresOptions {
  /** The first 16 hex characters of the SHA-256 of the API key (Web Identity 4). */
  readonly keyHash: string;
  readonly storage: KeyValueStorage;
  /** The instance's log; its `per_24h` limit becomes the device store's (Web Logging 2). */
  readonly log: Log;
  readonly clock: Clock;
  /** `full` unless given. */
  readonly access?: StoreAccess['level'];
}

/**
 * The five store records of one instance (Web Disk 2), sharing one {@link StoreAccess}. Creating
 * them reads nothing; every read is fresh, at the time it is made. The instance's `Log` asks the
 * device store for its `per_24h` limit from here on (plan section 15, step 2.2); its issue counter
 * is wired by the factory, which builds the `Log` first (step 6.7).
 */
export class Stores {
  readonly device: DeviceStore;
  readonly person: PersonStore;
  readonly remote: RemoteStore;
  readonly consent: ConsentStore;
  readonly pause: PauseStore;

  private readonly access: StoreAccess;

  constructor(options: StoresOptions) {
    const { keyHash, storage, log, clock } = options;
    this.access = { level: options.access ?? 'full' };
    this.device = new DeviceStore(keyHash, storage, this.access, log, clock);
    this.person = new PersonStore(keyHash, storage, this.access, log);
    this.remote = new RemoteStore(keyHash, storage, this.access, log);
    this.consent = new ConsentStore(keyHash, storage, this.access, log);
    this.pause = new PauseStore(keyHash, storage, this.access, log);
    log.dailyLimit = this.device.dailyLogLimit;
  }

  /** What the stores may touch now; see {@link StoreAccess}. */
  get accessLevel(): StoreAccess['level'] {
    return this.access.level;
  }

  set accessLevel(level: StoreAccess['level']) {
    this.access.level = level;
  }

  /** Writes every store's pending changes: in writer slices and on hiding (Web Disk 3). */
  persist(): void {
    this.device.persist();
    this.person.persist();
  }
}
