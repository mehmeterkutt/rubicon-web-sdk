import { describe, expect, it } from 'vitest';
import { ANONYMOUS, PERSON_FIELDS } from '../../src';
import type { JsonValue, PersonState } from '../../src';
import { openPage, plant } from './store-test-support';

const DEVICE_ID = '0191d0c2-1a2b-7c3d-9e4f-5a6b7c8d9e0f';

const IDENTIFIED: PersonState = {
  userId: 'user-42',
  superProperties: new Map<string, JsonValue>([
    ['plan', 'pro'],
    ['beta', true],
    ['tags', ['a', 'b']],
    ['gone', null],
    ['nested', { level: { deep: 1 } }],
  ]),
  deviceId: DEVICE_ID,
};

describe('PersonStore', () => {
  describe('the record', () => {
    it('has exactly the decided keys', () => {
      const page = openPage();
      page.stores.person.write(() => IDENTIFIED);

      const stored = page.stored('person')!;

      expect(Object.keys(stored).sort()).toEqual(['v', ...PERSON_FIELDS].sort());
      expect(Object.keys(stored).sort()).toEqual(['device_id', 'super_properties', 'user_id', 'v']);
      expect(page.raw('person')).toBe(
        '{"v":1,"user_id":"user-42","super_properties":{"plan":"pro","beta":true,"tags":["a","b"],"gone":null,' +
          `"nested":{"level":{"deep":1}}},"device_id":"${DEVICE_ID}"}`,
      );
    });

    it('an anonymous person is written with a null user', () => {
      const page = openPage();
      page.stores.person.write((state) => ({ ...state, deviceId: DEVICE_ID }));

      expect(page.stored('person')).toEqual({ v: 1, user_id: null, super_properties: {}, device_id: DEVICE_ID });
    });

    it('reads back as written, in another page', () => {
      const page = openPage();
      page.stores.person.write(() => IDENTIFIED);

      const other = openPage(page.storage.otherPage());

      expect(other.stores.person.state).toEqual(IDENTIFIED);
    });

    it('a super property named __proto__ stays a property', () => {
      const page = openPage();
      page.stores.person.register('__proto__', 'x');
      page.stores.person.persist();

      const state = openPage(page.storage.otherPage()).stores.person.state;

      expect(page.raw('person')).toBe('{"v":1,"user_id":null,"super_properties":{"__proto__":"x"}}');
      expect(state.superProperties.get('__proto__')).toBe('x');
    });
  });

  describe('missing and unreadable', () => {
    it('a missing record is anonymous and nothing is written until a change', () => {
      const page = openPage();

      expect(page.stores.person.read()).toEqual({ status: 'missing' });
      expect(page.stores.person.state).toEqual(ANONYMOUS);
      expect(page.storage.writeCount).toBe(0);
    });

    it('an unreadable record is anonymous in memory with the changes and is never written', () => {
      const page = openPage();
      plant(page.storage, 'person', '{}');

      page.stores.person.write(() => IDENTIFIED);
      page.stores.person.register('plan', 'free');
      page.stores.person.persist();

      expect(page.stores.person.state.userId).toBe('user-42');
      expect(page.stores.person.state.superProperties.get('plan')).toBe('free');
      expect(page.raw('person')).toBe('{}');
      expect(page.logged('STORE_UNREADABLE')).toBe(true);
    });

    describe('records left byte-identical', () => {
      it.each([
        ['corrupt JSON', '{"v":1,"user_id":"user-42",'],
        ['a newer version', '{"v":2,"user_id":"user-42","super_properties":{}}'],
        ['no version', '{"user_id":"user-42","super_properties":{}}'],
        ['a user id of the wrong type', '{"v":1,"user_id":42,"super_properties":{}}'],
        ['super properties that are not an object', '{"v":1,"user_id":null,"super_properties":[]}'],
        ['a device id of the wrong type', '{"v":1,"user_id":null,"device_id":7}'],
      ])('%s', (_name, content) => {
        const page = openPage();
        plant(page.storage, 'person', content);

        page.stores.person.write(() => IDENTIFIED);

        expect(page.stores.person.state).toEqual(IDENTIFIED);
        expect(page.raw('person')).toBe(content);
        expect(page.logged('STORE_UNREADABLE')).toBe(true);
      });
    });
  });

  describe('writes', () => {
    it('many updates in a row produce one write', () => {
      const page = openPage();

      for (let i = 0; i < 50; i += 1) page.stores.person.register('n', i);
      page.stores.person.persist();

      expect(page.storage.writeCount).toBe(1);
      expect(openPage(page.storage.otherPage()).stores.person.state.superProperties.get('n')).toBe(49);
    });

    it('nothing is written when nothing changed', () => {
      const page = openPage();
      page.stores.person.write(() => IDENTIFIED);

      page.stores.person.update((state) => state);
      page.stores.person.unregister('absent');

      expect(page.stores.person.persist()).toBe('unchanged');
      expect(page.storage.writeCount).toBe(1);
    });

    it('a change is visible in memory before it is written', () => {
      const page = openPage();
      page.stores.person.write(() => ANONYMOUS);

      page.stores.person.update((state) => ({ ...state, userId: 'user-7' }));

      expect(page.stores.person.state.userId).toBe('user-7');
      expect(page.stored('person')).toMatchObject({ user_id: null });
    });

    it('a failed write logs an error and is retried by the next persist', () => {
      const page = openPage();
      page.storage.failWrites = true;
      page.stores.person.update(() => IDENTIFIED);

      expect(page.stores.person.persist()).toBe('failed');
      expect(page.logged('STORAGE_WRITE_FAILED')).toBe(true);

      page.storage.failWrites = false;
      expect(page.stores.person.persist()).toBe('written');
      expect(openPage(page.storage.otherPage()).stores.person.state).toEqual(IDENTIFIED);
    });

    it('two register calls in two pages, written in turn, both survive (Web Disk 3)', () => {
      const page = openPage();
      const other = openPage(page.storage.otherPage());
      expect(page.stores.person.state.superProperties.size).toBe(0);
      expect(other.stores.person.state.superProperties.size).toBe(0);

      page.stores.person.register('plan', 'pro');
      other.stores.person.register('campaign', 'autumn');
      page.stores.person.persist();
      other.stores.person.persist();

      expect(page.stored('person')).toEqual({
        v: 1,
        user_id: null,
        super_properties: { plan: 'pro', campaign: 'autumn' },
      });
      expect(page.stores.person.state.superProperties).toEqual(
        new Map<string, unknown>([
          ['plan', 'pro'],
          ['campaign', 'autumn'],
        ]),
      );
    });

    it("an unregister removes one key and keeps another page's", () => {
      const page = openPage();
      const other = openPage(page.storage.otherPage());
      page.stores.person.register('a', 1);
      page.stores.person.register('b', 2);
      page.stores.person.persist();

      other.stores.person.register('c', 3);
      page.stores.person.unregister('a');
      other.stores.person.persist();
      page.stores.person.persist();

      expect(page.stored('person')).toMatchObject({ super_properties: { b: 2, c: 3 } });
      expect(Object.keys((page.stored('person') as { super_properties: object }).super_properties)).toEqual(['b', 'c']);
    });

    it('remove deletes the record, also an unreadable one, and drops the pending changes', () => {
      const page = openPage();
      plant(page.storage, 'person', 'broken');
      page.stores.person.register('a', 1);

      expect(page.stores.person.remove()).toBe(true);

      expect(page.raw('person')).toBeNull();
      expect(page.stores.person.state).toEqual(ANONYMOUS);
    });

    it('remove reports a storage that throws, without throwing', () => {
      const page = openPage();
      page.stores.person.write(() => IDENTIFIED);
      page.storage.failAccess = true;

      expect(page.stores.person.remove()).toBe(false);
      expect(page.sink.lines.find((line) => line.message.startsWith('STORAGE_WRITE_FAILED'))?.message).toBe(
        'STORAGE_WRITE_FAILED: Could not delete the person store',
      );
    });
  });
});
