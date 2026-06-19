# 简单支付 MVP 测试计划 / MVP Test Plan

每次发布到 GitHub Pages 前，按这份清单测试。
Use this checklist before every GitHub Pages release.

## 1. 登录与身份隔离 / Login And Role Isolation

- 用户登录后，只能看到用户界面。 / User login opens only the user interface.
- 商家登录后，只能看到商家界面。 / Merchant login opens only the merchant interface.
- 管理员登录后，只能看到后台界面。 / Admin login opens only the admin interface.
- 未授权 Google 账号不能进入后台。 / Non-admin Google accounts cannot enter the admin interface.
- 退出登录后，会回到身份选择登录页。 / Logout returns to the role login screen.

## 2. 用户钱包 / User Wallet

- 新用户登录后，会创建独立钱包。 / A new user creates an independent wallet.
- 用户充值后，会生成待审批充值申请。 / Recharge creates a pending recharge request.
- 被冻结用户不能充值或付款。 / A frozen user cannot submit recharge or payment actions.
- 后台通过充值后，用户积分增加。 / Approved recharge increases user points.
- 后台拒绝充值后，用户积分不变。 / Rejected recharge does not change user points.
- 用户提现后，会生成待审批提现申请。 / Withdrawal creates a pending withdrawal request.
- 后台通过提现后，用户积分减少。 / Approved withdrawal decreases user points.
- 后台拒绝提现后，用户积分不减少。 / Rejected withdrawal does not decrease user points.
- 同一个用户的收款码保持固定不变。 / The personal receive QR code is stable for the same user.
- 其他用户可以扫码个人收款码并转积分。 / Other users can scan the personal receive QR and transfer points.

## 3. 商家端 / Merchant

- 新商家登录后，会创建商家资料。 / A new merchant profile is created after merchant login.
- 商家可以编辑名称、联系人、电话、地址、结算银行和结算账号。 / Merchant can edit business name, contact name, phone, address, settlement bank and settlement account.
- 商家资料不完整时，后台不能通过商家审核。 / Merchant approval is blocked if required profile fields are missing.
- 已通过审核的商家可以收款。 / Approved merchant can receive QR payments.
- 用户付款后，商家会生成订单和支付通知。 / Merchant payment creates an order and payment notification.
- 商家申请结算后，积分从可结算余额进入待审批结算。 / Merchant settlement request moves points from available settlement to pending settlement.
- 可结算余额为 0 时，结算按钮不可点击。 / Settlement button is disabled when available settlement is zero.
- 待审批结算会显示在后台结算审批里。 / Pending settlement appears in admin settlement approval.

## 4. 后台管理 / Admin

- 用户管理可以加载用户，并支持分页。 / User management loads users and supports pagination.
- 管理员可以冻结和解冻用户。 / Admin can freeze and unfreeze users.
- 商家管理可以加载商家，并支持分页。 / Merchant management loads merchants and supports pagination.
- 管理员可以通过、拒绝、冻结和解冻商家。 / Admin can approve, reject, freeze and unfreeze merchants.
- 通过充值时必须填写付款凭证。 / Recharge approval requires payment reference when approving.
- 拒绝充值时必须填写拒绝原因。 / Recharge rejection requires rejection reason.
- 通过提现时必须填写出款凭证。 / Withdrawal approval requires payout reference when approving.
- 拒绝提现时必须填写拒绝原因。 / Withdrawal rejection requires rejection reason.
- 通过退款后，用户和商家余额会正确变化。 / Refund approval updates user and merchant balances correctly.
- 通过或拒绝结算后，商家结算记录会正确变化。 / Settlement approval or rejection updates merchant settlement records correctly.
- 交易管理可以加载交易流水。 / Transaction management loads transactions.
- 交易搜索可以按邮箱、UID、订单号和流水号查询。 / Transaction search finds by email, UID, order ID and transaction ID.
- CSV 导出会按照当前筛选和搜索结果导出。 / CSV export follows current transaction filters and search.
- 财务报表会在充值、提现、退款、结算后刷新。 / Finance report refreshes after recharge, withdrawal, refund and settlement.
- 风控中心会显示大额余额或大额待审批请求。 / Risk center shows large balances or large pending requests.
- KYC 实名申请可以通过或拒绝。 / KYC requests can be approved or rejected.
- 权限管理可以新增或停用非 owner 管理员。 / Permission management can add or disable non-owner admins.
- 操作日志会记录敏感后台操作。 / Audit logs record sensitive admin actions.
- 公告、活动、优惠券可以创建并显示给用户。 / Marketing items can be created and shown to users.
- 客服工单可以创建、回复和关闭。 / Support tickets can be opened, replied to and closed.
- 系统配置只能由管理员修改。 / System config can be edited by admin only.
- 备份 JSON 可以成功下载。 / Backup JSON downloads successfully.

## 5. Firebase 规则 / Firebase Rules

- 发布 `firestore.rules` 到 Firebase Console 后再测试。 / Publish `firestore.rules` in Firebase Console before testing.
- 确认登录用户可以读取和写入 `transactions`。 / Confirm `transactions` reads and writes are allowed for signed-in test accounts.
- 确认只有 owner 邮箱可以写入 `adminUsers`。 / Confirm `adminUsers` write is allowed only for the owner email.
- 确认只有管理员可以写入 `systemConfig`。 / Confirm `systemConfig` write is allowed only for admins.
- 确认未登录用户不能读取系统数据。 / Confirm signed-out users cannot read app data.

## 6. GitHub Pages 发布 / GitHub Pages Release

- 上传前先运行本地语法检查。 / Run a local syntax check before upload.

```powershell
$node = "C:\Users\PC19\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
& $node --check script.js
```

- 提交并推送修改文件。 / Commit and push changed files.
- GitHub Pages 发布后等待 1-2 分钟。 / Wait 1-2 minutes after GitHub Pages deployment.
- 浏览器按 `Ctrl + F5` 强制刷新。 / Test with hard refresh: `Ctrl + F5`.
- 测试以下网址。 / Test these URLs.

```text
https://mlbb061979.github.io/simple-pay/
https://mlbb061979.github.io/simple-pay/index.html?role=user
https://mlbb061979.github.io/simple-pay/index.html?role=merchant
https://mlbb061979.github.io/simple-pay/index.html?role=admin
```

## 7. 当前 MVP 限制 / Known MVP Limits

- 余额变化目前仍然由浏览器前端执行。 / Balance-changing actions still run from the browser.
- Firestore 规则为了测试，对登录测试账号相对宽松。 / Firestore rules are intentionally permissive for signed-in test accounts.
- 正式上线前，钱包余额变化应该迁移到 Cloud Functions。 / Production launch should move wallet balance changes to Cloud Functions.
- 真实支付网关、银行出款和正式 KYC 服务还没有接入。 / Real payment gateway, bank payout and official KYC provider are not connected yet.
