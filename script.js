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
const DEFAULT_SYSTEM_CONFIG = {
  pointsPerMyr: 100,
  merchantFeeRate: "0.60%",
  dailyTransactionLimit: 400000,
  maintenanceMode: false,
  rechargeEnabled: true,
  withdrawEnabled: true,
  noticeTemplate: "您的交易已处理完成",
  riskHandledIds: [],
};
const ADMIN_MODULES = {
  users: "用户管理",
  merchants: "商家管理",
  transactions: "交易管理",
  funds: "充值/提现管理",
  refunds: "退款管理",
  settlements: "结算管理",
  finance: "财务报表",
  risk: "风控中心",
  kyc: "实名认证/KYC 审核",
  permissions: "权限管理",
  logs: "操作日志",
  marketing: "公告/活动/优惠券管理",
  support: "客服工单",
  config: "系统配置",
};
const ADMIN_ROLE_PRESETS = {
  owner: Object.keys(ADMIN_MODULES),
  ops: ["users", "merchants", "transactions", "funds", "refunds", "settlements", "kyc", "marketing"],
  finance: ["transactions", "funds", "refunds", "settlements", "finance"],
  risk: ["users", "transactions", "risk", "kyc"],
  support: ["users", "transactions", "refunds", "kyc", "support"],
};
const MODULE_PERMISSION_BY_TITLE = Object.fromEntries(Object.entries(ADMIN_MODULES).map(([key, title]) => [title, key]));

let activeRole = sessionStorage.getItem("activeRole") || "";
let currentUser = null;
let currentAdminProfile = null;
let walletUnsubscribe = null;
let merchantUnsubscribe = null;
let scannerStream = null;
let scannerTimer = null;
let dynamicQrId = 6130;
let toastTimer;
let walletBalance = 0;
let walletStatus = "active";
let walletKycStatus = "unsubmitted";
let usedCouponIds = [];
let dailyUsage = { date: "", amount: 0 };
let merchantStatus = "pending";
let currentMerchant = null;
let userTransactions = [];
let adminUsersCache = [];
let merchantsCache = [];
let rechargeRequestsCache = [];
let withdrawalRequestsCache = [];
let refundRequestsCache = [];
let settlementRequestsCache = [];
let kycRequestsCache = [];
let adminTransactionsCache = [];
let financeReportRowsCache = [];
let financeReportMetricsCache = {};
let riskAlertsCache = [];
let permissionAdminsCache = [];
let auditLogsCache = [];
let marketingItemsCache = [];
let supportTicketsCache = [];
let systemConfig = { ...DEFAULT_SYSTEM_CONFIG };
let userTransactionFilter = "all";
let adminTransactionFilter = "all";
let auditLogFilter = { module: "all", result: "all" };

function formatMoney(amount) {
  return `${Math.round(Number(amount || 0)).toLocaleString("en-MY")} 积分`;
}

function formatRM(amount) {
  return `RM ${Number(amount || 0).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportMerchantOrdersCsv() {
  const orders = Array.isArray(currentMerchant?.orders) ? currentMerchant.orders : [];
  if (!orders.length) {
    showToast("暂无订单可导出");
    return;
  }
  const rows = [
    ["订单号", "顾客", "积分", "原始积分", "优惠积分", "优惠券", "状态", "创建时间"],
    ...orders.map((order) => [
      order.id || "",
      order.customer || order.customerId || "",
      Math.round(Number(order.amount || 0)),
      Math.round(Number(order.originalAmount || order.amount || 0)),
      Math.round(Number(order.discount || 0)),
      order.couponTitle || order.couponId || "",
      order.status || "",
      order.createdAt || "",
    ]),
  ];
  downloadCsv(`merchant-orders-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  showToast("订单 CSV 已导出");
}

function exportFinanceReportCsv() {
  const rows = financeReportRowsCache || [];
  if (!rows.length) {
    showToast("No finance rows to export");
    return;
  }
  const metrics = financeReportMetricsCache || {};
  const csvRows = [
    ["Section", "Points", "RM", "Count", "Note"],
    ["Recharge total", Math.round(Number(metrics.rechargeTotal || 0)), pointsToMyr(metrics.rechargeTotal || 0), "", ""],
    ["Withdrawal total", Math.round(Number(metrics.withdrawTotal || 0)), pointsToMyr(metrics.withdrawTotal || 0), "", ""],
    ["Merchant sales", Math.round(Number(metrics.merchantSales || 0)), pointsToMyr(metrics.merchantSales || 0), "", ""],
    ["Platform fee", Math.round(Number(metrics.platformFee || 0)), pointsToMyr(metrics.platformFee || 0), "", ""],
    [],
    ...rows.map((row) => [
      row.name || "",
      Math.round(Number(row.points || 0)),
      pointsToMyr(row.points || 0),
      row.count || 0,
      row.note || "",
    ]),
  ];
  downloadCsv(`finance-report-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
  showToast("Finance CSV exported");
}

function exportAdminTransactionsCsv() {
  const rows = adminTransactionsCache
    .filter((item) => adminTransactionFilter === "all" || item.sourceType === adminTransactionFilter)
    .map((item) => normalizeTransactionRow(item));
  if (!rows.length) {
    showToast("No transactions to export");
    return;
  }
  downloadCsv(
    `admin-transactions-${adminTransactionFilter}-${new Date().toISOString().slice(0, 10)}.csv`,
    [
      ["ID", "Account", "Type", "Amount", "Source", "Status", "Created at", "Detail"],
      ...rows.map((row) => [row.id, row.account, row.type, row.amount, row.source, row.status, row.createdAt, row.detail]),
    ]
  );
  showToast("Transaction CSV exported");
}

function myrToPoints(amount) {
  return Math.round(Number(amount || 0) * Number(systemConfig.pointsPerMyr || DEFAULT_SYSTEM_CONFIG.pointsPerMyr));
}

function pointsToMyr(points) {
  return Number(points || 0) / Number(systemConfig.pointsPerMyr || DEFAULT_SYSTEM_CONFIG.pointsPerMyr);
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

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getDailyUsageAmount(usage = dailyUsage) {
  return usage?.date === todayKey() ? Number(usage.amount || 0) : 0;
}

function nextDailyUsage(usage, amount) {
  return {
    date: todayKey(),
    amount: getDailyUsageAmount(usage) + Math.round(Number(amount || 0)),
  };
}

function assertDailyLimit(amount, usage = dailyUsage) {
  const limit = Math.round(Number(systemConfig.dailyTransactionLimit || 0));
  const nextAmount = getDailyUsageAmount(usage) + Math.round(Number(amount || 0));
  if (limit > 0 && nextAmount > limit) {
    throw new Error(`超过每日交易限额：今日已用 ${formatMoney(getDailyUsageAmount(usage))}，本次 ${formatMoney(amount)}，限额 ${formatMoney(limit)}`);
  }
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

function updateSystemStatus() {
  const pill = document.querySelector(".status-pill");
  if (!pill) return;
  pill.textContent = systemConfig.maintenanceMode ? "系统维护中" : "系统运行正常";
  pill.classList.toggle("warning", Boolean(systemConfig.maintenanceMode));
}

function renderSystemConfig() {
  setText("#config-rate-summary", `${systemConfig.pointsPerMyr} 积分/RM`);
  setText("#config-fee-summary", systemConfig.merchantFeeRate || DEFAULT_SYSTEM_CONFIG.merchantFeeRate);
  setText("#config-limit-summary", formatMoney(systemConfig.dailyTransactionLimit || 0));
  setText("#config-maintenance-summary", systemConfig.maintenanceMode ? "开启" : "关闭");

  const fields = {
    "#config-points-rate": systemConfig.pointsPerMyr,
    "#config-merchant-fee": systemConfig.merchantFeeRate,
    "#config-daily-limit": systemConfig.dailyTransactionLimit,
    "#config-notice-template": systemConfig.noticeTemplate,
  };
  Object.entries(fields).forEach(([selector, value]) => {
    const node = document.querySelector(selector);
    if (node) node.value = value ?? "";
  });
  const maintenance = document.querySelector("#config-maintenance");
  if (maintenance) maintenance.value = systemConfig.maintenanceMode ? "on" : "off";
  const recharge = document.querySelector("#config-recharge-enabled");
  if (recharge) recharge.value = systemConfig.rechargeEnabled ? "on" : "off";
  const withdraw = document.querySelector("#config-withdraw-enabled");
  if (withdraw) withdraw.value = systemConfig.withdrawEnabled ? "on" : "off";
  updateSystemStatus();
}

async function loadSystemConfig() {
  const snap = await getDoc(doc(db, "systemConfig", "main"));
  systemConfig = { ...DEFAULT_SYSTEM_CONFIG, ...(snap.exists() ? snap.data() : {}) };
  renderSystemConfig();
}

async function saveSystemConfig() {
  const nextConfig = {
    pointsPerMyr: Math.max(1, Math.round(parseAmount(document.querySelector("#config-points-rate")?.value) || DEFAULT_SYSTEM_CONFIG.pointsPerMyr)),
    merchantFeeRate: document.querySelector("#config-merchant-fee")?.value.trim() || DEFAULT_SYSTEM_CONFIG.merchantFeeRate,
    dailyTransactionLimit: Math.max(0, Math.round(parseAmount(document.querySelector("#config-daily-limit")?.value) || 0)),
    maintenanceMode: document.querySelector("#config-maintenance")?.value === "on",
    rechargeEnabled: document.querySelector("#config-recharge-enabled")?.value !== "off",
    withdrawEnabled: document.querySelector("#config-withdraw-enabled")?.value !== "off",
    noticeTemplate: document.querySelector("#config-notice-template")?.value.trim() || DEFAULT_SYSTEM_CONFIG.noticeTemplate,
    updatedBy: currentUser.email,
    updatedAt: serverTimestamp(),
  };
  await setDoc(doc(db, "systemConfig", "main"), nextConfig, { merge: true });
  systemConfig = { ...DEFAULT_SYSTEM_CONFIG, ...nextConfig };
  renderSystemConfig();
  logAuditSafe({
    module: "系统配置",
    action: "保存系统配置",
    target: "systemConfig/main",
    detail: `兑换比例 ${nextConfig.pointsPerMyr}，费率 ${nextConfig.merchantFeeRate}`,
  });
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
  if (isOwnerAdmin(user)) {
    currentAdminProfile = {
      email: normalizeEmail(user.email),
      enabled: true,
      role: "owner",
      permissions: ADMIN_ROLE_PRESETS.owner,
    };
    return true;
  }

  const adminSnap = await getDoc(adminUserRef(user.email));
  const data = adminSnap.data();
  const allowed = adminSnap.exists() && data?.enabled === true;
  currentAdminProfile = allowed
    ? {
        email: normalizeEmail(user.email),
        role: data.role || "ops",
        enabled: true,
        permissions: Array.isArray(data.permissions) ? data.permissions : ADMIN_ROLE_PRESETS[data.role || "ops"] || [],
      }
    : null;
  return allowed;
}

function hasAdminPermission(permission) {
  if (!permission) return true;
  if (isOwnerAdmin() || currentAdminProfile?.role === "owner") return true;
  return (currentAdminProfile?.permissions || []).includes(permission);
}

function requireAdminPermission(permission) {
  if (hasAdminPermission(permission)) return true;
  showToast(`权限不足：需要 ${ADMIN_MODULES[permission] || permission} 权限`);
  logAuditSafe({
    module: "权限管理",
    action: "权限拦截",
    target: ADMIN_MODULES[permission] || permission,
    detail: `管理员缺少 ${permission} 权限`,
    result: "blocked",
  });
  return false;
}

function applyAdminPermissions() {
  if (activeRole !== "admin") return;
  const sectionPermissions = {
    "#admin-user-management": "users",
    "#admin-merchant-management": "merchants",
    "#admin-recharge-management": "funds",
    "#admin-withdraw-management": "funds",
    "#admin-refund-management": "refunds",
    "#admin-settlement-management": "settlements",
    "#admin-finance-report": "finance",
    "#admin-risk-center": "risk",
    "#admin-kyc-management": "kyc",
    "#admin-permission-management": "permissions",
    "#admin-audit-log": "logs",
    "#admin-marketing-management": "marketing",
    "#admin-support-management": "support",
    "#admin-system-config": "config",
    "#admin-transaction-management": "transactions",
  };
  Object.entries(sectionPermissions).forEach(([selector, permission]) => {
    document.querySelector(selector)?.classList.toggle("hidden", !hasAdminPermission(permission));
  });
  document.querySelector(".admin-auth-panel")?.classList.toggle("hidden", !hasAdminPermission("permissions"));
  document.querySelectorAll(".module-card").forEach((card) => {
    const title = card.querySelector("h2")?.textContent.trim();
    const permission = MODULE_PERMISSION_BY_TITLE[title];
    if (permission) card.classList.toggle("hidden", !hasAdminPermission(permission));
  });
}

async function authorizeAdminEmail(email, role = "ops") {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw new Error("请输入正确的管理员邮箱");
  }
  if (!isOwnerAdmin()) {
    throw new Error("只有主后台账号可以授权其他管理员");
  }
  const nextRole = ADMIN_ROLE_PRESETS[role] ? role : "ops";

  await setDoc(adminUserRef(normalizedEmail), {
    email: normalizedEmail,
    enabled: true,
    role: nextRole,
    permissions: ADMIN_ROLE_PRESETS[nextRole],
    authorizedBy: currentUser.email,
    updatedAt: serverTimestamp(),
  }, { merge: true });
  logAuditSafe({
    module: "权限管理",
    action: "授权管理员",
    target: normalizedEmail,
    detail: `角色：${roleLabel(nextRole)}`,
  });
}

function emptyTransactionRow(message) {
  if (!userTransactionsBody) return;
  userTransactionsBody.innerHTML = `<tr><td colspan="5">${message}</td></tr>`;
}

function userTransactionMatchesFilter(item, filter = userTransactionFilter) {
  if (filter === "all") return true;
  const type = String(item.type || "");
  const amount = String(item.amount || "").trim();
  const text = `${type} ${item.target || ""} ${amount}`;
  if (filter === "refund") return text.includes("退款") || text.includes("閫€娆");
  if (filter === "receive") return amount.startsWith("+") || text.includes("收款") || text.includes("充值") || text.includes("鏀舵") || text.includes("鍏呭€");
  if (filter === "payment") return amount.startsWith("-") || text.includes("付款") || text.includes("支付") || text.includes("提现") || text.includes("浠樻") || text.includes("鎻愮幇");
  return true;
}

function renderUserTransactions(transactions = []) {
  if (!userTransactionsBody) return;
  const visibleTransactions = transactions.filter((item) => userTransactionMatchesFilter(item));
  if (!visibleTransactions.length) {
    emptyTransactionRow("当前账户暂无交易记录");
    return;
  }

  userTransactionsBody.innerHTML = visibleTransactions
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

function kycStatusLabel(status) {
  if (status === "approved") return '<span class="tag success">已实名</span>';
  if (status === "pending") return '<span class="tag warning">待审核</span>';
  if (status === "rejected") return '<span class="tag danger">已拒绝</span>';
  return '<span class="tag warning">未提交</span>';
}

function updateUserKycStatus(status = walletKycStatus) {
  walletKycStatus = status || "unsubmitted";
  const node = document.querySelector("#user-kyc-status");
  if (node) {
    const textMap = {
      approved: "实名状态：已通过",
      pending: "实名状态：待后台审核",
      rejected: "实名状态：已拒绝，请重新提交",
      unsubmitted: "实名状态：未提交",
    };
    node.textContent = textMap[walletKycStatus] || textMap.unsubmitted;
  }
  const button = document.querySelector("#submit-kyc-button");
  if (button) {
    button.textContent = walletKycStatus === "approved" ? "查看实名" : walletKycStatus === "pending" ? "查看申请" : "提交实名";
  }
}

function renderAdminUsers(users = []) {
  const body = document.querySelector("#admin-users-body");
  if (!body) return;
  if (!users.length) {
    body.innerHTML = '<tr><td colspan="6">暂无用户钱包数据</td></tr>';
    return;
  }

  body.innerHTML = users
    .map(
      (user) => `
        <tr>
          <td>${user.email || user.displayName || user.id}</td>
          <td>${formatMoney(user.balance || 0)}</td>
          <td>${kycStatusLabel(user.kycStatus)}</td>
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

function roleLabel(role) {
  const labels = {
    owner: "主后台",
    ops: "运营管理员",
    finance: "财务管理员",
    risk: "风控管理员",
    support: "客服管理员",
  };
  return labels[role] || role || "运营管理员";
}

function renderPermissionAdmins(admins = []) {
  const body = document.querySelector("#admin-permissions-body");
  if (!body) return;
  if (!admins.length) {
    body.innerHTML = '<tr><td colspan="5">暂无管理员权限数据</td></tr>';
    return;
  }

  body.innerHTML = admins
    .map((admin) => {
      const permissions = Array.isArray(admin.permissions) ? admin.permissions : ADMIN_ROLE_PRESETS[admin.role || "ops"] || [];
      const permissionText = admin.role === "owner" ? "全部权限" : permissions.map((item) => ADMIN_MODULES[item] || item).join("、");
      const locked = admin.role === "owner";
      return `
        <tr>
          <td>${admin.email || admin.id}</td>
          <td>${roleLabel(admin.role)}</td>
          <td>${admin.enabled ? '<span class="tag success">已启用</span>' : '<span class="tag danger">已停用</span>'}</td>
          <td>${permissionText || "-"}</td>
          <td>
            ${
              locked
                ? "-"
                : `<button class="text-action permission-action" data-action="edit" data-email="${admin.email}">编辑</button>
                   <button class="text-action permission-action" data-action="${admin.enabled ? "disable" : "enable"}" data-email="${admin.email}">
                    ${admin.enabled ? "停用" : "启用"}
                   </button>`
            }
          </td>
        </tr>
      `;
    })
    .join("");
}

function auditResultTag(result) {
  if (result === "success") return '<span class="tag success">成功</span>';
  if (result === "blocked") return '<span class="tag warning">拦截</span>';
  return '<span class="tag danger">失败</span>';
}

function auditLogMatchesFilter(log, filter = auditLogFilter) {
  const moduleMatch = filter.module === "all" || String(log.module || "") === filter.module;
  const resultMatch = filter.result === "all" || String(log.result || "success") === filter.result;
  return moduleMatch && resultMatch;
}

function getFilteredAuditLogs() {
  return auditLogsCache.filter((log) => auditLogMatchesFilter(log));
}

function exportAuditLogsCsv() {
  const logs = getFilteredAuditLogs();
  if (!logs.length) {
    showToast("No audit logs to export");
    return;
  }
  downloadCsv(
    `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`,
    [
      ["ID", "Time", "Actor", "Role", "Module", "Action", "Target", "Result", "Detail", "Created at"],
      ...logs.map((log) => [
        log.id || "",
        log.time || "",
        log.actor || "",
        log.actorRole || "",
        log.module || "",
        log.action || "",
        log.target || "",
        log.result || "success",
        log.detail || "",
        log.createdAt || "",
      ]),
    ]
  );
  showToast("Audit CSV exported");
}

function renderAuditLogs(logs = []) {
  const body = document.querySelector("#admin-audit-body");
  if (!body) return;
  const visibleLogs = logs.filter((log) => auditLogMatchesFilter(log));
  if (!visibleLogs.length) {
    body.innerHTML = '<tr><td colspan="7">暂无操作日志</td></tr>';
    return;
  }

  body.innerHTML = visibleLogs
    .slice(0, 120)
    .map(
      (log) => `
        <tr>
          <td>${log.time || "-"}</td>
          <td>${log.actor || "-"}</td>
          <td>${log.module || "-"}</td>
          <td>${log.action || "-"}</td>
          <td>${log.target || "-"}</td>
          <td>${auditResultTag(log.result || "success")}</td>
          <td><button class="text-action audit-action" data-log-id="${log.id}">查看</button></td>
        </tr>
      `
    )
    .join("");
}

function marketingTypeLabel(type) {
  const labels = { notice: "公告", campaign: "活动", coupon: "优惠券" };
  return labels[type] || type || "-";
}

function isMarketingItemValid(item) {
  if (!item?.validUntil) return true;
  const end = new Date(`${item.validUntil}T23:59:59`);
  return Number.isNaN(end.getTime()) || end >= new Date();
}

function renderUserMarketing(items = []) {
  const visibleItems = items.filter(
    (item) => item.status === "published" && isMarketingItemValid(item) && (item.type !== "coupon" || !usedCouponIds.includes(item.id))
  );
  renderList(
    "#user-marketing-list",
    visibleItems,
    "暂无公告或优惠券",
    (item) => `<li><span>${marketingTypeLabel(item.type)} · ${item.title}</span><strong>${item.type === "coupon" ? `可抵 ${formatMoney(item.discount || 0)}` : item.badge || "查看"}</strong></li>`
  );
}

function getAvailableCoupons() {
  return marketingItemsCache.filter(
    (item) => item.type === "coupon" && item.status === "published" && isMarketingItemValid(item) && !usedCouponIds.includes(item.id)
  );
}

function couponSelectMarkup() {
  const coupons = getAvailableCoupons();
  if (!coupons.length) {
    return `<label class="field-label">优惠券</label>
      <select class="dialog-input" id="pay-coupon" disabled><option value="">暂无可用优惠券</option></select>`;
  }
  return `<label class="field-label">优惠券</label>
    <select class="dialog-input" id="pay-coupon">
      <option value="">不使用优惠券</option>
      ${coupons.map((item) => `<option value="${item.id}">${item.title}：抵扣 ${formatMoney(item.discount || 0)}</option>`).join("")}
    </select>`;
}

function renderMarketingItems(items = []) {
  const body = document.querySelector("#admin-marketing-body");
  if (!body) return;
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="6">暂无公告活动优惠券</td></tr>';
    return;
  }

  body.innerHTML = items
    .map(
      (item) => `
        <tr>
          <td>${item.title || "-"}</td>
          <td>${marketingTypeLabel(item.type)}</td>
          <td>${item.type === "coupon" ? formatMoney(item.discount || 0) : item.badge || "-"}</td>
          <td>${item.status === "published" ? '<span class="tag success">已发布</span>' : item.status === "paused" ? '<span class="tag danger">已停用</span>' : '<span class="tag warning">草稿</span>'}</td>
          <td>${item.validUntil || "-"}</td>
          <td>
            <button class="text-action marketing-action" data-action="view" data-item-id="${item.id}">查看</button>
            ${
              item.status === "published"
                ? `<button class="text-action marketing-action" data-action="pause" data-item-id="${item.id}">停用</button>`
                : `<button class="text-action marketing-action" data-action="publish" data-item-id="${item.id}">发布</button>`
            }
          </td>
        </tr>
      `
    )
    .join("");
}

function openMarketingEditor() {
  openDialog(
    "新建公告/活动/优惠券",
    `<label class="field-label">类型</label>
     <select class="dialog-input" id="marketing-type">
       <option value="notice">公告</option>
       <option value="campaign">活动</option>
       <option value="coupon">优惠券</option>
     </select>
     <label class="field-label">标题</label>
     <input class="dialog-input" id="marketing-title" placeholder="例如：周末积分返利活动" />
     <label class="field-label">内容说明</label>
     <input class="dialog-input" id="marketing-description" placeholder="展示给用户的说明" />
     <label class="field-label">优惠积分</label>
     <input class="dialog-input" id="marketing-discount" value="500" />
     <label class="field-label">有效期</label>
     <input class="dialog-input" id="marketing-valid-until" value="2026-12-31" />
     <p class="dialog-note">公告和活动可把优惠积分留作标签展示；优惠券会作为用户可领取/可用金额展示。</p>`,
    "保存草稿",
    async () => {
      const type = document.querySelector("#marketing-type").value;
      const title = document.querySelector("#marketing-title").value.trim();
      const description = document.querySelector("#marketing-description").value.trim();
      const discount = Math.round(parseAmount(document.querySelector("#marketing-discount").value) || 0);
      const validUntil = document.querySelector("#marketing-valid-until").value.trim();
      if (!title || !description) {
        showToast("请填写标题和说明");
        return;
      }
      try {
        await createMarketingItem({
          type,
          title,
          description,
          discount: type === "coupon" ? discount : 0,
          badge: type === "coupon" ? "优惠券" : type === "campaign" ? "活动" : "公告",
          validUntil,
        });
        closeDialog();
        showToast("营销内容草稿已创建");
      } catch (error) {
        showToast(error.message || "创建失败");
      }
    }
  );
}

async function loadMarketingItems() {
  const body = document.querySelector("#admin-marketing-body");
  if (body) body.innerHTML = '<tr><td colspan="6">正在加载公告活动优惠券...</td></tr>';

  const snapshot = await getDocs(collection(db, "marketingItems"));
  marketingItemsCache = snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  renderMarketingItems(marketingItemsCache);
  renderUserMarketing(marketingItemsCache);
}

async function createMarketingItem(data) {
  const itemId = `MKT${Date.now()}`;
  await setDoc(doc(db, "marketingItems", itemId), {
    ...data,
    id: itemId,
    status: "draft",
    createdBy: currentUser.email,
    createdAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
  });
  logAuditSafe({
    module: "公告/活动/优惠券管理",
    action: "新建营销内容",
    target: itemId,
    detail: `${marketingTypeLabel(data.type)} / ${data.title}`,
  });
  await loadMarketingItems();
}

async function updateMarketingStatus(itemId, status) {
  const item = marketingItemsCache.find((entry) => entry.id === itemId);
  await setDoc(
    doc(db, "marketingItems", itemId),
    {
      status,
      updatedBy: currentUser.email,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  logAuditSafe({
    module: "公告/活动/优惠券管理",
    action: status === "published" ? "发布营销内容" : "停用营销内容",
    target: itemId,
    detail: item?.title || "-",
  });
  await loadMarketingItems();
}

function ticketStatusLabel(status) {
  if (status === "open") return '<span class="tag warning">待处理</span>';
  if (status === "processing") return '<span class="tag warning">处理中</span>';
  if (status === "closed") return '<span class="tag success">已关闭</span>';
  return '<span class="tag warning">待处理</span>';
}

function ticketTypeLabel(type) {
  const labels = {
    complaint: "投诉",
    refund: "退款争议",
    account: "账户问题",
    payment: "支付问题",
    other: "其他",
  };
  return labels[type] || type || "其他";
}

function renderUserTickets(tickets = []) {
  const ownTickets = tickets.filter((ticket) => ticket.userId === currentUser?.uid);
  renderList(
    "#user-ticket-list",
    ownTickets,
    "No support tickets",
    (ticket) => {
      const statusText = ticket.status === "closed" ? "Closed" : ticket.status === "processing" ? "Processing" : "Open";
      const replyButton = ticket.status === "closed" ? "" : `<button class="text-action user-ticket-action" data-action="reply" data-ticket-id="${ticket.id}" type="button">Reply</button>`;
      return `<li>
        <span>${ticketTypeLabel(ticket.type)} - ${ticket.title}</span>
        <strong>${statusText}</strong>
        <button class="text-action user-ticket-action" data-action="view" data-ticket-id="${ticket.id}" type="button">View</button>
        ${replyButton}
      </li>`;
    }
  );
}

function renderSupportTickets(tickets = []) {
  const body = document.querySelector("#admin-support-body");
  if (!body) return;
  if (!tickets.length) {
    body.innerHTML = '<tr><td colspan="6">暂无客服工单</td></tr>';
    return;
  }

  body.innerHTML = tickets
    .map(
      (ticket) => `
        <tr>
          <td>${ticket.id}</td>
          <td>${ticket.email || ticket.userId}</td>
          <td>${ticketTypeLabel(ticket.type)}</td>
          <td>${ticket.title || "-"}</td>
          <td>${ticketStatusLabel(ticket.status || "open")}</td>
          <td>
            <button class="text-action support-action" data-action="view" data-ticket-id="${ticket.id}">查看</button>
            ${
              ticket.status === "open"
                ? `<button class="text-action support-action" data-action="assign" data-ticket-id="${ticket.id}">接单</button>`
                : ""
            }
            ${
              ticket.status !== "closed"
                ? `<button class="text-action support-action" data-action="reply" data-ticket-id="${ticket.id}">回复</button>
                   <button class="text-action support-action" data-action="close" data-ticket-id="${ticket.id}">关闭</button>`
                : "-"
            }
          </td>
        </tr>
      `
    )
    .join("");
}

async function loadSupportTickets() {
  const body = document.querySelector("#admin-support-body");
  if (body) body.innerHTML = '<tr><td colspan="6">正在加载客服工单...</td></tr>';

  const snapshot = await getDocs(collection(db, "supportTickets"));
  supportTicketsCache = snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  renderSupportTickets(supportTicketsCache);
  renderUserTickets(supportTicketsCache);
}

async function createSupportTicket(data) {
  const ticketId = `TK${Date.now()}`;
  await setDoc(doc(db, "supportTickets", ticketId), {
    ...data,
    id: ticketId,
    userId: currentUser.uid,
    email: currentUser.email,
    displayName: currentUser.displayName || "",
    status: "open",
    replies: [],
    time: "刚刚",
    createdAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
  });
  await loadSupportTickets();
}

async function updateSupportTicket(ticketId, patch, auditAction = "更新客服工单") {
  const ticket = supportTicketsCache.find((item) => item.id === ticketId);
  await setDoc(
    doc(db, "supportTickets", ticketId),
    {
      ...patch,
      updatedBy: currentUser.email,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  logAuditSafe({
    module: "客服工单",
    action: auditAction,
    target: ticketId,
    detail: ticket?.title || "-",
  });
  await loadSupportTickets();
}

async function addUserSupportReply(ticket, message) {
  if (!ticket || ticket.userId !== currentUser?.uid) throw new Error("Ticket not found");
  if (ticket.status === "closed") throw new Error("This ticket is already closed");
  const replies = [
    ...(ticket.replies || []),
    {
      by: currentUser.email,
      role: "user",
      text: message,
      time: "just now",
      createdAt: new Date().toISOString(),
    },
  ];
  await setDoc(
    doc(db, "supportTickets", ticket.id),
    {
      status: ticket.status === "open" ? "open" : "processing",
      replies,
      lastReplyBy: currentUser.email,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  await loadSupportTickets();
}

function openSupportReply(ticket) {
  openDialog(
    "回复客服工单",
    `<p class="dialog-note">${ticket.title || "-"}</p>
     <label class="field-label">回复内容</label>
     <input class="dialog-input" id="support-reply" placeholder="输入处理结果或补充说明" />`,
    "提交回复",
    async () => {
      const reply = document.querySelector("#support-reply").value.trim();
      if (!reply) {
        showToast("请输入回复内容");
        return;
      }
      const replies = [
        { by: currentUser.email, text: reply, time: "刚刚", createdAt: new Date().toISOString() },
        ...(ticket.replies || []),
      ].slice(0, 20);
      try {
        await updateSupportTicket(ticket.id, { status: "processing", replies }, "回复客服工单");
        closeDialog();
        showToast("工单回复已提交");
      } catch (error) {
        showToast(error.message || "回复失败");
      }
    }
  );
}

async function loadAuditLogs() {
  const body = document.querySelector("#admin-audit-body");
  if (body) body.innerHTML = '<tr><td colspan="7">正在加载操作日志...</td></tr>';

  const snapshot = await getDocs(collection(db, "auditLogs"));
  auditLogsCache = snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  renderAuditLogs(auditLogsCache);
}

async function writeAuditLog({ module, action, target = "-", detail = "-", result = "success" }) {
  if (!currentUser?.email || activeRole !== "admin") return;
  const logId = `L${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await setDoc(doc(db, "auditLogs", logId), {
    actor: currentUser.email,
    actorRole: currentAdminProfile?.role || (isOwnerAdmin() ? "owner" : "admin"),
    module,
    action,
    target,
    detail,
    result,
    time: "刚刚",
    createdAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
  });
}

function logAuditSafe(payload) {
  writeAuditLog(payload)
    .then(() => {
      if (hasAdminPermission("logs")) loadAuditLogs().catch(() => {});
    })
    .catch(() => {});
}

async function loadPermissionAdmins() {
  const body = document.querySelector("#admin-permissions-body");
  if (body) body.innerHTML = '<tr><td colspan="5">正在加载管理员权限...</td></tr>';

  const snapshot = await getDocs(collection(db, "adminUsers"));
  const owner = {
    id: normalizeEmail(OWNER_ADMIN_EMAIL),
    email: normalizeEmail(OWNER_ADMIN_EMAIL),
    role: "owner",
    enabled: true,
    permissions: ADMIN_ROLE_PRESETS.owner,
  };
  const admins = snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter((item) => normalizeEmail(item.email || item.id) !== normalizeEmail(OWNER_ADMIN_EMAIL));
  permissionAdminsCache = [owner, ...admins];
  renderPermissionAdmins(permissionAdminsCache);
}

async function updateAdminAccess(email, patch) {
  if (!isOwnerAdmin()) throw new Error("只有主后台账号可以修改权限");
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || normalizedEmail === normalizeEmail(OWNER_ADMIN_EMAIL)) throw new Error("不能修改主后台账号");
  await setDoc(
    adminUserRef(normalizedEmail),
    {
      email: normalizedEmail,
      ...patch,
      updatedBy: currentUser.email,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  await loadPermissionAdmins();
  logAuditSafe({
    module: "权限管理",
    action: "修改管理员权限",
    target: normalizedEmail,
    detail: JSON.stringify(patch),
  });
}

function openPermissionEditor(admin) {
  const currentPermissions = Array.isArray(admin.permissions) ? admin.permissions : ADMIN_ROLE_PRESETS[admin.role || "ops"] || [];
  const moduleChecks = Object.entries(ADMIN_MODULES)
    .filter(([key]) => key !== "permissions")
    .map(
      ([key, label]) => `
        <label class="check-row">
          <input type="checkbox" class="permission-check" value="${key}" ${currentPermissions.includes(key) ? "checked" : ""} />
          <span>${label}</span>
        </label>
      `
    )
    .join("");
  openDialog(
    "编辑权限",
    `<label class="field-label">管理员邮箱</label>
     <input class="dialog-input" value="${admin.email}" disabled />
     <label class="field-label">角色</label>
     <select class="dialog-input" id="permission-role">
       <option value="ops" ${admin.role === "ops" ? "selected" : ""}>运营管理员</option>
       <option value="finance" ${admin.role === "finance" ? "selected" : ""}>财务管理员</option>
       <option value="risk" ${admin.role === "risk" ? "selected" : ""}>风控管理员</option>
       <option value="support" ${admin.role === "support" ? "selected" : ""}>客服管理员</option>
     </select>
     <div class="check-grid">${moduleChecks}</div>`,
    "保存权限",
    async () => {
      const role = document.querySelector("#permission-role").value;
      const permissions = [...document.querySelectorAll(".permission-check:checked")].map((item) => item.value);
      try {
        await updateAdminAccess(admin.email, { role, permissions, enabled: true });
        closeDialog();
        showToast("管理员权限已更新");
      } catch (error) {
        showToast(error.message || "权限更新失败");
      }
    }
  );
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
  renderList(
    "#merchant-profile-list",
    [
      { label: "Business", value: data.businessName || data.displayName || "-" },
      { label: "Contact", value: [data.contactName, data.contactPhone].filter(Boolean).join(" / ") || "-" },
      { label: "Address", value: data.businessAddress || "-" },
      { label: "Settlement", value: [data.settlementBank, data.settlementAccount].filter(Boolean).join(" / ") || "-" },
      { label: "Status", value: data.status || "pending" },
    ],
    "No merchant profile",
    (item) => `<li><span>${item.label}</span><strong>${item.value}</strong></li>`
  );

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

async function payMerchant(merchantId, merchantName, amount, coupon = null) {
  const payerRef = walletRef();
  const merchantDocRef = doc(db, "merchants", merchantId);
  const orderId = `M${Date.now()}`;
  const discount = Math.min(Number(coupon?.discount || 0), amount);
  const payableAmount = Math.max(0, amount - discount);
  const couponText = coupon ? `，优惠 ${formatMoney(discount)}` : "";
  const payerTx = transactionItem("商家付款", merchantName, `- ${formatMoney(payableAmount)}${couponText}`);

  await runTransaction(db, async (transaction) => {
    const payerSnap = await transaction.get(payerRef);
    const merchantSnap = await transaction.get(merchantDocRef);
    if (!merchantSnap.exists()) throw new Error("商家不存在");

    const payerData = payerSnap.data() || {};
    const merchantData = merchantSnap.data() || {};
    if (merchantData.status !== "approved") throw new Error("商家未通过审核，无法收款");

    const payerBalance = Number(payerData.balance || 0);
    const latestUsedCoupons = Array.isArray(payerData.usedCouponIds) ? payerData.usedCouponIds : [];
    if (coupon?.id && latestUsedCoupons.includes(coupon.id)) throw new Error("该优惠券已使用");
    if (payableAmount > payerBalance) throw new Error("钱包余额不足");

    assertDailyLimit(payableAmount, payerData.dailyUsage);

    const order = {
      id: orderId,
      customerId: currentUser.uid,
      customer: currentUser.email,
      amount: payableAmount,
      originalAmount: amount,
      discount,
      couponId: coupon?.id || "",
      couponTitle: coupon?.title || "",
      status: "approved",
      createdAt: new Date().toISOString(),
    };
    const merchantTx = transactionItem("QR收款", currentUser.email, `+ ${formatMoney(payableAmount)}`);
    const notification = { text: `订单 ${orderId} 支付成功${coupon ? `，优惠 ${formatMoney(discount)}` : ""}`, time: "刚刚", createdAt: new Date().toISOString() };

    transaction.set(
      payerRef,
      {
        balance: payerBalance - payableAmount,
        dailyUsage: nextDailyUsage(payerData.dailyUsage, payableAmount),
        usedCouponIds: coupon?.id ? [coupon.id, ...latestUsedCoupons].slice(0, 100) : latestUsedCoupons,
        transactions: [payerTx, ...(payerData.transactions || [])].slice(0, 30),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    transaction.set(
      merchantDocRef,
      {
        totalReceived: Number(merchantData.totalReceived || 0) + payableAmount,
        settlementBalance: Number(merchantData.settlementBalance || 0) + payableAmount,
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
    contactName: user.displayName || "",
    contactPhone: "",
    businessAddress: "",
    settlementBank: "",
    settlementAccount: "",
    status: "pending",
    feeRate: systemConfig.merchantFeeRate || DEFAULT_SYSTEM_CONFIG.merchantFeeRate,
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
  logAuditSafe({
    module: "商家管理",
    action: "更新商家状态",
    target: merchantId,
    detail: `状态：${status}`,
  });
}

async function updateOwnMerchantProfile(profile) {
  if (!currentUser || activeRole !== "merchant") throw new Error("Please login as merchant");
  await setDoc(
    merchantRef(),
    {
      businessName: profile.businessName,
      contactName: profile.contactName,
      contactPhone: profile.contactPhone,
      businessAddress: profile.businessAddress,
      settlementBank: profile.settlementBank,
      settlementAccount: profile.settlementAccount,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
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
  logAuditSafe({
    module: "充值/提现管理",
    action: approved ? "通过充值申请" : "拒绝充值申请",
    target: requestId,
    detail: `${request.email || request.userId} / ${formatMoney(request.amount || 0)}`,
  });
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
  const requestRef = doc(db, "withdrawRequests", requestId);
  const userWalletRef = walletRef();
  const requestData = {
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
  };

  await runTransaction(db, async (transaction) => {
    const walletSnap = await transaction.get(userWalletRef);
    const walletData = walletSnap.data() || {};
    const latestStatus = walletData.status || walletStatus;
    const latestBalance = Number(walletData.balance || 0);

    if (latestStatus === "frozen") throw new Error("账户已被冻结，无法提交提现申请");
    if (amount > latestBalance) throw new Error("钱包余额不足，无法提交提现申请");
    assertDailyLimit(amount, walletData.dailyUsage);

    transaction.set(requestRef, requestData);
    transaction.set(
      userWalletRef,
      {
        dailyUsage: nextDailyUsage(walletData.dailyUsage, amount),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
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
  logAuditSafe({
    module: "充值/提现管理",
    action: approved ? "通过提现申请" : "拒绝提现申请",
    target: requestId,
    detail: `${request.email || request.userId} / ${formatMoney(request.amount || 0)}`,
  });
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
  logAuditSafe({
    module: "退款管理",
    action: approved ? "通过退款申请" : "拒绝退款申请",
    target: requestId,
    detail: `${request.customerEmail || request.customerId} / ${formatMoney(request.amount || 0)}`,
  });
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
  logAuditSafe({
    module: "结算管理",
    action: approved ? "通过结算申请" : "拒绝结算申请",
    target: requestId,
    detail: `${request.merchantName || request.merchantId} / ${formatMoney(request.amount || 0)}`,
  });
}

function renderKycRequests(requests = []) {
  const body = document.querySelector("#admin-kyc-body");
  if (!body) return;
  if (!requests.length) {
    body.innerHTML = '<tr><td colspan="6">暂无实名申请</td></tr>';
    return;
  }

  body.innerHTML = requests
    .map(
      (request) => `
        <tr>
          <td>${request.email || request.userId}</td>
          <td>${request.fullName || "-"}</td>
          <td>${request.idNumber || "-"}</td>
          <td>${request.phone || "-"}</td>
          <td>${kycStatusLabel(request.status || "pending")}</td>
          <td>
            ${
              request.status === "pending"
                ? `<button class="text-action kyc-action" data-action="approve" data-request-id="${request.id}">通过</button>
                   <button class="text-action kyc-action" data-action="reject" data-request-id="${request.id}">拒绝</button>`
                : "-"
            }
          </td>
        </tr>
      `
    )
    .join("");
}

async function loadKycRequests() {
  const body = document.querySelector("#admin-kyc-body");
  if (body) body.innerHTML = '<tr><td colspan="6">正在加载实名申请...</td></tr>';

  const snapshot = await getDocs(collection(db, "kycRequests"));
  kycRequestsCache = snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  renderKycRequests(kycRequestsCache);
}

async function submitKycRequest(fullName, idNumber, phone) {
  if (!currentUser) throw new Error("请先登录用户账号");
  if (walletStatus === "frozen") throw new Error("账户已被冻结，无法提交实名");
  const requestId = currentUser.uid;
  await setDoc(
    doc(db, "kycRequests", requestId),
    {
      userId: currentUser.uid,
      email: currentUser.email,
      displayName: currentUser.displayName || "",
      fullName,
      idNumber,
      phone,
      status: "pending",
      time: "刚刚",
      createdAt: new Date().toISOString(),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  await setDoc(
    walletRef(),
    {
      kycStatus: "pending",
      kycFullName: fullName,
      kycIdNumber: idNumber,
      kycPhone: phone,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function reviewKycRequest(requestId, approved) {
  const request = kycRequestsCache.find((item) => item.id === requestId);
  if (!request) throw new Error("找不到实名申请");
  if (request.status !== "pending") throw new Error("该实名申请已处理");

  const status = approved ? "approved" : "rejected";
  await setDoc(
    doc(db, "kycRequests", requestId),
    {
      status,
      reviewedBy: currentUser.email,
      reviewedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  await setDoc(
    doc(db, "wallets", request.userId),
    {
      kycStatus: status,
      kycFullName: request.fullName || "",
      kycIdNumber: request.idNumber || "",
      kycPhone: request.phone || "",
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  await Promise.all([loadKycRequests(), loadAdminUsers(), loadRiskCenter()]);
  logAuditSafe({
    module: "实名认证/KYC 审核",
    action: approved ? "通过实名申请" : "拒绝实名申请",
    target: requestId,
    detail: `${request.email || request.userId} / ${request.fullName || "-"}`,
  });
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
  logAuditSafe({
    module: "用户管理",
    action: frozen ? "冻结用户" : "解冻用户",
    target: userId,
    detail: `状态：${frozen ? "frozen" : "active"}`,
  });
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
  financeReportRowsCache = rows;
  financeReportMetricsCache = metrics;
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

function getHandledRiskIds() {
  return Array.isArray(systemConfig.riskHandledIds) ? systemConfig.riskHandledIds : [];
}

async function markRiskHandled(riskId) {
  const nextIds = [riskId, ...getHandledRiskIds().filter((id) => id !== riskId)].slice(0, 300);
  systemConfig = { ...systemConfig, riskHandledIds: nextIds };
  await setDoc(doc(db, "systemConfig", "main"), { riskHandledIds: nextIds, updatedAt: serverTimestamp() }, { merge: true });
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
    status: getHandledRiskIds().includes(alert.id) ? "handled" : alert.status || "open",
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

  const [configSnap, walletSnapshot, merchantSnapshot, withdrawalSnapshot, refundSnapshot, settlementSnapshot] = await Promise.all([
    getDoc(doc(db, "systemConfig", "main")),
    getDocs(collection(db, "wallets")),
    getDocs(collection(db, "merchants")),
    getDocs(collection(db, "withdrawRequests")),
    getDocs(collection(db, "refundRequests")),
    getDocs(collection(db, "settlementRequests")),
  ]);
  if (configSnap.exists()) {
    systemConfig = { ...DEFAULT_SYSTEM_CONFIG, ...systemConfig, ...configSnap.data() };
  }

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
    if ((wallet.kycStatus || "unsubmitted") !== "approved" && balance >= 30000) {
      addRisk(alerts, {
        id: `kyc-risk-${wallet.id}`,
        subjectId: wallet.id,
        subject: wallet.email || wallet.displayName || wallet.id,
        subjectType: "user",
        type: "未实名高余额",
        level: balance >= 100000 ? "high" : "medium",
        reason: `实名状态为 ${wallet.kycStatus || "未提交"}，余额 ${formatMoney(balance)}`,
        suggestion: "要求用户完成 KYC 后再放开大额交易",
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
      kycStatus: "unsubmitted",
      dailyUsage: { date: todayKey(), amount: 0 },
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
    updateUserKycStatus(data.kycStatus || "unsubmitted");
    usedCouponIds = Array.isArray(data.usedCouponIds) ? data.usedCouponIds : [];
    dailyUsage = data.dailyUsage?.date === todayKey() ? data.dailyUsage : { date: todayKey(), amount: 0 };
    userTransactions = Array.isArray(data.transactions) ? data.transactions : [];
    renderUserTransactions(userTransactions);
    updateReceiveQr(data.receiveCode || createReceiveCode(user));
    renderUserMarketing(marketingItemsCache);
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

    assertDailyLimit(amount, payerData.dailyUsage);

    transaction.set(
      payerRef,
      {
        balance: payerBalance - amount,
        dailyUsage: nextDailyUsage(payerData.dailyUsage, amount),
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
    await loadSystemConfig().catch(() => {});
    enterRole(target);
    if (target === "user") {
      await attachWallet(currentUser);
      loadMarketingItems().catch(() => {});
      loadSupportTickets().catch(() => {});
    }
    if (target === "merchant") await attachMerchant(currentUser);
    if (target === "admin") {
      logAuditSafe({
        module: "登录",
        action: "管理员登录",
        target: currentUser.email,
        detail: `角色：${roleLabel(currentAdminProfile?.role)}`,
      });
    }
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
  roleName.textContent = target === "admin" && currentAdminProfile ? `${role.title} · ${roleLabel(currentAdminProfile.role)}` : role.title;
  loginGateway.classList.add("hidden");
  appShell.classList.remove("locked");
  if (target === "admin") {
    await loadSystemConfig().catch(() => {});
    applyAdminPermissions();
    if (hasAdminPermission("users")) loadAdminUsers().catch((error) => showToast(error.message || "用户数据加载失败"));
    if (hasAdminPermission("merchants")) loadMerchants().catch((error) => showToast(error.message || "商家数据加载失败"));
    if (hasAdminPermission("funds")) loadRechargeRequests().catch((error) => showToast(error.message || "充值申请加载失败"));
    if (hasAdminPermission("funds")) loadWithdrawalRequests().catch((error) => showToast(error.message || "提现申请加载失败"));
    if (hasAdminPermission("refunds")) loadRefundRequests().catch((error) => showToast(error.message || "退款申请加载失败"));
    if (hasAdminPermission("settlements")) loadSettlementRequests().catch((error) => showToast(error.message || "结算申请加载失败"));
    if (hasAdminPermission("finance")) loadFinanceReport().catch((error) => showToast(error.message || "财务报表加载失败"));
    if (hasAdminPermission("risk")) loadRiskCenter().catch((error) => showToast(error.message || "风控中心加载失败"));
    if (hasAdminPermission("kyc")) loadKycRequests().catch((error) => showToast(error.message || "实名申请加载失败"));
    if (hasAdminPermission("permissions")) loadPermissionAdmins().catch((error) => showToast(error.message || "权限数据加载失败"));
    if (hasAdminPermission("logs")) loadAuditLogs().catch((error) => showToast(error.message || "操作日志加载失败"));
    if (hasAdminPermission("marketing")) loadMarketingItems().catch((error) => showToast(error.message || "营销内容加载失败"));
    if (hasAdminPermission("support")) loadSupportTickets().catch((error) => showToast(error.message || "客服工单加载失败"));
    if (hasAdminPermission("config")) renderSystemConfig();
    if (hasAdminPermission("transactions")) loadAdminTransactions().catch((error) => showToast(error.message || "交易流水加载失败"));
  }
}

async function logout() {
  const wasAdmin = activeRole === "admin";
  const logoutEmail = currentUser?.email || "";
  if (wasAdmin) {
    logAuditSafe({
      module: "登录",
      action: "管理员退出",
      target: logoutEmail,
      detail: "主动退出登录",
    });
  }
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
  const couponId = document.querySelector("#pay-coupon")?.value || "";
  const selectedCoupon = getAvailableCoupons().find((item) => item.id === couponId) || null;
  const couponDiscount = selectedCoupon ? Math.min(Number(selectedCoupon.discount || 0), amount || 0) : 0;
  const payableAmount = Math.max(0, Number(amount || 0) - couponDiscount);
  const recipientUserId = codeInput?.dataset.recipientUserId;
  const kind = codeInput?.dataset.kind;

  if (!amount) {
    showToast(`请输入正确的付款金额，当前读取到：${amountInput?.value || "空"}`);
    amountInput?.focus();
    return;
  }
  if (kind === "receive" && selectedCoupon) {
    showToast("优惠券只能用于商家付款，不能用于个人转账");
    return;
  }
  if (payableAmount > walletBalance) {
    showToast("钱包余额不足");
    return;
  }

  try {
    assertDailyLimit(kind === "receive" ? amount : payableAmount);
  } catch (error) {
    showToast(error.message || "已超过每日交易限额");
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
        await payMerchant(merchantId, merchant, amount, selectedCoupon);
      } else {
        const txText = selectedCoupon ? `- ${formatMoney(payableAmount)}，优惠 ${formatMoney(couponDiscount)}` : `- ${formatMoney(amount)}`;
        const transactions = [transactionItem("扫码付款", merchant, txText), ...userTransactions].slice(0, 30);
        const nextUsedCoupons = selectedCoupon ? [selectedCoupon.id, ...usedCouponIds].slice(0, 100) : usedCouponIds;
        const nextBalance = Math.max(0, walletBalance - payableAmount);
        const updatedDailyUsage = nextDailyUsage(dailyUsage, payableAmount);
        setWalletBalance(nextBalance);
        usedCouponIds = nextUsedCoupons;
        dailyUsage = updatedDailyUsage;
        renderUserTransactions(transactions);
        renderUserMarketing(marketingItemsCache);
        await setDoc(
          walletRef(),
          {
            balance: nextBalance,
            dailyUsage: updatedDailyUsage,
            usedCouponIds: nextUsedCoupons,
            transactions,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      }
      showToast(selectedCoupon ? `付款成功，原价 ${formatMoney(amount)}，优惠 ${formatMoney(couponDiscount)}，实付 ${formatMoney(payableAmount)}` : `付款成功，余额已扣除 ${formatMoney(amount)}`);
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
  if (button.classList.contains("user-ticket-action")) {
    const ticket = supportTicketsCache.find((item) => item.id === button.dataset.ticketId && item.userId === currentUser?.uid);
    if (!ticket) {
      showToast("Ticket not found");
      return;
    }
    const replies = (ticket.replies || []).map((reply) => `<p><strong>${reply.by || reply.role || "-"}:</strong> ${reply.text || ""}</p>`).join("") || "<p>No replies yet</p>";
    if (button.dataset.action === "view") {
      openDialog(
        "Support ticket",
        `<div class="detail-list">
          <p><strong>ID:</strong> ${ticket.id}</p>
          <p><strong>Type:</strong> ${ticketTypeLabel(ticket.type)}</p>
          <p><strong>Title:</strong> ${ticket.title || "-"}</p>
          <p><strong>Status:</strong> ${ticket.status || "open"}</p>
          <p><strong>Message:</strong> ${ticket.message || "-"}</p>
          <div>${replies}</div>
        </div>`,
        "Close",
        closeDialog
      );
      return;
    }
    if (button.dataset.action === "reply") {
      openDialog(
        "Reply ticket",
        `<p class="dialog-note">${ticket.title || ticket.id}</p>
         <div class="detail-list">${replies}</div>
         <label class="field-label">Message</label>
         <input class="dialog-input" id="user-ticket-reply" placeholder="Type your follow-up message" />`,
        "Send",
        async () => {
          const message = document.querySelector("#user-ticket-reply")?.value.trim();
          if (!message) {
            showToast("Please enter a message");
            return;
          }
          try {
            await addUserSupportReply(ticket, message);
            closeDialog();
            showToast("Reply sent");
          } catch (error) {
            showToast(error.message || "Reply failed");
          }
        }
      );
      return;
    }
  }

  if (button.id === "refresh-user-marketing-button") {
    loadMarketingItems()
      .then(() => showToast("公告与优惠券已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-user-tickets-button") {
    loadSupportTickets()
      .then(() => showToast("客服工单已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "create-user-ticket-button") {
    openDialog(
      "提交客服工单",
      `<label class="field-label">问题类型</label>
       <select class="dialog-input" id="ticket-type">
         <option value="account">账户问题</option>
         <option value="payment">支付问题</option>
         <option value="refund">退款争议</option>
         <option value="complaint">投诉</option>
         <option value="other">其他</option>
       </select>
       <label class="field-label">标题</label>
       <input class="dialog-input" id="ticket-title" placeholder="简单描述你的问题" />
       <label class="field-label">问题说明</label>
       <input class="dialog-input" id="ticket-message" placeholder="请输入详细情况、订单号或截图说明" />`,
      "提交工单",
      async () => {
        const type = document.querySelector("#ticket-type").value;
        const title = document.querySelector("#ticket-title").value.trim();
        const message = document.querySelector("#ticket-message").value.trim();
        if (!title || !message) {
          showToast("请填写标题和问题说明");
          return;
        }
        try {
          await createSupportTicket({ type, title, message });
          closeDialog();
          showToast("客服工单已提交");
        } catch (error) {
          showToast(error.message || "提交失败");
        }
      }
    );
    return;
  }

  if (button.id === "submit-kyc-button") {
    const currentDataNote =
      walletKycStatus === "approved"
        ? "当前账号已完成实名，如需变更资料可重新提交后台审核。"
        : walletKycStatus === "pending"
          ? "当前实名申请正在等待后台审核，重新提交会覆盖旧资料。"
          : "请填写真实资料提交后台审核。";
    openDialog(
      "实名认证",
      `<label class="field-label">真实姓名</label>
       <input class="dialog-input" id="kyc-full-name" placeholder="例如：Lee Wei" />
       <label class="field-label">证件号码</label>
       <input class="dialog-input" id="kyc-id-number" placeholder="身份证/护照号码" />
       <label class="field-label">手机号</label>
       <input class="dialog-input" id="kyc-phone" placeholder="+60..." />
       <p class="dialog-note">${currentDataNote}</p>`,
      "提交审核",
      async () => {
        const fullName = document.querySelector("#kyc-full-name").value.trim();
        const idNumber = document.querySelector("#kyc-id-number").value.trim();
        const phone = document.querySelector("#kyc-phone").value.trim();
        if (!fullName || !idNumber || !phone) {
          showToast("请完整填写实名资料");
          return;
        }
        try {
          await submitKycRequest(fullName, idNumber, phone);
          closeDialog();
          showToast("实名资料已提交后台审核");
        } catch (error) {
          showToast(error.message || "实名提交失败");
        }
      }
    );
    return;
  }

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
    if (systemConfig.maintenanceMode || !systemConfig.rechargeEnabled) {
      showToast(systemConfig.maintenanceMode ? "系统维护中，暂不能充值" : "充值通道已关闭");
      return;
    }
    if (walletStatus === "frozen") {
      showToast("账户已被冻结，无法充值");
      return;
    }
    openDialog(
      "钱包充值",
      `<label class="field-label">充值金额（RM）</label>
       <input class="dialog-input" id="recharge-amount" value="100.00" />
       <p class="dialog-note">系统会按 RM 1 = ${systemConfig.pointsPerMyr} 积分自动兑换，审批通过后积分才会增加。</p>`,
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
    if (systemConfig.maintenanceMode || !systemConfig.withdrawEnabled) {
      showToast(systemConfig.maintenanceMode ? "系统维护中，暂不能提现" : "提现通道已关闭");
      return;
    }
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
       <p class="dialog-note">系统会按 ${systemConfig.pointsPerMyr} 积分 = RM 1 自动换算，审批通过后才会扣除积分余额。</p>`,
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
    if (systemConfig.maintenanceMode) {
      showToast("系统维护中，暂不能付款");
      return;
    }
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
       <input class="dialog-input" id="pay-amount" value="" placeholder="请输入积分" />
       ${couponSelectMarkup()}`,
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

  if (button.closest(".table-panel")) {
    openDialog(
      "Filter transactions",
      `<label class="field-label">Transaction type</label>
       <select class="dialog-input" id="user-transaction-filter">
         <option value="all" ${userTransactionFilter === "all" ? "selected" : ""}>All</option>
         <option value="payment" ${userTransactionFilter === "payment" ? "selected" : ""}>Payment / withdraw</option>
         <option value="receive" ${userTransactionFilter === "receive" ? "selected" : ""}>Receive / recharge</option>
         <option value="refund" ${userTransactionFilter === "refund" ? "selected" : ""}>Refund</option>
       </select>`,
      "Apply",
      () => {
        userTransactionFilter = document.querySelector("#user-transaction-filter")?.value || "all";
        renderUserTransactions(userTransactions);
        closeDialog();
        showToast("Transaction filter applied");
      }
    );
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
  if (button.id === "edit-merchant-profile-button") {
    const data = currentMerchant || {};
    openDialog(
      "Merchant profile",
      `<label class="field-label">Business name</label>
       <input class="dialog-input" id="merchant-profile-name" value="${data.businessName || ""}" />
       <label class="field-label">Contact name</label>
       <input class="dialog-input" id="merchant-profile-contact" value="${data.contactName || currentUser?.displayName || ""}" />
       <label class="field-label">Contact phone</label>
       <input class="dialog-input" id="merchant-profile-phone" value="${data.contactPhone || ""}" />
       <label class="field-label">Business address</label>
       <input class="dialog-input" id="merchant-profile-address" value="${data.businessAddress || ""}" />
       <label class="field-label">Settlement bank</label>
       <input class="dialog-input" id="merchant-profile-bank" value="${data.settlementBank || ""}" />
       <label class="field-label">Settlement account</label>
       <input class="dialog-input" id="merchant-profile-account" value="${data.settlementAccount || ""}" />
       <p class="dialog-note">These details help admin review merchant approval and settlement requests.</p>`,
      "Save",
      async () => {
        const profile = {
          businessName: document.querySelector("#merchant-profile-name")?.value.trim(),
          contactName: document.querySelector("#merchant-profile-contact")?.value.trim(),
          contactPhone: document.querySelector("#merchant-profile-phone")?.value.trim(),
          businessAddress: document.querySelector("#merchant-profile-address")?.value.trim(),
          settlementBank: document.querySelector("#merchant-profile-bank")?.value.trim(),
          settlementAccount: document.querySelector("#merchant-profile-account")?.value.trim(),
        };
        if (!profile.businessName || !profile.contactName || !profile.contactPhone) {
          showToast("Please fill business name, contact and phone");
          return;
        }
        try {
          await updateOwnMerchantProfile(profile);
          closeDialog();
          showToast("Merchant profile saved");
        } catch (error) {
          showToast(error.message || "Save failed");
        }
      }
    );
    return;
  }

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

  if (button.classList.contains("ghost-action") && button.closest(".table-panel")) {
    exportMerchantOrdersCsv();
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
  if (button.id === "export-finance-button") {
    if (!requireAdminPermission("finance")) return;
    exportFinanceReportCsv();
    return;
  }

  if (button.id === "export-transactions-button") {
    if (!requireAdminPermission("transactions")) return;
    exportAdminTransactionsCsv();
    return;
  }

  if (button.id === "filter-audit-button") {
    if (!requireAdminPermission("logs")) return;
    const modules = [...new Set(auditLogsCache.map((log) => log.module).filter(Boolean))];
    openDialog(
      "Filter audit logs",
      `<label class="field-label">Module</label>
       <select class="dialog-input" id="audit-filter-module">
         <option value="all" ${auditLogFilter.module === "all" ? "selected" : ""}>All modules</option>
         ${modules.map((module) => `<option value="${module}" ${auditLogFilter.module === module ? "selected" : ""}>${module}</option>`).join("")}
       </select>
       <label class="field-label">Result</label>
       <select class="dialog-input" id="audit-filter-result">
         <option value="all" ${auditLogFilter.result === "all" ? "selected" : ""}>All results</option>
         <option value="success" ${auditLogFilter.result === "success" ? "selected" : ""}>Success</option>
         <option value="blocked" ${auditLogFilter.result === "blocked" ? "selected" : ""}>Blocked</option>
         <option value="failed" ${auditLogFilter.result === "failed" ? "selected" : ""}>Failed</option>
       </select>`,
      "Apply",
      () => {
        auditLogFilter = {
          module: document.querySelector("#audit-filter-module")?.value || "all",
          result: document.querySelector("#audit-filter-result")?.value || "all",
        };
        renderAuditLogs(auditLogsCache);
        closeDialog();
        showToast("Audit filter applied");
      }
    );
    return;
  }

  if (button.id === "export-audit-button") {
    if (!requireAdminPermission("logs")) return;
    exportAuditLogsCsv();
    return;
  }

  if (button.id === "refresh-users-button") {
    if (!requireAdminPermission("users")) return;
    loadAdminUsers()
      .then(() => showToast("用户列表已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-recharges-button") {
    if (!requireAdminPermission("funds")) return;
    loadRechargeRequests()
      .then(() => showToast("充值申请已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-withdrawals-button") {
    if (!requireAdminPermission("funds")) return;
    loadWithdrawalRequests()
      .then(() => showToast("提现申请已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-refunds-button") {
    if (!requireAdminPermission("refunds")) return;
    loadRefundRequests()
      .then(() => showToast("退款申请已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-settlements-button") {
    if (!requireAdminPermission("settlements")) return;
    loadSettlementRequests()
      .then(() => showToast("结算申请已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-finance-button") {
    if (!requireAdminPermission("finance")) return;
    loadFinanceReport()
      .then(() => showToast("财务报表已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-risk-button") {
    if (!requireAdminPermission("risk")) return;
    loadRiskCenter()
      .then(() => showToast("风控预警已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-kyc-button") {
    if (!requireAdminPermission("kyc")) return;
    loadKycRequests()
      .then(() => showToast("实名申请已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-permissions-button") {
    if (!requireAdminPermission("permissions")) return;
    loadPermissionAdmins()
      .then(() => showToast("权限数据已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-audit-button") {
    if (!requireAdminPermission("logs")) return;
    loadAuditLogs()
      .then(() => showToast("操作日志已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-marketing-button") {
    if (!requireAdminPermission("marketing")) return;
    loadMarketingItems()
      .then(() => showToast("公告活动优惠券已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-support-button") {
    if (!requireAdminPermission("support")) return;
    loadSupportTickets()
      .then(() => showToast("客服工单已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-config-button") {
    if (!requireAdminPermission("config")) return;
    loadSystemConfig()
      .then(() => showToast("系统配置已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "save-config-button") {
    if (!requireAdminPermission("config")) return;
    saveSystemConfig()
      .then(() => showToast("系统配置已保存"))
      .catch((error) => showToast(error.message || "保存失败"));
    return;
  }

  if (button.id === "create-marketing-button") {
    if (!requireAdminPermission("marketing")) return;
    openMarketingEditor();
    return;
  }

  if (button.id === "refresh-merchants-button") {
    if (!requireAdminPermission("merchants")) return;
    loadMerchants()
      .then(() => showToast("商家列表已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.id === "refresh-transactions-button") {
    if (!requireAdminPermission("transactions")) return;
    loadAdminTransactions()
      .then(() => showToast("交易流水已刷新"))
      .catch((error) => showToast(error.message || "刷新失败"));
    return;
  }

  if (button.classList.contains("transaction-filter")) {
    if (!requireAdminPermission("transactions")) return;
    adminTransactionFilter = button.dataset.filter || "all";
    document.querySelectorAll(".transaction-filter").forEach((item) => item.classList.toggle("active", item === button));
    renderAdminTransactions(adminTransactionFilter);
    return;
  }

  if (button.classList.contains("transaction-action")) {
    if (!requireAdminPermission("transactions")) return;
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

  if (button.classList.contains("audit-action")) {
    if (!requireAdminPermission("logs")) return;
    const log = auditLogsCache.find((item) => item.id === button.dataset.logId);
    if (!log) {
      showToast("找不到日志详情");
      return;
    }
    openDialog(
      "操作日志详情",
      `<div class="detail-list">
        <p><strong>日志号：</strong>${log.id}</p>
        <p><strong>操作者：</strong>${log.actor || "-"}</p>
        <p><strong>角色：</strong>${roleLabel(log.actorRole)}</p>
        <p><strong>模块：</strong>${log.module || "-"}</p>
        <p><strong>动作：</strong>${log.action || "-"}</p>
        <p><strong>对象：</strong>${log.target || "-"}</p>
        <p><strong>结果：</strong>${log.result || "success"}</p>
        <p><strong>详情：</strong>${log.detail || "-"}</p>
      </div>`,
      "关闭",
      closeDialog
    );
    return;
  }

  if (button.classList.contains("marketing-action")) {
    if (!requireAdminPermission("marketing")) return;
    const item = marketingItemsCache.find((entry) => entry.id === button.dataset.itemId);
    if (!item) {
      showToast("找不到营销内容");
      return;
    }
    const action = button.dataset.action;
    if (action === "view") {
      openDialog(
        "营销内容详情",
        `<div class="detail-list">
          <p><strong>标题：</strong>${item.title || "-"}</p>
          <p><strong>类型：</strong>${marketingTypeLabel(item.type)}</p>
          <p><strong>说明：</strong>${item.description || "-"}</p>
          <p><strong>优惠：</strong>${item.type === "coupon" ? formatMoney(item.discount || 0) : item.badge || "-"}</p>
          <p><strong>有效期：</strong>${item.validUntil || "-"}</p>
          <p><strong>状态：</strong>${item.status || "draft"}</p>
        </div>`,
        "关闭",
        closeDialog
      );
      return;
    }
    updateMarketingStatus(item.id, action === "publish" ? "published" : "paused")
      .then(() => showToast(action === "publish" ? "营销内容已发布" : "营销内容已停用"))
      .catch((error) => showToast(error.message || "操作失败"));
    return;
  }

  if (button.classList.contains("support-action")) {
    if (!requireAdminPermission("support")) return;
    const ticket = supportTicketsCache.find((item) => item.id === button.dataset.ticketId);
    if (!ticket) {
      showToast("找不到客服工单");
      return;
    }
    const action = button.dataset.action;
    if (action === "view") {
      const replies = (ticket.replies || []).map((reply) => `<p><strong>${reply.by}：</strong>${reply.text}</p>`).join("") || "<p>暂无回复</p>";
      openDialog(
        "客服工单详情",
        `<div class="detail-list">
          <p><strong>工单号：</strong>${ticket.id}</p>
          <p><strong>用户：</strong>${ticket.email || ticket.userId}</p>
          <p><strong>类型：</strong>${ticketTypeLabel(ticket.type)}</p>
          <p><strong>标题：</strong>${ticket.title || "-"}</p>
          <p><strong>说明：</strong>${ticket.message || "-"}</p>
          <p><strong>状态：</strong>${ticket.status || "open"}</p>
          <div>${replies}</div>
        </div>`,
        "关闭",
        closeDialog
      );
      return;
    }
    if (action === "assign") {
      updateSupportTicket(ticket.id, { status: "processing", assignedTo: currentUser.email }, "接收客服工单")
        .then(() => showToast("工单已接收"))
        .catch((error) => showToast(error.message || "接单失败"));
      return;
    }
    if (action === "reply") {
      openSupportReply(ticket);
      return;
    }
    if (action === "close") {
      updateSupportTicket(ticket.id, { status: "closed", closedBy: currentUser.email }, "关闭客服工单")
        .then(() => showToast("工单已关闭"))
        .catch((error) => showToast(error.message || "关闭失败"));
      return;
    }
  }

  if (button.classList.contains("risk-action")) {
    if (!requireAdminPermission("risk")) return;
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
      markRiskHandled(alert.id)
        .then(() => {
          alert.status = "handled";
          renderRiskAlerts(riskAlertsCache);
          logAuditSafe({
            module: "Risk center",
            action: "Mark risk handled",
            target: alert.id,
            detail: `${alert.subject || "-"} / ${alert.type || "-"}`,
          });
          showToast("Risk alert marked as handled");
        })
        .catch((error) => showToast(error.message || "Mark handled failed"));
      return;
    }
  }

  if (button.classList.contains("merchant-action")) {
    if (!requireAdminPermission("merchants")) return;
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
          <p><strong>联系人：</strong>${merchant?.contactName || "-"} ${merchant?.contactPhone || ""}</p>
          <p><strong>地址：</strong>${merchant?.businessAddress || "-"}</p>
          <p><strong>结算账户：</strong>${[merchant?.settlementBank, merchant?.settlementAccount].filter(Boolean).join(" / ") || "-"}</p>
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
    if (!requireAdminPermission("funds")) return;
    const approved = button.dataset.action === "approve";
    reviewRechargeRequest(button.dataset.requestId, approved)
      .then(() => showToast(approved ? "充值申请已通过" : "充值申请已拒绝"))
      .catch((error) => showToast(error.message || "审批失败"));
    return;
  }

  if (button.classList.contains("withdrawal-action")) {
    if (!requireAdminPermission("funds")) return;
    const approved = button.dataset.action === "approve";
    reviewWithdrawalRequest(button.dataset.requestId, approved)
      .then(() => showToast(approved ? "提现申请已通过" : "提现申请已拒绝"))
      .catch((error) => showToast(error.message || "审批失败"));
    return;
  }

  if (button.classList.contains("refund-action")) {
    if (!requireAdminPermission("refunds")) return;
    const approved = button.dataset.action === "approve";
    reviewRefundRequest(button.dataset.requestId, approved)
      .then(() => showToast(approved ? "退款申请已通过，积分已退回用户" : "退款申请已拒绝"))
      .catch((error) => showToast(error.message || "审批失败"));
    return;
  }

  if (button.classList.contains("settlement-action")) {
    if (!requireAdminPermission("settlements")) return;
    const approved = button.dataset.action === "approve";
    reviewSettlementRequest(button.dataset.requestId, approved)
      .then(() => showToast(approved ? "结算申请已通过" : "结算申请已拒绝，积分已退回待结算"))
      .catch((error) => showToast(error.message || "审批失败"));
    return;
  }

  if (button.classList.contains("kyc-action")) {
    if (!requireAdminPermission("kyc")) return;
    const approved = button.dataset.action === "approve";
    reviewKycRequest(button.dataset.requestId, approved)
      .then(() => showToast(approved ? "实名审核已通过" : "实名审核已拒绝"))
      .catch((error) => showToast(error.message || "审核失败"));
    return;
  }

  if (button.classList.contains("permission-action")) {
    if (!requireAdminPermission("permissions")) return;
    const admin = permissionAdminsCache.find((item) => normalizeEmail(item.email) === normalizeEmail(button.dataset.email));
    if (!admin) {
      showToast("找不到管理员资料");
      return;
    }
    const action = button.dataset.action;
    if (action === "edit") {
      openPermissionEditor(admin);
      return;
    }
    updateAdminAccess(admin.email, { enabled: action === "enable" })
      .then(() => showToast(action === "enable" ? "管理员已启用" : "管理员已停用"))
      .catch((error) => showToast(error.message || "权限更新失败"));
    return;
  }

  if (button.classList.contains("admin-user-action")) {
    if (!requireAdminPermission("users")) return;
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
          <p><strong>实名状态：</strong>${user?.kycStatus || "unsubmitted"}</p>
          <p><strong>实名姓名：</strong>${user?.kycFullName || "-"}</p>
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
    if (!requireAdminPermission("permissions")) return;
    const input = document.querySelector("#admin-email-input");
    const role = document.querySelector("#admin-role-select")?.value || "ops";
    const email = normalizeEmail(input?.value);
    authorizeAdminEmail(email, role)
      .then(() => {
        showToast(`已授权 ${email} 登录后台`);
        input.value = "";
        loadPermissionAdmins().catch(() => {});
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
    const permission = MODULE_PERMISSION_BY_TITLE[title];
    if (permission && !requireAdminPermission(permission)) return;
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
    if (title === "实名认证/KYC 审核") {
      document.querySelector("#admin-kyc-management")?.scrollIntoView({ behavior: "smooth", block: "start" });
      loadKycRequests()
        .then(() => showToast("KYC 审核已打开"))
        .catch((error) => showToast(error.message || "实名申请加载失败"));
      return;
    }
    if (title === "权限管理") {
      document.querySelector("#admin-permission-management")?.scrollIntoView({ behavior: "smooth", block: "start" });
      loadPermissionAdmins()
        .then(() => showToast("权限管理已打开"))
        .catch((error) => showToast(error.message || "权限数据加载失败"));
      return;
    }
    if (title === "操作日志") {
      document.querySelector("#admin-audit-log")?.scrollIntoView({ behavior: "smooth", block: "start" });
      loadAuditLogs()
        .then(() => showToast("操作日志已打开"))
        .catch((error) => showToast(error.message || "操作日志加载失败"));
      return;
    }
    if (title === "公告/活动/优惠券管理") {
      document.querySelector("#admin-marketing-management")?.scrollIntoView({ behavior: "smooth", block: "start" });
      loadMarketingItems()
        .then(() => showToast("营销管理已打开"))
        .catch((error) => showToast(error.message || "营销内容加载失败"));
      return;
    }
    if (title === "客服工单") {
      document.querySelector("#admin-support-management")?.scrollIntoView({ behavior: "smooth", block: "start" });
      loadSupportTickets()
        .then(() => showToast("客服工单已打开"))
        .catch((error) => showToast(error.message || "客服工单加载失败"));
      return;
    }
    if (title === "系统配置") {
      document.querySelector("#admin-system-config")?.scrollIntoView({ behavior: "smooth", block: "start" });
      loadSystemConfig()
        .then(() => showToast("系统配置已打开"))
        .catch((error) => showToast(error.message || "系统配置加载失败"));
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
  await loadSystemConfig().catch(() => {});
  enterRole(activeRole);
  if (activeRole === "user") await attachWallet(user);
  if (activeRole === "merchant") await attachMerchant(user);
});
