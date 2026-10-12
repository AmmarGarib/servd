# Raast QR — cashier and finance guide

Raast QR replaced Keenu QR at the till on 2026-10-12. Tills now take **Cash,
Card – Keenu and Raast QR**. Raast is taxed like card (the digital rate).

## Before the first Raast sale (finance)

1. Finance → Bank accounts: for the account customers pay into, fill in its
   **Raast ID** and tick **Company default Raast account**. The account must be
   linked to a bank code in the chart. A brand that banks elsewhere gets its own
   account under **Raast by brand**.
2. Print the shop's Raast QR / Raast ID for the counter.
3. **Remove the old Keenu QR standees.** A payment someone still makes to an old
   Keenu QR is recorded as **Card – Keenu**.

## At the till (cashier)

1. Choose **Raast QR** before printing the final bill (the total is at the
   digital rate).
2. The customer pays the exact amount to the shop's Raast QR / ID.
3. **Check the money on the counter phone** (bank SMS or merchant app).
   **Never accept the customer's phone screen or a screenshot** — fake payment
   screens are common.
4. Type the **transaction ID** from the counter phone, tick *"I saw PKR X arrive
   on the counter phone"*, and take the payment.

The till refuses a reference already used on another bill, one that looks
wrong, or one from an older transfer. Refunds by Raast need a manager and the
reference of the transfer you sent back from the bank.

## Every day (finance)

Import the bank statement (Finance → Reconciliation). servd matches each Raast
payment to its statement line by reference, amount and date. In the **Raast**
tab:

- **Provisional** payments are waiting for the statement. A flag is raised when
  one is older than the configured number of days.
- **Match** pairs a payment with a line by hand; **Fix reference** corrects a
  mistyped reference (approvers only).
- **Not received** writes off a payment that never arrived (approvers; posts a
  balanced entry against the bank it should have reached).
- **Resolve** closes a payment marked *needs attention* (refunded to the
  customer, not a sale, or booked elsewhere).

A month cannot be closed while Raast payments are unmatched, unless the CEO
closes it anyway (recorded).

## Bank SMS matching (optional, off until the CEO switches it on)

A cheap Android phone at the counter holds the SIM that gets the bank's alerts
and forwards them to servd. Then a Raast bill can wait for the bank SMS and
complete itself. Set-up for IT: `docs/raast-sms-forwarder.md`. servd only
completes a bill when exactly one waiting bill matches the SMS — anything else
goes to the till's **Bank alerts** list for a person to attach. It never
guesses, and the bank statement is still the final check.
