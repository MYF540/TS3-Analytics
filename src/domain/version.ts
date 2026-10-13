/** Release versions of the form `1.2.3` or `v1.2.3`. Pure, no I/O. */

const RELEASE = /^v?(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/;

/** The three numbers of a release version; undefined for anything else (pre-releases included). */
export function parseVersion(text: string): [number, number, number] | undefined {
  const match = RELEASE.exec(text.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** `1.2.3` without the leading `v`; undefined when the text is not a release version. */
export function normalizeVersion(text: string): string | undefined {
  return parseVersion(text)?.join('.');
}

/** True when `candidate` is a higher release than `current`. Unreadable versions are never newer. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}
