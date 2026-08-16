/**
 * Story 1.6 — `effectiveBlocklist` unit tests.
 *
 * Pure domain logic — no native modules, no mocks. Epic 1 contribution only:
 * `domains.filter(alwaysOn)`, normalised + deduped. Active-timer / schedule
 * contributions are reserved for later epics and must contribute nothing here.
 */

import { effectiveBlocklist } from '../src/domain/effectiveBlocklist';
import type { Config, Domain } from '../src/config/types';
import { DEFAULT_CONFIG } from '../src/config/types';

function configWith(domains: Domain[]): Config {
  return {
    ...DEFAULT_CONFIG,
    domains,
  };
}

test('an empty config yields an empty effective blocklist', () => {
  expect(effectiveBlocklist(DEFAULT_CONFIG)).toStrictEqual([]);
});

test('only alwaysOn domains are included; alwaysOn:false is excluded', () => {
  const cfg = configWith([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'news.site', alwaysOn: false },
    { hostname: 'social.com', alwaysOn: true },
  ]);
  expect(effectiveBlocklist(cfg)).toStrictEqual([
    'example.com',
    'social.com',
  ]);
});

test('all domains with alwaysOn:false yields an empty effective blocklist', () => {
  const cfg = configWith([
    { hostname: 'example.com', alwaysOn: false },
    { hostname: 'news.site', alwaysOn: false },
  ]);
  expect(effectiveBlocklist(cfg)).toStrictEqual([]);
});

test('duplicate apexes (by hostname) are deduped, preserving first-seen order', () => {
  // A corrupt config with a duplicate hostname PK is deduped.
  const cfg = configWith([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: true },
  ]);
  expect(effectiveBlocklist(cfg)).toStrictEqual(['example.com', 'social.com']);
});

test('a www.-prefixed or upper-case stored hostname is normalised to the apex', () => {
  // A hand-edited config.json could store a non-normalised hostname. The
  // computation normalises defensively so the hosts payload stays clean.
  const cfg = configWith([
    { hostname: 'www.example.com', alwaysOn: true },
    { hostname: 'EXAMPLE.COM', alwaysOn: true },
    { hostname: 'https://social.com/', alwaysOn: true },
  ]);
  expect(effectiveBlocklist(cfg)).toStrictEqual(['example.com', 'social.com']);
});

test('a corrupt (non-hostname) entry is skipped, not thrown', () => {
  const cfg = configWith([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'not a domain', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: true },
  ]);
  expect(effectiveBlocklist(cfg)).toStrictEqual(['example.com', 'social.com']);
});

test('a single alwaysOn domain yields a single apex', () => {
  const cfg = configWith([{ hostname: 'example.com', alwaysOn: true }]);
  expect(effectiveBlocklist(cfg)).toStrictEqual(['example.com']);
});

// Compile-time pin on the signature.
const _effectiveBlocklistAcceptsConfigReturnsStringArray: (
  config: Config,
) => string[] = effectiveBlocklist;
void _effectiveBlocklistAcceptsConfigReturnsStringArray;