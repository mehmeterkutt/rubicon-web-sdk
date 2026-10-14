import type { ParsedUrl, UrlParser } from 'rubicon-analytics-core';

/**
 * The `UrlParser` of the tests: Node's global `URL`, the same WHATWG parser the browsers implement,
 * so the host table of Web Configuration 4 runs against the rules the browser applies.
 */
export class WhatwgUrlParser implements UrlParser {
  parse(text: string): ParsedUrl | undefined {
    try {
      const url = new URL(text);
      return {
        protocol: url.protocol,
        hostname: url.hostname,
        search: url.search,
        hash: url.hash,
        username: url.username,
        password: url.password,
      };
    } catch {
      return undefined;
    }
  }
}
