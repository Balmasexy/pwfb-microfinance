import { createHmac } from 'node:crypto';
import { PaystackService } from './paystack.service';

describe('PaystackService webhook signature verification', () => {
  const service = new PaystackService();
  const originalSecretKey = process.env.PAYSTACK_SECRET_KEY;
  const originalWebhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET;

  afterEach(() => {
    if (originalSecretKey === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecretKey;
    if (originalWebhookSecret === undefined) delete process.env.PAYSTACK_WEBHOOK_SECRET;
    else process.env.PAYSTACK_WEBHOOK_SECRET = originalWebhookSecret;
  });

  it('verifies the legacy X-Paystack-Signature using the integration secret key', () => {
    const rawBody = Buffer.from('{"event":"customeridentification.success","data":{"customer_code":"CUS_123"}}');
    const secret = 'sk_live_unit_test_secret';
    process.env.PAYSTACK_SECRET_KEY = secret;
    delete process.env.PAYSTACK_WEBHOOK_SECRET;
    const signature = createHmac('sha512', secret).update(rawBody).digest('hex');
    expect(service.verifyWebhookSignature(rawBody, signature)).toBe(true);
    expect(service.verifyWebhookSignature(rawBody, '0'.repeat(128))).toBe(false);
  });

  it('verifies the current Paystack-Signature using the whsec_ secret and timestamp', () => {
    const rawBody = Buffer.from('{"event":"customeridentification.success"}');
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = 'whsec_test_signing_secret';
    process.env.PAYSTACK_WEBHOOK_SECRET = secret;
    const digest = createHmac('sha512', secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
    const signature = `t=${timestamp},v1=whk_test:${digest}`;
    expect(service.verifyWebhookSignature(rawBody, undefined, signature)).toBe(true);
    expect(service.verifyWebhookSignature(rawBody, undefined, `t=${timestamp - 600},v1=whk_test:${digest}`)).toBe(false);
  });

  it('does not accept a v2 signature when no matching signing secret is configured', () => {
    const rawBody = Buffer.from('{"event":"customeridentification.failed"}');
    const secret = 'sk_live_unit_test_secret';
    process.env.PAYSTACK_SECRET_KEY = secret;
    delete process.env.PAYSTACK_WEBHOOK_SECRET;
    expect(service.verifyWebhookSignature(rawBody, undefined, 't=1,v1=whk_test:' + '0'.repeat(128))).toBe(false);
  });
  it('keeps legacy verification working until the whsec_ secret is configured', () => {
    const rawBody = Buffer.from('{"event":"customeridentification.success"}');
    const secret = 'sk_live_unit_test_secret';
    process.env.PAYSTACK_SECRET_KEY = secret;
    delete process.env.PAYSTACK_WEBHOOK_SECRET;
    const legacy = createHmac('sha512', secret).update(rawBody).digest('hex');
    expect(service.verifyWebhookSignature(rawBody, legacy, 't=1,v1=whk_not_configured:' + '0'.repeat(128))).toBe(true);
  });
});