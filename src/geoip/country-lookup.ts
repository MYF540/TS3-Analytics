import { existsSync } from 'node:fs';
import maxmind, { type CountryResponse, type Reader } from 'maxmind';
import type { Logger } from '../logging/logger.js';

/** Resolves an IP address to an ISO 3166-1 alpha-2 country code. */
export interface CountryLookup {
  country(ip: string): string | undefined;
}

export const noCountryLookup: CountryLookup = { country: () => undefined };

/** Fixed mapping for tests. */
export function staticCountryLookup(countries: Record<string, string>): CountryLookup {
  return { country: (ip) => countries[ip] };
}

/**
 * Opens a local MaxMind GeoLite2-Country database. A missing or unreadable file is not fatal:
 * the service keeps running without country information. The file is watched, so replacing it
 * (monthly GeoLite2 update) takes effect without a restart.
 */
export async function openCountryLookup(path: string, logger: Logger): Promise<CountryLookup> {
  if (!existsSync(path)) {
    logger.warn({ path }, 'GeoIP database not found – countries will not be resolved');
    return noCountryLookup;
  }
  try {
    const reader: Reader<CountryResponse> = await maxmind.open<CountryResponse>(path, {
      watchForUpdates: true,
      watchForUpdatesNonPersistent: true,
    });
    return {
      country: (ip) => {
        const result = reader.get(ip);
        return result?.country?.iso_code ?? result?.registered_country?.iso_code;
      },
    };
  } catch (error) {
    logger.warn({ err: error, path }, 'GeoIP database could not be opened');
    return noCountryLookup;
  }
}
