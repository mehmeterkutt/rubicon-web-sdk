import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DROP_REASONS, ISSUE_CODES, issueCodes } from '../../src';

// Keeps docs/issue-codes.md and ISSUE_CODES in step (Web Logging 3): every code the web produces is
// documented once with its web level and frequency, and no other code appears in the sources.

const root = fileURLToPath(new URL('../../../../', import.meta.url));

interface Row {
  readonly code: string;
  readonly level: string;
  readonly platforms: readonly string[];
  readonly webLevel: string;
  readonly frequency: string;
}

function parseCatalogue(text: string): Row[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => {
      const cells = line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim());
      return {
        code: (cells[0] ?? '').replace(/`/g, ''),
        level: cells[1] ?? '',
        platforms: (cells[2] ?? '').split(',').map((p) => p.trim()),
        webLevel: cells[3] ?? '',
        frequency: cells[4] ?? '',
      };
    });
}

/** The levels a web row allows: the Web level when filled, else the Level, as `warn` or `error`. */
function webLevels(row: Row): string[] {
  const text = row.webLevel === '' ? row.level : row.webLevel;
  return text
    .split(' or ')
    .map((level) => level.trim().toLowerCase())
    .sort();
}

type Table = Readonly<Record<string, { readonly levels: readonly string[]; readonly frequency: string }>>;

/** Every disagreement between the catalogue rows and the code table; empty when they agree. */
function compareCatalogue(rows: readonly Row[], table: Table): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.code)) problems.push(`${row.code}: documented twice`);
    seen.add(row.code);
    if (!['WARN', 'ERROR'].includes(row.level)) problems.push(`${row.code}: level ${row.level}`);
    if (row.platforms.some((p) => !['Android', 'iOS', 'web'].includes(p)))
      problems.push(`${row.code}: platform ${row.platforms.join(', ')}`);
    const entry = table[row.code];
    if (row.platforms.includes('web')) {
      if (entry === undefined) {
        problems.push(`${row.code}: documented for the web but not in ISSUE_CODES`);
        continue;
      }
      const levels = [...entry.levels].sort();
      if (webLevels(row).join() !== levels.join())
        problems.push(`${row.code}: catalogue level ${webLevels(row).join()} but ISSUE_CODES ${levels.join()}`);
      if (row.frequency !== entry.frequency)
        problems.push(`${row.code}: catalogue frequency ${row.frequency} but ISSUE_CODES ${entry.frequency}`);
    } else {
      if (entry !== undefined) problems.push(`${row.code}: in ISSUE_CODES but not documented for the web`);
      if (row.webLevel !== '-' || row.frequency !== '-')
        problems.push(`${row.code}: not produced on the web, so Web level and Frequency are "-"`);
    }
  }
  for (const code of Object.keys(table)) {
    if (!seen.has(code)) problems.push(`${code}: in ISSUE_CODES but missing from the catalogue`);
  }
  return problems;
}

const catalogue = readFileSync(join(root, 'docs/issue-codes.md'), 'utf8');
const rows = parseCatalogue(catalogue);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('the issue code catalogue', () => {
  it('the code list matches the catalogue file', () => {
    expect(rows.length).toBeGreaterThan(40);
    expect(compareCatalogue(rows, ISSUE_CODES)).toEqual([]);
  });

  it('the comparison fails on a missing row, a wrong level or frequency, and an extra code', () => {
    const withoutRow = rows.filter((row) => row.code !== 'QUEUE_FULL');
    expect(compareCatalogue(withoutRow, ISSUE_CODES)).toEqual([
      'QUEUE_FULL: in ISSUE_CODES but missing from the catalogue',
    ]);

    const wrong = rows.map((row) =>
      row.code === 'CSP_BLOCKED' ? { ...row, level: 'WARN', frequency: 'per_24h' } : row,
    );
    expect(compareCatalogue(wrong, ISSUE_CODES)).toEqual([
      'CSP_BLOCKED: catalogue level warn but ISSUE_CODES error',
      'CSP_BLOCKED: catalogue frequency per_24h but ISSUE_CODES per_page',
    ]);

    const extra = { ...ISSUE_CODES, HOST_BLOCKED: { levels: ['warn'], frequency: 'per_page' } };
    expect(compareCatalogue(rows, extra)).toEqual(['HOST_BLOCKED: in ISSUE_CODES but not documented for the web']);
  });

  it('holds the nine codes Web Logging 3 names as never produced on the web, and no others', () => {
    const notOnWeb = rows.filter((row) => !row.platforms.includes('web')).map((row) => row.code);
    expect(notOnWeb.sort()).toEqual(
      [
        'API_KEY_CHANGED',
        'CONFIG_FROZEN',
        'HOST_BLOCKED',
        'LIFECYCLE_UNAVAILABLE',
        'NETWORK_CALLBACK_FAILED',
        'NETWORK_STATE_PERMISSION_MISSING',
        'PROCESS_NAME_UNKNOWN',
        'SWIZZLE_FAILED',
        'TLS_FAILED',
        'UNREADABLE_SEGMENT',
      ].sort(),
    );
  });

  it('marks the three per_24h codes of Web Logging 2 and every other web code per_page', () => {
    const daily = issueCodes().filter((code) => ISSUE_CODES[code].frequency === 'per_24h');
    expect(daily.sort()).toEqual(['EVENTS_EXPIRED', 'QUEUE_FULL', 'UPLOAD_FAILED_OPAQUE']);
  });

  it('codes marked never produced on the web do not appear in src', () => {
    const notOnWeb = rows.filter((row) => !row.platforms.includes('web')).map((row) => row.code);
    const found: string[] = [];
    for (const pkg of ['core', 'web']) {
      for (const file of sourceFiles(join(root, 'packages', pkg, 'src'))) {
        const text = readFileSync(file, 'utf8');
        for (const code of notOnWeb) {
          if (new RegExp(`\\b${code}\\b`).test(text)) found.push(`${code} in ${file.slice(root.length)}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('every drop reason is named in the catalogue, and api_key_changed is not one of the web', () => {
    for (const reason of DROP_REASONS) expect(catalogue).toContain(`\`${reason}\``);
    expect(DROP_REASONS).not.toContain('api_key_changed');
  });
});
