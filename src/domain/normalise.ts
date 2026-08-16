/**
 * Domain-owned hostname normalisation + hosts-line production (Story 1.6).
 *
 * The domain layer is the SOLE owner of these two concerns (ports-&-adapters:
 * the privileged ShellRunner stays a dumb validated-line writer per 1.5's
 * contract). Keeping them here makes them Jest-testable without the native
 * module — `toHostsLines` produces the exact payload `writeHosts` expects.
 *
 * Pragmatic, not PSL-based: real apex detection via the Public Suffix List is
 * Story 2.2. 1.6's normaliser strips scheme/path/port, a single leading `www.`,
 * and a trailing dot, then validates against a hostname regex. Good enough to
 * prove the pipeline end-to-end on one domain.
 */

// One hostname label: lowercase alphanumeric with optional internal hyphens;
// must not start or end with a hyphen.
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
// A hostname = two or more dot-separated labels. Requiring >=2 labels (>=1 dot)
// means single-label hosts like `localhost` are rejected (out of scope for a
// domain blocker) and `example.com` is accepted.
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

// Leading scheme such as `https://` / `ftp://` (users pasting URLs). Only
// `://`-style schemes are stripped — pragmatic, covers the common paste case.
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//;

/**
 * True if `h` is an all-numeric-label hostname — every dot-separated label is
 * purely numeric. Such a string is an IP literal or fragment (e.g.
 * `192.168.0.1`, `127.0.0`, `1.2`, `1234.5678.9012.3456`), not a usable domain
 * to block: a real domain has at least one non-numeric label (`example.com`).
 * Subsumes the old "exactly-4-numeric-parts" IPv4 check, which let 3-part and
 * over-long-numeric hostnames slip through to the hostname regex.
 */
function looksLikeIpLiteral(h: string): boolean {
  const parts = h.split('.');
  // An empty `parts` (no dots) cannot be all-numeric-label and is rejected later
  // by HOSTNAME_RE's >=2-label rule; guard the `every` so a single-label
  // all-numeric input like `12345` is not mis-classified here (HOSTNAME_RE
  // handles it). Only strings with at least 2 labels and ALL of them numeric
  // are IP literals.
  return parts.length >= 2 && parts.every((p) => /^[0-9]+$/.test(p));
}

/**
 * Normalise a raw user input into a lowercase apex hostname, or `null` when the
 * input is not a usable hostname.
 *
 * Steps: trim + lowercase -> strip a leading `scheme://` -> cut at the first
 * `/` (path) -> cut at the first `:` (port) -> strip a SINGLE leading `www.`
 * -> strip a trailing dot -> validate against the hostname regex -> reject
 * IPv4-looking literals. Returns `null` for non-string input, empty input, or
 * anything that is not a 2+-label hostname.
 *
 * Real PSL-based apex detection (e.g. recognising that `blog.example.co.uk`
 * has apex `example.co.uk`) is Story 2.2; this normaliser is deliberately
 * pragmatic and only strips one leading `www.`.
 */
export function normaliseDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  let s = raw.trim().toLowerCase();
  if (s === '') {
    return null;
  }
  // Strip a leading scheme like `https://`.
  s = s.replace(SCHEME_RE, '');
  // Strip the path (everything from the first `/` onward).
  const slash = s.indexOf('/');
  if (slash >= 0) {
    s = s.slice(0, slash);
  }
  // Strip the port (everything from the first `:` onward). Hostnames have no
  // colons; IPv6 brackets are not supported here (pragmatic, out of scope for a
  // domain blocker).
  const colon = s.indexOf(':');
  if (colon >= 0) {
    s = s.slice(0, colon);
  }
  // Strip a SINGLE leading `www.` (PSL-aware `www` stripping is 2.2).
  if (s.startsWith('www.')) {
    s = s.slice(4);
  }
  // Strip a trailing dot (fully-qualified root indicator).
  if (s.endsWith('.')) {
    s = s.slice(0, -1);
  }
  if (s === '') {
    return null;
  }
  if (looksLikeIpLiteral(s)) {
    return null;
  }
  return HOSTNAME_RE.test(s) ? s : null;
}

/**
 * Produce the 4 managed hosts lines for a normalised apex hostname: apex and
 * `www.`<apex> on `0.0.0.0` (IPv4) and `::` (IPv6), lowercase. The order is
 * fixed and matches the 1.5 hosts-file contract golden section:
 *
 *   0.0.0.0 <apex>
 *   :: <apex>
 *   0.0.0.0 www.<apex>
 *   :: www.<apex>
 *
 * `apex` is expected to be a `normaliseDomain` result (lowercase, valid). It is
 * lowercased defensively; no other validation is done here — the native side
 * re-validates each line against the strict hosts-line regex before any
 * elevation (defence-in-depth, layer 1). Returns an empty array for an empty
 * `apex` so a corrupt caller cannot emit a bare `0.0.0.0 ` line.
 */
export function toHostsLines(apex: string): string[] {
  const h = apex.toLowerCase();
  if (h === '') {
    return [];
  }
  return [
    `0.0.0.0 ${h}`,
    `:: ${h}`,
    `0.0.0.0 www.${h}`,
    `:: www.${h}`,
  ];
}