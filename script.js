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

let dynamicQrId = 6130;
let toastTimer;

function showOnlyView(target) {
  Object.entries(views).forEach(([name, view]) => {
    view.classList.toggle("active", name === target);
  });
}

function loginAs(target) {
  const role = roleConfig[target];
  showOnlyView(target);
  pageTitle.textContent = role.title;
  currentRole.textContent = role.label;
  roleName.textContent = role.title;
  loginGateway.classList.add("hidden");
  appShell.classList.remove("locked");
  showToast(`${role.title}登录成功`);
}

function logout() {
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
  confirm.onclick = () => {
    onConfirm();
  };
  overlay.classList.remove("hidden");
}

function closeDialog() {
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
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
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

function handleUserButton(button) {
  const text = button.textContent.trim();
  if (text.includes("充值") || text.includes("鍏")) {
    openDialog(
      "钱包充值",
      `<label class="field-label">充值金额</label>
       <input class="dialog-input" id="recharge-amount" value="100.00" />
       <p class="dialog-note">原型中会模拟把金额加入交易记录。</p>`,
      "确认充值",
      () => {
        const amount = document.querySelector("#recharge-amount").value || "100.00";
        addTransaction("充值", "Google Pay", `+ RM ${amount}`);
        closeDialog();
        showToast("充值成功，交易记录已更新");
      }
    );
    return;
  }

  if (text.includes("扫码") || text.includes("鎵")) {
    openDialog(
      "扫码付款",
      `<div class="sim-scan"><div class="scan-frame"><div class="scan-line"></div></div></div>
       <label class="field-label">商家</label>
       <input class="dialog-input" id="pay-merchant" value="MY Coffee" />
       <label class="field-label">付款金额</label>
       <input class="dialog-input" id="pay-amount" value="12.80" />`,
      "确认付款",
      () => {
        const merchant = document.querySelector("#pay-merchant").value || "商家";
        const amount = document.querySelector("#pay-amount").value || "0.00";
        addTransaction("扫码付款", merchant, `- RM ${amount}`);
        closeDialog();
        showToast("付款成功");
      }
    );
    return;
  }

  if (text.includes("筛选") || text.includes("绛")) {
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
  if (text.includes("动态") || text.includes("鐢熸垚")) {
    dynamicQrId += 1;
    const panel = button.closest(".qr-panel");
    const idLine = panel.querySelector("p") || document.createElement("p");
    idLine.textContent = `动态码: M-${dynamicQrId}`;
    panel.appendChild(idLine);
    showToast("已生成新的商家动态收款码");
    return;
  }

  if (text.includes("导出") || text.includes("瀵")) {
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

  if (text.includes("查看") || text.includes("鏌")) {
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

  if (text.includes("处理") || text.includes("澶")) {
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

  if (text.includes("通过") || text.includes("审核") || text.includes("閫") || text.includes("瀹")) {
    button.textContent = "已完成";
    button.disabled = true;
    showToast("退款审核已完成");
    return;
  }

  if (text.includes("申请") || text.includes("凭证") || text.includes("鐢") || text.includes("鍑")) {
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
  if (text.includes("查看") || text.includes("鏌")) {
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
