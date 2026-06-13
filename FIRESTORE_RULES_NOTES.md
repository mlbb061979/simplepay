# Firestore Rules Notes

Use `firestore.rules` as the current MVP rules in Firebase Console.

## Current MVP Choice

This app is still a static front-end MVP on GitHub Pages. Because there is no trusted server or Cloud Functions layer yet, wallet transfers, merchant payments, settlement requests, refund requests and transaction ledger writes still happen directly from the browser.

For that reason, these collections allow authenticated writes:

- `wallets`
- `merchants`
- `rechargeRequests`
- `withdrawRequests`
- `refundRequests`
- `settlementRequests`
- `kycRequests`
- `supportTickets`
- `transactions`

This keeps the MVP usable for testing.

## Protected Collections

These are restricted:

- `adminUsers`: only `stanleyhoh79@gmail.com` can write admin authorization.
- `systemConfig`: only admins can write.
- `auditLogs`: only admins can read/write.
- `marketingItems`: signed-in users can read, admins can write.

## Production Upgrade

Before real public launch, move all balance-changing actions to Cloud Functions:

- recharge approval
- withdrawal approval
- QR payment
- user-to-user transfer
- refund approval
- settlement approval

After that, Firestore rules should prevent normal users from directly changing balances, transactions, merchant settlement balances and admin approval status.
