(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => n == null || n === "" ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n) => n == null ? "—" : Number(n).toLocaleString("en-US");
  const pct = (n) => n == null ? "—" : `${Number(n).toFixed(1)}%`;
  const isoDay = (d) => d.toISOString().slice(0, 10);
  const daysAgo = (n) => isoDay(new Date(Date.now() - n * 86400000));
  const empty = (cols, text, err) => `<tr><td colspan="${cols}" class="empty"${err ? ' style="color:var(--err)"' : ""}>${esc(text)}</td></tr>`;
  let STATUS = {};

  async function api(path, opts = {}) {
    const r = await fetch(path, { credentials: "same-origin", ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
    if (r.status === 401) { location.href = "/login"; throw new Error("未登录"); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `请求失败（${r.status}）`);
    return data;
  }
  /** Calls a tool; resolves to { ok, summary, data, ms, isError }. */
  const callTool = (name, args = {}) => api("/api/tools/call", { method: "POST", body: JSON.stringify({ name, arguments: args }) });
  async function mustTool(name, args) { const r = await callTool(name, args); if (!r.ok) throw new Error(r.summary); return r; }

  let toastTimer;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600); }
  function copy(text) { navigator.clipboard?.writeText(text).then(() => toast("已复制"), () => toast("复制失败，请手动选中")); }
  function bars(el, items, fmt = num) {
    const max = Math.max(...items.map((i) => i.value), 0) || 1;
    el.innerHTML = items.length ? items.map((i) => `<div class="bar" title="${esc(i.label)}"><span class="label">${esc(i.label)}</span>
      <span class="track"><span class="fill${i.err ? " err" : ""}" style="width:${(i.value / max) * 100}%"></span></span><span class="val">${esc(i.display ?? fmt(i.value))}</span></div>`).join("")
      : `<p class="muted" style="font-size:13px">没有数据</p>`;
  }
  function tabs(container) {
    const btns = container.querySelectorAll("[data-tab]");
    btns.forEach((b) => b.addEventListener("click", () => {
      btns.forEach((x) => { x.setAttribute("aria-selected", String(x === b)); $(x.dataset.tab).hidden = x !== b; });
      container.dispatchEvent(new CustomEvent("tab", { detail: b.dataset.tab }));
    }));
  }
  const fmtUptime = (s) => s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分钟` : s < 86400 ? `${Math.floor(s / 3600)} 小时 ${Math.floor(s % 3600 / 60)} 分` : `${Math.floor(s / 86400)} 天`;
  const localTime = (ts) => ts ? new Date(ts).toLocaleString() : "—";

  /* ================= router ================= */
  const VIEWS = ["overview", "clients", "spend", "reports", "usage", "tokens", "tools"];
  const loaded = {};
  function show() {
    const [name, param] = location.hash.slice(1).split(":");
    const view = VIEWS.includes(name) ? name : "overview";
    VIEWS.forEach((v) => { $("view-" + v).hidden = v !== view; });
    document.querySelectorAll(".nav a").forEach((a) => { if (a.dataset.view === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    const sec = $("view-" + view);
    $("viewTitle").textContent = sec.dataset.title; $("viewSub").textContent = sec.dataset.sub || "";
    document.title = `${sec.dataset.title} · Tally 控制台`;
    if (!loaded[view] && LOADERS[view]) { loaded[view] = true; LOADERS[view](); }
    if (param && PARAM_HANDLERS[view]) PARAM_HANDLERS[view](decodeURIComponent(param));
  }
  addEventListener("hashchange", show);

  /* ================= overview ================= */
  const STAGES = [
    { n: "阶段 1", name: "骨架与登录鉴权", state: "已在 staging 验收", cls: "ok", items: ["@feedmob.com 才能使用", "key + secret 签名", "客户查询", "人工控制台"] },
    { n: "阶段 2", name: "Spend 与 Rate", state: "查询已验收，写入待验收", cls: "warn", items: ["每日 spend、单价历史", "新增 / 修改 spend", "修改历史单价（需确认）", "写入默认关闭"] },
    { n: "阶段 3", name: "Report 统计", state: "已在 staging 验证", cls: "ok", items: ["客户报表按天 / 渠道 / campaign", "渠道、campaign 统计", "和 direct spend 对数一致"] },
    { n: "阶段 4", name: "使用记录", state: "已完成", cls: "ok", items: ["每次调用记谁、哪个工具、耗时、成败", "个人 MCP 令牌", "本地 SQLite"] },
  ];
  async function loadOverview() {
    $("stages").innerHTML = STAGES.map((s) => `<div class="stage${s.cls === "warn" ? " current" : ""}"><span class="n">${s.n}</span><h3>${esc(s.name)}</h3>
      <span class="pill ${s.cls}" style="justify-self:start">${esc(s.state)}</span><ul>${s.items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`).join("");
    try {
      const s = STATUS = await api("/api/status");
      $("tService").innerHTML = `<span class="pill ok">运行中</span>`;
      $("tServiceD").textContent = `v${s.version} · 已运行 ${fmtUptime(s.uptimeSec)} · 在线 ${s.activeSessions} 人`;
      const host = (u) => (u || "").replace(/^https?:\/\//, "");
      const isProd = (u) => /\/\/admin\.feedmob\.com/.test(u || "");
      $("tApi").innerHTML = s.mockApi ? `<span class="pill warn">Mock 数据</span>` : `<span class="pill ${isProd(s.readApiBase) ? "ok" : "warn"}">读：${isProd(s.readApiBase) ? "生产" : "测试"}</span> <span class="pill warn">写：${isProd(s.writeApiBase) ? "生产" : "测试"}</span>`;
      $("tApiD").textContent = `读 ${host(s.readApiBase)} · 写 ${host(s.writeApiBase)} · key ${s.apiKey}`;
      $("tTools").textContent = s.toolCount;
      $("tToolsD").textContent = s.writeEnabled ? "含写入工具" : `另有 ${s.hiddenWriteTools} 个写入工具未开启`;
      $("navFoot").textContent = `v${s.version}`;
    } catch (e) { $("tService").innerHTML = `<span class="pill err">异常</span>`; $("tServiceD").textContent = e.message; }
    api("/api/usage/summary?days=1").then((u) => {
      $("tCalls").textContent = num(u.total); $("tCallsD").textContent = `${u.users} 人 · 失败 ${u.failed} 次`;
    }).catch(() => { $("tCalls").textContent = "—"; });
    try {
      const { tools } = await api("/api/tools");
      $("toolRows").innerHTML = tools.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td>${esc(t.title)}</td><td>阶段 ${t.stage}</td>
        <td>${t.write ? '<span class="pill warn">写入</span>' : '<span class="pill ok">只读</span>'}</td>
        <td>${t.enabled ? '<span class="pill ok">可用</span>' : '<span class="pill idle">未开启</span>'}</td></tr>`).join("");
    } catch (e) { $("toolRows").innerHTML = empty(5, e.message, true); }
  }
  $("btnCheck").addEventListener("click", async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "测试中…";
    try {
      const r = await api("/api/upstream-check");
      $("tApiD").textContent = r.ok ? `连接正常 · ${r.ms} ms` : `连接失败：${r.error}`;
      toast(r.ok ? "上游 API 连接正常" : "上游 API 连接失败");
    } catch (err) { toast(err.message); }
    finally { b.disabled = false; b.textContent = "测试连接"; }
  });

  /* ================= clients (stage 1) ================= */
  let lastClients = [], lastQuery = "";
  function renderClients() {
    const rows = $("hideTest").checked ? lastClients.filter((r) => !r.for_test) : lastClients;
    $("clientRows").innerHTML = rows.length ? rows.map((r) => `<tr><td class="num mono">${esc(r.id)}</td><td>${esc(r.name)}</td>
      <td>${r.status ? `<span class="pill ${r.status === "normal" ? "ok" : "idle"}">${esc(r.status)}</span>` : ""}</td>
      <td>${esc(r.mmp_track_party ?? "")}</td><td>${r.for_test ? '<span class="pill warn">测试</span>' : ""}</td><td class="mono">${esc((r.created_at ?? "").slice(0, 10))}</td>
      <td style="white-space:nowrap"><a href="#spend:${r.id}">Spend</a> · <a href="#reports:${r.id}">Campaign</a></td></tr>`).join("")
      : empty(7, `没有匹配“${lastQuery}”的客户`);
    return { shown: rows.length, hidden: lastClients.length - rows.length };
  }
  async function queryClients() {
    const q = $("clientQ").value.trim(), btn = $("clientGo");
    btn.disabled = true; $("clientMeta").textContent = "查询中…";
    try {
      const r = await mustTool("get_clients", q ? { client_name: q } : {});
      lastClients = r.data; lastQuery = q;
      const { shown, hidden } = renderClients();
      $("clientMeta").textContent = `显示 ${shown} 条${hidden ? `（隐藏测试客户 ${hidden} 条）` : ""} · ${r.ms} ms`;
      $("clientCsv").disabled = !lastClients.length;
    } catch (e) { $("clientRows").innerHTML = empty(7, e.message, true); $("clientMeta").textContent = "查询失败"; }
    finally { btn.disabled = false; }
  }
  $("clientForm").addEventListener("submit", (e) => { e.preventDefault(); queryClients(); });
  $("hideTest").addEventListener("change", () => { if (lastClients.length) renderClients(); });
  $("clientCsv").addEventListener("click", () => downloadCsv(lastClients, "clients"));
  function downloadCsv(rows, name) {
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const cell = (v) => `"${String(typeof v === "object" && v !== null ? JSON.stringify(v) : v ?? "").replace(/"/g, '""')}"`;
    const csv = [keys.map(cell).join(","), ...rows.map((r) => keys.map((k) => cell(r[k])).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    a.download = `${name}_${isoDay(new Date())}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ================= spend & rate (stage 2) ================= */
  $("spStart").value = daysAgo(10); $("spEnd").value = daysAgo(1);
  const parseIds = (s) => s.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  async function querySpend() {
    const ids = parseIds($("spClick").value), client = $("spClient").value.trim();
    const start = $("spStart").value, end = $("spEnd").value;
    if (!ids.length && !client) { toast("请填 Click URL ID 或 Client ID"); return; }
    $("spGo").disabled = true; $("spMeta").textContent = "查询中…";
    try {
      const sp = await mustTool("get_direct_spends", { start_date: start, end_date: end, ...(ids.length ? { click_url_ids: ids } : {}), ...(client ? { client_id: Number(client) } : {}) });
      const d = sp.data;
      const rateIds = ids.length ? ids : d.by_click_url.slice(0, 50).map((x) => x.click_url_id);
      let rates = { periods: [], rows: [] };
      if (rateIds.length) rates = (await mustTool("get_click_url_histories", { click_url_ids: rateIds, start_date: start, end_date: end })).data;
      $("spTiles").hidden = $("spResult").hidden = $("spDailyPanel").hidden = false;
      $("spNet").textContent = money(d.totals.net); $("spGross").textContent = money(d.totals.gross);
      $("spMargin").textContent = d.totals.gross ? pct((1 - d.totals.net / d.totals.gross) * 100) : "—";
      $("spCount").textContent = `${d.by_click_url.length} / ${new Set(d.rows.map((r) => r.date)).size}`;
      $("spByUrl").innerHTML = d.by_click_url.length ? d.by_click_url.map((u) => `<tr><td class="mono">${u.click_url_id}</td><td>${esc(u.campaign_name)}</td>
        <td class="num">${u.days}</td><td class="num">${money(u.net)}</td><td class="num">${money(u.gross)}</td><td class="num">${pct(u.margin_pct)}</td></tr>`).join("") : empty(6, "这段时间没有 spend");
      $("spPeriods").innerHTML = rates.periods.length ? rates.periods.map((p) => `<tr><td class="mono">${p.click_url_id}</td><td class="mono">${p.from}</td><td class="mono">${p.to}</td>
        <td class="num">${p.net_cpi}</td><td class="num">${p.gross_cpi}</td><td class="num">${p.margin ?? "N/A"}</td></tr>`).join("") : empty(6, "没有单价记录");
      const rateBy = new Map(rates.rows.map((r) => [`${r.click_url_id}|${r.date}`, r]));
      const daily = [...d.rows].sort((a, b) => b.date.localeCompare(a.date) || a.click_url_id - b.click_url_id);
      $("spDaily").innerHTML = daily.length ? daily.map((r) => { const rt = rateBy.get(`${r.click_url_id}|${r.date}`) || {};
        return `<tr><td class="mono">${r.date}</td><td class="mono" title="${esc(r.campaign_name)}">${r.click_url_id}</td><td class="num">${money(r.feedmob_net_spend)}</td>
          <td class="num">${money(r.feedmob_gross_spend)}</td><td class="num">${rt.net_cpi ?? "—"}</td><td class="num">${rt.gross_cpi ?? "—"}</td><td class="num">${rt.margin ?? "—"}</td></tr>`; }).join("") : empty(7, "没有明细");
      $("spMeta").textContent = `${sp.summary} · ${sp.ms} ms`;
    } catch (e) { $("spMeta").textContent = e.message; toast("查询失败"); }
    finally { $("spGo").disabled = false; }
  }
  $("spendForm").addEventListener("submit", (e) => { e.preventDefault(); querySpend(); });

  // ---- write forms ----
  tabs($("view-spend").querySelector(".tabs"));
  $("view-spend").querySelector(".tabs").addEventListener("tab", () => { $("writeConfirm").innerHTML = ""; });
  function formArgs(form) {
    const args = {};
    for (const [k, v0] of new FormData(form).entries()) {
      const v = String(v0).trim(); if (!v) continue;
      if (k === "prices") {
        args.prices = v.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
          const [spend_date, net_cpi, gross_cpi, margin] = line.split(/\s*[,，\t]\s*/);
          return { spend_date, net_cpi, gross_cpi, margin };
        });
      } else if (k === "click_url_id" || k === "id") args[k] = Number(v);
      else args[k] = v;
    }
    return args;
  }
  function renderConfirm(tool, args, extra = "") {
    const can = STATUS.writeEnabled;
    $("writeConfirm").innerHTML = `<div class="confirm"><h3>确认要调用 ${esc(tool)}？</h3>${extra}
      <pre class="code">${esc(JSON.stringify(args, null, 2))}</pre>
      <p style="font-size:13px">这会修改 <b>${esc((STATUS.writeApiBase || STATUS.apiBase || "").replace(/^https?:\/\//, ""))}</b> 上的数据（写入环境），审计备注里会记下你的邮箱。上面查询看到的数据来自读取环境 ${esc((STATUS.readApiBase || "").replace(/^https?:\/\//, ""))}，两者不同时，记录可能对不上。</p>
      <div class="row-actions"><button class="primary" type="button" id="wGo" ${can ? "" : "disabled"}>${can ? "确认提交" : "写入未开启，不能提交"}</button><button type="button" id="wCancel">取消</button></div>
      <div id="wResult"></div></div>`;
    $("wCancel").onclick = () => { $("writeConfirm").innerHTML = ""; };
    $("wGo").onclick = async () => {
      $("wGo").disabled = true; $("wResult").innerHTML = `<p class="muted">提交中…</p>`;
      try {
        const r = await callTool(tool, args);
        if (!r.ok && r.data?.confirmation_required) {
          const warns = (r.data.warnings || []).map((w) => `<li><b>${esc(w.title || "")}</b> ${esc(w.content || w.message || JSON.stringify(w))}</li>`).join("");
          renderConfirm(tool, { ...args, confirm: true }, `<p class="notice">API 返回了警告，<b>上一次提交没有保存任何修改</b>。看完下面的警告，确认没问题再提交。</p><ul>${warns}</ul>`);
          return;
        }
        $("wResult").innerHTML = `<p>${r.ok ? '<span class="pill ok">成功</span>' : '<span class="pill err">失败</span>'} ${esc(r.summary)}</p>${r.data ? `<pre class="code">${esc(JSON.stringify(r.data, null, 2))}</pre>` : ""}`;
        if (!r.ok) $("wResult").insertAdjacentHTML("beforeend", `<p class="notice">操作未确认；请先核实写入环境，不要自动重试。</p>`);
        if (r.ok) {
          toast("写入请求已成功，请核对读回状态");
          if (tool === "update_direct_spend") {
            $("wResult").insertAdjacentHTML("beforeend", `<p class="notice">${esc(r.data?.readback?.message || "请在写入环境核实。") } 外部 Admin 页面如仍显示旧值，请手动刷新。</p>`);
            if (STATUS.readApiBase === STATUS.writeApiBase && (parseIds($("spClick").value).length || $("spClient").value.trim())) await querySpend();
          }
        }
      } catch (e) { $("wResult").innerHTML = `<p style="color:var(--err)">${esc(e.message)}；请求结果未确认，请先核实，勿重复提交。</p>`; }
    };
  }
  ["w-create", "w-update"].forEach((id) => $(id).addEventListener("submit", (e) => {
    e.preventDefault(); renderConfirm(e.currentTarget.dataset.tool, formArgs(e.currentTarget));
  }));

  /* ---- auto-find spend for the create form ---- */
  $("supFile").addEventListener("change", async () => {
    const file = $("supFile").files[0]; if (!file) return;
    if (file.size > 100000) { $("supSummary").textContent = "CSV 文件超过 100,000 字节"; $("supCsv").value = ""; return; }
    $("supCsv").value = await file.text(); $("supSummary").textContent = "已读取 CSV 文件，请核对字段和映射。";
  });
  $("suppliedForm").addEventListener("submit", async (e) => {
    e.preventDefault(); $("supSummary").textContent = "检查中…"; $("supOutput").textContent = "";
    try {
      const filters = $("supFilters").value.trim();
      const mapping = filters ? { basis: $("supBasis").value.trim(), filters: JSON.parse(filters), ...($("supMapStart").value ? { effective_from: $("supMapStart").value } : {}), ...($("supMapEnd").value ? { effective_to: $("supMapEnd").value } : {}) } : undefined;
      const ledger = $("supLedgerCurrency").value.trim() || $("supLedgerBasis").value.trim() ? { currency: $("supLedgerCurrency").value.trim(), basis: $("supLedgerBasis").value.trim() } : undefined;
      const rulePresent = ["supMargin", "supRuleCurrency", "supRuleStart", "supRuleEnd", "supRuleBasis"].some(id => $(id).value.trim());
      if (rulePresent && ["supMargin", "supRuleCurrency", "supRuleStart", "supRuleEnd", "supRuleBasis"].some(id => !$(id).value.trim())) throw new Error("计费规则字段不完整：请填写 margin、币种、生效起止日和依据");
      const billing_rule = rulePresent ? { type: "margin_on_gross", margin_percent: Number($("supMargin").value), currency: $("supRuleCurrency").value.trim(), effective_from: $("supRuleStart").value, effective_to: $("supRuleEnd").value, basis: $("supRuleBasis").value.trim() } : undefined;
      const columns = { date: $("supDay").value.trim(), net: $("supNet").value.trim() };
      if ($("supCurrency").value.trim()) columns.currency = $("supCurrency").value.trim();
      if ($("supGross").value.trim()) columns.gross = $("supGross").value.trim();
      if ($("supId").value.trim()) columns.click_url_id = $("supId").value.trim();
      const r = await mustTool("preview_supplied_spend_report", { click_url_id: Number($("supUrl").value), spend_date: $("supDate").value, source_name: $("supSource").value, csv_text: $("supCsv").value, columns, date_format: $("supDateFormat").value, ...(mapping ? { mapping } : {}), ...(ledger ? { ledger } : {}), ...(billing_rule ? { billing_rule } : {}), check_existing: true });
      $("supSummary").textContent = r.summary; $("supOutput").textContent = JSON.stringify(r.data, null, 2);
    } catch (err) { $("supSummary").textContent = err.message; }
  });
  $("spFind").addEventListener("click", async () => {
    const form = $("w-create"), get = (n) => form.querySelector(`[name=${n}]`);
    const id = Number(get("click_url_id").value.trim()), day = get("spend_date").value;
    if (!Number.isInteger(id) || id <= 0 || !day) { toast("先填 Click URL ID 和日期"); return; }
    const box = $("spFindResult"), btn = $("spFind");
    btn.disabled = true; box.innerHTML = `<p class="muted" style="font-size:13px">查找中…（会查已有记录、AppsFlyer/Kochava、内部 report 和后台任务）</p>`;
    try {
      const r = await mustTool("find_direct_spend", { click_url_id: id, spend_date: day });
      const f = r.data, pill = { ready: "ok", partial: "warn", not_found: "err", exists: "idle" }[f.status], label = { ready: "找到了", partial: "只找到一部分", not_found: "没找到", exists: "已有记录" }[f.status];
      const side = (name, s) => `<tr><td>${name}</td><td class="num">${s.value ?? "—"}</td><td>${esc(s.how)}</td></tr>`;
      box.innerHTML = `<div class="confirm" style="border-color:var(--line);background:var(--sunk)">
        <p><span class="pill ${pill}">${label}</span> ${esc(f.advice)}</p>
        ${f.status === "exists" ? "" : `<div class="tbl-wrap"><table><thead><tr><th></th><th class="num">金额</th><th>怎么来的</th></tr></thead><tbody>${side("Gross", f.gross)}${side("Net", f.net)}</tbody></table></div>`}
        ${f.job ? `<p class="muted" style="font-size:12.5px">后台任务 ${esc(f.job.name)}：gross 来自“${esc(f.job.gross_source)}”，net 来自“${esc(f.job.net_source)}”</p>` : ""}
        ${f.rate ? `<p class="muted" style="font-size:12.5px">当天单价：net CPI ${f.rate.net_cpi === -1 ? "动态" : f.rate.net_cpi} / gross CPI ${f.rate.gross_cpi === -1 ? "动态" : f.rate.gross_cpi} / margin ${f.rate.margin ?? "动态"}${f.rate.margin == null ? "" : "%"}，计费方式 ${esc(f.rate.client_paid_action || "")} / ${esc(f.rate.vendor_paid_action || "")}</p>` : ""}</div>`;
      if (f.gross.value !== null && f.status !== "exists") get("gross_spend").value = f.gross.value;
      if (f.net.value !== null && f.status !== "exists") get("net_spend").value = f.net.value;
      if (f.proposal?.installs_count !== undefined) get("installs_count").value = f.proposal.installs_count;
      if (f.status === "ready" || f.status === "partial") {
        if (!get("audit_comment").value.trim()) get("audit_comment").value = `自动查找：gross = ${f.gross.how}；net = ${f.net.how}`.slice(0, 480);
        toast(f.status === "ready" ? "已填好金额，核对后点“预览”" : "只填了一项，另一项需要你补上");
      }
    } catch (e) { box.innerHTML = `<p style="color:var(--err);font-size:13px">${esc(e.message)}</p>`; }
    finally { btn.disabled = false; }
  });

  /* ---- historical price editor (table of inputs) ---- */
  const pcRows = $("pcRows"), yday = daysAgo(1);
  $("pcStart").value = daysAgo(7); $("pcEnd").value = yday;
  $("pcStart").max = $("pcEnd").max = yday;
  const normRate = (v) => /^n\/a$/i.test(String(v).trim()) ? "N/A" : String(v).trim();
  const rateFromApi = (v) => (v === null || v === undefined || Number(v) === -1) ? "N/A" : String(v);
  function syncPcEmpty() { $("pcEmpty").hidden = pcRows.children.length > 0; }
  function addPriceRow(v = {}) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><input type="date" class="pc-date" max="${yday}" value="${esc(v.date || "")}" aria-label="日期"></td>
      <td><input class="pc-net" inputmode="decimal" placeholder="1.1 或 N/A" value="${esc(v.net ?? "")}" aria-label="Net CPI"></td>
      <td><input class="pc-gross" inputmode="decimal" placeholder="3 或 N/A" value="${esc(v.gross ?? "")}" aria-label="Gross CPI"></td>
      <td><input class="pc-margin" inputmode="decimal" placeholder="63 或 N/A" value="${esc(v.margin ?? "")}" aria-label="Margin %"></td>
      <td><button type="button" aria-label="删除这一行">删除</button></td>`;
    tr.querySelector("button").onclick = () => { tr.remove(); syncPcEmpty(); };
    pcRows.appendChild(tr); syncPcEmpty(); return tr;
  }
  const eachDay = (start, end) => {
    const out = []; for (let t = Date.parse(start); t <= Date.parse(end) && out.length <= 370; t += 86400000) out.push(isoDay(new Date(t))); return out;
  };
  const rowFor = (date) => [...pcRows.children].find((tr) => tr.querySelector(".pc-date").value === date);
  function upsertRow(date, v) {
    const tr = rowFor(date) || addPriceRow({ date });
    tr.querySelector(".pc-net").value = v.net; tr.querySelector(".pc-gross").value = v.gross; tr.querySelector(".pc-margin").value = v.margin;
  }
  function rangeOrToast() {
    const s = $("pcStart").value, e = $("pcEnd").value;
    if (!s || !e || s > e) { toast("请先选好开始和结束日期"); return null; }
    if (e > yday) { toast("结束日期必须是今天之前"); return null; }
    const days = eachDay(s, e);
    if (days.length > 370) { toast("一次最多 370 天"); return null; }
    return days;
  }
  $("pcAdd").onclick = () => addPriceRow();
  $("pcClear").onclick = () => { pcRows.innerHTML = ""; syncPcEmpty(); };
  $("pcFill").onclick = () => {
    const days = rangeOrToast(); if (!days) return;
    const v = { net: normRate($("pcFillNet").value), gross: normRate($("pcFillGross").value), margin: normRate($("pcFillMargin").value) };
    if (!v.net || !v.gross || !v.margin) { toast("请把 Net CPI、Gross CPI、Margin 都填上"); return; }
    days.forEach((d) => upsertRow(d, v)); toast(`已填充 ${days.length} 天`);
  };
  $("pcLoad").onclick = async () => {
    const id = Number($("w-prices").querySelector('[name=click_url_id]').value.trim());
    if (!Number.isInteger(id) || id <= 0) { toast("请先填 Click URL ID"); return; }
    const days = rangeOrToast(); if (!days) return;
    $("pcLoad").disabled = true;
    try {
      const r = await mustTool("get_click_url_histories", { click_url_ids: [id], start_date: days[0], end_date: days[days.length - 1] });
      if (!r.data.rows.length) { toast("这段时间没有单价记录"); return; }
      pcRows.innerHTML = "";
      r.data.rows.sort((a, b) => a.date.localeCompare(b.date)).forEach((x) => addPriceRow({ date: x.date, net: rateFromApi(x.net_cpi), gross: rateFromApi(x.gross_cpi), margin: rateFromApi(x.margin) }));
      toast(`已载入 ${r.data.rows.length} 天，改完点“预览”`);
    } catch (e) { toast(e.message); }
    finally { $("pcLoad").disabled = false; }
  };
  function priceArgs() {
    const id = Number($("w-prices").querySelector('[name=click_url_id]').value.trim());
    if (!Number.isInteger(id) || id <= 0) { toast("请填 Click URL ID"); return null; }
    const trs = [...pcRows.children];
    if (!trs.length) { toast("请至少加一行"); return null; }
    const seen = new Set(), prices = [];
    for (let i = 0; i < trs.length; i++) {
      const tr = trs[i], n = i + 1;
      const row = { spend_date: tr.querySelector(".pc-date").value, net_cpi: normRate(tr.querySelector(".pc-net").value), gross_cpi: normRate(tr.querySelector(".pc-gross").value), margin: normRate(tr.querySelector(".pc-margin").value) };
      if (!row.spend_date) { toast(`第 ${n} 行：请选日期`); return null; }
      if (row.spend_date > yday) { toast(`第 ${n} 行：日期必须是今天之前`); return null; }
      if (seen.has(row.spend_date)) { toast(`第 ${n} 行：日期 ${row.spend_date} 重复了`); return null; }
      seen.add(row.spend_date);
      for (const [k, label] of [["net_cpi", "Net CPI"], ["gross_cpi", "Gross CPI"], ["margin", "Margin"]]) {
        const v = row[k];
        if (v === "") { toast(`第 ${n} 行：${label} 没填（动态请填 N/A）`); return null; }
        if (v !== "N/A" && !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(v)) { toast(`第 ${n} 行：${label} 不是数字`); return null; }
        if (k !== "margin" && v !== "N/A" && Number(v) < 0) { toast(`第 ${n} 行：${label} 不能为负数`); return null; }
      }
      prices.push(row);
    }
    return { click_url_id: id, prices };
  }
  const priceTable = (prices) => `<div class="tbl-wrap"><table><thead><tr><th>日期</th><th class="num">Net CPI</th><th class="num">Gross CPI</th><th class="num">Margin %</th></tr></thead><tbody>${
    prices.map((p) => `<tr><td class="mono">${esc(p.spend_date)}</td><td class="num">${esc(p.net_cpi)}</td><td class="num">${esc(p.gross_cpi)}</td><td class="num">${esc(p.margin)}</td></tr>`).join("")}</tbody></table></div>`;
  $("w-prices").addEventListener("submit", (e) => {
    e.preventDefault(); const a = priceArgs(); if (!a) return;
    renderConfirm("update_click_url_prices", a, `<p style="font-size:13px">将修改 click URL <b>${a.click_url_id}</b> 的 <b>${a.prices.length}</b> 天单价：</p>${priceTable(a.prices)}`);
  });
  syncPcEmpty();

  /* ================= reports (stage 3) ================= */
  const reportTabs = $("view-reports").querySelector(".tabs");
  tabs(reportTabs);
  reportTabs.addEventListener("tab", (e) => { if (e.detail === "r-vendors" && !loaded.vendors) { loaded.vendors = true; loadVendors(); } });
  $("rpStart").value = daysAgo(7); $("rpEnd").value = daysAgo(1);
  let reportMeta = {};
  async function loadReports() {
    try {
      const r = await mustTool("get_client_report_spend_report_names");
      reportMeta = Object.fromEntries(r.data.map((x) => [x.name, x]));
      $("rpName").innerHTML = r.data.map((x) => `<option value="${esc(x.name)}">${esc(x.admin_name ? (x.admin_name === x.name ? x.name : `${x.admin_name} · ${x.name}`) : `${x.name}（后台名称未确认）`)}</option>`).join("");
    } catch (e) { $("rpName").innerHTML = `<option>加载失败：${esc(e.message)}</option>`; }
  }
  $("rpForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if ($("rpBasis").value === "direct") { $("rpTiles").hidden = $("rpResult").hidden = $("rpCampPanel").hidden = $("rpMeta").hidden = true; await runCompare(); return; }
    $("rpGo").disabled = true;
    try {
      const r = await mustTool("get_client_report_spends", { report_name: $("rpName").value, start_date: $("rpStart").value, end_date: $("rpEnd").value });
      const d = r.data;
      $("rpTiles").hidden = $("rpResult").hidden = $("rpCampPanel").hidden = false;
      $("rpMeta").hidden = false;
      $("rpMeta").innerHTML = `后台名称：<b>${esc(d.admin_name || "未确认")}</b> · 接口名：<code>${esc(d.report_name)}</code> · 读取环境：${esc((STATUS.readApiBase || "").replace(/^https?:\/\//, ""))} · ${esc(d.source_note)} · ${esc(d.currency_info.warning || `币种：${d.currency_info.currency || "未知"}`)} · ${esc(d.completeness_warning)}`;
      $("rpTotal").textContent = money(d.total_gross); $("rpRows").textContent = num(d.rows);
      $("rpVendors").textContent = d.by_vendor.length; $("rpClients").textContent = d.clients.join("、") || "—";
      bars($("rpByDay"), d.by_day.map((x) => ({ label: x.key, value: x.gross })), money);
      bars($("rpByVendor"), d.by_vendor.map((x) => ({ label: x.key, value: x.gross })), money);
      $("rpByCampaign").innerHTML = d.by_campaign.length ? d.by_campaign.map((c) => `<tr><td>${esc(c.key)}</td><td class="num">${c.rows}</td><td class="num">${money(c.gross)}</td></tr>`).join("") : empty(3, "没有数据");
      toast(r.summary);
    } catch (err) { toast(err.message); }
    finally { $("rpGo").disabled = false; }
  });

  /* ---- client report overview + reconciliation ---- */
  $("ovStart").value = daysAgo(14); $("ovEnd").value = daysAgo(1);
  const HEALTH = { ok: ["ok", "完整"], gaps: ["warn", "有缺天"], empty: ["idle", "无数据"] };
  async function loadReportHealth() {
    $("ovGo").disabled = true; $("ovMeta").textContent = "统计中…（逐个查询全部报表）";
    try {
      const r = await mustTool("get_client_report_overview", { start_date: $("ovStart").value, end_date: $("ovEnd").value });
      const list = r.data.reports, c = (st) => list.filter((x) => x.status === st).length;
      $("ovTiles").hidden = $("ovPanel").hidden = false;
      $("ovCount").textContent = list.length; $("ovOk").textContent = c("ok"); $("ovGaps").textContent = c("gaps"); $("ovEmpty").textContent = c("empty");
      $("ovRows").innerHTML = list.map((x) => { const [cls, label] = HEALTH[x.status];
        const miss = x.missing_days.length > 6 ? `${x.missing_days.slice(0, 6).map((d) => d.slice(5)).join("、")} 等 ${x.missing_days.length} 天` : x.missing_days.map((d) => d.slice(5)).join("、");
        return `<tr><td>${esc(x.admin_name || x.name)}${x.admin_name && x.admin_name !== x.name ? `<br><span class="muted mono" style="font-size:11.5px">${esc(x.name)}</span>` : ""}</td>
          <td><span class="pill ${cls}">${label}</span></td><td class="num">${x.days_with_data}/${x.days_in_range}</td><td class="mono" style="white-space:nowrap">${esc(x.latest_spend_date || "—")}</td>
          <td class="mono" style="white-space:nowrap">${esc(x.last_upload ? localTime(x.last_upload) : "—")}</td><td>${esc(miss || "—")}</td>
          <td style="font-size:12.5px">${esc(x.vendors.join("、") || "—")}</td><td class="num">${x.rows ? money(x.total_gross) : "—"}</td>
          <td>${x.rows ? `<button type="button" data-open="${esc(x.name)}">对账</button>` : ""}</td></tr>`; }).join("");
      $("ovRows").querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openReport(b.dataset.open, $("ovStart").value, $("ovEnd").value)));
      $("ovMeta").textContent = `${r.summary} · 日期覆盖不代表数据完整；币种及分页需核实 · ${(r.ms / 1000).toFixed(1)} 秒`;
    } catch (e) { $("ovMeta").textContent = e.message; toast("统计失败"); }
    finally { $("ovGo").disabled = false; }
  }
  $("ovForm").addEventListener("submit", (e) => { e.preventDefault(); loadReportHealth(); });
  async function openReport(name, start, end) {
    reportTabs.querySelector('[data-tab="r-internal"]').click();
    if (!Object.keys(reportMeta).length) await loadReports();
    $("rpName").value = name; $("rpStart").value = start; $("rpEnd").value = end;
    $("rpForm").requestSubmit(); runCompare();
  }
  let cmpData = null;
  const CMP = { match: ["ok", "一致"], diff: ["warn", "金额不同"], missing_in_report: ["err", "报表缺失"], missing_in_direct: ["idle", "direct 缺失"], outside_report_scope: ["warn", "报表范围待确认"] };
  function renderCompareRows() {
    if (!cmpData) return;
    const rows = ($("cmpAll").checked || !cmpData.currency_info.currency) ? cmpData.rows : cmpData.rows.filter((x) => x.status !== "match");
    $("cmpRows").innerHTML = rows.length ? rows.map((x) => `<tr><td class="mono">${x.date}</td><td class="mono" title="${esc(x.campaign_name)}">${x.click_url_id}</td><td>${esc(x.vendor_name)}</td>
      <td class="num">${money(x.report_gross)}</td><td class="num">${money(x.direct_gross)}</td><td class="num${x.diff > 0 && cmpData.currency_info.currency ? " neg" : ""}">${x.diff == null || !cmpData.currency_info.currency ? "—" : money(-x.diff)}</td>
      <td>${x.report_rows} / ${x.direct_rows}</td><td><span class="pill ${CMP[x.status][0]}">${!cmpData.currency_info.currency && ["match", "diff"].includes(x.status) ? "币种待核实" : CMP[x.status][1]}</span></td></tr>`).join("") : empty(8, "没有差异");
  }
  async function runCompare() {
    const btn = $("rpCompare"); btn.disabled = true; $("cmpPanel").hidden = false; $("cmpMeta").textContent = "对账中…"; cmpData = null; $("cmpCounts").innerHTML = $("cmpByUrl").innerHTML = $("cmpRows").innerHTML = "";
    try {
      const rawScope = $("rpScope").value.trim();
      const parts = rawScope ? rawScope.split(/[\s,，]+/) : [];
      if (parts.some((x) => !/^\d+$/.test(x) || !Number.isSafeInteger(Number(x)) || Number(x) <= 0)) throw new Error("额外对照范围只能填写正整数 Click URL ID");
      const r = await mustTool("compare_client_report_with_direct_spend", { report_name: $("rpName").value, start_date: $("rpStart").value, end_date: $("rpEnd").value, ...(parts.length ? { click_url_ids: parts.map(Number) } : {}) });
      cmpData = r.data; const d = r.data;
      if (!d.counts) { $("cmpCounts").innerHTML = ""; $("cmpByUrl").innerHTML = empty(8, r.summary); $("cmpRows").innerHTML = ""; $("cmpMeta").textContent = ""; return; }
      $("cmpCounts").innerHTML = Object.entries(d.counts).filter(([k]) => d.currency_info.currency || !["match", "diff"].includes(k)).map(([k, n]) => `<span class="pill ${CMP[k][0]}">${CMP[k][1]} ${n}</span>`).join(" ")
        + (d.currency_info.currency ? ` <span class="muted" style="font-size:12.5px">日报 gross ${money(d.totals.report_gross)} · 后台 gross ${money(d.totals.direct_gross)} · 总差额（后台 − 日报）${d.totals.report_gross == null || d.totals.direct_gross == null ? "—" : money(d.totals.direct_gross - d.totals.report_gross)} · 日报缺记录部分 ${money(d.totals.missing_in_report_gross)} · 后台缺记录部分（后台 − 日报）${money(-d.rows.filter(x => x.status === "missing_in_direct").reduce((s, x) => s + x.report_gross, 0))} · 双方有记录的金额差（后台 − 日报）${money(d.rows.filter(x => x.status === "diff").reduce((s, x) => s - x.diff, 0))} · 容差内差额 ${money(d.rows.filter(x => x.status === "match").reduce((s, x) => s - x.diff, 0))} · 归属待确认部分 ${money(d.totals.outside_report_scope_gross)}</span>` : ' <span class="muted">币种未确认，隐藏差额和金额一致性判断。</span>');
      $("cmpByUrl").innerHTML = d.by_click_url.map((b) => { const diff = b.report_gross == null || b.direct_gross == null ? null : b.direct_gross - b.report_gross;
        return `<tr><td class="mono">${b.click_url_id}${b.report_membership === "unconfirmed" ? ' <span class="pill warn">归属待确认</span>' : ""}</td><td>${esc(b.vendor_name)}</td><td>${esc(b.campaign_name)}</td><td class="num">${money(b.report_gross)}</td><td class="num">${money(b.direct_gross)}</td>
          <td class="num${diff < 0 ? " neg" : ""}">${diff == null || !d.currency_info.currency ? "—" : money(diff)}</td><td class="num">${d.currency_info.currency ? `${b.diff_days} 天` : "—"}</td><td>${b.missing_in_report.length ? `<span class="pill err">${b.missing_in_report.length} 天</span> ${esc(b.missing_in_report.map((x) => x.slice(5)).join("、"))}` : "—"}</td></tr>`; }).join("");
      renderCompareRows();
      $("cmpMeta").textContent = `${d.start_date} ~ ${d.end_date} · ${d.scope.warning} · ${d.currency_info.warning || `币种：${d.currency_info.currency || "未知"}`} · ${d.completeness_warning} · ${r.ms} ms`;
    } catch (e) { $("cmpMeta").textContent = e.message; toast("对账失败"); }
    finally { btn.disabled = false; }
  }
  $("rpCompare").addEventListener("click", runCompare);
  $("cmpAll").addEventListener("change", renderCompareRows);

  $("vrStart").value = daysAgo(14); $("vrEnd").value = daysAgo(1);
  async function vendorReport(compare) {
    $("vrSummary").textContent = "查询中…"; $("vrResult").hidden = true;
    try {
      const args = { partner: $("vrPartner").value, start_date: $("vrStart").value, end_date: $("vrEnd").value };
      if ($("vrClient").value) args.client_id = Number($("vrClient").value);
      if ($("vrIds").value.trim()) args.report_ids = JSON.parse($("vrIds").value);
      if (compare) {
        if ($("vrScope").value.trim()) args.click_url_ids = $("vrScope").value.split(",").map((x) => x.trim()).filter(Boolean);
        if ($("vrTolerance").value !== "") args.tolerance = Number($("vrTolerance").value);
      }
      const result = await mustTool(compare ? "compare_vendor_report_with_direct_spend" : "get_vendor_report_overview", args);
      $("vrSummary").textContent = result.summary; $("vrOutput").textContent = JSON.stringify(result.data, null, 2); $("vrResult").hidden = false;
    } catch (e) { $("vrSummary").textContent = e.message; }
  }
  $("vrForm").addEventListener("submit", (e) => { e.preventDefault(); vendorReport(false); });
  $("vrCompare").addEventListener("click", () => vendorReport(true));

  let vendors = [], vdFilter = { status: "", type: "" };
  async function loadVendors() {
    try { const r = await mustTool("get_vendors"); vendors = r.data.rows; renderVendorChips(r.data); renderVendors(); }
    catch (e) { $("vdRows").innerHTML = empty(5, e.message, true); }
  }
  function renderVendorChips(d) {
    const chips = (el, key, counts) => {
      el.innerHTML = `<button type="button" class="chip" data-v="" aria-pressed="true">全部${key === "status" ? "状态" : "类型"}</button>` +
        Object.entries(counts).map(([k, n]) => `<button type="button" class="chip" data-v="${esc(k)}" aria-pressed="false">${esc(k)} <b>${n}</b></button>`).join("");
      el.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
        el.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
        vdFilter[key] = c.dataset.v; renderVendors();
      }));
    };
    chips($("vdStatus"), "status", d.by_status); chips($("vdType"), "type", d.by_type);
  }
  function renderVendors() {
    const q = $("vdQ").value.trim().toLowerCase();
    const rows = vendors.filter((v) => (!q || v.vendor_name.toLowerCase().includes(q)) && (!vdFilter.status || v.status === vdFilter.status) && (!vdFilter.type || v.vendor_type === vdFilter.type));
    $("vdMeta").textContent = `${rows.length} / ${vendors.length} 个渠道`;
    const cls = { running: "ok", paused: "idle", archived: "idle", onboarding: "warn" };
    $("vdRows").innerHTML = rows.length ? rows.map((v) => `<tr><td class="num mono">${v.id}</td><td>${esc(v.vendor_name)}${v.for_test ? ' <span class="pill warn">测试</span>' : ""}</td>
      <td><span class="pill ${cls[v.status] || "idle"}">${esc(v.status)}</span></td><td>${esc(v.vendor_type)}</td><td class="mono">${esc((v.created_at || "").slice(0, 10))}</td></tr>`).join("") : empty(5, "没有匹配的渠道");
  }
  $("vdQ").addEventListener("input", renderVendors);

  async function queryCampaigns() {
    const client = $("cpClient").value.trim();
    if (!client) { toast("请填 Client ID"); return; }
    $("cpMeta").textContent = "查询中…";
    try {
      const r = await mustTool("get_campaigns", { client_id: Number(client), include_archived: $("cpArchived").checked });
      const d = r.data;
      $("cpOs").innerHTML = Object.entries(d.by_os).map(([k, n]) => `<span class="chip">${esc(k)} <b>${n}</b></span>`).join("");
      $("cpRows").innerHTML = d.rows.length ? d.rows.map((c) => `<tr><td class="num mono">${c.id}</td><td>${esc(c.name)}</td><td>${esc(c.os)}</td>
        <td><span class="pill ${c.status === "normal" ? "ok" : "idle"}">${esc(c.status)}</span></td><td>${c.agency ? "是" : ""}</td><td class="mono">${esc((c.created_at || "").slice(0, 10))}</td></tr>`).join("") : empty(6, "这个客户没有 campaign");
      $("cpMeta").textContent = `${r.summary} · ${r.ms} ms`;
    } catch (e) { $("cpRows").innerHTML = empty(6, e.message, true); $("cpMeta").textContent = "查询失败"; }
  }
  $("cpForm").addEventListener("submit", (e) => { e.preventDefault(); queryCampaigns(); });

  /* ================= usage (stage 4) ================= */
  async function loadUsage() {
    const days = $("usDays").value;
    try {
      const s = await api(`/api/usage/summary?days=${days}`);
      $("usTotal").textContent = num(s.total); $("usUsers").textContent = num(s.users);
      $("usFail").textContent = s.total ? pct(s.failed / s.total * 100) : "—"; $("usFailD").textContent = `${s.failed} 次失败`;
      $("usAvg").textContent = s.total ? `${num(s.avgMs)} ms` : "—";
      bars($("usByTool"), s.byTool.map((r) => ({ label: r.tool, value: r.n, display: `${r.n}${r.failed ? ` / ${r.failed} 失败` : ""}`, err: r.failed > 0 && r.failed === r.n })));
      bars($("usByCaller"), s.byCaller.map((r) => ({ label: r.caller, value: r.n })));
      bars($("usByDay"), s.byDay.map((r) => ({ label: r.day, value: r.n })));
      bars($("usBySource"), s.bySource.map((r) => ({ label: r.source, value: r.n })));
      const keep = (el, vals) => { const cur = el.value; el.innerHTML = `<option value="">全部</option>` + vals.map((v) => `<option${v === cur ? " selected" : ""}>${esc(v)}</option>`).join(""); };
      keep($("usCaller"), s.byCaller.map((r) => r.caller)); keep($("usTool"), s.byTool.map((r) => r.tool));
    } catch (e) { toast(e.message); }
    loadCalls();
  }
  async function loadCalls() {
    const q = new URLSearchParams({ days: $("usDays").value, limit: "200" });
    if ($("usCaller").value) q.set("caller", $("usCaller").value);
    if ($("usTool").value) q.set("tool", $("usTool").value);
    try {
      const { calls } = await api(`/api/usage/calls?${q}`);
      $("usRows").innerHTML = calls.length ? calls.map((c) => `<tr><td class="mono" style="white-space:nowrap">${esc(localTime(c.ts))}</td><td>${esc(c.caller)}</td><td>${esc(c.source)}</td>
        <td><code>${esc(c.tool)}</code></td><td class="mono" style="max-width:260px;overflow-wrap:anywhere;font-size:12px">${esc(c.args === "{}" ? "" : c.args)}</td>
        <td class="num">${num(c.duration_ms)} ms</td><td>${c.ok ? '<span class="pill ok">成功</span>' : `<span class="pill err" title="${esc(c.error)}">失败</span>`}</td></tr>`).join("")
        : empty(7, "这段时间还没有调用记录");
    } catch (e) { $("usRows").innerHTML = empty(7, e.message, true); }
  }
  $("usDays").addEventListener("change", loadUsage); $("usRefresh").addEventListener("click", loadUsage);
  $("usCaller").addEventListener("change", loadCalls); $("usTool").addEventListener("change", loadCalls);

  /* ================= personal tokens ================= */
  /* ---- connect snippets for any agent ---- */
  let connToken = "", connKind = "claude-code";
  const PLACEHOLDER = "<你的个人令牌>";
  const CLIENTS = [
    { id: "claude-code", label: "Claude Code", note: "在终端执行，然后重启 Claude Code。",
      snippet: (U, T) => `claude mcp add --transport http tally ${U} \\\n  --header "Authorization: Bearer ${T}"` },
    { id: "claude-desktop", label: "Claude Desktop", note: "写进 claude_desktop_config.json 的 mcpServers 里（需要装有 Node.js），然后完全退出再重开 Claude Desktop。Windows 把 npx 改成 npx.cmd。",
      snippet: (U, T) => JSON.stringify({ mcpServers: { "tally": { command: "npx", args: ["-y", "mcp-remote@latest", U, "--header", `Authorization: Bearer ${T}`] } } }, null, 2) },
    { id: "codex", label: "Codex", note: "令牌放在环境变量里，Codex 从变量读取，不写进配置文件。",
      snippet: (U, T) => `export TALLY_TOKEN="${T}"\ncodex mcp add tally --url ${U} --bearer-token-env-var TALLY_TOKEN` },
    { id: "opencode", label: "OpenCode", note: "合并进 ~/.config/opencode/opencode.json。",
      snippet: (U, T) => JSON.stringify({ mcp: { "tally": { type: "remote", url: U, enabled: true, headers: { Authorization: `Bearer ${T}` } } } }, null, 2) },
    { id: "cursor", label: "Cursor / 其他", note: "Cursor 写进 ~/.cursor/mcp.json；Windsurf、Cline、Continue 等支持“远程 / HTTP MCP + 自定义请求头”的，字段名大同小异。",
      snippet: (U, T) => JSON.stringify({ mcpServers: { "tally": { url: U, headers: { Authorization: `Bearer ${T}` } } } }, null, 2) },
    { id: "http", label: "自己写的 Agent / curl", note: "标准 JSON-RPC over HTTP：先 initialize，再 tools/list、tools/call。用 MCP 官方 SDK 的 Streamable HTTP 客户端也行，把请求头设成下面这个。",
      snippet: (U, T) => `curl -s ${U} \\\n  -H "Authorization: Bearer ${T}" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` },
  ];
  function renderConn() {
    const U = `${location.origin}/mcp`, c = CLIENTS.find((x) => x.id === connKind) || CLIENTS[0];
    $("connTabs").innerHTML = CLIENTS.map((x) => `<button type="button" role="tab" aria-selected="${x.id === c.id}" data-conn="${x.id}">${esc(x.label)}</button>`).join("");
    $("connTabs").querySelectorAll("[data-conn]").forEach((b) => b.addEventListener("click", () => { connKind = b.dataset.conn; renderConn(); }));
    $("connNote").textContent = c.note;
    $("mcpCmd").textContent = c.snippet(U, connToken || PLACEHOLDER);
    $("connUrl").textContent = U;
    $("connTokenState").textContent = connToken ? "已填入刚生成的令牌" : "令牌位置是占位符，先在上面生成一个";
  }
  $("copyCmd").addEventListener("click", () => copy($("mcpCmd").textContent));

  async function loadTokens() {
    renderConn();
    try {
      const { tokens } = await api("/api/tokens");
      $("tkRows").innerHTML = tokens.length ? tokens.map((t) => `<tr><td>${esc(t.label)}</td><td class="mono">${esc(t.prefix)}…</td><td>${esc(localTime(t.created_at))}</td>
        <td>${esc(t.last_used_at ? localTime(t.last_used_at) : "从未")}</td><td>${t.revoked_at ? '<span class="pill idle">已吊销</span>' : '<span class="pill ok">有效</span>'}</td>
        <td>${t.revoked_at ? "" : `<button type="button" data-revoke="${t.id}">吊销</button>`}</td></tr>`).join("") : empty(6, "还没有令牌");
      $("tkRows").querySelectorAll("[data-revoke]").forEach((b) => b.addEventListener("click", async () => {
        if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "确认吊销？"; return; }
        try { await api("/api/tokens/revoke", { method: "POST", body: JSON.stringify({ id: Number(b.dataset.revoke) }) }); toast("已吊销"); loadTokens(); }
        catch (e) { toast(e.message); }
      }));
    } catch (e) { $("tkRows").innerHTML = empty(6, e.message, true); }
  }
  $("tkForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const { token } = await api("/api/tokens", { method: "POST", body: JSON.stringify({ label: $("tkLabel").value.trim() }) });
      $("tkNew").innerHTML = `<p class="notice info">新令牌只显示这一次，请马上复制保存：</p><div class="secret" id="tkSecret">${esc(token)}</div>
        <button type="button" id="tkCopy" style="justify-self:start">复制令牌</button>`;
      $("tkCopy").onclick = () => copy(token);
      connToken = token; renderConn();
      $("tkLabel").value = ""; loadTokens();
    } catch (err) { toast(err.message); }
  });

  /* ================= tool console ================= */
  let tools = [];
  async function loadTools() {
    try {
      ({ tools } = await api("/api/tools"));
      $("toolSel").innerHTML = tools.map((t) => `<option value="${esc(t.name)}">${esc(t.name)} · ${esc(t.title)}${t.enabled ? "" : "（未开启）"}</option>`).join("");
      renderToolForm();
    } catch (e) { $("toolDesc").textContent = e.message; }
  }
  const fieldKind = (p) => p.type === "array" ? (p.items?.type === "object" ? "json" : "array") : p.type || (p.anyOf ? "text" : "text");
  function renderToolForm() {
    const t = tools.find((x) => x.name === $("toolSel").value); if (!t) return;
    $("toolDesc").textContent = t.description || "";
    $("toolRun").disabled = !t.enabled; $("toolRun").textContent = t.enabled ? "调用" : "未开启";
    const props = t.inputSchema?.properties || {}, req = new Set(t.inputSchema?.required || []);
    const keys = Object.keys(props);
    $("toolForm").innerHTML = keys.length ? keys.map((k) => {
      const p = props[k], kind = fieldKind(p), id = `arg-${esc(k)}`;
      const ph = esc(p.description || "");
      const input = kind === "boolean" ? `<select id="${id}" data-kind="boolean"><option value="">不填</option><option value="true">true</option><option value="false">false</option></select>`
        : kind === "json" ? `<textarea id="${id}" data-kind="json" rows="4" placeholder='${ph}（JSON 数组）'></textarea>`
        : `<input id="${id}" data-kind="${kind}" data-items="${esc(p.items?.type || "")}" placeholder="${ph}">`;
      return `<label for="${id}">${esc(k)}${req.has(k) ? " *" : ""}<span style="font-size:11.5px"> · ${kind === "array" ? "逗号分隔" : esc(kind)}</span>${input}</label>`;
    }).join("") : `<p class="muted" style="font-size:13px">这个工具没有参数。</p>`;
  }
  $("toolSel").addEventListener("change", renderToolForm);
  $("toolRun").addEventListener("click", async (e) => {
    const name = $("toolSel").value, args = {};
    try {
      for (const el of $("toolForm").querySelectorAll("[data-kind]")) {
        const k = el.id.slice(4), v = el.value.trim(); if (v === "") continue;
        const kind = el.dataset.kind;
        if (kind === "number" || kind === "integer") args[k] = Number(v);
        else if (kind === "boolean") args[k] = v === "true";
        else if (kind === "json") args[k] = JSON.parse(v);
        else if (kind === "array") args[k] = v.split(/[,，]/).map((x) => x.trim()).filter(Boolean).map((x) => (el.dataset.items === "number" || el.dataset.items === "integer") ? Number(x) : x);
        else args[k] = v;
      }
    } catch (err) { toast("参数格式不对：" + err.message); return; }
    const b = e.currentTarget; b.disabled = true; $("toolMeta").textContent = "调用中…";
    try {
      const r = await callTool(name, args);
      $("toolSummary").textContent = r.summary;
      $("toolOut").textContent = r.data === undefined ? "（没有数据）" : JSON.stringify(r.data, null, 2);
      $("toolMeta").innerHTML = `${r.ok ? '<span class="pill ok">成功</span>' : '<span class="pill err">出错</span>'}<span>${esc(name)} · ${r.ms} ms</span>`;
    } catch (err) { $("toolSummary").textContent = ""; $("toolOut").textContent = err.message; $("toolMeta").innerHTML = '<span class="pill err">请求失败</span>'; }
    finally { b.disabled = false; }
  });

  /* ================= boot ================= */
  const LOADERS = { overview: loadOverview, reports: () => { loadReports(); loadReportHealth(); }, usage: loadUsage, tokens: loadTokens, tools: loadTools };
  const PARAM_HANDLERS = {
    spend: (id) => { $("spClient").value = id; $("spClick").value = ""; querySpend(); },
    reports: (id) => { reportTabs.querySelector('[data-tab="r-campaigns"]').click(); $("cpClient").value = id; queryCampaigns(); },
  };
  $("logout").addEventListener("click", async () => { try { await api("/api/logout", { method: "POST" }); } catch (e) {} location.href = "/login"; });
  api("/api/me").then((me) => { $("meEmail").textContent = me.email; $("avatar").textContent = me.email[0].toUpperCase(); }).catch(() => {});
  api("/api/status").then((s) => {
    STATUS = s;
    $("writeState").innerHTML = s.writeEnabled ? '<span class="pill warn">写入已开启</span>' : '<span class="pill idle">写入未开启</span>';
    $("writeOff").hidden = s.writeEnabled;
  }).catch(() => {});
  show();
})();
