// An app that imports only the no-op (step 8.2): with `sideEffects: false` and an import free of
// side effects (Web Public API 7), its bundle must leave the rest of the SDK out.
import { createNoOpAnalytics } from 'rubicon-analytics';

window.__analytics = createNoOpAnalytics();
