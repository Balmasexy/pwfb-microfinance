import { ServiceUnavailableException } from '@nestjs/common';

export type PaystackVirtualAccountEnvironment = 'test' | 'live';

export type PaystackVirtualAccountConfig = {
  environment: PaystackVirtualAccountEnvironment;
  secretKey: string;
  baseUrl: string;
};

/**
 * Resolve credentials only for the Paystack virtual-account adapter.
 * Test mode keeps PAYSTACK_SECRET_KEY as a backwards-compatible fallback.
 * Live mode always requires its own secret and an explicit live enable switch.
 */
export function getPaystackVirtualAccountConfig(environmentOverride?: PaystackVirtualAccountEnvironment): PaystackVirtualAccountConfig {
  const configured = String(environmentOverride || process.env.PAYSTACK_ENVIRONMENT || 'test').trim().toLowerCase();
  if (configured !== 'test' && configured !== 'live') {
    throw new ServiceUnavailableException('PAYSTACK_ENVIRONMENT must be test or live');
  }

  const environment = configured as PaystackVirtualAccountEnvironment;
  const prefix = environment === 'test' ? 'sk_test_' : 'sk_live_';
  const rawSecret = environment === 'test'
    ? process.env.PAYSTACK_TEST_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY
    : process.env.PAYSTACK_LIVE_SECRET_KEY;
  const secretKey = String(rawSecret || '').trim();

  if (!secretKey || !secretKey.startsWith(prefix)) {
    throw new ServiceUnavailableException(
      environment === 'test'
        ? 'Configure PAYSTACK_TEST_SECRET_KEY with an sk_test_ key for virtual accounts'
        : 'Configure PAYSTACK_LIVE_SECRET_KEY with an sk_live_ key for virtual accounts',
    );
  }

  if (environment === 'live' && process.env.PAYSTACK_LIVE_ENABLED !== 'true') {
    throw new ServiceUnavailableException('Paystack Live virtual accounts are disabled until PAYSTACK_LIVE_ENABLED=true');
  }

  const baseUrl = String(process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co').trim().replace(/\/$/, '');
  if (baseUrl !== 'https://api.paystack.co') {
    throw new ServiceUnavailableException('PAYSTACK_BASE_URL must be https://api.paystack.co');
  }

  return { environment, secretKey, baseUrl };
}
