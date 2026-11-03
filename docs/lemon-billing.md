# Lemon Squeezy billing

Approved monthly base prices: Analytics USD 9.99; Complete USD 19.75. Applicable tax is shown by the hosted checkout.

## Deployment configuration

All credentials are server-only Vercel environment variables. Never put them in HTML, browser storage, GitHub issues or chat.

| Variable | Value |
| --- | --- |
| LEMON_ENABLED | `false` until activation is approved and configured |
| LEMON_TEST_MODE | `true` for test credentials/products; `false` for live |
| LEMON_API_KEY | Lemon Squeezy integration key |
| LEMON_WEBHOOK_SECRET | Webhook signing secret |
| LEMON_STORE_ID | Numeric store ID |
| LEMON_VARIANT_ANALYTICS | Numeric Analytics variant ID for the selected mode |
| LEMON_VARIANT_COMPLETE | Numeric Complete variant ID for the selected mode |

Missing/incomplete settings keep checkout unavailable. Test and live products, credentials and webhook configurations must stay separate. Switching modes requires redeployment. Existing test subscription bindings must not be reused for live accounts.

Endpoint: `https://sharflow.online/api/lemon-webhook`. Subscribe to subscription_created, subscription_updated, subscription_cancelled, subscription_resumed, subscription_expired, subscription_paused, subscription_unpaused, subscription_payment_success, subscription_payment_failed, subscription_payment_recovered, subscription_payment_refunded. Both the API checkout and webhook must use the same mode/store/variants.

## Behavior

- Only a verified, current Sharflow session with completed profile review can create checkout.
- The server selects the variant; client prices and custom user IDs are ignored. Checkout contains an opaque random binding, not an email or reusable session credential.
- Binding hashes live in existing `billing_events` with unique `eventId`. No new production collections or indexes are needed. User checkout locks expire after 30 minutes; binding records remain valid for 24 hours to allow delayed notification delivery. Do not add TTL to the billing event ledger.
- The app supplies the no-card trial. Checkout skips the provider trial, so selecting a paid subscription starts billing immediately as displayed in the hosted checkout.
- An existing subscription opens the provider portal to avoid a second recurring subscription. Plan changes use portal settings supported by Lemon Squeezy; if the portal does not offer a requested change, support must handle it rather than opening a duplicate checkout.
- Verify HMAC against exact raw bytes. Fetch current provider subscription/invoice state; do not grant access from the browser success redirect. Compare-and-set account revisions serialize overlapping events; retry failures return non-2xx.
- Cancelled subscriptions retain access only until `ends_at`. Active access is bounded by `renews_at`; failed/unpaid/expired/paused subscriptions do not grant paid entitlements. Full latest-invoice refunds revoke paid access; partial refunds do not. A later successful invoice can restore access. Local app trials and explicit administrator access remain governed by the entitlements engine.
- Checkout/account-link state is retained after uncertain provider failures. Retrying a completed checkout uses the saved URL while valid; a lost response without a saved URL blocks a new checkout for 30 minutes.

## Activation checklist

1. Approve/create integration credentials and configure Vercel secrets without displaying them.
2. Use separate test products and keys. Complete hosted test checkout and verify account binding, both plans, cancellation, failure/recovery and full refund behavior. Local isolated tests are not a substitute for this provider test.
3. Verify store and variant IDs against product settings and approved monthly prices.
4. Publish live billing/cancellation/refund disclosures before enabling live checkout; current public pages explicitly say activation is pending.
5. Configure live webhook and live credentials, set LEMON_TEST_MODE=false and LEMON_ENABLED=true, and redeploy only when the preceding steps are complete.
6. Daily reporting is a separate release gate. Do not enable the disabled scheduler merely because billing code is deployed.

## Validation

`npm run test:lemon` runs network-isolated signature, session/origin/review, account-binding, checkout race/deduplication, current-state replay, mode/store isolation, cancellation deadline, refund and provider-failure tests. It is included in `npm test`.

Official references: https://docs.lemonsqueezy.com/api/checkouts/create-checkout, https://docs.lemonsqueezy.com/api/subscriptions/the-subscription-object, https://docs.lemonsqueezy.com/guides/developer-guide/webhooks.
