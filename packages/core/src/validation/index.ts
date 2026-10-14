// Property validation and normalization (step 2.5): the port of the Android `internal/validation`
// package with the JavaScript conversion table of Web Serialization 2.
export {
  checkName,
  isOversizeLine,
  MAX_DEPTH,
  MAX_EVENT_BYTES,
  MAX_KEY_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PROPERTIES,
  MAX_STRING_LENGTH,
  mergeSuperProperties,
  normalizeProperties,
  propertyKeys,
  replaceLoneSurrogates,
} from './property-normalizer';
export type { MergedProperties, NameCheck, NormalizedProperties } from './property-normalizer';
export {
  isDeveloperError,
  PROPERTY_PROBLEM_KINDS,
  propertyProblemCode,
  propertyProblemMessage,
  reportPropertyProblems,
} from './property-problem';
export type { PropertyProblem, PropertyProblemKind } from './property-problem';
export type { PropertyValue } from './property-value';
