// `SDK Diagnostics` (step 6.6): the port of the Android `Diagnostics` with the checkpoint of Web
// Logging 5, which the writer calls right before a flush.
export {
  DIAGNOSTICS_INTERVAL_MS,
  DiagnosticsReporter,
  diagnosticsProperties,
  isDiagnosticsDue,
  SDK_DIAGNOSTICS,
} from './diagnostics';
export type { DiagnosticsReport, DiagnosticsReporterOptions } from './diagnostics';
