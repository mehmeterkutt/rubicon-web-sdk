// The event pipeline (step 6.3a): the port of the Android `EventPipeline`, split as Web Queue 1
// splits the work between the public call and the writer.
export { DURATION_MS, EventPipeline, LIBRARY_NAME, SESSION_ENDED, SESSION_STARTED } from './event-pipeline';
export type { CapturedEvent, EventPipelineOptions, PipelineResult, PreparedEvent } from './event-pipeline';
