import { getPaystackVirtualAccountConfig } from './paystack-virtual-account-config';

const KEYS = [
  'PAYSTACK_ENVIRONMENT',
  'PAYSTACK_TEST_SECRET_KEY',
  'PAYSTACK_LIVE_SECRET_KEY',
  'PAYSTACK_SECRET_KEY',
  'PAYSTACK_LIVE_ENABLED',
  'PAYSTACK_BASE_URL',
] as const;
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

describe('Paystack virtual-account environment configuration', () => {
  beforeEach(() => {
    for (const key of KEYS) delete process.env[key];
  });

  afterAll(() => {
    for (const key of KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('prefers the dedicated test secret over the legacy key', () => {
    process.env.PAYSTACK_ENVIRONMENT = 'test';
    process.env.PAYSTACK_TEST_SECRET_KEY = 'sk_test_virtual_account_test';
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_legacy_key';
    expect(getPaystackVirtualAccountConfig()).toMatchObject({
      environment: 'test',
      secretKey: 'sk_test_virtual_account_test',
      baseUrl: 'https://api.paystack.co',
    });
  });

  it('keeps the legacy secret as a test-only backwards-compatible fallback', () => {
    process.env.PAYSTACK_ENVIRONMENT = 'test';
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_legacy_key';
    expect(getPaystackVirtualAccountConfig().secretKey).toBe('sk_test_legacy_key');
  });

  it('never uses a test or legacy key for live mode', () => {
    process.env.PAYSTACK_ENVIRONMENT = 'live';
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_legacy_key';
    process.env.PAYSTACK_TEST_SECRET_KEY = 'sk_test_test_key';
    expect(() => getPaystackVirtualAccountConfig()).toThrow('PAYSTACK_LIVE_SECRET_KEY');
  });

  it('can resolve a distinct Test webhook key while Live is selected', () => {
    process.env.PAYSTACK_ENVIRONMENT = 'live';
    process.env.PAYSTACK_LIVE_SECRET_KEY = 'sk_live_dva';
    process.env.PAYSTACK_LIVE_ENABLED = 'true';
    process.env.PAYSTACK_TEST_SECRET_KEY = 'sk_test_dva';
    expect(getPaystackVirtualAccountConfig('test').secretKey).toBe('sk_test_dva');
    expect(getPaystackVirtualAccountConfig('live').secretKey).toBe('sk_live_dva');
  });

  it('requires an explicit live enable switch and a live-prefixed key', () => {
    process.env.PAYSTACK_ENVIRONMENT = 'live';
    process.env.PAYSTACK_LIVE_SECRET_KEY = 'sk_live_virtual_account_key';
    expect(() => getPaystackVirtualAccountConfig()).toThrow('PAYSTACK_LIVE_ENABLED=true');
    process.env.PAYSTACK_LIVE_ENABLED = 'true';
    expect(getPaystackVirtualAccountConfig()).toMatchObject({
      environment: 'live',
      secretKey: 'sk_live_virtual_account_key',
    });
  });

  it('rejects invalid mode, mismatched key prefixes, and non-canonical API hosts', () => {
    process.env.PAYSTACK_ENVIRONMENT = 'sandbox';
    expect(() => getPaystackVirtualAccountConfig()).toThrow('PAYSTACK_ENVIRONMENT');

    process.env.PAYSTACK_ENVIRONMENT = 'test';
    process.env.PAYSTACK_TEST_SECRET_KEY = 'sk_live_wrong_mode';
    expect(() => getPaystackVirtualAccountConfig()).toThrow('sk_test_');

    process.env.PAYSTACK_TEST_SECRET_KEY = 'sk_test_ok';
    process.env.PAYSTACK_BASE_URL = 'https://example.invalid';
    expect(() => getPaystackVirtualAccountConfig()).toThrow('PAYSTACK_BASE_URL');
  });
});
