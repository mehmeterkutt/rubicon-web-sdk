// Retry (step 5.2): the groups of Retry 1 and the policy of Retry 1 to 5 with the state every page
// of the origin shares (Web Retry 1 to 4). The uploader that runs it is step 6.4's.
export { retryGroupOf } from './retry-group';
export type { RetryGroup } from './retry-group';
export {
  ALONE_BEFORE_DELETE,
  BACKOFF_MS,
  EXHAUSTED_AFTER,
  failureName,
  LONGEST_WAIT_MS,
  MAX_WAIT_MS,
  MIN_RETRY_AFTER_MS,
  PROBE_WINDOW_MS,
  RetryPolicy,
  SUSPECT_AFTER,
} from './retry-policy';
export type {
  ResultOptions,
  RetryAttempt,
  RetryDecision,
  RetryPolicyOptions,
  UploadGate,
  WaitKind,
  WaitReason,
} from './retry-policy';
