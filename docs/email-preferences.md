# Email preferences

The Account page exposes three communication categories:

- **System messages** are always enabled and are not represented by an opt-out field.
- **Useful information** uses `User.marketingEmailsEnabled` and Brevo list `8`.
- **Newsletter** uses `User.newsletterEmailsEnabled` and Brevo lists `6` (English) and `7` (Hungarian).

The list identifiers can be overridden with:

```text
BREVO_NEWSLETTER_EN_LIST_ID=6
BREVO_NEWSLETTER_HU_LIST_ID=7
BREVO_USEFUL_INFORMATION_LIST_ID=8
```

New English users default to both optional categories and are synchronized to lists `6` and `8`. Hungarian users will use list `7` instead of list `6` when language selection is implemented. Preference changes are recorded in the `emailconsentlogs` collection.

## API

Authenticated users manage only their own settings:

```text
GET /api/user/me/email-preferences
PUT /api/user/me/email-preferences
```

The update body may contain `usefulInformationEnabled`, `newsletterEnabled`, and `preferredLanguage` (`en` or `hu`).

## Brevo webhook

Set a strong `BREVO_WEBHOOK_SECRET`, then configure the Brevo marketing webhook URL as:

```text
https://YOUR_API_HOST/api/webhooks/brevo/marketing
```

Add this custom header to the outbound webhook:

```text
x-brevo-webhook-secret: YOUR_SECRET
```

Use the **Send one at a time** strategy and subscribe only to the Marketing email **Unsubscribed** event. The callback disables Newsletter for list `6` or `7`, and Useful information for list `8`. It accepts common scalar and array variants of `listId`, `list_id`, and `listIds`, and also checks the contact's `listUnsubscribed` values.

Failed list synchronization is stored on the user and retried by the worker every ten minutes.
