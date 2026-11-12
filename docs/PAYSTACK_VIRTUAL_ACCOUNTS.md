# Paystack virtual accounts — PWFB Microfinance and LAB Microfinance

This integration scope is **virtual accounts only**. It does not enable Paystack card charging, hosted checkout deposits, bank payouts, transfers, or subscription billing.

## Separate credentials

Set these variables on the relevant backend service, not the frontend:

| Variable | Purpose |
|---|---|
| `PAYSTACK_ENVIRONMENT` | Select `test` or `live` |
| `PAYSTACK_TEST_SECRET_KEY` | Test secret beginning `sk_test_` |
| `PAYSTACK_LIVE_SECRET_KEY` | Live secret beginning `sk_live_` |
| `PAYSTACK_LIVE_ENABLED` | Must be `true` before the DVA adapter will make Live requests |
| `PAYSTACK_BASE_URL` | Fixed to `https://api.paystack.co` |
| `PAYSTACK_DVA_PREFERRED_BANK` | Optional provider-supported preferred bank |
| `PAYSTACK_DVA_REQUIRE_IDENTITY` | Defaults to `true` for the existing financial-services identity checks |

For backwards compatibility, Test mode can temporarily fall back to the existing `PAYSTACK_SECRET_KEY` only when `PAYSTACK_TEST_SECRET_KEY` is absent. Live mode never reads `PAYSTACK_SECRET_KEY`; it requires `PAYSTACK_LIVE_SECRET_KEY` and `PAYSTACK_LIVE_ENABLED=true`.

Keep Test and Live webhook registrations separate. Configure the Paystack webhook for the active mode to:

- Test: `/webhooks/paystack/branch-dva/test`
- Live: `/webhooks/paystack/branch-dva/live`
- Legacy Test alias: `/webhooks/paystack/branch-dva`

Each endpoint verifies the raw-body HMAC-SHA512 signature with the matching environment's secret. The existing handler provisions and records **branch-level** dedicated virtual accounts and handles successful incoming transfers to those accounts. Live webhooks require `PAYSTACK_LIVE_ENABLED=true`; Test webhooks continue to use the Test key even while Live mode is selected.

## Safe rollout

1. Keep `PAYSTACK_ENVIRONMENT=test` while validating with test credentials.
2. Do not paste keys into GitHub or frontend configuration.
3. Do not enable Live until the merchant account, DVA product, webhook registration, identity requirements, and target bank have been confirmed.
4. Before Live use, set `PAYSTACK_LIVE_SECRET_KEY` and explicitly set `PAYSTACK_LIVE_ENABLED=true` in that project's backend secret store.
5. Deploy the reviewed application change separately. No database migration is introduced by this configuration-only change.

PWFB and LAB must use different credentials, webhook registrations, databases, and Render services. Do not reuse PWFB credentials in LAB.
