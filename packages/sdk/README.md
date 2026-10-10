# @saidic/sdk

Your own app, talking to your business's Saidic assistant: a signed-in customer's
conversations, in real time, with a person of your team able to take over. For browsers,
React Native and Node 18 and up. No dependency; about 4 KB compressed.

The SDK holds the customer's **token**, made by your server for an hour at most. It never
holds an API key: keys stay on your server.

```sh
npm install @saidic/sdk
```

```ts
import { Saidic } from '@saidic/sdk';

const client = Saidic.create({
  // Your server's route that mints a token for the customer signed in to your app.
  getToken: () => fetch('/saidic-token').then(answer => answer.text()),
});

const conversation = await client.conversations.start({ language: 'en' });
await client.messages.send(conversation.id, 'Where is my order?');

const connection = client.connect();
connection.subscribe([conversation.id]);
connection.on('message.created', ({ message }) => showMessage(message));
connection.on('conversation.status', ({ status }) => showWorking(status));
connection.on('handover.started', ({ person_name }) => showPerson(person_name));
```

What it does for you: it asks `getToken` again when a token expires; messages sent while
offline wait and go in order when the network is back, never twice; after a lost
connection it catches up with what was missed; handlers see each message once, in order.

On Node 18 and 20, which have no WebSocket of their own, pass one:
`Saidic.create({ getToken, WebSocket })`.

Everything else: https://docs.saidic.com
