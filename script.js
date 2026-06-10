import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  doc,
  getDoc,
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
let scannerStream = null;
let scannerTimer = null;
let dynamicQrId = 6130;
let toastTimer;
let walletBalance = 0;
let userTransactions = [];

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

    const merchant = url.searchParams.get("merchant") || url.searchParams.get("m") || url.hostname;
    const amount = parseAmount(url.searchParams.get("amount") || url.searchParams.get("a"));
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
}

async function logout() {
  if (walletUnsubscribe) walletUnsubscribe();
  walletUnsubscribe = null;
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
      await updateWalletBalance(-amount, transactionItem("扫码付款", merchant, `- ${formatMoney(amount)}`));
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
    openDialog(
      "钱包充值",
      `<label class="field-label">充值金额</label>
       <input class="dialog-input" id="recharge-amount" value="100.00" />
       <p class="dialog-note">充值后会写入 Firebase，仅当前 Google 账号的钱包余额会增加。</p>`,
      "确认充值",
      async () => {
        const amount = parseAmount(document.querySelector("#recharge-amount").value);
        if (!amount) {
          showToast("请输入正确的充值金额");
          return;
        }
        await updateWalletBalance(amount, transactionItem("充值", "Google Pay", `+ ${formatMoney(amount)}`));
        closeDialog();
        showToast(`充值成功，余额已增加 ${formatMoney(amount)}`);
      }
    );
    return;
  }

  if (text.includes("扫码")) {
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
  if (text.includes("动态")) {
    dynamicQrId += 1;
    const panel = button.closest(".qr-panel");
    const idLine = panel.querySelector("p") || document.createElement("p");
    idLine.textContent = `动态码: M-${dynamicQrId}`;
    panel.appendChild(idLine);
    showToast("已生成新的商家动态收款码");
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
});
