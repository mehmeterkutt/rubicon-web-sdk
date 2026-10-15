// The event pipeline (step 6.3a) and the writer (step 6.3b): the ports of the Android `EventPipeline`
// and `Writer`, split as Web Queue 1 splits the work between the public call and the writer.
export { DURATION_MS, EventPipeline, LIBRARY_NAME, SESSION_ENDED, SESSION_STARTED } from './event-pipeline';
export type { CapturedEvent, EventPipelineOptions, PipelineResult, PreparedEvent } from './event-pipeline';
export { DRAIN_BUDGET_MS, SLICE_BUDGET_MS, WRITE_QUEUE_CAPACITY, Writer } from './writer';
export type { UploadTrigger, WriterOptions, WriterSettings } from './writer';
