// ---------- Shared helpers (every page) ----------
let ME = null, ws = null;

async function api(url, method = 'GET', body) {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Call on every page. Returns false (and redirects) if not logged in.
async function initPage(requireLogin = true) {
  try { ME = await api('/api/me'); } catch (e) { ME = null; }
  if (!ME && requireLogin) { location.href = '/login.html'; return false; }
  document.getElementById('nav').innerHTML = `
    <h1 class="logo">📋 TaskBoard</h1>
    <nav>
      ${ME ? `<a href="/">Projects</a>
        <span id="bell" onclick="toggleNotifs()">🔔 <span class="badge" id="nc">0</span></span>
        <a href="#" onclick="logout()">Logout (${esc(ME.name)})</a>`
      : `<a href="/login.html">Login / Register</a>`}
    </nav>
    <div class="panel" id="panel" style="display:none"></div>`;
  if (ME) { updateBadge(); connectWS(); }
  return true;
}

async function logout() { await api('/api/logout', 'POST'); location.href = '/login.html'; }

// ---------- Real-time (WebSocket) ----------
function connectWS() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.type === 'notification') { toast('🔔 ' + d.message); updateBadge(); }
    window.dispatchEvent(new CustomEvent('ws', { detail: d }));   // pages listen to this
  };
  ws.onclose = () => setTimeout(connectWS, 3000);                 // auto-reconnect
}

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ---------- Notifications ----------
async function updateBadge() {
  try {
    const list = await api('/api/notifications');
    document.getElementById('nc').textContent = list.filter(n => !n.is_read).length;
  } catch (e) {}
}

async function toggleNotifs() {
  const panel = document.getElementById('panel');
  if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
  const list = await api('/api/notifications');
  panel.innerHTML = list.length
    ? list.map(n => `<div class="${n.is_read ? '' : 'unread'}" onclick="location.href='/board.html?id=${n.project_id}'">${esc(n.message)}<br><small>${n.created_at}</small></div>`).join('')
    : '<div>No notifications yet</div>';
  panel.style.display = 'block';
  await api('/api/notifications/read', 'POST');
  document.getElementById('nc').textContent = 0;
}
