import { sql } from './db.js';

export async function writeAudit(executor, userId, entityType, entityId, action, oldValue, newValue) {
  const request = executor.request ? executor.request() : executor;
  await request
    .input('userId', sql.Int, userId || null)
    .input('entityType', sql.NVarChar, entityType)
    .input('entityId', sql.NVarChar, entityId == null ? null : String(entityId))
    .input('action', sql.NVarChar, action)
    .input('oldValue', sql.NVarChar, oldValue == null ? null : JSON.stringify(oldValue))
    .input('newValue', sql.NVarChar, newValue == null ? null : JSON.stringify(newValue))
    .query(`INSERT INTO audit_logs(user_id, entity_type, entity_id, action, old_value, new_value)
            VALUES (@userId, @entityType, @entityId, @action, @oldValue, @newValue)`);
}
