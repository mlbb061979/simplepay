# SimplePay secure money migration

This migration moves every balance-changing approval and merchant operation into trusted Cloud Functions.
No service-account key or private credential belongs in this repository.

## Added callable functions

- `createMerchantPayment`
- `submitRechargeRequest`
- `submitWithdrawalRequest`
- `submitMerchantRefund`
- `reviewMerchantRefund`
- `submitMerchantSettlement`
- `reviewMerchantSettlement`
- `reviewRechargeRequest`
- `reviewWithdrawalRequest`

Merchant payments now create a document in `merchantOrders`. The document ID is derived from the caller's
`externalOrderId`, so a retried POS or SimplePay request cannot deduct the wallet twice.

## Safe rollout order

1. Keep `systemConfig/main.secureMoneyFunctionsEnabled` absent or `false`.
2. Install dependencies in `functions` and deploy Cloud Functions.
3. Test payment, duplicate payment, refund, rejected refund, settlement, recharge and withdrawal with test accounts.
4. Deploy `firestore.rules`.
5. Set `systemConfig/main.secureMoneyFunctionsEnabled` to `true`.
6. Repeat the full test checklist before accepting real funds.

When the flag is `false`, the current browser transaction flow remains available for MVP testing. When it is
`true`, wallet balances, merchant balances, money requests, independent orders and transaction ledgers can only
be changed by Admin SDK code in Cloud Functions. Users may still update their own non-financial profile fields.

## POS integration boundary

`createMerchantPayment` accepts:

- `externalOrderId`
- `posOrderId`
- `branchId`
- `sourceSystem`

The customer must still authenticate with SimplePay before payment. The POS integration worker may create a
payment intent, but it must never debit a customer merely because a POS terminal submitted an order.

## Deployment

```bash
firebase deploy --only functions
firebase deploy --only firestore:rules
```

Deployments may require a billing-enabled Firebase project. A budget alert sends notifications but does not
itself stop charges.
