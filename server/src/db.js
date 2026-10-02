import sql from 'mssql';
import dotenv from 'dotenv';

dotenv.config();

export const dbConfig = {
  server: process.env.DB_SERVER || '127.0.0.1',
  port: Number(process.env.DB_PORT || 1433),
  user: process.env.DB_USER || 'sa',
  password: process.env.DB_PASSWORD || 'Esa@Sql#2026!',
  database: process.env.DB_NAME || 'EsaManagement',
  options: {
    encrypt: true,
    trustServerCertificate: true,
    enableArithAbort: true
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  requestTimeout: 60000
};

let pool;

export function resetPool() {
  pool = null;
}

export async function getPool() {
  if (!pool) {
    pool = new sql.ConnectionPool(dbConfig);
    await pool.connect();
  }
  return pool;
}

export async function query(strings, ...values) {
  const p = await getPool();
  const request = p.request();
  let text = '';
  strings.forEach((part, i) => {
    text += part;
    if (i < values.length) {
      const name = `p${i}`;
      request.input(name, values[i]);
      text += `@${name}`;
    }
  });
  return request.query(text);
}

export { sql };
