/**
 * A property, trait or super property value as the SDK holds it after validation: a string, a
 * finite number, a boolean, `null`, a list or an object of such values (Web Public API 4). Whatever
 * the developer passes is converted into this tree once, during the call, and again after the
 * `beforeSend` hooks; the conversion table is Web Serialization 2, and the wire JSON is written from
 * the tree as it is (Web Serialization 1).
 */
// The exact type of Web Public API 4; how `web` exports it is step 3.2.
export type PropertyValue = string | number | boolean | null | PropertyValue[] | { [key: string]: PropertyValue };
