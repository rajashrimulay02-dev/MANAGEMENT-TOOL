const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const db = new Database('pm.db');

// ---------- Database tables ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  description TEXT DEFAULT '', owner_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS project_members(
  project_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  PRIMARY KEY(project_id, user_id));
CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
  title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'todo', assigned_to INTEGER,
  created_by INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL, content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  message TEXT NOT NULL, project_id INTEGER, is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

const sessionMw = session({ secret: 'change-this-secret', resave: false, saveUninitialized: false });
app.use(express.json());
app.use(sessionMw);
app.use(express.static('public'));

// ---------- WebSockets (real-time updates + notifications) ----------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  sessionMw(req, {}, () => {                       // reuse login session
    if (!req.session || !req.session.userId) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.userId = req.session.userId;
      wss.emit('connection', ws, req);
    });
  });
});

function sendTo(userIds, payload) {
  const ids = new Set(userIds);
  const msg = JSON.stringify(payload);
  wss.clients.forEach(c => { if (c.readyState === 1 && ids.has(c.userId)) c.send(msg); });
}
const memberIds = pid => db.prepare('SELECT user_id FROM project_members WHERE project_id=?').all(pid).map(r => r.user_id);
const refresh = (pid, extra = {}) => sendTo(memberIds(pid), { type: 'project_update', projectId: pid, ...extra });

function notify(userId, message, projectId) {
  db.prepare('INSERT INTO notifications(user_id,message,project_id) VALUES(?,?,?)').run(userId, message, projectId);
  sendTo([userId], { type: 'notification', message, projectId });
}

// ---------- Helpers ----------
const needLogin = (req, res, next) =>
  req.session.userId ? next() : res.status(401).json({ error: 'Please login first' });
const isMember = (pid, uid) => !!db.prepare('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?').get(pid, uid);
const userName = id => db.prepare('SELECT name FROM users WHERE id=?').get(id).name;

// Load a task only if the logged-in user belongs to its project
function getTask(req, res) {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t || !isMember(t.project_id, req.session.userId)) {
    res.status(404).json({ error: 'Task not found' });
    return null;
  }
  return t;
}

// ---------- Auth ----------
app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 6)
    return res.status(400).json({ error: 'Fill all fields (password minimum 6 characters)' });
  try {
    const r = db.prepare('INSERT INTO users(name,email,password) VALUES(?,?,?)')
      .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10));
    req.session.userId = r.lastInsertRowid;
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: 'Email already registered' }); }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE email=?').get((email || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(password || '', u.password))
    return res.status(400).json({ error: 'Wrong email or password' });
  req.session.userId = u.id;
  res.json({ id: u.id });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json(null);
  res.json(db.prepare('SELECT id,name,email FROM users WHERE id=?').get(req.session.userId));
});

// ---------- Projects ----------
app.get('/api/projects', needLogin, (req, res) => {
  res.json(db.prepare(`
    SELECT p.*, 
      (SELECT COUNT(*) FROM project_members WHERE project_id=p.id) AS members,
      (SELECT COUNT(*) FROM tasks WHERE project_id=p.id) AS tasks,
      (SELECT COUNT(*) FROM tasks WHERE project_id=p.id AND status='done') AS done
    FROM projects p JOIN project_members m ON m.project_id=p.id
    WHERE m.user_id=? ORDER BY p.id DESC`).all(req.session.userId));
});

app.post('/api/projects', needLogin, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  const create = db.transaction(() => {
    const r = db.prepare('INSERT INTO projects(name,description,owner_id) VALUES(?,?,?)')
      .run(name, (req.body.description || '').trim(), req.session.userId);
    db.prepare('INSERT INTO project_members(project_id,user_id) VALUES(?,?)').run(r.lastInsertRowid, req.session.userId);
    return r.lastInsertRowid;
  });
  res.json({ id: create() });
});

app.get('/api/projects/:id', needLogin, (req, res) => {
  const pid = req.params.id;
  if (!isMember(pid, req.session.userId)) return res.status(404).json({ error: 'Project not found' });
  res.json({
    project: db.prepare('SELECT * FROM projects WHERE id=?').get(pid),
    members: db.prepare(`SELECT u.id,u.name,u.email FROM users u
      JOIN project_members m ON m.user_id=u.id WHERE m.project_id=?`).all(pid),
    tasks: db.prepare(`SELECT t.*, u.name AS assignee_name,
      (SELECT COUNT(*) FROM comments WHERE task_id=t.id) AS comment_count
      FROM tasks t LEFT JOIN users u ON u.id=t.assigned_to
      WHERE t.project_id=? ORDER BY t.id`).all(pid)
  });
});

// Add a team member by email (project owner only)
app.post('/api/projects/:id/members', needLogin, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p || p.owner_id !== req.session.userId)
    return res.status(403).json({ error: 'Only the project owner can add members' });
  const u = db.prepare('SELECT id FROM users WHERE email=?').get((req.body.email || '').trim().toLowerCase());
  if (!u) return res.status(404).json({ error: 'No user with this email. Ask them to register first.' });
  if (isMember(p.id, u.id)) return res.status(400).json({ error: 'Already a member' });
  db.prepare('INSERT INTO project_members(project_id,user_id) VALUES(?,?)').run(p.id, u.id);
  notify(u.id, `${userName(req.session.userId)} added you to project "${p.name}"`, p.id);
  refresh(p.id);
  res.json({ ok: true });
});

// ---------- Tasks ----------
app.post('/api/projects/:id/tasks', needLogin, (req, res) => {
  const pid = parseInt(req.params.id), me = req.session.userId;
  if (!isMember(pid, me)) return res.status(404).json({ error: 'Project not found' });
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Task title is required' });
  let assignee = req.body.assigned_to ? parseInt(req.body.assigned_to) : null;
  if (assignee && !isMember(pid, assignee)) return res.status(400).json({ error: 'Assignee must be a project member' });
  const r = db.prepare('INSERT INTO tasks(project_id,title,description,assigned_to,created_by) VALUES(?,?,?,?,?)')
    .run(pid, title, (req.body.description || '').trim(), assignee, me);
  if (assignee && assignee !== me) notify(assignee, `${userName(me)} assigned you a task: "${title}"`, pid);
  refresh(pid);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/tasks/:id', needLogin, (req, res) => {
  const t = getTask(req, res); if (!t) return;
  const me = req.session.userId, b = req.body;
  const n = {
    title: b.title !== undefined ? String(b.title).trim() : t.title,
    description: b.description !== undefined ? String(b.description).trim() : t.description,
    status: b.status !== undefined ? b.status : t.status,
    assigned_to: b.assigned_to !== undefined ? (b.assigned_to ? parseInt(b.assigned_to) : null) : t.assigned_to
  };
  if (!n.title) return res.status(400).json({ error: 'Title cannot be empty' });
  if (!['todo', 'doing', 'done'].includes(n.status)) return res.status(400).json({ error: 'Invalid status' });
  if (n.assigned_to && !isMember(t.project_id, n.assigned_to))
    return res.status(400).json({ error: 'Assignee must be a project member' });

  db.prepare('UPDATE tasks SET title=?,description=?,status=?,assigned_to=? WHERE id=?')
    .run(n.title, n.description, n.status, n.assigned_to, t.id);

  const who = userName(me);
  if (n.assigned_to && n.assigned_to !== t.assigned_to && n.assigned_to !== me)
    notify(n.assigned_to, `${who} assigned you a task: "${n.title}"`, t.project_id);
  if (n.status !== t.status) {
    const label = { todo: 'To Do', doing: 'In Progress', done: 'Done' }[n.status];
    new Set([n.assigned_to, t.created_by]).forEach(uid => {
      if (uid && uid !== me) notify(uid, `${who} moved "${n.title}" to ${label}`, t.project_id);
    });
  }
  refresh(t.project_id, { taskId: t.id });
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', needLogin, (req, res) => {
  const t = getTask(req, res); if (!t) return;
  db.prepare('DELETE FROM comments WHERE task_id=?').run(t.id);
  db.prepare('DELETE FROM tasks WHERE id=?').run(t.id);
  refresh(t.project_id);
  res.json({ ok: true });
});

// ---------- Comments ----------
app.get('/api/tasks/:id/comments', needLogin, (req, res) => {
  const t = getTask(req, res); if (!t) return;
  res.json(db.prepare(`SELECT c.id,c.content,c.created_at,u.name FROM comments c
    JOIN users u ON u.id=c.user_id WHERE c.task_id=? ORDER BY c.id`).all(t.id));
});

app.post('/api/tasks/:id/comments', needLogin, (req, res) => {
  const t = getTask(req, res); if (!t) return;
  const content = (req.body.content || '').trim();
  if (!content || content.length > 300) return res.status(400).json({ error: 'Comment must be 1-300 characters' });
  const me = req.session.userId;
  db.prepare('INSERT INTO comments(task_id,user_id,content) VALUES(?,?,?)').run(t.id, me, content);
  new Set([t.assigned_to, t.created_by]).forEach(uid => {
    if (uid && uid !== me) notify(uid, `${userName(me)} commented on "${t.title}"`, t.project_id);
  });
  refresh(t.project_id, { taskId: t.id });
  res.json({ ok: true });
});

// ---------- Notifications ----------
app.get('/api/notifications', needLogin, (req, res) => {
  res.json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 20').all(req.session.userId));
});
app.post('/api/notifications/read', needLogin, (req, res) => {
  db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.session.userId);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Project tool running at http://localhost:${PORT}`));
