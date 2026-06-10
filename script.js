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

let activeRole = sessionStorage.getItem("activeRole") || "";
let currentUser = null;
let walletUnsubscribe = null;
let scannerStream = null;
let scannerTimer = null;
let dynamicQrId = 6130;
let toastTimer;
let walletBalance = readWalletBalance();

function formatMoney(amount) {
  return `RM ${amount.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function parseAmount(value) {
  const amount = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function parsePaymentCode(rawCode) {
  const raw = String(rawCode || "").trim();
  if (!raw) return null;

  try {
    const url = raw.includes("://") ? new URL(raw) : new URL(`https://pay.local/?${raw}`);
    const merchant = url.searchParams.get("merchant") || url.searchParams.get("m") || url.hostname;
    const amount = parseAmount(url.searchParams.get("amount") || url.searchParams.get("a"));
    if (merchant && amount) return { merchant, amount, code: raw };
  } catch (error) {
    const parts = Object.fromEntries(
      raw.split(/[|&;]/).map((part) => {
        const [key, value = ""] = part.split("=");
        return [key.trim().toLowerCase(), decodeURIComponent(value.trim())];
      })
    );
    const merchant = parts.merchant || parts.m || parts.shop;
    const amount = parseAmount(parts.amount || parts.a);
    if (merchant && amount) return { merchant, amount, code: raw };
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

  qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=10&data=${encodeURIComponent(receiveCode)}`;
  qrImage.dataset.code = receiveCode;
  label.textContent = `固定收款ID: ${receiveCode.slice(receiveCode.indexOf("userId=") + 7, receiveCode.indexOf("&name=")).slice(0, 10)}...`;
}

function getWalletBalanceElement() {
  return document.querySelector("#wallet-balance") || document.querySelector(".balance-panel strong");
}

function readWalletBalance() {
  const balance = getWalletBalanceElement();
  if (!balance) return 1268.5;
  const amount = Number(balance.textContent.replace(/[^\d.]/g, ""));
  return Number.isFinite(amount) ? amount : 1268.5;
}

function setWalletBalance(amount) {
  walletBalance = Math.max(0, amount);
  const balance = getWalletBalanceElement();
  if (balance) balance.textContent = formatMoney(walletBalance);
}

function getWalletRef(user = currentUser) {
  return doc(db, "wallets", user.uid);
}

async function attachWallet(user) {
  if (walletUnsubscribe) walletUnsubscribe();
  const walletRef = getWalletRef(user);
  const walletDoc = await getDoc(walletRef);

  if (!walletDoc.exists()) {
    const receiveCode = createReceiveCode(user);
    await setDoc(walletRef, {
      balance: walletBalance,
      email: user.email,
      receiveCode,
      role: "user",
      updatedAt: serverTimestamp(),
    });
    updateReceiveQr(receiveCode);
  } else {
    const data = walletDoc.data();
    const receiveCode = data.receiveCode || createReceiveCode(user);
    updateReceiveQr(receiveCode);
    if (!data.receiveCode) {
      await setDoc(walletRef, { receiveCode, updatedAt: serverTimestamp() }, { merge: true });
    }
  }

  walletUnsubscribe = onSnapshot(walletRef, (snapshot) => {
    const data = snapshot.data();
    if (data && typeof data.balance === "number") {
      setWalletBalance(data.balance);
    }
    if (data?.receiveCode) updateReceiveQr(data.receiveCode);
  });
}

async function updateWalletBalance(change) {
  const nextBalance = Math.max(0, walletBalance + change);
  setWalletBalance(nextBalance);

  if (currentUser && activeRole === "user") {
    await setDoc(
      getWalletRef(),
      {
        balance: nextBalance,
        email: currentUser.email,
        role: "user",
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }
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

function addTransaction(type, target, amount, status = "成功") {
  const activeView = document.querySelector(".view.active");
  const tbody = activeView?.querySelector("tbody");
  if (!tbody) return;

  const row = document.createElement("tr");
  row.innerHTML = `
    <td>刚刚</td>
    <td>${type}</td>
    <td>${target}</td>
    <td>${amount}</td>
    <td><span class="tag success">${status}</span></td>
  `;
  tbody.prepend(row);
}

function fillPaymentForm(payment) {
  const merchantInput = document.querySelector("#pay-merchant");
  const amountInput = document.querySelector("#pay-amount");
  const codeInput = document.querySelector("#pay-code");
  const result = document.querySelector("#scan-result");

  if (merchantInput) merchantInput.value = payment.merchant;
  if (amountInput) amountInput.value = payment.amount.toFixed(2);
  if (codeInput) codeInput.value = payment.code || "";
  if (result) result.textContent = `已识别：${payment.merchant}，${formatMoney(payment.amount)}`;
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
    } catch (error) {
      scannerStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
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
    if (result) result.textContent = "请把商家二维码放入取景框";

    if ("BarcodeDetector" in window) {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      scannerTimer = window.setInterval(async () => {
        if (!video.videoWidth) return;
        const codes = await detector.detect(video);
        const payment = parsePaymentCode(codes[0]?.rawValue);
        if (payment) {
          fillPaymentForm(payment);
          stopScanner();
          showToast("已识别付款二维码");
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
  if (scannerStream) {
    scannerStream.getTracks().forEach((track) => track.stop());
  }
  scannerStream = null;
  const video = document.querySelector("#scanner-video");
  if (video) video.srcObject = null;
  const startButton = document.querySelector("#start-scanner");
  if (startButton) startButton.textContent = "打开摄像头扫码";
}

async function confirmScanPayment() {
  const codeInput = document.querySelector("#pay-code");
  const manualPayment = parsePaymentCode(codeInput?.value);
  if (manualPayment) fillPaymentForm(manualPayment);

  const merchant = document.querySelector("#pay-merchant").value || "商家";
  const amount = parseAmount(document.querySelector("#pay-amount").value);
  if (!amount) {
    showToast("请输入正确的付款金额");
    return;
  }
  if (amount > walletBalance) {
    showToast("钱包余额不足");
    return;
  }

  await updateWalletBalance(-amount);
  addTransaction("扫码付款", merchant, `- ${formatMoney(amount)}`);
  closeDialog();
  showToast(`付款成功，余额已扣除 ${formatMoney(amount)}`);
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
       <p class="dialog-note">充值后会写入 Firebase，同一个 Google 账号在电脑和手机会同步余额。</p>`,
      "确认充值",
      async () => {
        const amount = parseAmount(document.querySelector("#recharge-amount").value);
        if (!amount) {
          showToast("请输入正确的充值金额");
          return;
        }
        await updateWalletBalance(amount);
        addTransaction("充值", "Google Pay", `+ ${formatMoney(amount)}`);
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
      <p class="dialog-note" id="scan-result">支持付款码格式：oneminpay://pay?merchant=MY%20Coffee&amount=12.80</p>
       <label class="field-label">付款码内容</label>
       <input class="dialog-input" id="pay-code" placeholder="粘贴或输入商家付款码" />
       <label class="field-label">商家</label>
       <input class="dialog-input" id="pay-merchant" value="MY Coffee" />
       <label class="field-label">付款金额</label>
       <input class="dialog-input" id="pay-amount" value="12.80" />`,
      "确认付款",
      confirmScanPayment
    );
    document.querySelector("#start-scanner").addEventListener("click", startScanner);
    document.querySelector("#use-demo-code").addEventListener("click", () => {
      fillPaymentForm({
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
  enterRole(activeRole);
  if (activeRole === "user") await attachWallet(user);
});
