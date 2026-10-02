import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { getPool, sql } from './db.js';
import { authenticate, signUser } from './auth.js';
import { assessmentRouter } from './routes/assessments.js';
import { adminRouter } from './routes/admin.js';
import { dashboardRouter } from './routes/dashboard.js';
import { reportRouter } from './routes/reports.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

app.get('/api/health', async (_req, res) => {
  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1 AS ok');
    res.json({ ok: true, database: 'SQL Server' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const pool = await getPool();
    const rows = await pool.request().input('email', sql.NVarChar, email).query(`
      SELECT u.*, r.name AS role_name, s.id AS surveyor_id
      FROM users u
      INNER JOIN roles r ON r.id=u.role_id
      LEFT JOIN surveyors s ON s.user_id=u.id
      WHERE LOWER(u.email)=@email`);
    const user = rows.recordset[0];
    if (!user || user.status !== 'Active' || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Email or password is not recognised.' });
    }
    const perms = await pool.request().input('role', sql.Int, user.role_id).query(`SELECT permission_code FROM role_permissions WHERE role_id=@role`);
    const permissions = perms.recordset.map((p) => p.permission_code);
    const token = signUser(user, permissions);
    res.json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role_name,
        employeeId: user.employee_id, surveyorId: user.surveyor_id, permissions
      }
    });
  } catch (err) { next(err); }
});

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/audit', authenticate, async (req, res, next) => {
  try {
    if (!(req.user.permissions || []).includes('audit.view')) {
      return res.status(403).json({ error: 'You do not have permission for this action.' });
    }
    const pool = await getPool();
    const rows = await pool.request().query(`SELECT TOP 300 a.*, u.name AS user_name
      FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC`);
    res.json(rows.recordset);
  } catch (err) { next(err); }
});

app.use('/api/dashboard', authenticate, dashboardRouter);
app.use('/api/assessments', authenticate, assessmentRouter);
app.use('/api/reports', authenticate, reportRouter);
app.use('/api/admin', authenticate, adminRouter);

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const message = status >= 500 ? 'The server could not complete that request.' : err.message;
  res.status(status).json({ error: message });
});

const port = Number(process.env.PORT || 4317);
app.listen(port, '0.0.0.0', () => {
  console.log(`ESA API listening on ${port}`);
});
