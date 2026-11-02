// Outreach Agent — single-page app (no build step). All server data is
// untrusted (business names come from scraped sites), so every dynamic value
// goes through esc() before it touches innerHTML.

const LABELS = { website: "Website", ads: "Ad Management", cro: "Shopify CRO" };
const STATUS_LABELS = {
  new: "Queued for audit", drafted: "Awaiting approval", approved: "Approved", contacted: "Contacted",
  replied: "Replied", skipped: "Skipped", no_opportunity: "No opportunity", no_contact: "No contact found", error: "Error",
};
const PLATFORM_LABELS = {
  shopify: "Shopify", wordpress: "WordPress", wix: "Wix", squarespace: "Squarespace", webflow: "Webflow",
  godaddy: "GoDaddy", weebly: "Weebly", custom: "Custom site", none: "No website", parked: "Parked domain", unreachable: "Site down",
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $("#view");

const state = { status: null, route: "dashboard", queue: [], selected: null, detail: null, leadsFilter: { status: "", q: "" } };

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "content-type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3500);
}

function timeAgo(ts) {
  if (!ts) return "—";
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 0) return `in ${Math.round(-s / 60)} min`;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return d.toLocaleDateString();
}
function clock(ts) {
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------- shell

async function refreshStatus() {
  try {
    state.status = await api("/api/status");
  } catch (e) {
    $("#agent-text").textContent = "Can't reach the app server";
    return;
  }
  const { agent, stats } = state.status;
  for (const c of ["website", "ads", "cro"]) $(`#count-${c}`).textContent = stats.queues[c];
  const pill = $("#agent-pill");
  pill.classList.toggle("running", agent.running);
  $("#agent-text").textContent = agent.running ? agent.detail : "Agent paused";
  pill.title = agent.detail;
  const btn = $("#agent-toggle");
  btn.textContent = agent.running ? "Pause agent" : "▶ Start agent";
  btn.className = agent.running ? "btn" : "btn primary";
  $("#sidebar-foot").textContent = `${stats.sentToday}/${state.status.dailyCap} emails sent today`;
  const waiting = stats.queues.website + stats.queues.ads + stats.queues.cro;
  document.title = waiting ? `(${waiting}) Outreach Agent` : "Outreach Agent";
  if (state.route === "dashboard") renderDashboardLive();
}

$("#agent-toggle").addEventListener("click", async () => {
  const running = state.status?.agent.running;
  await api(running ? "/api/agent/pause" : "/api/agent/start", { method: "POST" });
  toast(running ? "Agent paused" : "Agent started — it will keep hunting 24/7");
  refreshStatus();
});
$("#menu-btn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
$$(".nav-item").forEach((b) => b.addEventListener("click", () => { location.hash = `#/${b.dataset.view}`; $("#sidebar").classList.remove("open"); }));

function route() {
  const r = location.hash.replace(/^#\//, "") || "dashboard";
  state.route = r;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === r || (r.startsWith("queue/") && b.dataset.view === r)));
  if (r === "dashboard") return renderDashboard();
  if (r.startsWith("queue/")) return renderQueue(r.split("/")[1]);
  if (r === "sent") return renderSent();
  if (r === "leads") return renderLeads();
  if (r === "settings") return renderSettings();
  location.hash = "#/dashboard";
}
window.addEventListener("hashchange", route);

// ---------------------------------------------------------------- dashboard

function renderDashboard() {
  $("#title").textContent = "Dashboard";
  view.innerHTML = `
    <div class="grid" style="gap:20px">
      <div id="setup"></div>
      <div class="grid stats" id="stats"></div>
      <div class="grid two-col">
        <div class="card card-pad" id="agent-card"></div>
        <div class="card card-pad"><h2>Activity</h2><ul class="feed" id="feed"></ul></div>
      </div>
    </div>`;
  renderDashboardLive();
}

async function renderDashboardLive() {
  const st = state.status;
  if (!st || !$("#stats")) return;
  const { stats, agent, checklist } = st;

  const missing = checklist.filter((c) => !c.done);
  $("#setup").innerHTML = missing.length
    ? `<div class="card card-pad"><h2>Finish setting up</h2><ul class="checklist">${checklist
        .map((c) => `<li><span class="check ${c.done ? "done" : ""}">${c.done ? "✓" : ""}</span><span>${esc(c.label)}${c.required ? "" : '<span class="tag">optional</span>'}</span></li>`)
        .join("")}</ul><div style="margin-top:14px"><a class="btn primary" href="#/settings">Open Settings</a></div></div>`
    : "";

  const q = stats.queues;
  $("#stats").innerHTML = `
    ${["website", "ads", "cro"].map((c) => `
      <div class="card stat link" data-go="#/queue/${c}">
        <div class="label"><span class="dot ${c}" style="width:8px;height:8px;border-radius:50%;display:inline-block"></span>${LABELS[c]}</div>
        <div class="value">${q[c]}</div><div class="sub">waiting for your approval</div>
      </div>`).join("")}
    <div class="card stat link" data-go="#/sent"><div class="label">Sent today</div><div class="value">${stats.sentToday}<span style="font-size:15px;color:var(--faint)"> / ${st.dailyCap}</span></div><div class="sub">${stats.scheduled} approved in the send queue</div></div>
    <div class="card stat"><div class="label">Replies</div><div class="value">${stats.replied}</div><div class="sub">${stats.totalSent} emails sent all-time</div></div>
    <div class="card stat link" data-go="#/leads"><div class="label">Leads found</div><div class="value">${stats.totalLeads}</div><div class="sub">${stats.byStatus.new || 0} waiting to be audited</div></div>`;
  $$("[data-go]").forEach((el) => el.addEventListener("click", () => (location.hash = el.dataset.go)));

  $("#agent-card").innerHTML = `
    <h2>Agent</h2>
    <dl class="kv">
      <dt>Status</dt><dd><b>${agent.running ? "🟢 Running 24/7" : "⏸ Paused"}</b>${agent.running ? ` — ${esc(agent.detail)}` : ""}</dd>
      <dt>Current niche</dt><dd>${esc(agent.currentNiche || "—")}</dd>
      <dt>Last cycle</dt><dd>${esc(agent.lastCycleSummary || "—")} <span style="color:var(--faint)">${agent.lastCycleAt ? timeAgo(agent.lastCycleAt) : ""}</span></dd>
      <dt>Next cycle</dt><dd>${agent.nextCycleAt ? new Date(agent.nextCycleAt).toLocaleTimeString() : "—"}</dd>
      <dt>Sending</dt><dd>${esc(agent.sendState)}</dd>
      <dt>Niches</dt><dd>${esc(st.niches.join(", "))}</dd>
      ${agent.lastError ? `<dt>Last error</dt><dd style="color:var(--bad)">${esc(agent.lastError)}</dd>` : ""}
    </dl>
    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
      <button class="btn" id="run-now" ${agent.phase === "discovering" || agent.phase === "auditing" ? "disabled" : ""}>🔎 Find leads now</button>
      <a class="btn ghost" href="#/leads">Add / import leads</a>
    </div>`;
  $("#run-now").addEventListener("click", async () => {
    await api("/api/agent/run", { method: "POST" });
    toast("Searching for new leads…");
    setTimeout(refreshStatus, 800);
  });

  const feed = await api("/api/activity").catch(() => []);
  const el = $("#feed");
  if (el) el.innerHTML = feed.length
    ? feed.map((a) => `<li><time>${clock(a.ts)}</time><span class="${esc(a.level)}">${esc(a.message)}</span></li>`).join("")
    : `<li><span style="color:var(--muted)">Nothing yet — start the agent and activity shows up here.</span></li>`;
}

// ---------------------------------------------------------------- review queues

async function renderQueue(category) {
  $("#title").textContent = `${LABELS[category]} — ready to approve`;
  view.innerHTML = `<div class="review" id="review"><div class="review-list" id="qlist"></div><div class="review-detail" id="qdetail"></div></div>`;
  state.queue = await api(`/api/queue/${category}`).catch((e) => (toast(e.message, "error"), []));
  if (!state.queue.length) {
    $("#review").innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">📭</div><h2>No ${LABELS[category]} drafts waiting</h2><p>The agent drops new, ready-to-send emails here as it finds businesses that need ${LABELS[category].toLowerCase()} help.</p><a class="btn" href="#/dashboard">Back to dashboard</a></div>`;
    return;
  }
  renderQueueList(category);
  if (window.matchMedia("(min-width: 901px)").matches) selectLead(state.queue[0].id, category);
}

function renderQueueList(category) {
  $("#qlist").innerHTML = state.queue
    .map((l) => {
      const f = (l.findings || []).filter((x) => x.category === category).sort((a, b) => b.severity - a.severity).slice(0, 3);
      return `<div class="lead-row ${state.selected === l.id ? "active" : ""}" data-id="${l.id}">
        <div class="top"><span class="name">${esc(l.name)}</span><span class="score ${category}">${l.scores?.[category] ?? 0}</span></div>
        <div class="dom">${esc(l.domain || "No website")} · ${esc(PLATFORM_LABELS[l.platform] || "")}${l.draft.channel === "manual" ? " · DM" : ""}</div>
        <div class="chips">${f.map((x) => `<span class="chip s${x.severity}">${esc(x.evidence)}</span>`).join("")}</div>
      </div>`;
    })
    .join("");
  $$(".lead-row").forEach((r) => r.addEventListener("click", () => selectLead(Number(r.dataset.id), category)));
}

async function selectLead(id, category) {
  state.selected = id;
  $$(".lead-row").forEach((r) => r.classList.toggle("active", Number(r.dataset.id) === id));
  $("#review")?.classList.add("has-detail");
  const data = await api(`/api/leads/${id}`);
  state.detail = data;
  renderDetail($("#qdetail"), data, { category, inQueue: true });
}

function scoreBars(scores) {
  return `<div class="bars">${["website", "ads", "cro"].map((c) => `
    <div class="bar"><span>${LABELS[c]}</span><div class="track"><div class="fill dot ${c}" style="width:${scores?.[c] ?? 0}%"></div></div><b>${scores?.[c] ?? 0}</b></div>`).join("")}</div>`;
}

function renderDetail(root, data, opts = {}) {
  const { lead, drafts } = data;
  const category = opts.category || lead.category;
  const first = drafts.find((d) => d.step === 0);
  const followups = drafts.filter((d) => d.step > 0);
  const editable = first && first.status === "pending";
  const manual = first?.channel === "manual";
  const findings = (lead.findings || []).slice().sort((a, b) => (a.category === category ? -1 : 1) - (b.category === category ? -1 : 1) || b.severity - a.severity);
  const contactLink = lead.facebook_url || (lead.socials || []).find((s) => /instagram|facebook/.test(s));

  root.innerHTML = `
    ${opts.inQueue ? `<button class="btn ghost sm hide-lg" id="back" style="margin-bottom:8px">← Back to list</button>` : ""}
    <div class="detail-head">
      <div style="min-width:0">
        <h2>${esc(lead.name)}</h2>
        <div class="meta">
          ${lead.domain ? `<a href="https://${esc(lead.domain)}" target="_blank" rel="noopener noreferrer">${esc(lead.domain)} ↗</a>` : "<span>No website</span>"}
          <span>${esc(PLATFORM_LABELS[lead.platform] || "—")}</span>
          ${lead.niche ? `<span>Niche: ${esc(lead.niche)}</span>` : ""}
          ${lead.ad_data ? `<span>${lead.ad_data.activeAds} active Meta ads${lead.ad_data.snapshotUrl ? ` · <a href="https://www.facebook.com/ads/library/?id=${esc(lead.ad_data.pageId)}&view_all_page_id=${esc(lead.ad_data.pageId)}" target="_blank" rel="noopener noreferrer">see ads ↗</a>` : ""}</span>` : ""}
          ${contactLink ? `<a href="${esc(contactLink)}" target="_blank" rel="noopener noreferrer">Social ↗</a>` : ""}
          <span class="status ${esc(lead.status)}">${esc(STATUS_LABELS[lead.status] || lead.status)}</span>
        </div>
      </div>
      ${scoreBars(lead.scores)}
    </div>

    <div class="detail-grid"><div class="detail-main">
    ${first ? `
    <div class="card card-pad">
      <h2>${manual ? "Message (send as a Facebook/Instagram DM)" : "Email"} ${first.composer === "ai" ? '<span class="tag">AI-written</span>' : '<span class="tag">template</span>'}</h2>
      ${manual ? `<div class="notice info" style="margin-bottom:10px">No email address on their site — copy this message and send it from their ${contactLink ? `<a href="${esc(contactLink)}" target="_blank" rel="noopener noreferrer">social page</a>` : "social page"}, then click <b>Mark as sent</b>.</div>` : ""}
      ${!editable ? `<div class="notice warn" style="margin-bottom:10px">This message is ${esc(first.status)} — editing is locked.</div>` : ""}
      <div class="composer">
        ${manual ? "" : `<div class="field-row"><label>To</label><input class="input" value="${esc(lead.email || "")}" disabled /></div>`}
        <div class="field-row"><label>${manual ? "Opener" : "Subject"}</label><input class="input" id="subj" value="${esc(first.subject)}" ${editable ? "" : "disabled"} /></div>
        <textarea class="textarea body-edit" id="body" ${editable ? "" : "disabled"}>${esc(first.body)}</textarea>
        <div class="sig">${esc(data.signature)}${manual ? "" : "\n\n" + esc(data.footer)}</div>
      </div>
    </div>` : ""}

    ${followups.length ? `<div style="display:grid;gap:10px;margin-top:16px">
      ${followups.map((d) => `
        <details class="fu"><summary>Follow-up ${d.step} — ${d.delay_days} days later if no reply <span class="status ${esc(d.status)}">${esc(d.status)}</span></summary>
          <div class="inner">
            <input class="input fu-subj" data-id="${d.id}" value="${esc(d.subject)}" ${d.status === "pending" ? "" : "disabled"} />
            <textarea class="textarea fu-body" data-id="${d.id}" ${d.status === "pending" ? "" : "disabled"}>${esc(d.body)}</textarea>
          </div></details>`).join("")}
    </div>` : ""}
    </div><aside class="detail-side">
    <div class="card card-pad">
      <h2>Their pain points (what we found)</h2>
      ${findings.length ? `<ul class="findings">${findings.map((f) => `
        <li><span class="sev s${f.severity}" title="severity ${f.severity}"></span>
          <div><span class="ev">${esc(f.evidence)}</span> <span class="tag">${LABELS[f.category]}</span><div>${esc(f.pain)}</div><div class="fix">→ ${esc(f.fix)}</div></div></li>`).join("")}</ul>` : `<p style="color:var(--muted)">No findings recorded.</p>`}
    </div>

    </aside></div>

    <div class="actions">
      ${editable ? (manual
        ? `<button class="btn" id="copy">📋 Copy message</button><button class="btn good" id="approve">✓ Mark as sent <kbd>A</kbd></button>`
        : `<button class="btn good" id="approve">✓ Approve &amp; send <kbd>A</kbd></button>
           ${followups.length ? `<label class="toggle"><input type="checkbox" id="with-fu" checked /> + ${followups.length} follow-ups if no reply</label>` : ""}`) : ""}
      <div class="spacer"></div>
      ${editable ? `<button class="btn" id="redraft" title="Write a fresh version">↻ Rewrite</button><button class="btn" id="skip">Skip <kbd>S</kbd></button>` : ""}
      ${lead.status === "skipped" ? `<button class="btn" id="unskip">Move back to queue</button>` : ""}
      ${lead.email ? `<button class="btn ghost danger" id="dnc" title="Never contact this address">Do not contact</button>` : ""}
    </div>`;

  $("#back", root)?.addEventListener("click", () => { $("#review").classList.remove("has-detail"); state.selected = null; });

  const saveEdits = async () => {
    if (!editable) return;
    const subject = $("#subj", root).value, body = $("#body", root).value;
    if (subject !== first.subject || body !== first.body) {
      await api(`/api/drafts/${first.id}`, { method: "PUT", body: { subject, body } });
      first.subject = subject; first.body = body;
    }
    for (const el of $$(".fu-body", root)) {
      const subjEl = $(`.fu-subj[data-id="${el.dataset.id}"]`, root);
      const d = followups.find((x) => x.id === Number(el.dataset.id));
      if (d && d.status === "pending" && (el.value !== d.body || subjEl.value !== d.subject)) {
        await api(`/api/drafts/${d.id}`, { method: "PUT", body: { subject: subjEl.value, body: el.value } });
        d.body = el.value; d.subject = subjEl.value;
      }
    }
  };
  $$("input, textarea", root).forEach((el) => el.addEventListener("blur", () => saveEdits().catch((e) => toast(e.message, "error"))));

  const next = () => afterAction(lead.id, opts);
  $("#approve", root)?.addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    try {
      await saveEdits();
      const r = await api(`/api/leads/${lead.id}/approve`, { method: "POST", body: { includeFollowups: $("#with-fu", root)?.checked ?? true } });
      toast(`✓ ${lead.name}: ${r.note}`);
      next();
    } catch (e) { toast(e.message, "error"); ev.target.disabled = false; }
  });
  $("#copy", root)?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(`${$("#body", root).value}\n\n${data.signature}`);
    toast("Message copied — paste it into their DMs");
  });
  $("#skip", root)?.addEventListener("click", async () => { await api(`/api/leads/${lead.id}/skip`, { method: "POST" }); toast(`Skipped ${lead.name}`); next(); });
  $("#unskip", root)?.addEventListener("click", async () => { await api(`/api/leads/${lead.id}/unskip`, { method: "POST" }); toast("Moved back to the queue"); refreshStatus(); closeModal(); });
  $("#dnc", root)?.addEventListener("click", async () => {
    if (!confirm(`Never contact ${lead.email} again?`)) return;
    await api(`/api/leads/${lead.id}/suppress`, { method: "POST" }); toast("Added to do-not-contact list"); next();
  });
  $("#redraft", root)?.addEventListener("click", async (ev) => {
    ev.target.disabled = true; ev.target.textContent = "Rewriting…";
    try { const d = await api(`/api/leads/${lead.id}/redraft`, { method: "POST" }); renderDetail(root, { ...data, drafts: d.drafts }, opts); toast("Fresh version written"); }
    catch (e) { toast(e.message, "error"); ev.target.disabled = false; ev.target.textContent = "↻ Rewrite"; }
  });
}

function afterAction(leadId, opts) {
  refreshStatus();
  if (!opts.inQueue) { closeModal(); if (state.route === "leads") renderLeads(); return; }
  const i = state.queue.findIndex((l) => l.id === leadId);
  state.queue.splice(i, 1);
  const category = state.route.split("/")[1];
  if (!state.queue.length) return renderQueue(category);
  renderQueueList(category);
  const nextLead = state.queue[Math.min(i, state.queue.length - 1)];
  selectLead(nextLead.id, category);
}

document.addEventListener("keydown", (e) => {
  if (!state.route.startsWith("queue/") || ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  const category = state.route.split("/")[1];
  const i = state.queue.findIndex((l) => l.id === state.selected);
  if (e.key === "a") $("#approve")?.click();
  else if (e.key === "s") $("#skip")?.click();
  else if ((e.key === "j" || e.key === "ArrowDown") && state.queue[i + 1]) selectLead(state.queue[i + 1].id, category);
  else if ((e.key === "k" || e.key === "ArrowUp") && i > 0) selectLead(state.queue[i - 1].id, category);
  else return;
  e.preventDefault();
});

// ---------------------------------------------------------------- sent

async function renderSent() {
  $("#title").textContent = "Sent & scheduled";
  const rows = await api("/api/sent").catch(() => []);
  view.innerHTML = `<div class="card"><div class="table-wrap"><table>
    <thead><tr><th>When</th><th>Business</th><th>Queue</th><th>Step</th><th>Subject</th><th>Status</th></tr></thead>
    <tbody>${rows.length ? rows.map((r) => `<tr class="click" data-lead="${r.lead_id}">
      <td>${esc(timeAgo(r.sent_at))}</td><td><b>${esc(r.lead_name)}</b><div style="color:var(--muted);font-size:12px">${esc(r.email || "DM")}</div></td>
      <td>${r.category ? `<span class="score ${r.category}">${LABELS[r.category]}</span>` : ""}</td>
      <td>${r.step === 0 ? "First email" : `Follow-up ${r.step}`}</td><td>${esc(r.subject)}</td>
      <td><span class="status ${esc(r.status)}">${esc(r.status)}</span>${r.error ? `<div style="color:var(--bad);font-size:12px">${esc(r.error)}</div>` : ""}</td></tr>`).join("")
      : `<tr><td colspan="6" class="empty">Nothing sent yet. Approve drafts in the queues and they'll show up here.</td></tr>`}</tbody></table></div></div>`;
  $$("tr[data-lead]").forEach((tr) => tr.addEventListener("click", () => openLeadModal(Number(tr.dataset.lead))));
}

// ---------------------------------------------------------------- leads

async function renderLeads() {
  $("#title").textContent = "All leads";
  const f = state.leadsFilter;
  const qs = new URLSearchParams({ ...(f.status && { status: f.status }), ...(f.q && { q: f.q }), limit: "500" });
  const rows = await api(`/api/leads?${qs}`).catch(() => []);
  view.innerHTML = `
    <div class="toolbar">
      <input class="input" id="lq" placeholder="Search name, domain, email…" value="${esc(f.q)}" style="max-width:280px" />
      <select class="input" id="ls" style="max-width:200px"><option value="">All statuses</option>${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}" ${f.status === k ? "selected" : ""}>${v}</option>`).join("")}</select>
      <div style="flex:1"></div>
      <button class="btn" id="add-lead">＋ Add lead</button>
      <button class="btn" id="import">⬆ Import CSV</button>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Business</th><th>Platform</th><th>Queue</th><th>Contact</th><th>Status</th><th>Found</th></tr></thead>
      <tbody>${rows.length ? rows.map((l) => `<tr class="click" data-lead="${l.id}">
        <td><b>${esc(l.name)}</b><div style="color:var(--muted);font-size:12px">${esc(l.domain || "no website")} · ${esc(l.source)}</div></td>
        <td>${esc(PLATFORM_LABELS[l.platform] || "—")}</td>
        <td>${l.category ? `<span class="score ${l.category}">${LABELS[l.category]} ${l.scores?.[l.category] ?? ""}</span>` : "—"}</td>
        <td>${esc(l.email || (l.facebook_url ? "Facebook" : "—"))}</td>
        <td><span class="status ${esc(l.status)}">${esc(STATUS_LABELS[l.status] || l.status)}</span>${l.error ? `<div style="color:var(--faint);font-size:12px">${esc(l.error)}</div>` : ""}</td>
        <td>${esc(timeAgo(l.created_at))}</td></tr>`).join("")
        : `<tr><td colspan="6" class="empty">No leads yet. Start the agent, or add/import some.</td></tr>`}</tbody></table></div></div>`;

  let t;
  $("#lq").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value; renderLeads().then(() => { const el = $("#lq"); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }); }, 300); });
  $("#ls").addEventListener("change", (e) => { f.status = e.target.value; renderLeads(); });
  $$("tr[data-lead]").forEach((tr) => tr.addEventListener("click", () => openLeadModal(Number(tr.dataset.lead))));
  $("#add-lead").addEventListener("click", openAddLead);
  $("#import").addEventListener("click", openImport);
}

function modal(html) {
  closeModal();
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="card modal"><button class="btn ghost close" aria-label="Close">✕</button>${html}</div>`;
  bg.addEventListener("click", (e) => { if (e.target === bg) closeModal(); });
  $(".close", bg).addEventListener("click", closeModal);
  document.body.append(bg);
  return $(".modal", bg);
}
function closeModal() { $(".modal-bg")?.remove(); }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

async function openLeadModal(id) {
  const data = await api(`/api/leads/${id}`);
  const m = modal(`<div id="mdetail"></div>
    <div style="margin-top:12px;display:flex;gap:8px"><button class="btn sm" id="reaudit">↻ Re-audit this lead</button></div>`);
  renderDetail($("#mdetail", m), data, { inQueue: false });
  $("#reaudit", m).addEventListener("click", async () => { const r = await api(`/api/leads/${id}/reaudit`, { method: "POST" }); toast(r.note); closeModal(); renderLeads(); });
}

function openAddLead() {
  const m = modal(`<h2>Add a lead</h2>
    <div class="form-grid">
      <div class="form-field"><label>Business name *</label><input class="input" id="n" /></div>
      <div class="form-field"><label>Website</label><input class="input" id="w" placeholder="https://…" /></div>
      <div class="form-field"><label>Email (optional)</label><input class="input" id="e" /></div>
      <div class="form-field"><label>Facebook page (optional)</label><input class="input" id="fb" /></div>
    </div>
    <p style="color:var(--muted);font-size:13px">The agent audits it on its next cycle and drops a ready-to-send email into the right queue.</p>
    <button class="btn primary" id="save">Add lead</button>`);
  $("#save", m).addEventListener("click", async () => {
    try {
      await api("/api/leads", { method: "POST", body: { name: $("#n", m).value, website: $("#w", m).value, email: $("#e", m).value, facebook: $("#fb", m).value } });
      toast("Lead added — it'll be audited on the next cycle"); closeModal(); renderLeads();
    } catch (e) { toast(e.message, "error"); }
  });
}

function openImport() {
  const m = modal(`<h2>Import leads from CSV</h2>
    <p style="color:var(--muted);font-size:13px">Needs a header row. Recognised columns: <b>name</b>, <b>website</b> (or url/domain), <b>email</b>, <b>facebook</b>, <b>niche</b>.</p>
    <input type="file" accept=".csv,text/csv" id="file" class="input" />
    <textarea class="textarea" id="csv" placeholder="…or paste CSV here" style="margin-top:10px"></textarea>
    <div style="margin-top:12px"><button class="btn primary" id="go">Import</button></div>`);
  $("#file", m).addEventListener("change", async (e) => { $("#csv", m).value = await e.target.files[0].text(); });
  $("#go", m).addEventListener("click", async () => {
    try { const r = await api("/api/import", { method: "POST", body: { csv: $("#csv", m).value } }); toast(`Imported ${r.added} of ${r.parsed} leads`); closeModal(); renderLeads(); }
    catch (e) { toast(e.message, "error"); }
  });
}

// ---------------------------------------------------------------- settings

async function renderSettings() {
  $("#title").textContent = "Settings";
  const { defs, values } = await api("/api/settings");
  const groups = [...new Set(defs.map((d) => d.group))];
  const field = (d) => {
    const v = values[d.key] ?? "";
    const wide = d.type === "textarea" || d.key === "niches" || d.key === "sources";
    let input;
    if (d.type === "bool") input = `<label class="toggle"><input type="checkbox" name="${d.key}" ${v === "true" ? "checked" : ""} /> ${esc(d.label)}</label>`;
    else if (d.type === "textarea") input = `<textarea class="textarea" name="${d.key}" style="min-height:70px">${esc(v)}</textarea>`;
    else input = `<input class="input" name="${d.key}" type="${d.type === "secret" ? "password" : d.type === "number" ? "number" : "text"}" value="${esc(v)}" autocomplete="off" />`;
    return `<div class="form-field ${wide ? "wide" : ""}">${d.type === "bool" ? "" : `<label>${esc(d.label)}</label>`}${input}${d.help ? `<div class="help">${esc(d.help)}</div>` : ""}</div>`;
  };
  view.innerHTML = `<form class="settings" id="sform">
    ${groups.map((g) => `<div class="card card-pad"><h2>${esc(g)}</h2><div class="form-grid">${defs.filter((d) => d.group === g).map(field).join("")}</div>
      ${g === "Email sending" ? `<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap"><input class="input" id="test-to" placeholder="Send a test to… (defaults to you)" style="max-width:280px" /><button type="button" class="btn" id="test-email">Send test email</button></div>` : ""}</div>`).join("")}
    <div class="card card-pad"><h2>Do-not-contact list</h2>
      <p style="color:var(--muted);font-size:13px;margin-top:0">These addresses (or whole <b>@domains</b>) are never emailed. People who reply "stop" are added automatically.</p>
      <div style="display:flex;gap:8px;margin-bottom:10px"><input class="input" id="dnc-add" placeholder="email@shop.com or @shop.com" style="max-width:280px" /><button type="button" class="btn" id="dnc-btn">Add</button></div>
      <div id="dnc-list"></div></div>
    <div class="save-bar"><button class="btn primary" type="submit">Save settings</button></div>
  </form>`;

  const loadDnc = async () => {
    const list = await api("/api/suppression");
    $("#dnc-list").innerHTML = list.length ? `<div class="chips">${list.map((s) => `<span class="chip">${esc(s.email)} <a href="#" data-rm="${esc(s.email)}" title="Remove">✕</a></span>`).join("")}</div>` : `<span style="color:var(--faint)">Empty</span>`;
    $$("[data-rm]").forEach((a) => a.addEventListener("click", async (e) => { e.preventDefault(); await api(`/api/suppression/${encodeURIComponent(a.dataset.rm)}`, { method: "DELETE" }); loadDnc(); }));
  };
  loadDnc();
  $("#dnc-btn").addEventListener("click", async () => { try { await api("/api/suppression", { method: "POST", body: { email: $("#dnc-add").value } }); $("#dnc-add").value = ""; loadDnc(); } catch (e) { toast(e.message, "error"); } });

  $("#sform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {};
    for (const d of defs) {
      const el = e.target.elements[d.key];
      if (el) body[d.key] = d.type === "bool" ? String(el.checked) : el.value;
    }
    try { await api("/api/settings", { method: "PUT", body }); toast("Settings saved"); refreshStatus(); } catch (err) { toast(err.message, "error"); }
  });
  $("#test-email").addEventListener("click", async () => {
    try { const r = await api("/api/test-email", { method: "POST", body: $("#test-to").value ? { to: $("#test-to").value } : {} }); toast(r.note); }
    catch (e) { toast(`Test failed: ${e.message} — save settings first if you just changed them`, "error"); }
  });
}

// ---------------------------------------------------------------- boot

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
route();
refreshStatus();
setInterval(refreshStatus, 5000);
