# @saidic/server

Saidic for your own Node server: mint the token that tells Saidic who a signed-in
customer is, verify the webhooks Saidic sends you, and keep your customers up to date.
No dependency beyond Node's own crypto.

The identity secret and the API key are read here and **never leave your server**: not
in a web page, not in an app.

```sh
npm install @saidic/server
```

```ts
import { mintToken, verifyWebhook } from '@saidic/server';

// For the widget on your site (data-identity, saidicIdentify) and for your app's SDK.
const token = mintToken({
  secret: process.env.SAIDIC_IDENTITY_SECRET,
  keyId: process.env.SAIDIC_IDENTITY_KEY_ID,
  businessId: 123,
  customerId: user.id,
  email: user.email,
  name: user.name,
});

// A webhook: the raw body, before any parsing.
if (!verifyWebhook(request.headers, rawBody, process.env.SAIDIC_WEBHOOK_SECRET)) {
  return response.status(400).end();
}
```

A token lasts an hour at most. What Saidic would refuse (a longer life, a phone number not
in E.164, facts over their limits) is refused when minting.

Everything else: https://docs.saidic.com
