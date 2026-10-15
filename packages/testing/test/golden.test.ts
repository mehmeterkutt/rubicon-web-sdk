import { describe, expect, it } from 'vitest';
import {
  forTheWeb,
  golden,
  GOLDEN_FILES,
  goldenFileNames,
  webFixture,
  webFixtureNames,
  withStableValuesOf,
} from '../src';
import type { JsonObject } from '../src';

// The golden loader of step 8.4: the files it finds, the removals of Web Context 5 and the
// structural comparison of Web Event Model 4.

const ID = '0192e4a3-1000-7000-8000-00000000abcd';

/** The session-started file as a web page would write it, with its own ids. */
function written(): JsonObject {
  const file = forTheWeb(golden('session-started'));
  const context = file.context as JsonObject;
  return {
    ...file,
    message_id: ID,
    device_id: ID,
    context: {
      ...context,
      session: { ...(context.session as JsonObject), id: ID },
      library: { name: 'rubicon-web', version: '9.9.9' },
      browser: { name: 'Chrome', version: '141' },
    },
  };
}

describe('the golden loader', () => {
  it('finds the thirteen Android files and the web fixtures', () => {
    expect(goldenFileNames()).toEqual([...GOLDEN_FILES].sort());
    expect(webFixtureNames()).toContain('context');
    expect(webFixture('context')).toHaveProperty('browser');
  });

  it('removes the fields the web never produces, and a group left empty', () => {
    const context = forTheWeb(golden('track')).context as JsonObject;

    expect(context.app).toEqual({ name: 'Rubicon', version: '1.4.0', namespace: 'com.rubicon.demo' });
    expect(context.device).toEqual({ type: 'phone' });
    expect(context.os).toEqual({ name: 'Android' });
    expect(context).not.toHaveProperty('network');
    expect(forTheWeb({ context: { device: { model: 'Pixel 8' } } })).toEqual({ context: {} });
  });

  it('takes the ids, the session id and library from the file, and drops the web-only groups', () => {
    const file = golden('session-started');

    expect(withStableValuesOf(file, written())).toEqual(forTheWeb(file));
    expect(withStableValuesOf(file, written(), { keepWebGroups: true }).context).toHaveProperty('browser');
  });

  it('refuses an id that is not a UUIDv7 and a library that is not rubicon-web', () => {
    const file = golden('session-started');
    const context = written().context as JsonObject;

    expect(() => withStableValuesOf(file, { ...written(), message_id: 'm-1' })).toThrow('message_id');
    expect(() => withStableValuesOf(file, { ...written(), device_id: ID.toUpperCase() })).toThrow('device_id');
    expect(() =>
      withStableValuesOf(file, { ...written(), context: { ...context, session: { id: 'x', started_at: 1 } } }),
    ).toThrow('context.session.id');
    expect(() =>
      withStableValuesOf(file, {
        ...written(),
        context: { ...context, library: (golden('track').context as JsonObject).library },
      }),
    ).toThrow('rubicon-web');
  });
});
