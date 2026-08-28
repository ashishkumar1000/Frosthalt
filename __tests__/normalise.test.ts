/**
 * Story 1.6 — `normaliseDomain` + `toHostsLines` unit tests.
 *
 * Pure domain logic — no native modules, no mocks. Covers the spec's golden
 * example, the pragmatic scheme/path/port/`www.`/trailing-dot stripping, and
 * the invalid cases from the I/O & Edge-Case Matrix (`not a domain`,
 * `0.0.0.0; rm -rf /`). `toHostsLines` asserts the exact 4-line shape and
 * order the 1.5 hosts-file contract requires.
 */

import {
  normaliseDomain,
  normaliseTime,
  toHostsLines,
} from '../src/domain/normalise';

// ---------------------------------------------------------------------------
// normaliseDomain — golden cases (valid input -> lowercase apex)
// ---------------------------------------------------------------------------

test('plain apex is lowercased and returned unchanged', () => {
  expect(normaliseDomain('example.com')).toBe('example.com');
});

test('upper-case input is lowercased', () => {
  expect(normaliseDomain('EXAMPLE.COM')).toBe('example.com');
  expect(normaliseDomain('ExAmPlE.CoM')).toBe('example.com');
});

test('a url with scheme + path + port + www is reduced to the apex', () => {
  expect(normaliseDomain('https://www.example.com:8080/path?q=1')).toBe(
    'example.com',
  );
});

test('a single leading www. is stripped', () => {
  expect(normaliseDomain('www.example.com')).toBe('example.com');
});

test('a trailing dot (FQDN root) is stripped', () => {
  expect(normaliseDomain('example.com.')).toBe('example.com');
});

test('www + trailing dot together', () => {
  expect(normaliseDomain('www.example.com.')).toBe('example.com');
});

test('http:// scheme without www', () => {
  expect(normaliseDomain('http://example.com/')).toBe('example.com');
});

test('ftp:// scheme is also stripped', () => {
  expect(normaliseDomain('ftp://files.example.com/pub/')).toBe(
    'files.example.com',
  );
});

test('a deeper subdomain is preserved (pragmatic — PSL apex is 2.2)', () => {
  // 1.6 only strips ONE leading www.; it does not collapse subdomains to the
  // PSL apex. `blog.example.com` stays `blog.example.com`.
  expect(normaliseDomain('blog.example.com')).toBe('blog.example.com');
});

test('a numeric first label is still a valid domain', () => {
  expect(normaliseDomain('2.example.com')).toBe('2.example.com');
  expect(normaliseDomain('123.com')).toBe('123.com');
});

test('whitespace is trimmed before normalisation', () => {
  expect(normaliseDomain('  example.com  ')).toBe('example.com');
});

// ---------------------------------------------------------------------------
// normaliseDomain — invalid cases -> null
// ---------------------------------------------------------------------------

test.each([
  ['an empty string', ''],
  ['only whitespace', '   '],
  ['a sentence with spaces', 'not a domain'],
  ['the spec injection example', '0.0.0.0; rm -rf /'],
  ['a shell metacharacter payload', 'example.com; rm -rf /'],
  ['a single label (localhost)', 'localhost'],
  ['a single label (example)', 'example'],
  ['an IPv4 literal', '0.0.0.0'],
  ['a loopback IPv4 literal', '127.0.0.1'],
  ['a 3-part IP fragment', '127.0.0'],
  ['a 2-part all-numeric fragment', '1.2'],
  ['an over-long all-numeric literal', '1234.5678.9012.3456'],
  ['a private-range IPv4 literal', '192.168.0.1'],
  ['a bare scheme', 'https://'],
  ['only a leading www.', 'www.'],
  ['a label starting with a hyphen', '-bad.com'],
  ['a label ending with a hyphen', 'bad-.com'],
  ['a label with an underscore', 'bad_name.com'],
  ['a label with a space', 'bad name.com'],
])('normaliseDomain returns null for %s', (_label, input) => {
  expect(normaliseDomain(input)).toBeNull();
});

test('normaliseDomain returns null for non-string input', () => {
  expect(normaliseDomain(null)).toBeNull();
  expect(normaliseDomain(undefined)).toBeNull();
  expect(normaliseDomain(42)).toBeNull();
  expect(normaliseDomain({ hostname: 'example.com' })).toBeNull();
});

// ---------------------------------------------------------------------------
// toHostsLines — the 4-line managed-section payload (1.5 contract)
// ---------------------------------------------------------------------------

test('toHostsLines produces apex + www. on 0.0.0.0 + :: in the fixed order', () => {
  expect(toHostsLines('example.com')).toStrictEqual([
    '0.0.0.0 example.com',
    ':: example.com',
    '0.0.0.0 www.example.com',
    ':: www.example.com',
  ]);
});

test('toHostsLines lowercases its input defensively', () => {
  expect(toHostsLines('EXAMPLE.COM')).toStrictEqual([
    '0.0.0.0 example.com',
    ':: example.com',
    '0.0.0.0 www.example.com',
    ':: www.example.com',
  ]);
});

test('toHostsLines returns an empty array for an empty apex (no bare target line)', () => {
  expect(toHostsLines('')).toStrictEqual([]);
});

test('every line matches the strict hosts-line regex from the 1.5 contract', () => {
  const re = /^(0\.0\.0\.0|::)\s+[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
  for (const line of toHostsLines('example.com')) {
    expect(re.test(line)).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// normaliseTime (Story 5.2) — golden cases + the total contract
// ---------------------------------------------------------------------------

describe('normaliseTime', () => {
  // The spec's golden examples: H:mm zero-pads to HH:mm.
  test.each([
    ['9:5', '09:05'],
    ['9:30', '09:30'],
    ['09:05', '09:05'],
    ['23:59', '23:59'],
    ['0:00', '00:00'],
    ['  07:15  ', '07:15'],
  ])('%p -> %p (trimmed + zero-padded)', (raw, expected) => {
    expect(normaliseTime(raw)).toBe(expected);
  });

  test.each([
    '', // empty
    '   ', // whitespace only
    '9', // no colon
    '9:5:3', // too many parts
    '0930', // no separator
    '24:00', // hour out of range
    '12:60', // minute out of range
    '-1:30', // negative hour
    '09:', // missing minute
    ':30', // missing hour
    'nine:thirty', // non-numeric
    '9.30', // wrong separator
    930 as unknown, // non-string input
    null as unknown, // non-string input
    undefined as unknown, // non-string input
  ])('%p -> null (invalid or non-string)', (raw) => {
    expect(normaliseTime(raw)).toBeNull();
  });
});

// Compile-time pin: the module exports the two functions with their contracts.
// If the signatures changed, these lines would be a compile error.
const _normaliseDomainAcceptsStringReturnsStringOrNull: (
  raw: unknown,
) => string | null = normaliseDomain;
const _toHostsLinesAcceptsStringReturnsStringArray: (apex: string) => string[] =
  toHostsLines;
const _normaliseTimeAcceptsUnknownReturnsStringOrNull: (
  raw: unknown,
) => string | null = normaliseTime;
void _normaliseDomainAcceptsStringReturnsStringOrNull;
void _toHostsLinesAcceptsStringReturnsStringArray;
void _normaliseTimeAcceptsUnknownReturnsStringOrNull;