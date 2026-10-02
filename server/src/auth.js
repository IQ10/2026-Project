import jwt from 'jsonwebtoken';

export const tokenSecret = process.env.JWT_SECRET || 'esa-desk-dev-secret-change-me';

export function signUser(user, permissions) {
  return jwt.sign({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role_name,
    employeeId: user.employee_id,
    surveyorId: user.surveyor_id || null,
    permissions
  }, tokenSecret, { expiresIn: '12h' });
}

export function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  try {
    req.user = jwt.verify(token, tokenSecret);
    next();
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
}

export function requirePerm(...codes) {
  return (req, res, next) => {
    const have = req.user.permissions || [];
    if (!codes.every((code) => have.includes(code))) {
      return res.status(403).json({ error: 'You do not have permission for this action.' });
    }
    next();
  };
}

export function canSeeAll(user) {
  return (user.permissions || []).includes('assessments.view.all');
}
