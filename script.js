import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCaPryZlkhPvzFC0OngXmA-hhXDsDx814U",
  authDomain: "oneminpay.firebaseapp.com",
  projectId: "oneminpay",
  storageBucket: "oneminpay.firebasestorage.app",
  messagingSenderId: "994992460655",
  appId: "1:994992460655:web:af50421b498ffec3dace9a",
  measurementId: "G-WD4LTPN670",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

const loginGateway = document.querySelector("#login-gateway");
const appShell = document.querySelector("#app-shell");
const pageTitle = document.querySelector("#page-title");
const currentRole = document.querySelector("#current-role");
const roleName = document.querySelector("#role-name");
const logoutButton = document.querySelector("#logout-button");
const authButtons = document.querySelectorAll(".auth-action");
const userTransactionsBody = document.querySelector("#user-transactions");
const views = {
  user: document.querySelector("#user-view"),
  merchant: document.querySelector("#merchant-view"),
  admin: document.querySelector("#admin-view"),
};

const roleConfig = {
  user: { title: "用户界面", label: "用户 Google 账号" },
  merchant: { title: "商家界面", label: "商家 Google 账号" },
  admin: { title: "后台界面", label: "管理员 Google 账号" },
};
const OWNER_ADMIN_EMAIL = "stanleyhoh79@gmail.com";
const POINTS_PER_MYR = 100;

let activeRole = sessionStorage.getItem("activeRole") || "";
let currentUser = null;
let walletUnsubscribe = null;
let merchantUnsubscribe = null;
let scannerStream = null;
let scannerTimer = null;
let dynamicQrId = 6130;
let toastTimer;
let walletBalance = 0;
let walletStatus = "active";
let merchantStatus = "pending";
let currentMerchant = null;
let userTransactions = [];
let adminUsersCache = [];
let merchantsCache = [];
let rechargeRequestsCache = [];
let withdrawalRequestsCache = [];
let refundRequestsCache = [];
let settlementRequestsCache = [];
let adminTransactionsCache = [];
let riskAlertsCache = [];
let adminTransactionFilter = "all";

function formatMoney(amount) {
  return `${Math.round(Number(amount || 0)).toLocaleString("en-MY")} 积分`;
}

function formatRM(amount) {
  return `RM ${Number(amount || 0).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function myrToPoints(amount) {
  return Math.round(Number(amount || 0) * POINTS_PER_MYR);
}

function pointsToMyr(points) {
  return Number(points || 0) / POINTS_PER_MYR;
}

function parseAmount(value) {
  const normalized = String(value || "")
    .replace(/[０-９．，]/g, (char) => {
      if (char === "．") return ".";
      if (char === "，") return ",";
      return String.fromCharCode(char.charCodeAt(0) - 0xfee0);
    })
    .replace(/[^\d.]/g, "")
    .trim();
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function decodeParam(value) {
  try {
    return decodeURIComponent(value || "");
  } catch {
    return value || "";
  }
}

function parseKeyValueCode(raw) {
  return Object.fromEntries(
    String(raw)
      .split(/[|&;]/)
      .map((part) => {
        const [key, value = ""] = part.split("=");
        return [key.trim().toLowerCase(), decodeParam(value.trim())];
      })
  );
}

function parsePaymentCode(rawCode) {
  const raw = String(rawCode || "").trim();
  if (!raw) return null;

  try {
    const url = raw.includes("://") ? new URL(raw) : new URL(`https://pay.local/?${raw}`);
    const action = url.hostname === "receive" || url.pathname.includes("receive") ? "receive" : "pay";
    if (action === "receive") {
      const recipientUserId = url.searchParams.get("userId");
      const name = url.searchParams.get("name") || "个人收款码";
      if (recipientUserId) {
        return { kind: "receive", recipientUserId, merchant: name, amount: null, code: raw };
      }
    }

    const merchantId = url.searchParams.get("merchantId");
    const merchant = url.searchParams.get("merchant") || url.searchParams.get("m") || url.hostname;
    const amount = parseAmount(url.searchParams.get("amount") || url.searchParams.get("a"));
    if (merchantId && merchant) return { kind: "merchant", merchantId, merchant, amount, code: raw };
    if (merchant && amount) return { kind: "merchant", merchant, amount, code: raw };
  } catch {
    const parts = parseKeyValueCode(raw);
    if (parts.userid || parts.user) {
      return {
        kind: "receive",
        recipientUserId: parts.userid || parts.user,
        merchant: parts.name || "个人收款码",
        amount: parseAmount(parts.amount),
        code: raw,
      };
    }

    const merchant = parts.merchant || parts.m || parts.shop;
    const amount = parseAmount(parts.amount || parts.a);
    if (merchant && amount) return { kind: "merchant", merchant, amount, code: raw };
  }

  return null;
}

function createReceiveCode(user = currentUser) {
  if (!user) return "";
  const name = encodeURIComponent(user.displayName || user.email || "User");
  return `oneminpay://receive?userId=${encodeURIComponent(user.uid)}&name=${name}`;
}

function updateReceiveQr(receiveCode) {
  const qrImage = document.querySelector("#receive-qr-image");
  const label = document.querySelector("#receive-code-label");
  if (!receiveCode || !qrImage || !label) return;

  const userId = new URL(receiveCode).searchParams.get("userId") || "";
  qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=10&data=${encodeURIComponent(receiveCode)}`;
  qrImage.dataset.code = receiveCode;
  label.textContent = `固定收款ID: ${userId.slice(0, 10)}...`;
}

function setWalletBalance(amount) {
  walletBalance = Math.max(0, Number(amount || 0));
  const balance = document.querySelector("#wallet-balance") || document.querySelector(".balance-panel strong");
  if (balance) balance.textContent = formatMoney(walletBalance);
}

function walletRef(user = currentUser) {
  return doc(db, "wallets", user.uid);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function adminUserRef(email) {
  return doc(db, "adminUsers", normalizeEmail(email));
}

function merchantRef(user = currentUser) {
  return doc(db, "merchants", user.uid);
}

function createMerchantCode(user = currentUser, amount = "") {
  if (!user) return "";
  const merchant = encodeURIComponent(currentMerchant?.businessName || user.displayName || user.email || "Merchant");
  const amountPart = amount ? `&amount=${encodeURIComponent(amount)}` : "";
  return `oneminpay://pay?merchantId=${encodeURIComponent(user.uid)}&merchant=${merchant}${amountPart}`;
}

function isOwnerAdmin(user = currentUser) {
  return normalizeEmail(user?.email) === normalizeEmail(OWNER_ADMIN_EMAIL);
}

async function isAuthorizedAdmin(user) {
  if (!user?.email) return false;
  if (isOwnerAdmin(user)) return true;

  const adminSnap = await getDoc(adminUserRef(user.email));
  const data = adminSnap.data();
  return adminSnap.exists() && data?.enabled === true;
}

async function authorizeAdminEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw new Error("请输入正确的管理员邮箱");
  }
  if (!isOwnerAdmin()) {
    throw new Error("只有主后台账号可以授权其他管理员");
  }

  await setDoc(adminUserRef(normalizedEmail), {
    email: normalizedEmail,
    enabled: true,
    authorizedBy: currentUser.email,
    updatedAt: serverTimestamp(),
  });
}

function emptyTransactionRow(message) {
  if (!userTransactionsBody) return;
  userTransactionsBody.innerHTML = `<tr><td colspan="5">${message}</td></tr>`;
}

function renderUserTransactions(transactions = []) {
  if (!userTransactionsBody) return;
  if (!transactions.length) {
    emptyTransactionRow("当前账户暂无交易记录");
    return;
  }

  userTransactionsBody.innerHTML = transactions
    .slice(0, 30)
    .map(
      (item) => `
        <tr>
          <td>${item.time || "刚刚"}</td>
          <td>${item.type || "-"}</td>
          <td>${item.target || "-"}</td>
          <td>${item.amount || "-"}</td>
          <td><span class="tag ${item.statusClass || "success"}">${item.status || "成功"}</span></td>
        </tr>
      `
    )
    .join("");
}

function statusTag(status) {
  if (status === "pending") return '<span class="tag warning">待审批</span>';
  if (status === "approved") return '<span class="tag success">已通过</span>';
  if (status === "rejected") return '<span class="tag danger">已拒绝</span>';
  if (status === "settled") return '<span class="tag success">已结算</span>';
  if (status === "refund_pending") return '<span class="tag warning">退款审批中</span>';
  if (status === "refunded") return '<span class="tag danger">已退款</span>';
  return status === "frozen"
    ? '<span class="tag danger">已冻结</span>'
    : '<span class="tag success">正常</span>';
}

function merchantStatusLabel(status) {
  if (status === "approved") return '<span class="tag success">已通过</span>';
  if (status === "rejected") return '<span class="tag danger">已拒绝</span>';
  if (status === "frozen") return '<span class="tag danger">已冻结</span>';
  return '<span class="tag warning">待审核</span>';
}

function renderAdminUsers(users = []) {
  const body = document.querySelector("#admin-users-body");
  if (!body) return;
  if (!users.length) {
    body.innerHTML = '<tr><td colspan="5">暂无用户钱包数据</td></tr>';
    return;
  }

  body.innerHTML = users
    .map(
      (user) => `
        <tr>
          <td>${user.email || user.displayName || user.id}</td>
          <td>${formatMoney(user.balance || 0)}</td>
          <td>${(user.transactions || []).length}</td>
          <td>${statusTag(user.status)}</td>
          <td>
            <button class="text-action admin-user-action" data-action="view" data-user-id="${user.id}">查看</button>
            <button class="text-action admin-user-action" data-action="${user.status === "frozen" ? "unfreeze" : "freeze"}" data-user-id="${user.id}">
              ${user.status === "frozen" ? "解冻" : "冻结"}
            </button>
          </td>
        </tr>
      `
    )
    .join("");
}

async function loadAdminUsers() {
  const body = document.querySelector("#admin-users-body");
  if (body) body.innerHTML = '<tr><td colspan="5">正在加载用户数据...</td></tr>';

  const snapshot = await getDocs(collection(db, "wallets"));
  adminUsersCache = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  renderAdminUsers(adminUsersCache);
}

function renderMerchants(merchants = []) {
  const body = document.querySelector("#admin-merchants-body");
  if (!body) return;
  if (!merchants.length) {
    body.innerHTML = '<tr><td colspan="5">暂无商家入驻资料</td></tr>';
    return;
  }

  body.innerHTML = merchants
    .map((merchant) => {
      const status = merchant.status || "pending";
      const pendingActions =
        status === "pending"
          ? `<button class="text-action merchant-action" data-action="approve" data-merchant-id="${merchant.id}">通过</button>
             <button class="text-action merchant-action" data-action="reject" data-merchant-id="${merchant.id}">拒绝</button>`
          : "";
      const freezeAction =
        status === "approved" || status === "frozen"
          ? `<button class="text-action merchant-action" data-action="${status === "frozen" ? "unfreeze" : "freeze"}" data-merchant-id="${merchant.id}">
              ${status === "frozen" ? "解冻" : "冻结"}
             </button>`
          : "";

      return `
        <tr>
          <td>${merchant.businessName || merchant.displayName || "未命名商家"}</td>
          <td>${merchant.email || "-"}</td>
          <td>${merchantStatusLabel(status)}</td>
          <td>${merchant.feeRate || "0.60%"}</td>
          <td>
            <button class="text-action merchant-action" data-action="view" data-merchant-id="${merchant.id}">查看</button>
            ${pendingActions}
            ${freezeAction}
          </td>
        </tr>
      `;
    })
    .join("");
}

function setText(selector, value) {
  const node = document.querySelector(selector);
  if (node) node.textContent = value;
}

function renderList(selector, items, emptyText, mapper) {
  const list = document.querySelector(selector);
  if (!list) return;
  if (!items.length) {
    list.innerHTML = `<li><span>${emptyText}</span><strong>-</strong></li>`;
    return;
  }
  list.innerHTML = items.slice(0, 8).map(mapper).join("");
}

function renderMerchantDashboard(data = {}) {
  const orders = Array.isArray(data.orders) ? data.orders : [];
  const refunds = Array.isArray(data.refunds) ? data.refunds : [];
  const settlements = Array.isArray(data.settlements) ? data.settlements : [];
  const transactions = Array.isArray(data.transactions) ? data.transactions : [];
  const notifications = Array.isArray(data.notifications) ? data.notifications : [];
  const totalReceived = Number(data.totalReceived || 0);
  const refundTotal = Number(data.refundTotal || 0);
  const settlementBalance = Number(data.settlementBalance || 0);

  setText("#merchant-total-received", formatMoney(totalReceived));
  setText("#merchant-order-count", String(orders.length));
  setText("#merchant-refund-total", formatMoney(refundTotal));
  setText("#merchant-settlement-balance", formatMoney(settlementBalance));

  const qrImage = document.querySelector("#merchant-qr-image");
  const label = document.querySelector("#merchant-code-label");
  const code = data.merchantCode || createMerchantCode();
  if (qrImage && code) {
    qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=10&data=${encodeURIComponent(code)}`;
    qrImage.dataset.code = code;
  }
  if (label) label.textContent = data.status === "approved" ? `商家ID: ${currentUser?.uid.slice(0, 10)}...` : "审核通过后可收款";

  const body = document.querySelector("#merchant-orders-body");
  if (body) {
    body.innerHTML = orders.length
      ? orders
          .slice(0, 20)
          .map(
            (order) => `
              <tr>
                <td>${order.id}</td>
                <td>${order.customer || "-"}</td>
                <td>${formatMoney(order.amount || 0)}</td>
                <td>钱包余额</td>
                <td>${statusTag(order.status || "approved")}</td>
                <td>
                  <button class="text-action merchant-order-action" data-order-id="${order.id}" data-action="view">查看</button>
                  ${
                    (order.status || "approved") === "approved"
                      ? `<button class="text-action merchant-order-action" data-order-id="${order.id}" data-action="refund">申请退款</button>`
                      : ""
                  }
                </td>
              </tr>
            `
          )
          .join("")
      : '<tr><td colspan="6">暂无订单</td></tr>';
  }

  renderList(
    "#merchant-refunds-list",
    refunds,
    "暂无退款申请",
    (item) => `<li><span>${item.orderId || item.id} · ${item.status === "pending" ? "待后台审批" : item.status === "approved" ? "已退款" : "已拒绝"}</span><strong>${formatMoney(item.amount || 0)}</strong></li>`
  );
  const settlementItems = [
    { id: "available", amount: settlementBalance, status: "available" },
    ...settlements.slice(0, 5),
  ];
  renderList(
    "#merchant-settlements-list",
    settlementItems,
    "暂无待结算余额",
    (item) =>
      item.status === "available"
        ? `<li><span>待结算余额</span><strong>${formatMoney(item.amount || 0)}</strong><button id="merchant-settlement-button" type="button">申请</button></li>`
        : `<li><span>${item.id || "结算单"} · ${item.status === "pending" ? "待后台审批" : item.status === "approved" ? "已结算" : "已拒绝"}</span><strong>${formatMoney(item.amount || 0)}</strong></li>`
  );
  renderList("#merchant-transactions-list", transactions, "暂无交易记录", (item) => `<li><span>${item.type || "交易"} ${item.target || ""}</span><strong>${item.amount || "-"}</strong></li>`);
  renderList("#merchant-notifications-list", notifications, "暂无支付通知", (item) => `<li><span>${item.text}</span><strong>${item.time || "刚刚"}</strong></li>`);
}

async function payMerchant(merchantId, merchantName, amount) {
  const payerRef = walletRef();
  const merchantDocRef = doc(db, "merchants", merchantId);
  const orderId = `M${Date.now()}`;
  const payerTx = transactionItem("商家付款", merchantName, `- ${formatMoney(amount)}`);

  await runTransaction(db, async (transaction) => {
    const payerSnap = await transaction.get(payerRef);
    const merchantSnap = await transaction.get(merchantDocRef);
    if (!merchantSnap.exists()) throw new Error("商家不存在");

    const payerData = payerSnap.data() || {};
    const merchantData = merchantSnap.data() || {};
    if (merchantData.status !== "approved") throw new Error("商家未通过审核，无法收款");

    const payerBalance = Number(payerData.balance || 0);
    if (amount > payerBalance) throw new Error("钱包余额不足");

    const order = {
      id: orderId,
      customerId: currentUser.uid,
      customer: currentUser.email,
      amount,
      status: "approved",
      createdAt: new Date().toISOString(),
    };
    const merchantTx = transactionItem("QR收款", currentUser.email, `+ ${formatMoney(amount)}`);
    const notification = { text: `订单 ${orderId} 支付成功`, time: "刚刚", createdAt: new Date().toISOString() };

    transaction.set(
      payerRef,
      {
        balance: payerBalance - amount,
        transactions: [payerTx, ...(payerData.transactions || [])].slice(0, 30),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    transaction.set(
      merchantDocRef,
      {
        totalReceived: Number(merchantData.totalReceived || 0) + amount,
        settlementBalance: Number(merchantData.settlementBalance || 0) + amount,
        orders: [order, ...(merchantData.orders || [])].slice(0, 50),
        transactions: [merchantTx, ...(merchantData.transactions || [])].slice(0, 30),
        notifications: [notification, ...(merchantData.notifications || [])].slice(0, 20),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  });
}

async function loadMerchants() {
  const body = document.querySelector("#admin-merchants-body");
  if (body) body.innerHTML = '<tr><td colspan="5">正在加载商家数据...</td></tr>';

  try {
    const snapshot = await getDocs(collection(db, "merchants"));
    merchantsCache = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderMerchants(merchantsCache);
  } catch (error) {
    if (body) {
      body.innerHTML = `<tr><td colspan="5">商家数据加载失败：${error.code || error.message}</td></tr>`;
    }
    throw error;
  }
}

async function ensureMerchant(user) {
  const ref = merchantRef(user);
  const snap = await getDoc(ref);
  if (snap.exists()) return;

  await setDoc(ref, {
    email: user.email,
    displayName: user.displayName || "",
    businessName: user.displayName ? `${user.displayName} 的商家` : "未命名商家",
    status: "pending",
    feeRate: "0.60%",
    totalReceived: 0,
    settlementBalance: 0,
    refundTotal: 0,
    orders: [],
    refunds: [],
    settlements: [],
    transactions: [],
    notifications: [],
    merchantCode: createMerchantCode(user),
    createdAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
  });
}

async function attachMerchant(user) {
  if (merchantUnsubscribe) merchantUnsubscribe();
  await ensureMerchant(user);

  merchantUnsubscribe = onSnapshot(merchantRef(user), (snapshot) => {
    const data = snapshot.data() || {};
    currentMerchant = { id: user.uid, ...data };
    merchantStatus = data.status || "pending";
    const roleText = merchantStatus === "approved" ? "商家已通过审核" : `商家状态：${merchantStatus === "frozen" ? "已冻结" : merchantStatus === "rejected" ? "已拒绝" : "待审核"}`;
    roleName.textContent = roleText;
    renderMerchantDashboard(data);
  });
}

async function updateMerchantStatus(merchantId, status) {
  await setDoc(
    doc(db, "merchants", merchantId),
    {
      status,
      reviewedBy: currentUser.email,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  await loadMerchants();
}

function renderRechargeRequests(requests = []) {
  const body = document.querySelector("#admin-recharges-body");
  if (!body) return;
  if (!requests.length) {
    body.innerHTML = '<tr><td colspan="5">暂无充值申请</td></tr>';
    return;
  }

  body.innerHTML = requests
    .map(
      (request) => `
        <tr>
          <td>${request.email || request.userId}</td>
          <td>${formatMoney(request.amount || 0)}<br><small>${formatRM(request.myrAmount || pointsToMyr(request.amount || 0))}</small></td>
          <td>${request.time || "-"}</td>
          <td>${statusTag(request.status || "pending")}</td>
          <td>
            ${
              request.status === "pending"
                ? `<button class="text-action recharge-action" data-action="approve" data-request-id="${request.id}">通过</button>
                   <button class="text-action recharge-action" data-action="reject" data-request-id="${request.id}">拒绝</button>`
                : "-"
            }
          </td>
        </tr>
      `
    )
    .join("");
}

async function loadRechargeRequests() {
  const body = document.querySelector("#admin-recharges-body");
  if (body) body.innerHTML = '<tr><td colspan="5">正在加载充值申请...</td></tr>';

  const snapshot = await getDocs(collection(db, "rechargeRequests"));
  rechargeRequestsCache = snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  renderRechargeRequests(rechargeRequestsCache);
}

async function submitRechargeRequest(amount) {
  if (walletStatus === "frozen") throw new Error("账户已被冻结，无法提交充值申请");
  const pointsAmount = myrToPoints(amount);
  const requestId = `${currentUser.uid}-${Date.now()}`;
  await setDoc(doc(db, "rechargeRequests", requestId), {
    userId: currentUser.uid,
    email: currentUser.email,
    displayName: currentUser.displayName || "",
    amount: pointsAmount,
    myrAmount: amount,
    status: "pending",
    time: "刚刚",
    createdAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
  });
}

async function reviewRechargeRequest(requestId, approved) {
  const request = rechargeRequestsCache.find((item) => item.id === requestId);
  if (!request) throw new Error("找不到充值申请");
  if (request.status !== "pending") throw new Error("该申请已处理");

  await runTransaction(db, async (transaction) => {
    const requestRef = doc(db, "rechargeRequests", requestId);
    const userRef = doc(db, "wallets", request.userId);
    const requestSnap = await transaction.get(requestRef);
    const userSnap = await transaction.get(userRef);
    if (!requestSnap.exists()) throw new Error("充值申请不存在");
    if (!userSnap.exists()) throw new Error("用户钱包不存在");

    const latestRequest = requestSnap.data();
    if (latestRequest.status !== "pending") throw new Error("该申请已处理");

    const userData = userSnap.data() || {};
    const tx = transactionItem(
      approved ? "充值" : "充值拒绝",
      "后台审批",
      approved ? `+ ${formatMoney(latestRequest.amount)}` : formatMoney(latestRequest.amount)
    );

    transaction.set(
      requestRef,
      {
        status: approved ? "approved" : "rejected",
        reviewedBy: currentUser.email,
        reviewedAt: serverTimestamp(),
      },
      { merge: true }
    );

    if (approved) {
      transaction.set(
        userRef,
        {
          balance: Number(userData.balance || 0) + Number(latestRequest.amount || 0),
          transactions: [tx, ...(userData.transactions || [])].slice(0, 30),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }
  });

  await Promise.all([loadRechargeRequests(), loadAdminUsers(), loadFinanceReport(), loadRiskCenter()]);
  loadAdminTransactions().catch(() => {});
}

function renderWithdrawalRequests(requests = []) {
  const body = document.querySelector("#admin-withdrawals-body");
  if (!body) return;
  if (!requests.length) {
    body.innerHTML = '<tr><td colspan="5">暂无提现申请</td></tr>';
    return;
  }

  body.innerHTML = requests
    .map(
      (request) => `
        <tr>
          <td>${request.email || request.userId}</td>
          <td>${formatMoney(request.amount || 0)}<br><small>${formatRM(request.myrAmount || pointsToMyr(request.amount || 0))}</small></td>
          <td>${request.bankAccount || "-"}</td>
          <td>${statusTag(request.status || "pending")}</td>
          <td>
            ${
              request.status === "pending"
                ? `<button class="text-action withdrawal-action" data-action="approve" data-request-id="${request.id}">通过</button>
                   <button class="text-action withdrawal-action" data-action="reject" data-request-id="${request.id}">拒绝</button>`
                : "-"
            }
          </td>
        </tr>
      `
    )
    .join("");
}

async function loadWithdrawalRequests() {
  const body = document.querySelector("#admin-withdrawals-body");
  if (body) body.innerHTML = '<tr><td colspan="5">正在加载提现申请...</td></tr>';

  const snapshot = await getDocs(collection(db, "withdrawRequests"));
  withdrawalRequestsCache = snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  renderWithdrawalRequests(withdrawalRequestsCache);
}

async function submitWithdrawalRequest(amount, bankAccount) {
  if (walletStatus === "frozen") throw new Error("账户已被冻结，无法提交提现申请");
  if (amount > walletBalance) throw new Error("钱包余额不足，无法提交提现申请");

  const requestId = `${currentUser.uid}-${Date.now()}`;
  await setDoc(doc(db, "withdrawRequests", requestId), {
    userId: currentUser.uid,
    email: currentUser.email,
    displayName: currentUser.displayName || "",
    amount,
    myrAmount: pointsToMyr(amount),
    bankAccount,
    status: "pending",
    time: "刚刚",
    createdAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
  });
}

async function reviewWithdrawalRequest(requestId, approved) {
  const request = withdrawalRequestsCache.find((item) => item.id === requestId);
  if (!request) throw new Error("找不到提现申请");
  if (request.status !== "pending") throw new Error("该申请已处理");

  await runTransaction(db, async (transaction) => {
    const requestRef = doc(db, "withdrawRequests", requestId);
    const userRef = doc(db, "wallets", request.userId);
    const requestSnap = await transaction.get(requestRef);
    const userSnap = await transaction.get(userRef);
    if (!requestSnap.exists()) throw new Error("提现申请不存在");
    if (!userSnap.exists()) throw new Error("用户钱包不存在");

    const latestRequest = requestSnap.data();
    if (latestRequest.status !== "pending") throw new Error("该申请已处理");
    const userData = userSnap.data() || {};
    const balance = Number(userData.balance || 0);
    if (approved && latestRequest.amount > balance) throw new Error("用户余额不足，不能提现");

    const tx = transactionItem(
      approved ? "提现" : "提现拒绝",
      latestRequest.bankAccount || "银行卡",
      approved ? `- ${formatMoney(latestRequest.amount)}` : formatMoney(latestRequest.amount)
    );

    transaction.set(
      requestRef,
      {
        status: approved ? "approved" : "rejected",
        reviewedBy: currentUser.email,
        reviewedAt: serverTimestamp(),
      },
      { merge: true }
    );

    if (approved) {
      transaction.set(
        userRef,
        {
          balance: balance - Number(latestRequest.amount || 0),
          transactions: [tx, ...(userData.transactions || [])].slice(0, 30),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }
  });

  await Promise.all([loadWithdrawalRequests(), loadAdminUsers(), loadFinanceReport(), loadRiskCenter()]);
  loadAdminTransactions().catch(() => {});
}

function renderRefundRequests(requests = []) {
  const body = document.querySelector("#admin-refunds-body");
  if (!body) return;
  if (!requests.length) {
    body.innerHTML = '<tr><td colspan="6">暂无退款申请</td></tr>';
    return;
  }

  body.innerHTML = requests
    .map(
      (request) => `
        <tr>
          <td>${request.orderId || request.id}</td>
          <td>${request.merchantName || request.merchantEmail || request.merchantId || "-"}</td>
          <td>${request.customerEmail || request.customerId || "-"}</td>
          <td>${formatMoney(request.amount || 0)}</td>
          <td>${statusTag(request.status || "pending")}</td>
          <td>
            ${
              request.status === "pending"
                ? `<button class="text-action refund-action" data-action="approve" data-request-id="${request.id}">通过</button>
                   <button class="text-action refund-action" data-action="reject" data-request-id="${request.id}">拒绝</button>`
                : "-"
            }
          </td>
        </tr>
      `
    )
    .join("");
}

async function loadRefundRequests() {
  const body = document.querySelector("#admin-refunds-body");
  if (body) body.innerHTML = '<tr><td colspan="6">正在加载退款申请...</td></tr>';

  const snapshot = await getDocs(collection(db, "refundRequests"));
  refundRequestsCache = snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  renderRefundRequests(refundRequestsCache);
}

async function submitRefundRequest(order) {
  if (!currentMerchant?.id) throw new Error("请先登录商家账号");
  if (!order?.id) throw new Error("找不到订单");
  if (!order.customerId) throw new Error("旧订单缺少用户ID，无法自动退款，请用新订单测试");
  if ((order.status || "approved") !== "approved") throw new Error("该订单当前不能申请退款");

  const requestId = `${currentMerchant.id}-${order.id}`;
  await runTransaction(db, async (transaction) => {
    const merchantDocRef = merchantRef();
    const requestRef = doc(db, "refundRequests", requestId);
    const merchantSnap = await transaction.get(merchantDocRef);
    const requestSnap = await transaction.get(requestRef);
    if (!merchantSnap.exists()) throw new Error("商家资料不存在");
    if (requestSnap.exists() && requestSnap.data()?.status === "pending") throw new Error("该订单已有待审批退款申请");

    const merchantData = merchantSnap.data() || {};
    const orders = Array.isArray(merchantData.orders) ? merchantData.orders : [];
    const latestOrder = orders.find((item) => item.id === order.id);
    if (!latestOrder) throw new Error("找不到订单");
    if ((latestOrder.status || "approved") !== "approved") throw new Error("该订单当前不能申请退款");

    const refund = {
      id: requestId,
      orderId: latestOrder.id,
      merchantId: currentMerchant.id,
      merchantName: merchantData.businessName || currentUser.email,
      merchantEmail: currentUser.email,
      customerId: latestOrder.customerId,
      customerEmail: latestOrder.customer || "",
      amount: Number(latestOrder.amount || 0),
      status: "pending",
      time: "刚刚",
      createdAt: new Date().toISOString(),
      updatedAt: serverTimestamp(),
    };
    const updatedOrders = orders.map((item) => (item.id === latestOrder.id ? { ...item, status: "refund_pending" } : item));
    const merchantRefunds = Array.isArray(merchantData.refunds) ? merchantData.refunds : [];

    transaction.set(requestRef, refund, { merge: true });
    transaction.set(
      merchantDocRef,
      {
        orders: updatedOrders,
        refunds: [refund, ...merchantRefunds.filter((item) => item.id !== requestId)].slice(0, 30),
        notifications: [{ text: `订单 ${latestOrder.id} 已提交退款审批`, time: "刚刚" }, ...(merchantData.notifications || [])].slice(0, 20),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  });
}

async function reviewRefundRequest(requestId, approved) {
  const request = refundRequestsCache.find((item) => item.id === requestId);
  if (!request) throw new Error("找不到退款申请");
  if (request.status !== "pending") throw new Error("该退款申请已处理");

  await runTransaction(db, async (transaction) => {
    const requestRef = doc(db, "refundRequests", requestId);
    const merchantDocRef = doc(db, "merchants", request.merchantId);
    const userRef = doc(db, "wallets", request.customerId);
    const requestSnap = await transaction.get(requestRef);
    const merchantSnap = await transaction.get(merchantDocRef);
    const userSnap = await transaction.get(userRef);
    if (!requestSnap.exists()) throw new Error("退款申请不存在");
    if (!merchantSnap.exists()) throw new Error("商家资料不存在");
    if (!userSnap.exists()) throw new Error("用户钱包不存在");

    const latestRequest = requestSnap.data();
    if (latestRequest.status !== "pending") throw new Error("该退款申请已处理");

    const amount = Number(latestRequest.amount || 0);
    const merchantData = merchantSnap.data() || {};
    const userData = userSnap.data() || {};
    const orders = Array.isArray(merchantData.orders) ? merchantData.orders : [];
    const refunds = Array.isArray(merchantData.refunds) ? merchantData.refunds : [];
    const nextStatus = approved ? "approved" : "rejected";
    const nextOrderStatus = approved ? "refunded" : "approved";
    const refundTx = transactionItem(
      approved ? "退款到账" : "退款拒绝",
      latestRequest.merchantName || "商家",
      approved ? `+ ${formatMoney(amount)}` : formatMoney(amount)
    );
    const merchantTx = transactionItem(
      approved ? "退款扣减" : "退款拒绝",
      latestRequest.customerEmail || "用户",
      approved ? `- ${formatMoney(amount)}` : formatMoney(amount)
    );

    transaction.set(
      requestRef,
      {
        status: nextStatus,
        reviewedBy: currentUser.email,
        reviewedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    transaction.set(
      merchantDocRef,
      {
        orders: orders.map((item) => (item.id === latestRequest.orderId ? { ...item, status: nextOrderStatus } : item)),
        refunds: refunds.map((item) => (item.id === requestId ? { ...item, status: nextStatus } : item)),
        refundTotal: approved ? Number(merchantData.refundTotal || 0) + amount : Number(merchantData.refundTotal || 0),
        settlementBalance: approved ? Math.max(0, Number(merchantData.settlementBalance || 0) - amount) : Number(merchantData.settlementBalance || 0),
        transactions: [merchantTx, ...(merchantData.transactions || [])].slice(0, 30),
        notifications: [
          { text: `退款 ${latestRequest.orderId} ${approved ? "已通过" : "已拒绝"}`, time: "刚刚" },
          ...(merchantData.notifications || []),
        ].slice(0, 20),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    if (approved) {
      transaction.set(
        userRef,
        {
          balance: Number(userData.balance || 0) + amount,
          transactions: [refundTx, ...(userData.transactions || [])].slice(0, 30),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }
  });

  await Promise.all([loadRefundRequests(), loadMerchants(), loadAdminUsers(), loadFinanceReport(), loadRiskCenter()]);
  loadAdminTransactions().catch(() => {});
}

function renderSettlementRequests(requests = []) {
  const body = document.querySelector("#admin-settlements-body");
  if (!body) return;
  if (!requests.length) {
    body.innerHTML = '<tr><td colspan="6">暂无结算申请</td></tr>';
    return;
  }

  body.innerHTML = requests
    .map(
      (request) => `
        <tr>
          <td>${request.id}</td>
          <td>${request.merchantName || request.merchantEmail || request.merchantId || "-"}</td>
          <td>${formatMoney(request.amount || 0)}<br><small>${formatRM(pointsToMyr(request.amount || 0))}</small></td>
          <td>${request.time || "-"}</td>
          <td>${statusTag(request.status || "pending")}</td>
          <td>
            ${
              request.status === "pending"
                ? `<button class="text-action settlement-action" data-action="approve" data-request-id="${request.id}">通过</button>
                   <button class="text-action settlement-action" data-action="reject" data-request-id="${request.id}">拒绝</button>`
                : "-"
            }
          </td>
        </tr>
      `
    )
    .join("");
}

async function loadSettlementRequests() {
  const body = document.querySelector("#admin-settlements-body");
  if (body) body.innerHTML = '<tr><td colspan="6">正在加载结算申请...</td></tr>';

  const snapshot = await getDocs(collection(db, "settlementRequests"));
  settlementRequestsCache = snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  renderSettlementRequests(settlementRequestsCache);
}

async function submitSettlementRequest(amount) {
  if (!currentMerchant?.id) throw new Error("请先登录商家账号");
  if (merchantStatus !== "approved") throw new Error("商家未通过审核，无法申请结算");
  if (!amount || amount <= 0) throw new Error("当前没有可结算积分");

  const requestId = `S${Date.now()}`;
  await runTransaction(db, async (transaction) => {
    const merchantDocRef = merchantRef();
    const requestRef = doc(db, "settlementRequests", requestId);
    const merchantSnap = await transaction.get(merchantDocRef);
    if (!merchantSnap.exists()) throw new Error("商家资料不存在");

    const merchantData = merchantSnap.data() || {};
    const currentBalance = Number(merchantData.settlementBalance || 0);
    if (currentBalance < amount) throw new Error("可结算积分不足");

    const settlement = {
      id: requestId,
      merchantId: currentMerchant.id,
      merchantName: merchantData.businessName || currentUser.email,
      merchantEmail: currentUser.email,
      amount,
      myrAmount: pointsToMyr(amount),
      status: "pending",
      time: "刚刚",
      createdAt: new Date().toISOString(),
      updatedAt: serverTimestamp(),
    };
    const merchantSettlements = Array.isArray(merchantData.settlements) ? merchantData.settlements : [];
    const merchantTx = transactionItem("申请结算", "后台审批", `- ${formatMoney(amount)}`);

    transaction.set(requestRef, settlement, { merge: true });
    transaction.set(
      merchantDocRef,
      {
        settlementBalance: currentBalance - amount,
        settlements: [settlement, ...merchantSettlements.filter((item) => item.id !== requestId)].slice(0, 30),
        transactions: [merchantTx, ...(merchantData.transactions || [])].slice(0, 30),
        notifications: [{ text: `结算 ${requestId} 已提交后台审批`, time: "刚刚" }, ...(merchantData.notifications || [])].slice(0, 20),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  });
}

async function reviewSettlementRequest(requestId, approved) {
  const request = settlementRequestsCache.find((item) => item.id === requestId);
  if (!request) throw new Error("找不到结算申请");
  if (request.status !== "pending") throw new Error("该结算申请已处理");

  await runTransaction(db, async (transaction) => {
    const requestRef = doc(db, "settlementRequests", requestId);
    const merchantDocRef = doc(db, "merchants", request.merchantId);
    const requestSnap = await transaction.get(requestRef);
    const merchantSnap = await transaction.get(merchantDocRef);
    if (!requestSnap.exists()) throw new Error("结算申请不存在");
    if (!merchantSnap.exists()) throw new Error("商家资料不存在");

    const latestRequest = requestSnap.data();
    if (latestRequest.status !== "pending") throw new Error("该结算申请已处理");

    const amount = Number(latestRequest.amount || 0);
    const merchantData = merchantSnap.data() || {};
    const settlements = Array.isArray(merchantData.settlements) ? merchantData.settlements : [];
    const nextStatus = approved ? "approved" : "rejected";
    const merchantTx = transactionItem(
      approved ? "结算通过" : "结算拒绝",
      "后台审批",
      approved ? `${formatMoney(amount)} / ${formatRM(pointsToMyr(amount))}` : `+ ${formatMoney(amount)}`
    );

    transaction.set(
      requestRef,
      {
        status: nextStatus,
        reviewedBy: currentUser.email,
        reviewedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    transaction.set(
      merchantDocRef,
      {
        settlementBalance: approved
          ? Number(merchantData.settlementBalance || 0)
          : Number(merchantData.settlementBalance || 0) + amount,
        settlements: settlements.map((item) => (item.id === requestId ? { ...item, status: nextStatus } : item)),
        transactions: [merchantTx, ...(merchantData.transactions || [])].slice(0, 30),
        notifications: [
          { text: `结算 ${requestId} ${approved ? "已通过" : "已拒绝，积分已退回待结算"}`, time: "刚刚" },
          ...(merchantData.notifications || []),
        ].slice(0, 20),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  });

  await Promise.all([loadSettlementRequests(), loadMerchants(), loadFinanceReport(), loadRiskCenter()]);
  loadAdminTransactions().catch(() => {});
}

async function setUserFrozen(userId, frozen) {
  await setDoc(
    doc(db, "wallets", userId),
    {
      status: frozen ? "frozen" : "active",
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  await loadAdminUsers();
  loadRiskCenter().catch(() => {});
}

function transactionItem(type, target, amount) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: "刚刚",
    type,
    target,
    amount,
    status: "成功",
    statusClass: "success",
    createdAt: new Date().toISOString(),
  };
}

function normalizeTransactionRow(row) {
  return {
    id: row.id || `T${Date.now()}`,
    account: row.account || "-",
    type: row.type || "-",
    amount: row.amount || "-",
    source: row.source || "-",
    status: row.status || "成功",
    statusClass: row.statusClass || "success",
    createdAt: row.createdAt || "",
    detail: row.detail || "",
  };
}

function sumApproved(docs, field = "amount") {
  return docs.reduce((total, item) => total + (item.status === "approved" ? Number(item[field] || 0) : 0), 0);
}

function parseFeeRate(rate = "0.60%") {
  const value = Number(String(rate).replace("%", "").trim());
  return Number.isFinite(value) ? value / 100 : 0.006;
}

function renderFinanceReport(rows = [], metrics = {}) {
  setText("#finance-recharge-total", formatMoney(metrics.rechargeTotal || 0));
  setText("#finance-withdraw-total", formatMoney(metrics.withdrawTotal || 0));
  setText("#finance-merchant-total", formatMoney(metrics.merchantSales || 0));
  setText("#finance-fee-total", formatMoney(metrics.platformFee || 0));

  const body = document.querySelector("#admin-finance-body");
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5">暂无财务数据</td></tr>';
    return;
  }

  body.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${row.name}</td>
          <td>${formatMoney(row.points)}</td>
          <td>${formatRM(pointsToMyr(row.points))}</td>
          <td>${row.count}</td>
          <td>${row.note}</td>
        </tr>
      `
    )
    .join("");
}

async function loadFinanceReport() {
  const body = document.querySelector("#admin-finance-body");
  if (body) body.innerHTML = '<tr><td colspan="5">正在加载财务报表...</td></tr>';

  const [merchantSnapshot, rechargeSnapshot, withdrawalSnapshot, refundSnapshot, settlementSnapshot] = await Promise.all([
    getDocs(collection(db, "merchants")),
    getDocs(collection(db, "rechargeRequests")),
    getDocs(collection(db, "withdrawRequests")),
    getDocs(collection(db, "refundRequests")),
    getDocs(collection(db, "settlementRequests")),
  ]);

  const merchants = merchantSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  const recharges = rechargeSnapshot.docs.map((item) => item.data());
  const withdrawals = withdrawalSnapshot.docs.map((item) => item.data());
  const refunds = refundSnapshot.docs.map((item) => item.data());
  const settlements = settlementSnapshot.docs.map((item) => item.data());
  const approvedOrders = merchants.flatMap((merchant) =>
    (merchant.orders || [])
      .filter((order) => (order.status || "approved") === "approved")
      .map((order) => ({
        amount: Number(order.amount || 0),
        feeRate: parseFeeRate(merchant.feeRate),
      }))
  );

  const rechargeTotal = sumApproved(recharges);
  const withdrawTotal = sumApproved(withdrawals);
  const refundTotal = sumApproved(refunds);
  const settlementTotal = sumApproved(settlements);
  const pendingSettlement = merchants.reduce((total, merchant) => total + Number(merchant.settlementBalance || 0), 0);
  const merchantSales = approvedOrders.reduce((total, order) => total + order.amount, 0);
  const platformFee = Math.round(approvedOrders.reduce((total, order) => total + order.amount * order.feeRate, 0));
  const netInflow = rechargeTotal - withdrawTotal - settlementTotal;

  const rows = [
    { name: "充值入金", points: rechargeTotal, count: recharges.filter((item) => item.status === "approved").length, note: "后台审批通过的用户充值" },
    { name: "提现出金", points: withdrawTotal, count: withdrawals.filter((item) => item.status === "approved").length, note: "后台审批通过的用户提现" },
    { name: "商家收款", points: merchantSales, count: approvedOrders.length, note: "未退款的商家订单收款" },
    { name: "退款支出", points: refundTotal, count: refunds.filter((item) => item.status === "approved").length, note: "已通过的退款申请" },
    { name: "商家结算", points: settlementTotal, count: settlements.filter((item) => item.status === "approved").length, note: "已通过的商家结算" },
    { name: "待结算余额", points: pendingSettlement, count: merchants.length, note: "仍停留在商家账户的待结算积分" },
    { name: "平台手续费", points: platformFee, count: approvedOrders.length, note: "按商家费率估算的平台收入" },
    { name: "净资金流入", points: netInflow, count: "-", note: "充值入金 - 提现出金 - 商家结算" },
  ];

  renderFinanceReport(rows, { rechargeTotal, withdrawTotal, merchantSales, platformFee });
}

function riskLevelTag(level) {
  if (level === "high") return '<span class="tag danger">高风险</span>';
  if (level === "medium") return '<span class="tag warning">中风险</span>';
  return '<span class="tag success">低风险</span>';
}

function addRisk(alerts, alert) {
  alerts.push({
    id: alert.id,
    subjectId: alert.subjectId || "",
    subject: alert.subject || alert.subjectId || "-",
    subjectType: alert.subjectType,
    type: alert.type,
    level: alert.level || "medium",
    reason: alert.reason,
    suggestion: alert.suggestion,
    action: alert.action || "review",
    status: alert.status || "open",
  });
}

function renderRiskAlerts(alerts = riskAlertsCache) {
  const body = document.querySelector("#admin-risk-body");
  const highCount = alerts.filter((item) => item.level === "high" && item.status !== "handled").length;
  const mediumCount = alerts.filter((item) => item.level === "medium" && item.status !== "handled").length;
  const frozenCount = alerts.filter((item) => item.status === "frozen").length;
  const openCount = alerts.filter((item) => item.status === "open").length;

  setText("#risk-high-count", String(highCount));
  setText("#risk-medium-count", String(mediumCount));
  setText("#risk-frozen-count", String(frozenCount));
  setText("#risk-open-count", String(openCount));
  setText("#admin-risk-count", String(highCount + mediumCount));

  if (!body) return;
  const visibleAlerts = alerts.filter((item) => item.status !== "handled");
  if (!visibleAlerts.length) {
    body.innerHTML = '<tr><td colspan="6">暂无风控预警</td></tr>';
    return;
  }

  body.innerHTML = visibleAlerts
    .slice(0, 80)
    .map(
      (alert) => `
        <tr>
          <td>${alert.subject}</td>
          <td>${alert.type}</td>
          <td>${riskLevelTag(alert.level)}</td>
          <td>${alert.reason}</td>
          <td>${alert.suggestion}</td>
          <td>
            <button class="text-action risk-action" data-action="view" data-risk-id="${alert.id}">查看</button>
            ${
              alert.action === "freeze-user"
                ? `<button class="text-action risk-action" data-action="freeze-user" data-risk-id="${alert.id}">冻结用户</button>`
                : ""
            }
            ${
              alert.action === "freeze-merchant"
                ? `<button class="text-action risk-action" data-action="freeze-merchant" data-risk-id="${alert.id}">冻结商家</button>`
                : ""
            }
            <button class="text-action risk-action" data-action="handle" data-risk-id="${alert.id}">已处理</button>
          </td>
        </tr>
      `
    )
    .join("");
}

async function loadRiskCenter() {
  const body = document.querySelector("#admin-risk-body");
  if (body) body.innerHTML = '<tr><td colspan="6">正在扫描风控预警...</td></tr>';

  const [walletSnapshot, merchantSnapshot, withdrawalSnapshot, refundSnapshot, settlementSnapshot] = await Promise.all([
    getDocs(collection(db, "wallets")),
    getDocs(collection(db, "merchants")),
    getDocs(collection(db, "withdrawRequests")),
    getDocs(collection(db, "refundRequests")),
    getDocs(collection(db, "settlementRequests")),
  ]);

  const wallets = walletSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  const merchants = merchantSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  const withdrawals = withdrawalSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  const refunds = refundSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  const settlements = settlementSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  const alerts = [];

  wallets.forEach((wallet) => {
    const transactions = Array.isArray(wallet.transactions) ? wallet.transactions : [];
    const balance = Number(wallet.balance || 0);
    const largeTxCount = transactions.filter((tx) => Math.abs(parseAmount(tx.amount) || 0) >= 50000).length;
    if (wallet.status === "frozen") {
      addRisk(alerts, {
        id: `frozen-user-${wallet.id}`,
        subjectId: wallet.id,
        subject: wallet.email || wallet.displayName || wallet.id,
        subjectType: "user",
        type: "账户冻结",
        level: "high",
        reason: "用户当前已被冻结",
        suggestion: "复核身份、交易和提现记录后决定是否解冻",
        status: "frozen",
      });
    }
    if (balance >= 100000) {
      addRisk(alerts, {
        id: `high-balance-${wallet.id}`,
        subjectId: wallet.id,
        subject: wallet.email || wallet.displayName || wallet.id,
        subjectType: "user",
        type: "高余额账户",
        level: balance >= 300000 ? "high" : "medium",
        reason: `钱包余额达到 ${formatMoney(balance)}`,
        suggestion: "核对充值来源和近期付款对象",
        action: "freeze-user",
      });
    }
    if (transactions.length >= 20 || largeTxCount >= 3) {
      addRisk(alerts, {
        id: `active-user-${wallet.id}`,
        subjectId: wallet.id,
        subject: wallet.email || wallet.displayName || wallet.id,
        subjectType: "user",
        type: "异常交易频率",
        level: largeTxCount >= 3 ? "high" : "medium",
        reason: `近期交易 ${transactions.length} 笔，大额交易 ${largeTxCount} 笔`,
        suggestion: "检查是否存在刷单、套现或账户共享",
        action: "freeze-user",
      });
    }
  });

  merchants.forEach((merchant) => {
    const orders = Array.isArray(merchant.orders) ? merchant.orders : [];
    const refundsForMerchant = refunds.filter((item) => item.merchantId === merchant.id);
    const approvedOrders = orders.filter((order) => (order.status || "approved") === "approved");
    const totalReceived = Number(merchant.totalReceived || 0);
    const refundRatio = orders.length ? refundsForMerchant.length / orders.length : 0;
    if (merchant.status === "frozen") {
      addRisk(alerts, {
        id: `frozen-merchant-${merchant.id}`,
        subjectId: merchant.id,
        subject: merchant.businessName || merchant.email || merchant.id,
        subjectType: "merchant",
        type: "商家冻结",
        level: "high",
        reason: "商家当前已被冻结",
        suggestion: "复核资质、退款争议和结算记录",
        status: "frozen",
      });
    }
    if (refundRatio >= 0.3 && refundsForMerchant.length >= 2) {
      addRisk(alerts, {
        id: `refund-ratio-${merchant.id}`,
        subjectId: merchant.id,
        subject: merchant.businessName || merchant.email || merchant.id,
        subjectType: "merchant",
        type: "退款率偏高",
        level: refundRatio >= 0.5 ? "high" : "medium",
        reason: `退款申请 ${refundsForMerchant.length} 笔，订单 ${orders.length} 笔`,
        suggestion: "检查商品交付、用户投诉和商家资质",
        action: "freeze-merchant",
      });
    }
    if (totalReceived >= 300000 || approvedOrders.some((order) => Number(order.amount || 0) >= 100000)) {
      addRisk(alerts, {
        id: `large-merchant-${merchant.id}`,
        subjectId: merchant.id,
        subject: merchant.businessName || merchant.email || merchant.id,
        subjectType: "merchant",
        type: "大额收款",
        level: totalReceived >= 600000 ? "high" : "medium",
        reason: `累计收款 ${formatMoney(totalReceived)}`,
        suggestion: "复核商家经营范围和结算银行卡",
        action: "freeze-merchant",
      });
    }
  });

  withdrawals
    .filter((item) => item.status === "pending" && Number(item.amount || 0) >= 50000)
    .forEach((item) =>
      addRisk(alerts, {
        id: `withdraw-${item.id}`,
        subjectId: item.userId,
        subject: item.email || item.userId,
        subjectType: "user",
        type: "大额提现待审",
        level: Number(item.amount || 0) >= 150000 ? "high" : "medium",
        reason: `提现申请 ${formatMoney(item.amount || 0)}`,
        suggestion: "审批前核对充值、付款和银行卡一致性",
        action: "freeze-user",
      })
    );

  settlements
    .filter((item) => item.status === "pending" && Number(item.amount || 0) >= 100000)
    .forEach((item) =>
      addRisk(alerts, {
        id: `settlement-${item.id}`,
        subjectId: item.merchantId,
        subject: item.merchantName || item.merchantEmail || item.merchantId,
        subjectType: "merchant",
        type: "大额结算待审",
        level: Number(item.amount || 0) >= 300000 ? "high" : "medium",
        reason: `结算申请 ${formatMoney(item.amount || 0)}`,
        suggestion: "出款前复核订单、退款和商家资料",
        action: "freeze-merchant",
      })
    );

  const riskWeight = { high: 0, medium: 1, low: 2 };
  riskAlertsCache = alerts.sort((a, b) => (riskWeight[a.level] ?? 1) - (riskWeight[b.level] ?? 1));
  renderRiskAlerts(riskAlertsCache);
}

function renderAdminTransactions(filter = adminTransactionFilter) {
  const body = document.querySelector("#admin-transactions-body");
  if (!body) return;
  const rows = adminTransactionsCache.filter((item) => filter === "all" || item.sourceType === filter);
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7">暂无交易流水</td></tr>';
    return;
  }

  body.innerHTML = rows
    .slice(0, 80)
    .map(
      (raw) => {
        const row = normalizeTransactionRow(raw);
        return `
          <tr>
            <td>${row.id}</td>
            <td>${row.account}</td>
            <td>${row.type}</td>
            <td>${row.amount}</td>
            <td>${row.source}</td>
            <td><span class="tag ${row.statusClass}">${row.status}</span></td>
            <td><button class="text-action transaction-action" data-transaction-id="${row.id}">查看</button></td>
          </tr>
        `;
      }
    )
    .join("");
}

async function loadAdminTransactions() {
  const body = document.querySelector("#admin-transactions-body");
  if (body) body.innerHTML = '<tr><td colspan="7">正在加载交易流水...</td></tr>';

  const [walletSnapshot, merchantSnapshot, rechargeSnapshot, withdrawalSnapshot, refundSnapshot, settlementSnapshot] = await Promise.all([
    getDocs(collection(db, "wallets")),
    getDocs(collection(db, "merchants")),
    getDocs(collection(db, "rechargeRequests")),
    getDocs(collection(db, "withdrawRequests")),
    getDocs(collection(db, "refundRequests")),
    getDocs(collection(db, "settlementRequests")),
  ]);

  const walletRows = walletSnapshot.docs.flatMap((docSnap) => {
    const data = docSnap.data();
    return (data.transactions || []).map((tx) => ({
      ...tx,
      id: tx.id || `${docSnap.id}-${tx.createdAt || Date.now()}`,
      account: data.email || docSnap.id,
      source: "用户钱包",
      sourceType: "wallet",
      detail: `UID: ${docSnap.id}`,
    }));
  });

  const merchantRows = merchantSnapshot.docs.flatMap((docSnap) => {
    const data = docSnap.data();
    const orderRows = (data.orders || []).map((order) => ({
      id: order.id,
      account: data.businessName || data.email || docSnap.id,
      type: "商家订单",
      amount: formatMoney(order.amount || 0),
      source: "商家订单",
      sourceType: "merchant",
      status: order.status === "approved" ? "已支付" : order.status === "refund_pending" ? "退款审批中" : order.status === "refunded" ? "已退款" : order.status || "成功",
      statusClass: order.status === "refund_pending" ? "warning" : order.status === "refunded" ? "danger" : "success",
      createdAt: order.createdAt || "",
      detail: `顾客: ${order.customer || "-"} / 商家UID: ${docSnap.id}`,
    }));
    const txRows = (data.transactions || []).map((tx) => ({
      ...tx,
      id: tx.id || `${docSnap.id}-${tx.createdAt || Date.now()}`,
      account: data.businessName || data.email || docSnap.id,
      source: "商家流水",
      sourceType: "merchant",
      detail: `商家UID: ${docSnap.id}`,
    }));
    return [...orderRows, ...txRows];
  });

  const rechargeRows = rechargeSnapshot.docs.map((docSnap) => {
    const data = docSnap.data();
    const statusMap = {
      pending: ["待审批", "warning"],
      approved: ["已通过", "success"],
      rejected: ["已拒绝", "danger"],
    };
    const [status, statusClass] = statusMap[data.status || "pending"] || statusMap.pending;
    return {
      id: docSnap.id,
      account: data.email || data.userId,
      type: "充值申请",
      amount: `${formatMoney(data.amount || 0)} / ${formatRM(data.myrAmount || pointsToMyr(data.amount || 0))}`,
      source: "充值审批",
      sourceType: "recharge",
      status,
      statusClass,
      createdAt: data.createdAt || "",
      detail: `申请UID: ${data.userId || "-"}`,
    };
  });

  const withdrawalRows = withdrawalSnapshot.docs.map((docSnap) => {
    const data = docSnap.data();
    const statusMap = {
      pending: ["待审批", "warning"],
      approved: ["已通过", "success"],
      rejected: ["已拒绝", "danger"],
    };
    const [status, statusClass] = statusMap[data.status || "pending"] || statusMap.pending;
    return {
      id: docSnap.id,
      account: data.email || data.userId,
      type: "提现申请",
      amount: `${formatMoney(data.amount || 0)} / ${formatRM(data.myrAmount || pointsToMyr(data.amount || 0))}`,
      source: "提现审批",
      sourceType: "withdrawal",
      status,
      statusClass,
      createdAt: data.createdAt || "",
      detail: `银行卡: ${data.bankAccount || "-"} / UID: ${data.userId || "-"}`,
    };
  });

  const refundRows = refundSnapshot.docs.map((docSnap) => {
    const data = docSnap.data();
    const statusMap = {
      pending: ["待审批", "warning"],
      approved: ["已通过", "success"],
      rejected: ["已拒绝", "danger"],
    };
    const [status, statusClass] = statusMap[data.status || "pending"] || statusMap.pending;
    return {
      id: docSnap.id,
      account: data.customerEmail || data.customerId,
      type: "退款申请",
      amount: formatMoney(data.amount || 0),
      source: data.merchantName || data.merchantEmail || "退款审批",
      sourceType: "refund",
      status,
      statusClass,
      createdAt: data.createdAt || "",
      detail: `订单: ${data.orderId || "-"} / 商家UID: ${data.merchantId || "-"}`,
    };
  });

  const settlementRows = settlementSnapshot.docs.map((docSnap) => {
    const data = docSnap.data();
    const statusMap = {
      pending: ["待审批", "warning"],
      approved: ["已通过", "success"],
      rejected: ["已拒绝", "danger"],
    };
    const [status, statusClass] = statusMap[data.status || "pending"] || statusMap.pending;
    return {
      id: docSnap.id,
      account: data.merchantName || data.merchantEmail || data.merchantId,
      type: "结算申请",
      amount: `${formatMoney(data.amount || 0)} / ${formatRM(data.myrAmount || pointsToMyr(data.amount || 0))}`,
      source: "结算审批",
      sourceType: "settlement",
      status,
      statusClass,
      createdAt: data.createdAt || "",
      detail: `商家UID: ${data.merchantId || "-"}`,
    };
  });

  adminTransactionsCache = [...walletRows, ...merchantRows, ...rechargeRows, ...withdrawalRows, ...refundRows, ...settlementRows].sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
  renderAdminTransactions();
}

async function ensureWallet(user) {
  const ref = walletRef(user);
  const snap = await getDoc(ref);
  const receiveCode = createReceiveCode(user);

  if (!snap.exists()) {
    await setDoc(ref, {
      balance: 0,
      email: user.email,
      displayName: user.displayName || "",
      receiveCode,
      role: "user",
      transactions: [],
      status: "active",
      updatedAt: serverTimestamp(),
    });
    return;
  }

  const data = snap.data();
  if (!data.receiveCode) {
    await setDoc(ref, { receiveCode, updatedAt: serverTimestamp() }, { merge: true });
  }
}

async function attachWallet(user) {
  if (walletUnsubscribe) walletUnsubscribe();
  await ensureWallet(user);

  walletUnsubscribe = onSnapshot(walletRef(user), (snapshot) => {
    const data = snapshot.data() || {};
    setWalletBalance(data.balance || 0);
    walletStatus = data.status || "active";
    userTransactions = Array.isArray(data.transactions) ? data.transactions : [];
    renderUserTransactions(userTransactions);
    updateReceiveQr(data.receiveCode || createReceiveCode(user));
  });
}

async function saveOwnWallet(nextBalance, transactions = userTransactions) {
  if (!currentUser || activeRole !== "user") return;
  await setDoc(
    walletRef(),
    {
      balance: nextBalance,
      email: currentUser.email,
      displayName: currentUser.displayName || "",
      receiveCode: createReceiveCode(currentUser),
      role: "user",
      transactions: transactions.slice(0, 30),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function updateWalletBalance(change, txItem) {
  const nextBalance = Math.max(0, walletBalance + change);
  const transactions = txItem ? [txItem, ...userTransactions].slice(0, 30) : userTransactions;
  setWalletBalance(nextBalance);
  renderUserTransactions(transactions);
  await saveOwnWallet(nextBalance, transactions);
}

async function transferToUser(recipientUserId, recipientName, amount) {
  const payerRef = walletRef();
  const recipientRef = doc(db, "wallets", recipientUserId);
  const payerTx = transactionItem("扫码转账", recipientName || "个人收款码", `- ${formatMoney(amount)}`);
  const recipientTx = transactionItem("收款", currentUser.displayName || currentUser.email || "用户", `+ ${formatMoney(amount)}`);

  await runTransaction(db, async (transaction) => {
    const payerSnap = await transaction.get(payerRef);
    const recipientSnap = await transaction.get(recipientRef);
    if (!recipientSnap.exists()) throw new Error("收款账户不存在，请让对方先登录生成收款码");

    const payerData = payerSnap.data() || {};
    const recipientData = recipientSnap.data() || {};
    const payerBalance = Number(payerData.balance || 0);
    const recipientBalance = Number(recipientData.balance || 0);
    if (amount > payerBalance) throw new Error("钱包余额不足");

    transaction.set(
      payerRef,
      {
        balance: payerBalance - amount,
        transactions: [payerTx, ...(payerData.transactions || [])].slice(0, 30),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    transaction.set(
      recipientRef,
      {
        balance: recipientBalance + amount,
        transactions: [recipientTx, ...(recipientData.transactions || [])].slice(0, 30),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  });
}

function showOnlyView(target) {
  Object.entries(views).forEach(([name, view]) => {
    view.classList.toggle("active", name === target);
  });
}

async function loginAs(target) {
  activeRole = target;
  sessionStorage.setItem("activeRole", target);

  try {
    const result = await signInWithPopup(auth, googleProvider);
    currentUser = result.user;
    if (target === "admin") {
      const allowed = await isAuthorizedAdmin(currentUser);
      if (!allowed) {
        activeRole = "";
        sessionStorage.removeItem("activeRole");
        await signOut(auth);
        currentUser = null;
        showToast("后台登录被拒绝：该 Google 账号未获授权");
        return;
      }
    }
    enterRole(target);
    if (target === "user") await attachWallet(currentUser);
    if (target === "merchant") await attachMerchant(currentUser);
    showToast(`${roleConfig[target].title}登录成功`);
  } catch (error) {
    showToast(`Google 登录失败：${error.message}`);
  }
}

function enterRole(target) {
  const role = roleConfig[target];
  showOnlyView(target);
  pageTitle.textContent = role.title;
  currentRole.textContent = currentUser?.email || role.label;
  roleName.textContent = role.title;
  loginGateway.classList.add("hidden");
  appShell.classList.remove("locked");
  if (target === "admin") loadAdminUsers().catch((error) => showToast(error.message || "用户数据加载失败"));
  if (target === "admin") loadMerchants().catch((error) => showToast(error.message || "商家数据加载失败"));
  if (target === "admin") loadRechargeRequests().catch((error) => showToast(error.message || "充值申请加载失败"));
  if (target === "admin") loadWithdrawalRequests().catch((error) => showToast(error.message || "提现申请加载失败"));
  if (target === "admin") loadRefundRequests().catch((error) => showToast(error.message || "退款申请加载失败"));
  if (target === "admin") loadSettlementRequests().catch((error) => showToast(error.message || "结算申请加载失败"));
  if (target === "admin") loadFinanceReport().catch((error) => showToast(error.message || "财务报表加载失败"));
  if (target === "admin") loadRiskCenter().catch((error) => showToast(error.message || "风控中心加载失败"));
  if (target === "admin") loadAdminTransactions().catch((error) => showToast(error.message || "交易流水加载失败"));
}

async function logout() {
  if (walletUnsubscribe) walletUnsubscribe();
  if (merchantUnsubscribe) merchantUnsubscribe();
  walletUnsubscribe = null;
  merchantUnsubscribe = null;
  activeRole = "";
  currentUser = null;
  sessionStorage.removeItem("activeRole");
  await signOut(auth);
  showOnlyView("");
  appShell.classList.add("locked");
  loginGateway.classList.remove("hidden");
  currentRole.textContent = "未登录";
  roleName.textContent = "-";
  setWalletBalance(0);
  merchantStatus = "pending";
  emptyTransactionRow("登录后显示当前账户交易记录");
  showToast("已退出登录");
}

function ensureOverlay() {
  let overlay = document.querySelector("#action-overlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "action-overlay";
  overlay.className = "action-overlay hidden";
  overlay.innerHTML = `
    <div class="dialog" role="dialog" aria-modal="true">
      <div class="dialog-header">
        <h2 id="dialog-title"></h2>
        <button class="dialog-close" type="button" aria-label="关闭">×</button>
      </div>
      <div class="dialog-body" id="dialog-body"></div>
      <div class="dialog-actions">
        <button class="ghost-action dialog-cancel" type="button">关闭</button>
        <button class="primary-action dialog-confirm" type="button">确认</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector(".dialog-close").addEventListener("click", closeDialog);
  overlay.querySelector(".dialog-cancel").addEventListener("click", closeDialog);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeDialog();
  });
  return overlay;
}

function openDialog(title, body, confirmText = "确认", onConfirm = closeDialog) {
  const overlay = ensureOverlay();
  overlay.querySelector("#dialog-title").textContent = title;
  overlay.querySelector("#dialog-body").innerHTML = body;
  const confirm = overlay.querySelector(".dialog-confirm");
  confirm.textContent = confirmText;
  confirm.onclick = () => onConfirm();
  overlay.classList.remove("hidden");
}

function closeDialog() {
  stopScanner();
  const overlay = document.querySelector("#action-overlay");
  if (overlay) overlay.classList.add("hidden");
}

function showToast(message) {
  let toast = document.querySelector("#toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function fillPaymentForm(payment) {
  const merchantInput = document.querySelector("#pay-merchant");
  const amountInput = document.querySelector("#pay-amount");
  const codeInput = document.querySelector("#pay-code");
  const result = document.querySelector("#scan-result");

  if (merchantInput) merchantInput.value = payment.merchant || "个人收款码";
  if (amountInput) amountInput.value = payment.amount ? String(Math.round(payment.amount)) : "";
  if (codeInput) codeInput.value = payment.code || "";
  if (codeInput) codeInput.dataset.kind = payment.kind || "";
  if (codeInput) codeInput.dataset.recipientUserId = payment.recipientUserId || "";
  if (codeInput) codeInput.dataset.merchantId = payment.merchantId || "";
  if (result) {
    result.textContent =
      payment.kind === "receive"
        ? `已识别个人收款码：${payment.merchant}，请输入转账金额`
        : `已识别商家付款码：${payment.merchant}，${formatMoney(payment.amount)}`;
  }
}

async function startScanner() {
  const video = document.querySelector("#scanner-video");
  const result = document.querySelector("#scan-result");
  const startButton = document.querySelector("#start-scanner");
  if (!video) return;

  if (!window.isSecureContext) {
    if (result) result.textContent = "手机摄像头需要 HTTPS 页面，请使用 GitHub Pages 的 https:// 地址打开。";
    return;
  }
  if (!("mediaDevices" in navigator) || !navigator.mediaDevices.getUserMedia) {
    if (result) result.textContent = "当前浏览器不支持摄像头扫码，请使用手动付款码。";
    return;
  }

  try {
    if (startButton) {
      startButton.disabled = true;
      startButton.textContent = "正在请求摄像头";
    }

    try {
      scannerStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch {
      scannerStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    video.setAttribute("autoplay", "");
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    video.srcObject = scannerStream;
    await video.play();
    if (startButton) {
      startButton.disabled = false;
      startButton.textContent = "扫码中";
    }
    if (result) result.textContent = "请把二维码放入取景框";

    if ("BarcodeDetector" in window) {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      scannerTimer = window.setInterval(async () => {
        if (!video.videoWidth) return;
        const codes = await detector.detect(video);
        const payment = parsePaymentCode(codes[0]?.rawValue);
        if (payment) {
          fillPaymentForm(payment);
          stopScanner();
          showToast("已识别二维码");
        }
      }, 800);
    } else if (result) {
      result.textContent = "摄像头已打开，但此浏览器不支持原生 QR 识别，请手动输入付款码。";
    }
  } catch (error) {
    if (startButton) {
      startButton.disabled = false;
      startButton.textContent = "打开摄像头扫码";
    }
    const reasonMap = {
      NotAllowedError: "摄像头权限被拒绝，请在浏览器网站设置里允许摄像头。",
      NotFoundError: "没有找到可用摄像头。",
      NotReadableError: "摄像头被其他应用占用，请关闭相机、微信、WhatsApp 等应用后重试。",
      OverconstrainedError: "当前摄像头不支持请求的模式。",
      SecurityError: "浏览器安全限制阻止摄像头，请确认使用 HTTPS。",
    };
    if (result) result.textContent = reasonMap[error.name] || `无法打开摄像头：${error.name || error.message}`;
  }
}

function stopScanner() {
  if (scannerTimer) window.clearInterval(scannerTimer);
  scannerTimer = null;
  if (scannerStream) scannerStream.getTracks().forEach((track) => track.stop());
  scannerStream = null;
  const video = document.querySelector("#scanner-video");
  if (video) video.srcObject = null;
  const startButton = document.querySelector("#start-scanner");
  if (startButton) startButton.textContent = "打开摄像头扫码";
}

async function confirmScanPayment() {
  const codeInput = document.querySelector("#pay-code");
  const amountInput = document.querySelector("#pay-amount");
  const amountBeforeParse = amountInput?.value || "";
  const manualPayment = parsePaymentCode(codeInput?.value);
  if (manualPayment) {
    if (manualPayment.kind === "receive") {
      const merchantInput = document.querySelector("#pay-merchant");
      if (merchantInput) merchantInput.value = manualPayment.merchant || "个人收款码";
      if (codeInput) {
        codeInput.dataset.kind = manualPayment.kind;
        codeInput.dataset.recipientUserId = manualPayment.recipientUserId || "";
      }
    } else {
      fillPaymentForm(manualPayment);
    }
  }

  const merchant = document.querySelector("#pay-merchant").value || "商家";
  if (amountInput && !amountInput.value && amountBeforeParse) amountInput.value = amountBeforeParse;
  const amount = parseAmount(amountInput?.value || amountBeforeParse);
  const recipientUserId = codeInput?.dataset.recipientUserId;
  const kind = codeInput?.dataset.kind;

  if (!amount) {
    showToast(`请输入正确的付款金额，当前读取到：${amountInput?.value || "空"}`);
    amountInput?.focus();
    return;
  }
  if (amount > walletBalance) {
    showToast("钱包余额不足");
    return;
  }

  try {
    if (kind === "receive" && recipientUserId) {
      if (recipientUserId === currentUser.uid) {
        showToast("不能付款给自己的收款码");
        return;
      }
      await transferToUser(recipientUserId, merchant, amount);
      showToast(`转账成功，已付款 ${formatMoney(amount)}`);
    } else {
      const merchantId = manualPayment?.merchantId || codeInput?.dataset.merchantId;
      if (merchantId) {
        await payMerchant(merchantId, merchant, amount);
      } else {
        await updateWalletBalance(-amount, transactionItem("扫码付款", merchant, `- ${formatMoney(amount)}`));
      }
      showToast(`付款成功，余额已扣除 ${formatMoney(amount)}`);
    }
    closeDialog();
  } catch (error) {
    if (error.code === "permission-denied") {
      showToast("付款失败：Firestore 规则不允许写入收款方钱包");
      return;
    }
    showToast(error.message || "付款失败");
  }
}

function handleUserButton(button) {
  const text = button.textContent.trim();
  if (button.id === "copy-receive-code") {
    const code = document.querySelector("#receive-qr-image")?.dataset.code;
    if (!code) {
      showToast("收款码还未生成，请先完成登录");
      return;
    }
    navigator.clipboard?.writeText(code);
    showToast("专属收款码已复制");
    return;
  }

  if (text.includes("充值")) {
    if (walletStatus === "frozen") {
      showToast("账户已被冻结，无法充值");
      return;
    }
    openDialog(
      "钱包充值",
      `<label class="field-label">充值金额（RM）</label>
       <input class="dialog-input" id="recharge-amount" value="100.00" />
       <p class="dialog-note">系统会按 RM 1 = 100 积分自动兑换，审批通过后积分才会增加。</p>`,
      "提交申请",
      async () => {
        const amount = parseAmount(document.querySelector("#recharge-amount").value);
        if (!amount) {
          showToast("请输入正确的充值金额");
          return;
        }
        const points = myrToPoints(amount);
        await submitRechargeRequest(amount);
        closeDialog();
        showToast(`充值申请已提交：${formatRM(amount)} = ${formatMoney(points)}`);
      }
    );
    return;
  }

  if (button.id === "withdraw-button" || text.includes("提现")) {
    if (walletStatus === "frozen") {
      showToast("账户已被冻结，无法提交提现申请");
      return;
    }
    openDialog(
      "钱包提现",
      `<label class="field-label">提现积分</label>
       <input class="dialog-input" id="withdraw-amount" value="5000" />
       <label class="field-label">到账银行卡/账户</label>
       <input class="dialog-input" id="withdraw-bank" value="Maybank **** 8821" />
       <p class="dialog-note">系统会按 100 积分 = RM 1 自动换算，审批通过后才会扣除积分余额。</p>`,
      "提交申请",
      async () => {
        const amount = parseAmount(document.querySelector("#withdraw-amount").value);
        const bankAccount = document.querySelector("#withdraw-bank").value.trim();
        if (!amount) {
          showToast("请输入正确的提现金额");
          return;
        }
        if (!bankAccount) {
          showToast("请输入到账银行卡/账户");
          return;
        }
        const points = Math.round(amount);
        await submitWithdrawalRequest(points, bankAccount);
        closeDialog();
        showToast(`提现申请已提交：${formatMoney(points)} = ${formatRM(pointsToMyr(points))}`);
      }
    );
    return;
  }

  if (text.includes("扫码")) {
    if (walletStatus === "frozen") {
      showToast("账户已被冻结，无法付款");
      return;
    }
    openDialog(
      "扫码付款",
      `<div class="scanner-box">
        <video id="scanner-video" class="scanner-video" playsinline muted></video>
        <div class="scanner-frame"><div class="scan-line"></div></div>
      </div>
      <div class="scanner-actions">
        <button class="text-action" id="start-scanner" type="button">打开摄像头扫码</button>
        <button class="text-action" id="use-demo-code" type="button">使用测试码</button>
      </div>
      <p class="dialog-note" id="scan-result">可扫描商家付款码，或扫描其他用户的固定收款码。</p>
       <label class="field-label">付款码内容</label>
       <input class="dialog-input" id="pay-code" placeholder="粘贴或输入商家付款码/用户收款码" />
       <label class="field-label">对象</label>
       <input class="dialog-input" id="pay-merchant" value="" placeholder="扫码后自动填入" />
       <label class="field-label">付款积分</label>
       <input class="dialog-input" id="pay-amount" value="" placeholder="请输入积分" />`,
      "确认付款",
      confirmScanPayment
    );
    document.querySelector("#start-scanner").addEventListener("click", startScanner);
    document.querySelector("#use-demo-code").addEventListener("click", () => {
      fillPaymentForm({
        kind: "merchant",
        merchant: "MY Coffee",
        amount: 1280,
        code: "oneminpay://pay?merchant=MY%20Coffee&amount=1280",
      });
      showToast("已填入测试付款码");
    });
    return;
  }

  if (text.includes("筛选")) {
    openDialog(
      "筛选交易记录",
      `<div class="filter-grid">
        <button class="filter-chip">全部</button>
        <button class="filter-chip">付款</button>
        <button class="filter-chip">收款</button>
        <button class="filter-chip">退款</button>
      </div>
      <p class="dialog-note">原型筛选会显示操作反馈，真实系统可连接交易接口。</p>`,
      "应用筛选",
      () => {
        closeDialog();
        showToast("已应用交易筛选");
      }
    );
  }
}

function handleMerchantButton(button) {
  const text = button.textContent.trim();
  if (merchantStatus !== "approved") {
    const message =
      merchantStatus === "frozen"
        ? "商家账户已被冻结，无法操作"
        : merchantStatus === "rejected"
          ? "商家入驻已被拒绝，无法操作"
          : "商家资料待后台审核，通过后才能操作";
    showToast(message);
    return;
  }

  if (text.includes("动态")) {
    openDialog(
      "生成动态收款码",
      `<label class="field-label">固定积分</label>
       <input class="dialog-input" id="merchant-dynamic-amount" placeholder="留空为任意积分" />
       <p class="dialog-note">用户扫码后会自动带入商家信息，填写积分后可直接付款。</p>`,
      "生成",
      async () => {
        const amount = document.querySelector("#merchant-dynamic-amount").value.trim();
        const code = createMerchantCode(currentUser, amount);
        await setDoc(merchantRef(), { merchantCode: code, updatedAt: serverTimestamp() }, { merge: true });
        closeDialog();
        showToast("动态收款码已生成");
      }
    );
    return;
  }

  if (button.classList.contains("merchant-order-action")) {
    const order = (currentMerchant?.orders || []).find((item) => item.id === button.dataset.orderId);
    if (button.dataset.action === "refund") {
      openDialog(
        "申请退款",
        `<p class="dialog-note">订单 ${order?.id || "-"} 将提交后台审批，审批通过后 ${formatMoney(order?.amount || 0)} 会退回用户钱包。</p>`,
        "提交退款",
        async () => {
          try {
            await submitRefundRequest(order);
            closeDialog();
            showToast("退款申请已提交后台审批");
          } catch (error) {
            showToast(error.message || "退款申请提交失败");
          }
        }
      );
      return;
    }
    openDialog(
      "订单详情",
      `<div class="detail-list">
        <p><strong>订单号：</strong>${order?.id || "-"}</p>
        <p><strong>顾客：</strong>${order?.customer || "-"}</p>
        <p><strong>积分：</strong>${formatMoney(order?.amount || 0)}</p>
        <p><strong>状态：</strong>已支付</p>
      </div>`,
      "关闭",
      closeDialog
    );
    return;
  }

  if (button.id === "merchant-settlement-button") {
    const amount = Number(currentMerchant?.settlementBalance || 0);
    if (!amount) {
      showToast("当前没有可结算金额");
      return;
    }
    openDialog(
      "申请结算",
      `<p class="dialog-note">本次申请结算 ${formatMoney(amount)}，后台通过后会按 ${formatRM(pointsToMyr(amount))} 出款。</p>`,
      "提交结算",
      async () => {
        try {
          await submitSettlementRequest(amount);
          closeDialog();
          showToast("结算申请已提交后台审批");
        } catch (error) {
          showToast(error.message || "结算申请提交失败");
        }
      }
    );
    return;
  }

  if (text.includes("导出")) {
    openDialog(
      "导出订单",
      `<p class="dialog-note">将导出今日订单、退款和结算状态。</p>
       <div class="summary-box">文件名：merchant-orders-${new Date().toISOString().slice(0, 10)}.xlsx</div>`,
      "模拟导出",
      () => {
        closeDialog();
        showToast("订单报表已生成");
      }
    );
    return;
  }

  if (text.includes("查看")) {
    openDialog(
      "订单详情",
      `<div class="detail-list">
        <p><strong>订单号：</strong>M20260603001</p>
        <p><strong>顾客：</strong>Chen</p>
        <p><strong>积分：</strong>6,820 积分</p>
        <p><strong>状态：</strong>已支付</p>
      </div>`,
      "知道了",
      closeDialog
    );
    return;
  }

  if (text.includes("处理")) {
    openDialog(
      "处理退款订单",
      `<p class="dialog-note">订单 M20260603002 申请退款 3,100 积分。</p>`,
      "通过退款",
      () => {
        button.textContent = "已处理";
        button.disabled = true;
        closeDialog();
        showToast("退款处理完成");
      }
    );
    return;
  }

  if (text.includes("通过") || text.includes("审核")) {
    button.textContent = "已完成";
    button.disabled = true;
    showToast("退款审核已完成");
    return;
  }

  if (text.includes("申请") || text.includes("凭证")) {
    openDialog(
      "结算管理",
      `<p class="dialog-note">今日待结算 1,290,000 积分，系统会按比例换算成 RM 12,900 提交到绑定银行卡。</p>`,
      "确认结算",
      () => {
        closeDialog();
        showToast("结算申请已提交");
      }
    );
  }
}

function handleAdminButton(button) {
  const text = button.textContent.trim();
  if (button.id === "refresh-users-button") {
    loadAdminUsers()
      .then(() => showToast("用户列表已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-recharges-button") {
    loadRechargeRequests()
      .then(() => showToast("充值申请已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-withdrawals-button") {
    loadWithdrawalRequests()
      .then(() => showToast("提现申请已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-refunds-button") {
    loadRefundRequests()
      .then(() => showToast("退款申请已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-settlements-button") {
    loadSettlementRequests()
      .then(() => showToast("结算申请已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-finance-button") {
    loadFinanceReport()
      .then(() => showToast("财务报表已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-risk-button") {
    loadRiskCenter()
      .then(() => showToast("风控预警已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-merchants-button") {
    loadMerchants()
      .then(() => showToast("商家列表已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-transactions-button") {
    loadAdminTransactions()
      .then(() => showToast("交易流水已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.classList.contains("transaction-filter")) {
    adminTransactionFilter = button.dataset.filter || "all";
    document.querySelectorAll(".transaction-filter").forEach((item) => item.classList.toggle("active", item === button));
    renderAdminTransactions(adminTransactionFilter);
    return;
  }

  if (button.classList.contains("transaction-action")) {
    const transaction = adminTransactionsCache.find((item) => item.id === button.dataset.transactionId);
    if (!transaction) {
      showToast("找不到该流水");
      return;
    }
    openDialog(
      "交易详情",
      `<div class="detail-list">
        <p><strong>流水号：</strong>${transaction.id}</p>
        <p><strong>账户：</strong>${transaction.account || "-"}</p>
        <p><strong>类型：</strong>${transaction.type || "-"}</p>
        <p><strong>金额：</strong>${transaction.amount || "-"}</p>
        <p><strong>来源：</strong>${transaction.source || "-"}</p>
        <p><strong>状态：</strong>${transaction.status || "成功"}</p>
        <p><strong>详情：</strong>${transaction.detail || "-"}</p>
      </div>`,
      "关闭",
      closeDialog
    );
    return;
  }

  if (button.classList.contains("risk-action")) {
    const alert = riskAlertsCache.find((item) => item.id === button.dataset.riskId);
    if (!alert) {
      showToast("找不到该风控预警");
      return;
    }
    const action = button.dataset.action;
    if (action === "view") {
      openDialog(
        "风控预警详情",
        `<div class="detail-list">
          <p><strong>对象：</strong>${alert.subject}</p>
          <p><strong>类型：</strong>${alert.type}</p>
          <p><strong>等级：</strong>${alert.level === "high" ? "高风险" : "中风险"}</p>
          <p><strong>原因：</strong>${alert.reason}</p>
          <p><strong>建议：</strong>${alert.suggestion}</p>
        </div>`,
        "关闭",
        closeDialog
      );
      return;
    }
    if (action === "freeze-user") {
      setUserFrozen(alert.subjectId, true)
        .then(() => showToast("用户已冻结，风控已刷新"))
        .catch((error) => showToast(error.message || "冻结失败"));
      return;
    }
    if (action === "freeze-merchant") {
      updateMerchantStatus(alert.subjectId, "frozen")
        .then(() => {
          loadRiskCenter().catch(() => {});
          showToast("商家已冻结，风控已刷新");
        })
        .catch((error) => showToast(error.message || "冻结失败"));
      return;
    }
    if (action === "handle") {
      alert.status = "handled";
      renderRiskAlerts(riskAlertsCache);
      showToast("该预警已标记为处理");
      return;
    }
  }

  if (button.classList.contains("merchant-action")) {
    const merchantId = button.dataset.merchantId;
    const action = button.dataset.action;
    const merchant = merchantsCache.find((item) => item.id === merchantId);

    if (action === "view") {
      openDialog(
        "商家详情",
        `<div class="detail-list">
          <p><strong>商家名称：</strong>${merchant?.businessName || "-"}</p>
          <p><strong>邮箱：</strong>${merchant?.email || "-"}</p>
          <p><strong>UID：</strong>${merchantId}</p>
          <p><strong>状态：</strong>${merchant?.status || "pending"}</p>
          <p><strong>费率：</strong>${merchant?.feeRate || "0.60%"}</p>
        </div>`,
        "关闭",
        closeDialog
      );
      return;
    }

    const statusMap = {
      approve: "approved",
      reject: "rejected",
      freeze: "frozen",
      unfreeze: "approved",
    };
    updateMerchantStatus(merchantId, statusMap[action])
      .then(() => showToast("商家状态已更新"))
      .catch((error) => showToast(error.message || "操作失败"));
    return;
  }

  if (button.classList.contains("recharge-action")) {
    const approved = button.dataset.action === "approve";
    reviewRechargeRequest(button.dataset.requestId, approved)
      .then(() => showToast(approved ? "充值申请已通过" : "充值申请已拒绝"))
      .catch((error) => showToast(error.message || "审批失败"));
    return;
  }

  if (button.classList.contains("withdrawal-action")) {
    const approved = button.dataset.action === "approve";
    reviewWithdrawalRequest(button.dataset.requestId, approved)
      .then(() => showToast(approved ? "提现申请已通过" : "提现申请已拒绝"))
      .catch((error) => showToast(error.message || "审批失败"));
    return;
  }

  if (button.classList.contains("refund-action")) {
    const approved = button.dataset.action === "approve";
    reviewRefundRequest(button.dataset.requestId, approved)
      .then(() => showToast(approved ? "退款申请已通过，积分已退回用户" : "退款申请已拒绝"))
      .catch((error) => showToast(error.message || "审批失败"));
    return;
  }

  if (button.classList.contains("settlement-action")) {
    const approved = button.dataset.action === "approve";
    reviewSettlementRequest(button.dataset.requestId, approved)
      .then(() => showToast(approved ? "结算申请已通过" : "结算申请已拒绝，积分已退回待结算"))
      .catch((error) => showToast(error.message || "审批失败"));
    return;
  }

  if (button.classList.contains("admin-user-action")) {
    const userId = button.dataset.userId;
    const action = button.dataset.action;
    const user = adminUsersCache.find((item) => item.id === userId);
    if (action === "view") {
      openDialog(
        "用户详情",
        `<div class="detail-list">
          <p><strong>邮箱：</strong>${user?.email || "-"}</p>
          <p><strong>UID：</strong>${userId}</p>
          <p><strong>余额：</strong>${formatMoney(user?.balance || 0)}</p>
          <p><strong>状态：</strong>${user?.status === "frozen" ? "已冻结" : "正常"}</p>
          <p><strong>交易数：</strong>${(user?.transactions || []).length}</p>
        </div>`,
        "关闭",
        closeDialog
      );
      return;
    }

    setUserFrozen(userId, action === "freeze")
      .then(() => showToast(action === "freeze" ? "用户已冻结" : "用户已解冻"))
      .catch((error) => showToast(error.message || "操作失败"));
    return;
  }

  if (button.id === "authorize-admin-button") {
    const input = document.querySelector("#admin-email-input");
    authorizeAdminEmail(input?.value)
      .then(() => {
        showToast(`已授权 ${normalizeEmail(input.value)} 登录后台`);
        input.value = "";
      })
      .catch((error) => showToast(error.message || "授权失败"));
    return;
  }

  if (text.includes("查看")) {
    openDialog(
      "后台交易监控",
      `<div class="detail-list">
        <p><strong>高风险提现：</strong>T202606030882</p>
        <p><strong>处理建议：</strong>进入风控中心复核用户身份与提现银行卡。</p>
      </div>`,
      "进入复核",
      () => {
        closeDialog();
        showToast("已进入风险复核流程");
      }
    );
  }
}

authButtons.forEach((button) => {
  button.addEventListener("click", () => loginAs(button.dataset.target));
});

logoutButton.addEventListener("click", logout);

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.classList.contains("auth-action") || button.id === "logout-button") return;
  const activeView = document.querySelector(".view.active");
  if (!activeView) return;
  if (button.closest("#action-overlay") || !activeView.contains(button)) return;

  if (activeView.id === "user-view") handleUserButton(button);
  if (activeView.id === "merchant-view") handleMerchantButton(button);
  if (activeView.id === "admin-view") handleAdminButton(button);
});

document.querySelectorAll(".module-card").forEach((card) => {
  card.addEventListener("click", () => {
    const title = card.querySelector("h2")?.textContent.trim() || "后台模块";
    const desc = card.querySelector("p")?.textContent.trim() || "模块详情";
    if (title === "财务报表") {
      document.querySelector("#admin-finance-report")?.scrollIntoView({ behavior: "smooth", block: "start" });
      loadFinanceReport()
        .then(() => showToast("财务报表已打开"))
        .catch((error) => showToast(error.message || "财务报表加载失败"));
      return;
    }
    if (title === "风控中心") {
      document.querySelector("#admin-risk-center")?.scrollIntoView({ behavior: "smooth", block: "start" });
      loadRiskCenter()
        .then(() => showToast("风控中心已打开"))
        .catch((error) => showToast(error.message || "风控中心加载失败"));
      return;
    }
    openDialog(title, `<p class="dialog-note">${desc}</p>`, "打开模块", () => {
      closeDialog();
      showToast(`${title}已打开`);
    });
  });
});

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user || !activeRole) return;
  if (activeRole === "admin") {
    const allowed = await isAuthorizedAdmin(user);
    if (!allowed) {
      activeRole = "";
      currentUser = null;
      sessionStorage.removeItem("activeRole");
      await signOut(auth);
      showOnlyView("");
      appShell.classList.add("locked");
      loginGateway.classList.remove("hidden");
      currentRole.textContent = "未登录";
      roleName.textContent = "-";
      showToast("后台登录被拒绝：该 Google 账号未获授权");
      return;
    }
  }
  enterRole(activeRole);
  if (activeRole === "user") await attachWallet(user);
  if (activeRole === "merchant") await attachMerchant(user);
});
