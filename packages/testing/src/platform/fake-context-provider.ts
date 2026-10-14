import type {
  CallTimeContextRequest,
  CallTimeContextValues,
  ContextProvider,
  DisabledContextFields,
  StaticContextValues,
} from 'rubicon-analytics-core';

/** The wire path of each provider value: the name a disabled field is given by (Web Context 5). */
const STATIC_FIELDS: Readonly<Record<keyof StaticContextValues, string>> = {
  osName: 'os.name',
  browserName: 'browser.name',
  browserVersion: 'browser.version',
  deviceType: 'device.type',
  screenWidth: 'screen.width',
  screenHeight: 'screen.height',
  screenDensity: 'screen.density',
  pageReferrer: 'page.referrer',
};

const CALL_TIME_FIELDS: Readonly<Record<Exclude<keyof CallTimeContextValues, 'pageTitle'>, string>> = {
  pageUrl: 'page.url',
  viewportWidth: 'page.viewport_width',
  viewportHeight: 'page.viewport_height',
  pageQuery: 'page.query',
  locale: 'locale',
  timezone: 'timezone',
};

function keep<T extends object>(
  values: T,
  fields: Readonly<Record<string, string>>,
  disabled: DisabledContextFields,
): T {
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    const path = fields[name];
    if (value !== undefined && path !== undefined && !disabled.has(path)) kept[name] = value;
  }
  return kept as T;
}

/**
 * A `ContextProvider` that returns what the test set, leaves out the disabled fields itself, as the
 * real provider never reads them (Context 6), applies `queryParams` and the title switch, and counts
 * its reads so a test can prove when values were read (Web Context 4).
 */
export class FakeContextProvider implements ContextProvider {
  staticReads = 0;
  callTimeReads = 0;
  lastDisabled: DisabledContextFields = new Set();

  constructor(
    public staticContext: StaticContextValues = {},
    public callTimeContext: CallTimeContextValues = {},
  ) {}

  staticValues(disabled: DisabledContextFields): StaticContextValues {
    this.staticReads += 1;
    this.lastDisabled = disabled;
    return keep(this.staticContext, STATIC_FIELDS, disabled);
  }

  callTimeValues(request: CallTimeContextRequest): CallTimeContextValues {
    this.callTimeReads += 1;
    this.lastDisabled = request.disabled;
    const { pageQuery, pageTitle, ...rest } = this.callTimeContext;
    const values: { -readonly [K in keyof CallTimeContextValues]: CallTimeContextValues[K] } = keep(
      rest,
      CALL_TIME_FIELDS,
      request.disabled,
    );
    if (pageQuery !== undefined && !request.disabled.has('page.query')) {
      const query: Record<string, string> = {};
      for (const name of request.queryParams) {
        const value = pageQuery[name];
        if (value !== undefined) query[name] = value;
      }
      if (Object.keys(query).length > 0) values.pageQuery = query;
    }
    if (request.title && pageTitle !== undefined) values.pageTitle = pageTitle;
    return values;
  }
}
