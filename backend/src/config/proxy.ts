import logger from '../utils/logger';

/**
 * Number of trusted reverse-proxy hops for Express `trust proxy`, from
 * TRUST_PROXY_HOPS. Anything other than a small non-negative integer falls
 * back to 1, the previous hard-coded value.
 */
export function trustProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) > 10) {
    logger.warn('Ignoring invalid TRUST_PROXY_HOPS, using 1', { value: raw });
    return 1;
  }
  return Number(raw);
}
