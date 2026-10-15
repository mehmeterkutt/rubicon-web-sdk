/**
 * The values of every cookie named `name` in `text`, the `document.cookie` form (`a=1; b=2`), in the
 * order the browser lists them: a longer `Path` first, then the older cookie (RFC 6265 section
 * 5.4). Several values appear when cookies of one name exist in more than one scope, such as a
 * host-only cookie and one for the registrable domain. Names are compared exactly; a pair without
 * `=` is a nameless cookie and never matches. Nothing is decoded here: each cookie's grammar is its
 * owner's (Web Identity 1, Web Session 2, Web Privacy 2).
 */
export function cookieValues(text: string, name: string): string[] {
  const values: string[] = [];
  for (const pair of text.split(';')) {
    const equals = pair.indexOf('=');
    if (equals < 0) continue;
    if (pair.slice(0, equals).trim() === name) values.push(pair.slice(equals + 1).trim());
  }
  return values;
}
