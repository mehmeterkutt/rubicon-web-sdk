// The uploader (step 6.4): the port of the Android `Uploader`, one request at a time over every
// page's chunks of the key (Web Queue 2, 3, 5), with the retry policy of step 5.2.
export { ADOPT_AFTER_MS, ONLINE_DELAY_MS, Uploader } from './uploader';
export type { UploaderOptions } from './uploader';
