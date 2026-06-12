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

function formatMoney(amount) {
  return `RM ${Number(amount || 0).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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
                <td><button class="text-action merchant-order-action" data-order-id="${order.id}" data-action="view">查看</button></td>
              </tr>
            `
          )
          .join("")
      : '<tr><td colspan="6">暂无订单</td></tr>';
  }

  renderList("#merchant-refunds-list", refunds, "暂无退款申请", (item) => `<li><span>${item.id}</span><strong>${formatMoney(item.amount || 0)}</strong><button>审核</button></li>`);
  renderList("#merchant-settlements-list", [{ amount: settlementBalance }], "暂无待结算余额", (item) => `<li><span>待结算余额</span><strong>${formatMoney(item.amount || 0)}</strong><button id="merchant-settlement-button" type="button">申请</button></li>`);
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
          <td>${formatMoney(request.amount || 0)}</td>
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
  const requestId = `${currentUser.uid}-${Date.now()}`;
  await setDoc(doc(db, "rechargeRequests", requestId), {
    userId: currentUser.uid,
    email: currentUser.email,
    displayName: currentUser.displayName || "",
    amount,
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

  await Promise.all([loadRechargeRequests(), loadAdminUsers()]);
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
  if (amountInput) amountInput.value = payment.amount ? payment.amount.toFixed(2) : "";
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
      `<label class="field-label">充值金额</label>
       <input class="dialog-input" id="recharge-amount" value="100.00" />
       <p class="dialog-note">充值会先提交给后台审批，审批通过后余额才会增加。</p>`,
      "提交申请",
      async () => {
        const amount = parseAmount(document.querySelector("#recharge-amount").value);
        if (!amount) {
          showToast("请输入正确的充值金额");
          return;
        }
        await submitRechargeRequest(amount);
        closeDialog();
        showToast(`充值申请已提交：${formatMoney(amount)}`);
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
       <label class="field-label">付款金额</label>
       <input class="dialog-input" id="pay-amount" value="" placeholder="请输入金额" />`,
      "确认付款",
      confirmScanPayment
    );
    document.querySelector("#start-scanner").addEventListener("click", startScanner);
    document.querySelector("#use-demo-code").addEventListener("click", () => {
      fillPaymentForm({
        kind: "merchant",
        merchant: "MY Coffee",
        amount: 12.8,
        code: "oneminpay://pay?merchant=MY%20Coffee&amount=12.80",
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
      `<label class="field-label">固定金额</label>
       <input class="dialog-input" id="merchant-dynamic-amount" placeholder="留空为任意金额" />
       <p class="dialog-note">用户扫码后会自动带入商家信息，填写金额后可直接付款。</p>`,
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
    openDialog(
      "订单详情",
      `<div class="detail-list">
        <p><strong>订单号：</strong>${order?.id || "-"}</p>
        <p><strong>顾客：</strong>${order?.customer || "-"}</p>
        <p><strong>金额：</strong>${formatMoney(order?.amount || 0)}</p>
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
      `<p class="dialog-note">本次申请结算 ${formatMoney(amount)}，原型会生成结算记录并清空待结算余额。</p>`,
      "提交结算",
      async () => {
        const settlement = {
          id: `S${Date.now()}`,
          amount,
          status: "pending",
          time: "刚刚",
          createdAt: new Date().toISOString(),
        };
        await setDoc(
          merchantRef(),
          {
            settlementBalance: 0,
            settlements: [settlement, ...(currentMerchant?.settlements || [])].slice(0, 20),
            notifications: [{ text: `结算 ${settlement.id} 已提交`, time: "刚刚" }, ...(currentMerchant?.notifications || [])].slice(0, 20),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        closeDialog();
        showToast("结算申请已提交");
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
        <p><strong>金额：</strong>RM 68.20</p>
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
      `<p class="dialog-note">订单 M20260603002 申请退款 RM 31.00。</p>`,
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
      `<p class="dialog-note">今日待结算金额 RM 12,900，将提交到绑定银行卡。</p>`,
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

  if (button.id === "refresh-merchants-button") {
    loadMerchants()
      .then(() => showToast("商家列表已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
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
