import type { ConfigSnapshot } from '../config/config-snapshot';
import type { ContextField } from '../context/context-field';
import type { Event, EventSource } from '../event/event';
import type { EventContext, SessionContext } from '../event/event-context';
import { runHooks } from '../event/hook-rules';
import type { IdentitySnapshot } from '../identity/identity';
import type { Log } from '../log/log';
import type { CallTimeContextValues, ContextProvider, StaticContextValues } from '../platform/context-provider';
import type { SessionEvent, SessionManager } from '../session/session-manager';
import type { UuidV7Generator } from '../util/uuid-v7-generator';
import { mergeSuperProperties, normalizeProperties } from '../validation/property-normalizer';
import { reportPropertyProblems } from '../validation/property-problem';
import type { PropertyValue } from '../validation/property-value';
import { SDK_VERSION } from '../version';

// The event pipeline, the port of the Android `EventPipeline` (Public API 4, Event Model 1, 3, Web
// Public API 5, Web Event Model 1, Android log 6.3a) split where Web Queue 1 splits the work:
//
// - At the call (`capture`, `sessionEvents`): the session read and written by Session 2's rules,
//   the context of that moment, the super properties, and the session events the call caused, each
//   built into the SDK's own `Event`. Android does these on its writer; the web does them in the
//   public call, since the session cookie is written at call time (Web Queue 1, Web Session 2).
// - On the writer (`process`): the `beforeSend` chain and the second validation (`runHooks`, step
//   3.2), the slow part that runs after paint. `SDK Diagnostics` skips the hooks (Logging 5).
//
// Serialization, the 32 KB scan and the `oversize` drop are the writer's (step 6.3b, section 15,
// step 2.5): the pipeline only carries the normalizer's flag, from the call and from every hook's
// second pass, to it. Nothing here throws.

/** `context.library.name` of every event this SDK sends (Web Context 3). */
export const LIBRARY_NAME = 'rubicon-web';

/** The name of the automatic event that opens a session (Session 5). */
export const SESSION_STARTED = 'Session Started';

/** The name of the automatic event that closes a session (Session 5). */
export const SESSION_ENDED = 'Session Ended';

// The key the `page.query` values are validated under, so a line names the context field.
const QUERY_KEY = 'page.query';

/** The one property of `Session Ended` (Session 5). */
export const DURATION_MS = 'duration_ms';

/** What every captured event has, whatever its kind. */
interface CapturedFields {
  readonly source: EventSource;
  /** Made during the call and never regenerated (Web Event Model 3). */
  readonly messageId: string;
  /** `t`: the call time, or the time the snippet recorded for a queued call (Web Session 5). */
  readonly timestamp: number;
  /** `visibilityState` was `visible` at `timestamp` (Web Session 1). */
  readonly visible: boolean;
  /** Who the event belongs to, read in the same call (Web Identity 3). */
  readonly identity: IdentitySnapshot;
  /** The context read inside the call, from {@link EventPipeline.callTimeValues} (Web Context 4). */
  readonly callTime: CallTimeContextValues;
  /** The normalizer stopped above the size limit at the call (section 15, step 2.5). */
  readonly oversize?: boolean;
  /** `SDK Diagnostics` reports on the SDK itself and never reaches a hook (Logging 5). */
  readonly skipsHooks?: boolean;
}

/**
 * An event as the public call (or the SDK itself) captured it: a valid name and normalized
 * properties or traits, its id and time, the identity and the call-time context of that moment.
 */
export type CapturedEvent = CapturedFields &
  (
    | {
        readonly type: 'track' | 'screen';
        /** Already checked by `checkName`, lone surrogates replaced. */
        readonly name: string;
        readonly properties: Readonly<Record<string, PropertyValue>>;
      }
    | {
        readonly type: 'identify';
        /** Sent with this event only; super properties are never merged in (Android log 6.3a). */
        readonly traits: Readonly<Record<string, PropertyValue>>;
      }
  );

/** An event built at the call, for the writer's {@link EventPipeline.process}. */
export interface PreparedEvent {
  readonly event: Event;
  /** The normalizer stopped above the size limit for this event's values (section 15, step 2.5). */
  readonly oversize: boolean;
  readonly skipsHooks: boolean;
}

/** What became of one event on the writer. */
export type PipelineResult =
  | {
      readonly kind: 'accepted';
      /** The event as the hooks left it, its values normalized again (Event Model 3). */
      readonly event: Event;
      /**
       * A pass of the normalizer over this event's values, at the call or after a hook, stopped above
       * the size limit; what the writer does with it is decided in step 6.3b.
       */
      readonly oversize: boolean;
    }
  | {
      readonly kind: 'dropped';
      readonly messageId: string;
      /** A hook returned `null`, threw or broke the rules, already logged (Public API 4). */
      readonly reason: 'before_send';
    };

/** What an {@link EventPipeline} is made of. */
export interface EventPipelineOptions {
  readonly config: Pick<ConfigSnapshot, 'beforeSend' | 'disabledFields' | 'app' | 'pageQueryParams' | 'pageTitle'>;
  readonly context: ContextProvider;
  /** The membership rule of Web Session 5 for every event, and the session events it causes. */
  readonly sessions: Pick<SessionManager, 'onEvent'>;
  /** The instance's generator: the session events' ids (Web Event Model 3). */
  readonly ids: Pick<UuidV7Generator, 'next'>;
  readonly log: Log;
}

/**
 * The internal steps an event passes (Public API 4, Event Model 3, Web Queue 1): session, context
 * and super properties at the call; the `beforeSend` chain and the second validation on the writer.
 * Session events pass the same steps, right before the event that caused them (Session 5), and
 * reach the hooks as automatic events.
 */
export class EventPipeline {
  // Read once, at the first event that needs them, never at import or in the factory (Web Context 4).
  private staticContext: StaticContextValues | undefined;

  constructor(private readonly options: EventPipelineOptions) {}

  /**
   * The context values of this moment, read inside a public call (Web Context 4): disabled fields
   * are never read, `page.query` holds only the configured parameters, `page.title` only when
   * switched on (Web Context 2, 5).
   */
  callTimeValues(): CallTimeContextValues {
    const { disabledFields, pageQueryParams, pageTitle } = this.options.config;
    const values = this.options.context.callTimeValues({
      disabled: disabledFields,
      queryParams: pageQueryParams,
      title: pageTitle,
    });
    if (values.pageQuery === undefined) return values;
    return { ...values, pageQuery: this.validQuery(values.pageQuery) };
  }

  /**
   * At the call: the session of `captured` (ending or starting one first where Web Session 5 says),
   * then the event built with its context and, for track and screen, the super properties. Returns
   * the session events it caused first, then the event.
   */
  capture(captured: CapturedEvent): PreparedEvent[] {
    const outcome = this.options.sessions.onEvent(
      { time: captured.timestamp, visible: captured.visible },
      captured.identity.personEpoch,
    );
    const prepared = this.sessionEvents(outcome.before, captured.identity, captured.callTime);
    prepared.push(this.build(captured, outcome.session));
    return prepared;
  }

  /**
   * Session events produced outside an event: at page load, a tab becoming visible, or a reset or a
   * change of user (Session 5, Android log 6.3a). `current` is the identity now; an end caused by a
   * person change carries the previous person's. They take the context of `callTime`, the moment
   * that found them.
   */
  sessionEvents(
    events: readonly SessionEvent[],
    current: IdentitySnapshot,
    callTime: CallTimeContextValues,
  ): PreparedEvent[] {
    return events.map((event) => {
      const session = { id: event.session.id, startedAt: event.session.startedAt };
      return this.build(this.sessionEvent(event, current, callTime), session);
    });
  }

  /**
   * On the writer: the hooks in order, each on its own deep copy, and the second validation of what
   * they return (Web Public API 5, step 3.2). A drop is already logged; counting it as `before_send`
   * is the writer's. `SDK Diagnostics` passes without hooks.
   */
  process(prepared: PreparedEvent): PipelineResult {
    if (prepared.skipsHooks) return { kind: 'accepted', event: prepared.event, oversize: prepared.oversize };
    const outcome = runHooks(this.options.config.beforeSend, prepared.event, this.options.log);
    if (!outcome.kept) return { kind: 'dropped', messageId: prepared.event.messageId, reason: 'before_send' };
    return { kind: 'accepted', event: outcome.event, oversize: prepared.oversize || outcome.oversize };
  }

  private build(captured: CapturedEvent, session: SessionContext | undefined): PreparedEvent {
    const who = captured.identity;
    const context = this.contextOf(captured.callTime, session);
    const fields = {
      source: captured.source,
      messageId: captured.messageId,
      timestamp: captured.timestamp,
      userId: who.userId,
      deviceId: who.deviceId,
    };
    const event: Event =
      captured.type === 'identify'
        ? { type: 'identify', ...fields, traits: captured.traits, context }
        : {
            type: captured.type,
            name: captured.name,
            ...fields,
            properties: this.withSuperProperties(captured.properties, who),
            context,
          };
    return { event, oversize: captured.oversize === true, skipsHooks: captured.skipsHooks === true };
  }

  // `page.query` values are "validated as properties" (Web Context 2): a value over 1024 code units
  // is truncated with `PROPERTY_TRUNCATED`, once per page and parameter, and a name a key cannot be
  // dropped. They are normalized under the key `page.query`, so a line names `page.query.<name>`.
  private validQuery(query: Readonly<Record<string, string>>): Readonly<Record<string, string>> | undefined {
    const normalized = normalizeProperties({ [QUERY_KEY]: query });
    reportPropertyProblems(normalized.problems, this.options.log);
    const valid = normalized.values[QUERY_KEY];
    if (valid === null || typeof valid !== 'object' || Array.isArray(valid)) return undefined;
    const kept: Record<string, string> = {};
    for (const name of Object.keys(valid)) {
      const value = valid[name];
      // Defined, not assigned, so a parameter named `__proto__` stays a field.
      if (typeof value === 'string') Object.defineProperty(kept, name, { value, enumerable: true, writable: true });
    }
    return Object.keys(kept).length > 0 ? kept : undefined;
  }

  // The event's own key wins; above 256 the super properties go first (Context 5, Serialization 3).
  private withSuperProperties(
    own: Readonly<Record<string, PropertyValue>>,
    identity: IdentitySnapshot,
  ): Readonly<Record<string, PropertyValue>> {
    if (Object.keys(identity.superProperties).length === 0) return own;
    const merged = mergeSuperProperties(own, identity.superProperties);
    reportPropertyProblems(merged.problems, this.options.log);
    return merged.values;
  }

  // A session event as if captured: an automatic track event, its id made now (Android log 6.3a).
  private sessionEvent(event: SessionEvent, current: IdentitySnapshot, callTime: CallTimeContextValues): CapturedEvent {
    const base = { source: 'auto' as const, messageId: this.options.ids.next(), visible: true, callTime };
    if (event.kind === 'started') {
      return {
        ...base,
        type: 'track',
        name: SESSION_STARTED,
        properties: {},
        timestamp: event.session.startedAt,
        identity: current,
      };
    }
    return {
      ...base,
      type: 'track',
      name: SESSION_ENDED,
      properties: { [DURATION_MS]: event.durationMs },
      timestamp: event.session.lastActivity,
      identity: event.identity ?? current,
    };
  }

  // A disabled field is left out here too, whatever the provider returned (Context 6, Web Context 5).
  private contextOf(callTime: CallTimeContextValues, session: SessionContext | undefined): EventContext {
    const s = this.staticValues();
    const { app, pageTitle } = this.options.config;
    const on = <T>(field: ContextField, value: T): T | undefined =>
      this.options.config.disabledFields.has(field) ? undefined : value;
    const query = on('page.query', callTime.pageQuery);
    return {
      app: {
        name: on('app.name', app.name),
        version: on('app.version', app.version),
        namespace: on('app.namespace', app.namespace),
      },
      device: { type: on('device.type', s.deviceType) },
      os: { name: on('os.name', s.osName) },
      browser: { name: on('browser.name', s.browserName), version: on('browser.version', s.browserVersion) },
      screen: {
        width: on('screen.width', s.screenWidth),
        height: on('screen.height', s.screenHeight),
        density: on('screen.density', s.screenDensity),
      },
      page: {
        url: on('page.url', callTime.pageUrl),
        referrer: on('page.referrer', s.pageReferrer),
        viewportWidth: on('page.viewport_width', callTime.viewportWidth),
        viewportHeight: on('page.viewport_height', callTime.viewportHeight),
        // The SDK's own copy: one call's values may serve several events.
        query: query === undefined ? undefined : { ...query },
        title: pageTitle ? callTime.pageTitle : undefined,
      },
      locale: on('locale', callTime.locale),
      timezone: on('timezone', callTime.timezone),
      session,
      library: { name: LIBRARY_NAME, version: SDK_VERSION },
    };
  }

  private staticValues(): StaticContextValues {
    if (this.staticContext === undefined) {
      this.staticContext = this.options.context.staticValues(this.options.config.disabledFields);
    }
    return this.staticContext;
  }
}
