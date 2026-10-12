# Raast QR: setting up the bank-SMS forwarder (IT runbook)

This runbook covers bank-SMS matching for Raast QR payments. A counter phone
receives the bank's credit SMS and forwards each one to servd. servd uses
the SMS to finish the right bill by itself, or to confirm a reference the
cashier typed. Matching never guesses: when one SMS could fit two bills, or
fits none, a person decides at the till.

Bank-SMS matching is **off for every company by default**. Only the CEO can
switch it on, and only after the readiness check below passes. With matching
off, the till still takes Raast: the cashier checks the counter phone, types
the bank reference and ticks "I saw it arrive". Finance then matches it
against the bank statement.

servd never logs in to internet banking.

## 1. What you need

- A phone that stays at the counter, holding the SIM that the bank sends
  credit SMS to. Use the merchant account's registered number.
- An SMS forwarder app on that phone. It must be able to:
  - forward only SMS from chosen senders (the bank's short code or number),
  - make an HTTPS POST with a JSON or form body,
  - set an `Authorization` header (strongly preferred).
- The receiving bank account set up by finance in **Finance → Bank
  accounts**. It needs its Raast ID, the "Company default Raast account"
  setting (or an account per brand), and a ledger code. IT cannot set this.
- `SERVD_SECRET_KEY` set on the API server. Device tokens are stored
  encrypted with it. Without the key, adding a device fails with
  `503 SECRET_KEY_MISSING`.

## 2. Add the device in servd

Go to **Dev → API → POS connector → Raast QR → Devices → Add device**.

1. Give the device a label (for example "Clifton counter phone"). You can
   also pick its outlet. The till then shows that phone's alerts only on
   that outlet's drawers.
2. servd shows the token **once**:
   - URL: `https://api.servd.pk/api/v1/webhooks/pos/sms`
   - Header: `Authorization: Bearer sms_<64 hex characters>`

   Copy both into the forwarder straight away. The CEO can reveal the token
   again later; every reveal is audited.
3. If a token leaks, use **Rotate**. The old token stops working at once,
   so put the new one into the forwarder.

**Forwarders that cannot set headers.** Turn on "Allow token in the URL"
for that device. The forwarder then posts to
`https://api.servd.pk/api/v1/webhooks/pos/sms/<token>`. This is weaker: the
token sits in the URL, which proxies and Cloudflare may log. servd masks it
in its own logs. Use this only when the app has no header option, and
rotate the token if the phone is lost.

## 3. The request the forwarder sends

`POST` with a JSON body, or with `application/x-www-form-urlencoded` form
fields. servd reads these field names, and the names are not case-sensitive:

| Meaning | Any of |
|---|---|
| Sender | `from`, `sender`, `address`, `phone`, `number`, `originatingAddress` |
| Text | `text`, `body`, `message`, `msg`, `content`, `sms` |
| Time received (optional) | `receivedAt`, `receivedStamp`, `sentStamp`, `timestamp`, `time`, `date`. Use epoch ms or seconds, or an ISO date. |

Example:

```json
{ "from": "MEEZANBNK", "text": "PKR 1,188.00 received in A/C ****1234 from ALI KHAN via Raast. Ref FT2610881234 on 12-10-2026 14:05.", "receivedAt": 1760259900000 }
```

Answers:

| Reply | Meaning |
|---|---|
| `200 {"ok":true,"id":…}` | Stored. servd processes it straight away. |
| `200 {"ignored":true,"reason":"sender_not_listed"}` | The sender is not on the company's bank sender list. **The text is not stored.** The device's "ignored" count goes up. |
| `200 {"ignored":true,"reason":"keyword"}` | The SMS has an ignore keyword (OTP, PIN, password, verification code…). **The text is never stored.** |
| `200 {"duplicate":true}` | The same SMS was already received, for example a forwarder retry. |
| `400 BAD_BODY` | No sender or text was found in the body. |
| `401` | The token is missing, wrong, rotated or deactivated. No detail is given. |
| `429` | Too many requests. The limit is 120 per minute per device, and an address that keeps failing auth is also blocked. |
| `503 TRY_AGAIN` | servd could not store the SMS. The forwarder should retry. |

The body can be at most 32 KB, and servd reads at most 2,000 characters of
the text.

Filter the forwarder to the bank's sender. servd also drops unlisted
senders, but fewer forwarded messages means fewer personal SMS leave the
phone.

## 4. Bank senders and templates

Go to **Dev → API → POS connector → Raast QR → Senders / Templates**.

- **Sender**: the bank's SMS sender as it appears on the phone, for example
  `MEEZANBNK` or `+92 300 …`. servd normalises it: upper case, punctuation
  removed, phone numbers written as 92XXXXXXXXXX. A sender maps to ONE of
  the company's bank accounts. If one sender reports on several accounts,
  add one entry per account, each with that account's last 4 digits.
- **Template**: the SMS wording in servd's template language. This is not
  a regex. Write the SMS as it arrives and replace the parts that change
  with placeholders:

| Placeholder | Matches |
|---|---|
| `{amount}` | `1,188.00`, `PKR 1188`, `Rs.1,188/-`. Every template needs it. |
| `{ref}` | The transaction ID. **Credit templates need it.** |
| `{date}` | `12-10-2026`, `12/10/26`, `12-Oct-2026`, `2026-10-12`. Set "Date format" when the bank writes month first. |
| `{time}` | `14:05`, `14:05:09`, `2:05 PM` |
| `{account}` | A masked account such as `****1234`. Its last 4 digits are used. |
| `{payer}` | The sender's name (up to 60 characters) |
| `{*}` | Anything, up to 200 characters, for a tail that varies |

Template rules:

- Spaces match any spacing.
- The whole SMS must match the template. A partial match does not count.
- Each named placeholder can appear once.
- `{*}` and `{payer}` together can appear at most 3 times in a template.
- Times are Pakistan time.

Example:
`PKR {amount} received in A/C {account} from {payer} via Raast. Ref {ref} on {date} {time}.`

Mark each template **credit** (money in) or **debit** (money out). A debit
SMS never pays a bill. It raises a finance flag, and its reference can then
never be used to pay a bill.

**Test before saving.** Paste a real SMS into the **Template tester**. It
shows which template matched, plus the amount, reference, time, account and
payer it read, or the reason it did not match. The tester saves nothing.

## 5. Let it run with matching OFF

Leave the phone forwarding for at least a day while matching is still off.
Every bank SMS is read and shown in the **Bank SMS log** with status `off`.
Use this to check the templates against real traffic:

- `off` with the right amount and reference: the template works.
- `unparsed`: no template matched. servd raises one flag per sender, and
  WhatsApps admin, IT and finance at most once an hour. Fix the template
  in the tester.

## 6. Switching matching ON (the CEO)

**Raast QR → Switch SMS matching on**, then type `SMS ON`. servd refuses
with `409 NOT_READY` and a list of what is missing until all of these hold:

- `SERVD_SECRET_KEY` is set on the server.
- At least one active device has reached servd in the last 24 hours.
- At least one active sender has an active credit template.
- A receiving account exists: the company default, or an account for each
  brand that traded in the last 30 days.
- At least one money-in SMS was read correctly (status `off`) in the last
  7 days.

IT (admin, it) can switch it off with `SMS OFF`. Raast payments already
waiting stay open: the cashier confirms them by hand, or they expire.

## 7. What happens at the till with matching ON

1. The cashier picks **Raast QR**. The bill waits for the customer's
   transfer. Waiting is limited to 30 minutes by default, and nothing else
   can settle the bill while it waits.
2. The bank SMS arrives. If exactly one waiting bill of that company, bank
   account and amount fits, servd completes it, and the till sees it within
   seconds. If two bills fit, or none, the SMS appears under **Bank
   alerts**. The cashier attaches it to the right bill, or a manager marks
   it "not a sale".
3. The cashier can still confirm by hand: check the counter phone, type the
   reference and tick the box. **Never accept the customer's phone screen
   or a screenshot.**
4. A cashier-typed reference that no SMS confirms within 30 minutes raises
   `raast_unconfirmed` for the floor managers.
5. Every Raast payment stays **provisional** until finance matches it to the
   bank statement.

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| Nothing arrives | The device's "last seen" time. If it never changes, check the forwarder URL and header, and whether the phone has data. |
| Ignored count grows | The bank's sender id differs from the one on the list. Look at the forwarder's log and add the exact sender. |
| Many `unparsed` | The bank changed its wording. Paste one into the tester and adjust the template. |
| `/health` shows `raastSms: warn` | An SMS was not understood in the last 24 h, a Raast bill needs a person, or a waiting intent is older than twice its time limit (check the Raast worker is running). |
| Phone lost | Deactivate or rotate the device at once. |

Retention: SMS text is deleted after 90 days (30 days for `unparsed`). The
amount, reference, time and outcome are kept.
