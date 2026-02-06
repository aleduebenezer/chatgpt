const express = require("express");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const http = require("http");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "workit-dev-secret";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const db = new sqlite3.Database(path.join(__dirname, "workit.db"));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const run = (statement, params = []) =>
  new Promise((resolve, reject) => {
    db.run(statement, params, function onRun(err) {
      if (err) reject(err);
      resolve(this);
    });
  });

const all = (statement, params = []) =>
  new Promise((resolve, reject) => {
    db.all(statement, params, (err, rows) => {
      if (err) reject(err);
      resolve(rows);
    });
  });

const get = (statement, params = []) =>
  new Promise((resolve, reject) => {
    db.get(statement, params, (err, row) => {
      if (err) reject(err);
      resolve(row);
    });
  });

const init = async () => {
  await run(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      skills TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      interest TEXT NOT NULL,
      budget TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES users (id)
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      talent_id INTEGER NOT NULL,
      cover_note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs (id),
      FOREIGN KEY (talent_id) REFERENCES users (id)
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      talent_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      next_payment_date TEXT NOT NULL,
      started_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs (id)
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      reviewer_id INTEGER NOT NULL,
      reviewee_id INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (contract_id) REFERENCES contracts (id)
    )`
  );
};

const authMiddleware = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "Missing token" });
  const [, token] = header.split(" ");
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

app.post("/api/register", async (req, res) => {
  const { name, email, password, role, skills } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const hash = await bcrypt.hash(password, 10);
  try {
    const result = await run(
      `INSERT INTO users (name, email, password_hash, role, skills, created_at)
       VALUES (?, ?, ?, ?, ?, ?)` ,
      [name, email, hash, role, skills || "", new Date().toISOString()]
    );
    const token = jwt.sign({ id: result.lastID, role }, JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token });
  } catch (error) {
    return res.status(400).json({ error: "Email already registered" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await get("SELECT * FROM users WHERE email = ?", [email]);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
  return res.json({ token, role: user.role });
});

app.get("/api/profile", authMiddleware, async (req, res) => {
  const user = await get(
    "SELECT id, name, email, role, skills, created_at FROM users WHERE id = ?",
    [req.user.id]
  );
  return res.json(user);
});

app.put("/api/profile", authMiddleware, async (req, res) => {
  const { name, skills } = req.body;
  await run("UPDATE users SET name = ?, skills = ? WHERE id = ?", [name, skills, req.user.id]);
  return res.json({ status: "updated" });
});

app.post("/api/jobs", authMiddleware, async (req, res) => {
  const { title, description, interest, budget } = req.body;
  if (req.user.role !== "client") {
    return res.status(403).json({ error: "Only clients can post jobs" });
  }
  const result = await run(
    `INSERT INTO jobs (client_id, title, description, interest, budget, created_at)
     VALUES (?, ?, ?, ?, ?, ?)` ,
    [req.user.id, title, description, interest, budget, new Date().toISOString()]
  );
  const job = await get("SELECT * FROM jobs WHERE id = ?", [result.lastID]);
  io.emit("job:new", job);
  return res.json(job);
});

app.get("/api/jobs", authMiddleware, async (req, res) => {
  const jobs = await all(
    `SELECT jobs.*, users.name as client_name
     FROM jobs
     JOIN users ON jobs.client_id = users.id
     WHERE jobs.status = 'open'
     ORDER BY jobs.created_at DESC`
  );
  return res.json(jobs);
});

app.post("/api/applications", authMiddleware, async (req, res) => {
  const { jobId, coverNote } = req.body;
  if (req.user.role !== "talent") {
    return res.status(403).json({ error: "Only talents can apply" });
  }
  const job = await get("SELECT * FROM jobs WHERE id = ?", [jobId]);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const result = await run(
    `INSERT INTO applications (job_id, talent_id, cover_note, created_at)
     VALUES (?, ?, ?, ?)` ,
    [jobId, req.user.id, coverNote || "", new Date().toISOString()]
  );
  const application = await get("SELECT * FROM applications WHERE id = ?", [result.lastID]);
  io.emit("application:new", { jobId, application });
  return res.json(application);
});

app.get("/api/client/dashboard", authMiddleware, async (req, res) => {
  if (req.user.role !== "client") {
    return res.status(403).json({ error: "Only clients can access dashboard" });
  }
  const jobs = await all("SELECT * FROM jobs WHERE client_id = ?", [req.user.id]);
  const applications = await all(
    `SELECT applications.*, users.name as talent_name, users.skills as talent_skills, jobs.title as job_title
     FROM applications
     JOIN users ON applications.talent_id = users.id
     JOIN jobs ON applications.job_id = jobs.id
     WHERE jobs.client_id = ?
     ORDER BY applications.created_at DESC`,
    [req.user.id]
  );
  const contracts = await all(
    `SELECT contracts.*, jobs.title as job_title, users.name as talent_name
     FROM contracts
     JOIN jobs ON contracts.job_id = jobs.id
     JOIN users ON contracts.talent_id = users.id
     WHERE contracts.client_id = ?`,
    [req.user.id]
  );
  return res.json({ jobs, applications, contracts });
});

app.post("/api/contracts", authMiddleware, async (req, res) => {
  const { applicationId } = req.body;
  if (req.user.role !== "client") {
    return res.status(403).json({ error: "Only clients can start contracts" });
  }
  const application = await get("SELECT * FROM applications WHERE id = ?", [applicationId]);
  if (!application) return res.status(404).json({ error: "Application not found" });
  const job = await get("SELECT * FROM jobs WHERE id = ?", [application.job_id]);
  if (job.client_id !== req.user.id) {
    return res.status(403).json({ error: "Not your job" });
  }
  const nextPayment = new Date();
  nextPayment.setDate(nextPayment.getDate() + 30);
  const result = await run(
    `INSERT INTO contracts (job_id, client_id, talent_id, next_payment_date, started_at)
     VALUES (?, ?, ?, ?, ?)` ,
    [job.id, req.user.id, application.talent_id, nextPayment.toISOString(), new Date().toISOString()]
  );
  await run("UPDATE applications SET status = 'accepted' WHERE id = ?", [applicationId]);
  io.emit("contract:new", { jobId: job.id, talentId: application.talent_id });
  const contract = await get("SELECT * FROM contracts WHERE id = ?", [result.lastID]);
  return res.json(contract);
});

app.post("/api/contracts/:id/hold", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const contract = await get("SELECT * FROM contracts WHERE id = ?", [id]);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  if (req.user.role !== "client" || contract.client_id !== req.user.id) {
    return res.status(403).json({ error: "Not authorized" });
  }
  await run("UPDATE contracts SET status = 'on-hold' WHERE id = ?", [id]);
  return res.json({ status: "on-hold" });
});

app.post("/api/contracts/:id/terminate", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const contract = await get("SELECT * FROM contracts WHERE id = ?", [id]);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  if (req.user.role !== "client" || contract.client_id !== req.user.id) {
    return res.status(403).json({ error: "Not authorized" });
  }
  await run("UPDATE contracts SET status = 'terminated' WHERE id = ?", [id]);
  return res.json({ status: "terminated" });
});

app.post("/api/reviews", authMiddleware, async (req, res) => {
  const { contractId, revieweeId, rating, comment } = req.body;
  await run(
    `INSERT INTO reviews (contract_id, reviewer_id, reviewee_id, rating, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?)` ,
    [contractId, req.user.id, revieweeId, rating, comment || "", new Date().toISOString()]
  );
  return res.json({ status: "submitted" });
});

io.on("connection", (socket) => {
  socket.emit("connected", { status: "ok" });
});

init().then(() => {
  server.listen(PORT, () => {
    console.log(`Workit server running on http://localhost:${PORT}`);
  });
});
