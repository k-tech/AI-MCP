(() => {
  const form = document.getElementById("form"), err = document.getElementById("err"), btn = document.getElementById("submit");
  try { const last = localStorage.getItem("aimcp_email"); if (last) document.getElementById("email").value = last; } catch (e) {}
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("email").value.trim(), token = document.getElementById("token").value.trim();
    if (!/@feedmob\.com$/i.test(email)) { err.textContent = "请使用 @feedmob.com 邮箱"; return; }
    if (!token) { err.textContent = "请输入访问令牌"; return; }
    btn.disabled = true; err.textContent = "";
    try {
      const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, token }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { err.textContent = data.error || "登录失败（" + r.status + "）"; return; }
      try { localStorage.setItem("aimcp_email", email); } catch (e) {}
      location.href = "/dashboard/";
    } catch (e) { err.textContent = "网络错误，请重试"; }
    finally { btn.disabled = false; }
  });
})();
