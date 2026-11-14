# Publisher details

What OpenAI needs to know about who publishes Notivelo, what is already known, and what Devon must decide or fill in. Source: https://developers.openai.com/plugins/deploy/submission ("Confirm access and identity") and the guidelines ("Publisher verification and support").

## Identity

| Item | Known | Devon to fill in |
|---|---|---|
| Who submits | The OpenAI platform organisation owner (or a member with "Apps Management Write"). | Which OpenAI platform organisation to use, and that you are its owner. |
| Verification | Required: "individual or business verification" in https://platform.openai.com/settings/organization/general. The directory shows the **verified** name, not the `developerName` in the package. | Choose **individual** (shows your legal name) or **business** (shows the company's legal name; needs a registered business and its documents). |
| Legal name | Not in the repo. The legal pages use the operator name "Notivelo" as a placeholder (`LEGAL_OPERATOR_NAME`, legal/privacy.md owner checklist). | Your legal name, or the registered company name. If you verify as an individual, consider setting `LEGAL_OPERATOR_NAME` on the server to match, so the privacy policy and the directory name the same publisher. |
| Developer name in the package | `Notivelo` (package/plugin.json, `developerName` and `author.name`). | Change if you want it to match the verified name exactly. |
| Contact email | support@notiveloapp.com (package `author.email`, privacy policy contact). | Confirm the inbox exists and is read; OpenAI sends review feedback to the account email, and users see the support details. |
| Support URL | https://app.notiveloapp.com/support (loads signed out). | Nothing. |

## Supported countries

The package field `publication.countries` is an optional allowlist of country codes; leaving it out keeps the default targeting (wherever ChatGPT offers plugins).

**Proposed default: leave it out** (no restriction). Reasons: Notivelo is a web app anyone can sign up for (production `signupMode` is `open`), it is English-only, and it has no payments, so there are no tax or consumer-law differences between countries.

Things to check with your lawyer before agreeing (they also apply to the web app today):

- EU/UK users: the privacy policy is written in plain English and covers access, export and deletion, but has had no lawyer review yet (owner checklist in legal/privacy.md). If you would rather wait for that review, a narrower start is `["US", "CA", "GB", "AU", "NZ", "IE"]`.
- Data location: the server is self-hosted. The privacy policy does not say which country it is in; some reviewers or users in the EU will want that stated.

## Monetisation

**Notivelo has no paid plans, subscriptions or in-app purchases.** The package sets `commerce: false`.

Evidence (checked on branch `docs/chatgpt-directory`, from main at `daa50ed`):

- No payment code or SDK: a search of the repo (`server/`, `src/`, `apps/`, `shared/`, `package.json`) for Stripe, Paddle, RevenueCat, StoreKit, "in-app purchase", "checkout" finds nothing. The only "subscription" hits are browser push subscriptions (`push_subscriptions`, `PushSubscriptionInput`).
- No plan or tier logic: there is no plan, tier or billing table in `server/migrations/`, and no feature is gated by a plan.
- App Store listing (docs/store/app-store-listing.md): "Price: Free", and "Pricing is free for now. Paid plans may come later".

What the guidelines say if that changes: a ChatGPT plugin may let people use features of an existing paid subscription, but must not show plans, start subscriptions, promote upgrades or link to checkout; at most it may say a feature needs a different plan and link to an informational plan page. The listing must not mention pricing at all.
