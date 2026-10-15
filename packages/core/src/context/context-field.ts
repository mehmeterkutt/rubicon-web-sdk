/**
 * Every {@link ContextField}, in the order of Web Context 5, so the SDK can iterate them. Internal:
 * the public union is spelled out and this array is checked against it (plan section 15, step 3.2).
 */
export const CONTEXT_FIELDS = [
  'app.name',
  'app.version',
  'app.namespace',
  'device.type',
  'os.name',
  'browser.name',
  'browser.version',
  'screen.width',
  'screen.height',
  'screen.density',
  'page.url',
  'page.referrer',
  'page.viewport_width',
  'page.viewport_height',
  'page.query',
  'locale',
  'timezone',
] as const satisfies readonly ContextField[];

/**
 * A field of `context` that `context.disabledFields` switches off, named by its wire path (Context 6,
 * Web Context 5). A disabled field is never read and never sent. `page.title` has its own switch,
 * `context.page.title`, and `library` cannot be disabled, so neither is a member.
 *
 * Members may be added in minor versions; a `switch` over a `ContextField` should keep a `default`
 * branch.
 */
export type ContextField =
  | 'app.name'
  | 'app.version'
  | 'app.namespace'
  | 'device.type'
  | 'os.name'
  | 'browser.name'
  | 'browser.version'
  | 'screen.width'
  | 'screen.height'
  | 'screen.density'
  | 'page.url'
  | 'page.referrer'
  | 'page.viewport_width'
  | 'page.viewport_height'
  | 'page.query'
  | 'locale'
  | 'timezone';
