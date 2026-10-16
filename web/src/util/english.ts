/** True when an enabled English section has an empty text, which the server would reject. */
export function englishIncomplete(enabled: boolean, values: readonly string[]): boolean {
  return enabled && values.some((value) => value.trim() === '');
}
