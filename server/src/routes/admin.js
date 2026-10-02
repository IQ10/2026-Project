import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getPool, sql } from '../db.js';
import { requirePerm } from '../auth.js';
import { writeAudit } from '../audit.js';

export const adminRouter = Router();
adminRouter.use(requirePerm('masters.manage'));

const catalogues = {
  dealers: {
    table: 'dealers',
    fields: ['dealer_code', 'dealer_name', 'dealer_group', 'address', 'city', 'state', 'region', 'postal_code', 'contact_person', 'contact_number', 'email', 'status'],
    required: ['dealer_code', 'dealer_name', 'address', 'city', 'state']
  },
  surveyors: {
    table: 'surveyors',
    fields: ['employee_id', 'name', 'email', 'phone', 'region', 'role_name', 'status', 'user_id'],
    required: ['employee_id', 'name']
  },
  'assessment-types': {
    table: 'assessment_types',
    fields: ['code', 'name', 'description', 'active_status', 'approval_status', 'effective_from', 'effective_to'],
    required: ['code', 'name']
  },
  templates: {
    table: 'assessment_templates',
    fields: ['assessment_type_id', 'version', 'status', 'approval_status', 'effective_from', 'effective_to', 'exclude_na_from_compliance', 'notes'],
    required: ['assessment_type_id', 'version', 'status', 'approval_status']
  },
  sections: {
    table: 'checklist_sections',
    fields: ['template_id', 'section_code', 'section_name', 'section_description', 'display_order', 'active_status'],
    required: ['template_id', 'section_code', 'section_name', 'display_order']
  },
  items: {
    table: 'checklist_items',
    fields: ['template_id', 'section_id', 'item_number', 'activity_description', 'requirement_description', 'guidance', 'response_type_id', 'risk_rating_enabled', 'observation_required', 'recommendation_required', 'evidence_required', 'display_order', 'active_status', 'version_number', 'source_review'],
    required: ['template_id', 'section_id', 'item_number', 'activity_description', 'requirement_description', 'response_type_id', 'display_order']
  },
  applicability: {
    table: 'applicability_rules',
    fields: ['checklist_item_id', 'assessment_type_id', 'facility_type', 'applicability_status', 'default_response', 'conditional_attribute', 'allow_override', 'effective_from', 'effective_to', 'active_status', 'review_required', 'remarks'],
    required: ['checklist_item_id', 'assessment_type_id', 'facility_type', 'applicability_status']
  },
  'risk-ratings': {
    table: 'risk_ratings',
    fields: ['code', 'name', 'description', 'severity_level', 'display_order', 'active_status'],
    required: ['code', 'name', 'severity_level', 'display_order']
  },
  'response-types': {
    table: 'response_types',
    fields: ['code', 'name', 'description', 'active_status'],
    required: ['code', 'name']
  },
  'response-options': {
    table: 'response_options',
    fields: ['response_type_id', 'code', 'label', 'counts_as', 'requires_observation', 'requires_recommendation', 'requires_risk', 'selectable_by_surveyor', 'display_order', 'active_status'],
    required: ['response_type_id', 'code', 'label', 'counts_as', 'display_order']
  },
  lookups: {
    table: 'lookups',
    fields: ['category', 'code', 'name', 'display_order', 'active_status'],
    required: ['category', 'code', 'name']
  }
};

adminRouter.get('/audit', async (req, res, next) => {
  try {
    const pool = await getPool();
    const rows = await pool.request().input('entity', sql.NVarChar, req.query.entity || null).query(`
      SELECT TOP 300 a.*, u.name AS user_name
      FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
      WHERE (@entity IS NULL OR a.entity_type=@entity)
      ORDER BY a.created_at DESC`);
    res.json(rows.recordset);
  } catch (err) { next(err); }
});

adminRouter.get('/users', async (req, res, next) => {
  try {
    const pool = await getPool();
    const rows = await pool.request().query(`SELECT u.id, u.name, u.email, u.employee_id, u.phone, u.region, u.status, u.created_at, r.name AS role_name, r.id AS role_id
      FROM users u INNER JOIN roles r ON r.id=u.role_id ORDER BY u.name`);
    res.json(rows.recordset);
  } catch (err) { next(err); }
});

adminRouter.post('/users', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.name || !body.email || !body.password || !body.role_id) return res.status(400).json({ error: 'Name, email, password and role are required.' });
    const pool = await getPool();
    const hash = bcrypt.hashSync(body.password, 10);
    const inserted = await pool.request()
      .input('name', sql.NVarChar, body.name).input('email', sql.NVarChar, body.email).input('hash', sql.NVarChar, hash)
      .input('role', sql.Int, body.role_id).input('emp', sql.NVarChar, body.employee_id || null)
      .input('phone', sql.NVarChar, body.phone || null).input('region', sql.NVarChar, body.region || null)
      .input('status', sql.NVarChar, body.status || 'Active')
      .query(`INSERT INTO users(name, email, password_hash, role_id, employee_id, phone, region, status)
              OUTPUT INSERTED.id VALUES (@name,@email,@hash,@role,@emp,@phone,@region,@status)`);
    await writeAudit(pool, req.user.id, 'user', inserted.recordset[0].id, 'create', null, { email: body.email, role_id: body.role_id });
    res.status(201).json(inserted.recordset[0]);
  } catch (err) { next(err); }
});

adminRouter.put('/users/:id', async (req, res, next) => {
  try {
    const pool = await getPool();
    const id = Number(req.params.id);
    const before = await pool.request().input('id', sql.Int, id).query(`SELECT id, name, email, role_id, status FROM users WHERE id=@id`);
    if (!before.recordset[0]) return res.status(404).json({ error: 'User not found.' });
    const body = req.body || {};
    const request = pool.request().input('id', sql.Int, id)
      .input('name', sql.NVarChar, body.name).input('role', sql.Int, body.role_id)
      .input('status', sql.NVarChar, body.status).input('emp', sql.NVarChar, body.employee_id || null)
      .input('phone', sql.NVarChar, body.phone || null).input('region', sql.NVarChar, body.region || null);
    let passwordSql = '';
    if (body.password) {
      request.input('hash', sql.NVarChar, bcrypt.hashSync(body.password, 10));
      passwordSql = ', password_hash=@hash';
    }
    await request.query(`UPDATE users SET name=@name, role_id=@role, status=@status, employee_id=@emp, phone=@phone, region=@region ${passwordSql} WHERE id=@id`);
    await writeAudit(pool, req.user.id, 'user', id, 'update', before.recordset[0], { ...body, password: body.password ? 'changed' : undefined });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

adminRouter.get('/roles', async (req, res, next) => {
  try {
    const pool = await getPool();
    const rows = await pool.request().query(`SELECT * FROM roles ORDER BY name`);
    res.json(rows.recordset);
  } catch (err) { next(err); }
});

adminRouter.get('/facilities', async (req, res, next) => {
  try {
    const pool = await getPool();
    const rows = await pool.request().query(`
      SELECT f.*, d.dealer_code, d.dealer_name
      FROM facilities f INNER JOIN dealers d ON d.id=f.dealer_id
      ORDER BY d.dealer_name, f.facility_name`);
    const attrs = await pool.request().query(`SELECT * FROM facility_attributes`);
    const grouped = rows.recordset.map((f) => ({
      ...f,
      attributes: Object.fromEntries(attrs.recordset.filter((a) => a.facility_id === f.id).map((a) => [a.attribute_code, !!a.attribute_value]))
    }));
    res.json(grouped);
  } catch (err) { next(err); }
});

adminRouter.post('/facilities', async (req, res, next) => {
  try {
    const id = await saveFacility(req, null);
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

adminRouter.put('/facilities/:id', async (req, res, next) => {
  try {
    await saveFacility(req, Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

async function saveFacility(req, id) {
  const body = req.body || {};
  if (!body.dealer_id || !body.facility_name || !body.facility_type) {
    const error = new Error('Dealer, facility name and facility type are required.');
    error.status = 400;
    throw error;
  }
  if (!['1S', '2S', '3S'].includes(body.facility_type)) {
    const error = new Error('Facility type must be 1S, 2S or 3S.');
    error.status = 400;
    throw error;
  }
  const pool = await getPool();
  let facilityId = id;
  if (!id) {
    const inserted = await pool.request()
      .input('d', sql.Int, body.dealer_id).input('n', sql.NVarChar, body.facility_name)
      .input('t', sql.NVarChar, body.facility_type).input('a', sql.NVarChar, body.address || null)
      .input('s', sql.NVarChar, body.status || 'Active')
      .input('from', sql.Date, body.effective_from || null).input('to', sql.Date, body.effective_to || null)
      .query(`INSERT INTO facilities(dealer_id, facility_name, facility_type, address, status, effective_from, effective_to)
              OUTPUT INSERTED.id VALUES (@d,@n,@t,@a,@s,@from,@to)`);
    facilityId = inserted.recordset[0].id;
    await writeAudit(pool, req.user.id, 'facility', facilityId, 'create', null, body);
  } else {
    const before = await pool.request().input('id', sql.Int, id).query(`SELECT * FROM facilities WHERE id=@id`);
    await pool.request()
      .input('id', sql.Int, id).input('d', sql.Int, body.dealer_id).input('n', sql.NVarChar, body.facility_name)
      .input('t', sql.NVarChar, body.facility_type).input('a', sql.NVarChar, body.address || null)
      .input('s', sql.NVarChar, body.status || 'Active')
      .input('from', sql.Date, body.effective_from || null).input('to', sql.Date, body.effective_to || null)
      .query(`UPDATE facilities SET dealer_id=@d, facility_name=@n, facility_type=@t, address=@a, status=@s, effective_from=@from, effective_to=@to WHERE id=@id`);
    await writeAudit(pool, req.user.id, 'facility', id, 'update', before.recordset[0], body);
  }
  if (body.attributes && typeof body.attributes === 'object') {
    await pool.request().input('id', sql.Int, facilityId).query(`DELETE FROM facility_attributes WHERE facility_id=@id`);
    for (const [code, value] of Object.entries(body.attributes)) {
      if (value === null || value === undefined || value === '') continue;
      await pool.request().input('f', sql.Int, facilityId).input('c', sql.NVarChar, code).input('v', sql.Bit, value ? 1 : 0)
        .query(`INSERT INTO facility_attributes(facility_id, attribute_code, attribute_value) VALUES (@f,@c,@v)`);
    }
  }
  return facilityId;
}

for (const [name, config] of Object.entries(catalogues)) {
  adminRouter.get(`/${name}`, async (req, res, next) => {
    try {
      const pool = await getPool();
      const rows = await pool.request().query(`SELECT * FROM ${config.table} ORDER BY id DESC`);
      res.json(rows.recordset);
    } catch (err) { next(err); }
  });

  adminRouter.post(`/${name}`, async (req, res, next) => {
    try {
      const missing = config.required.filter((f) => req.body?.[f] === undefined || req.body?.[f] === '');
      if (missing.length) return res.status(400).json({ error: `Missing ${missing.join(', ')}.` });
      const pool = await getPool();
      const inserted = await insertRow(pool, config, req.body);
      await writeAudit(pool, req.user.id, config.table, inserted.id, 'create', null, req.body);
      res.status(201).json(inserted);
    } catch (err) { next(err); }
  });

  adminRouter.put(`/${name}/:id`, async (req, res, next) => {
    try {
      const pool = await getPool();
      const id = Number(req.params.id);
      const before = await pool.request().input('id', sql.Int, id).query(`SELECT * FROM ${config.table} WHERE id=@id`);
      if (!before.recordset[0]) return res.status(404).json({ error: 'Record not found.' });
      await updateRow(pool, config, id, req.body || {});
      await writeAudit(pool, req.user.id, config.table, id, 'update', before.recordset[0], req.body);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
}

async function insertRow(pool, config, body) {
  const request = pool.request();
  const cols = [];
  const vals = [];
  config.fields.forEach((field, i) => {
    if (body[field] === undefined) return;
    const param = `p${i}`;
    request.input(param, body[field]);
    cols.push(field);
    vals.push(`@${param}`);
  });
  const result = await request.query(`INSERT INTO ${config.table}(${cols.join(',')}) OUTPUT INSERTED.id VALUES (${vals.join(',')})`);
  return result.recordset[0];
}

async function updateRow(pool, config, id, body) {
  const request = pool.request().input('id', sql.Int, id);
  const sets = [];
  config.fields.forEach((field, i) => {
    if (body[field] === undefined) return;
    const param = `p${i}`;
    request.input(param, body[field] === '' ? null : body[field]);
    sets.push(`${field}=@${param}`);
  });
  if (!sets.length) return;
  await request.query(`UPDATE ${config.table} SET ${sets.join(', ')} WHERE id=@id`);
}

adminRouter.get('/import/validate', async (req, res, next) => {
  try {
    const pool = await getPool();
    const flags = await validateTemplate(pool, req.query.templateId ? Number(req.query.templateId) : null);
    res.json({ flags, count: flags.length });
  } catch (err) { next(err); }
});

adminRouter.post('/import/preview', async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const flags = previewItems(items);
    res.json({
      items: items.length,
      sections: new Set(items.map((i) => i.section).filter(Boolean)).size,
      flags,
      ready: !flags.some((f) => f.severity === 'error')
    });
  } catch (err) { next(err); }
});

adminRouter.post('/import/commit', async (req, res, next) => {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const flags = previewItems(items);
    if (!items.length || flags.some((f) => f.severity === 'error')) {
      return res.status(422).json({ error: 'Fix preview errors before import.', flags });
    }
    const typeCode = req.body.assessmentTypeCode || 'ESA';
    await tx.begin();
    const typeRow = await tx.request().input('code', sql.NVarChar, typeCode).query(`SELECT id FROM assessment_types WHERE code=@code`);
    if (!typeRow.recordset[0]) {
      await tx.rollback();
      return res.status(400).json({ error: 'Assessment type code was not found. Create the type in master data first.' });
    }
    const typeId = typeRow.recordset[0].id;
    const verRow = await tx.request().input('t', sql.Int, typeId).query(`SELECT COUNT(*) AS n FROM assessment_templates WHERE assessment_type_id=@t`);
    const version = `1.${verRow.recordset[0].n}`;
    const responseType = await tx.request().query(`SELECT TOP 1 id FROM response_types WHERE code=N'COMPLIANCE'`);
    const tpl = await tx.request().input('t', sql.Int, typeId).input('v', sql.NVarChar, version).input('u', sql.Int, req.user.id)
      .query(`INSERT INTO assessment_templates(assessment_type_id, version, status, approval_status, effective_from, exclude_na_from_compliance, notes)
              OUTPUT INSERTED.id VALUES (@t, @v, N'Draft', N'Draft', CAST(SYSUTCDATETIME() AS date), 1, N'Imported by administrator. Approve the template before surveyors use it.')`);
    const templateId = tpl.recordset[0].id;
    const sectionIds = new Map();
    let sectionOrder = 1;
    for (const item of items) {
      if (!sectionIds.has(item.section)) {
        const code = `IMP${String(sectionOrder).padStart(2, '0')}`;
        const sec = await tx.request().input('tpl', sql.Int, templateId).input('c', sql.NVarChar, code).input('n', sql.NVarChar, item.section).input('o', sql.Int, sectionOrder)
          .query(`INSERT INTO checklist_sections(template_id, section_code, section_name, display_order) OUTPUT INSERTED.id VALUES (@tpl,@c,@n,@o)`);
        sectionIds.set(item.section, sec.recordset[0].id);
        sectionOrder += 1;
      }
      const inserted = await tx.request()
        .input('tpl', sql.Int, templateId).input('sec', sql.Int, sectionIds.get(item.section))
        .input('num', sql.Int, Number(item.item_number)).input('act', sql.NVarChar, item.activity)
        .input('req', sql.NVarChar, item.requirement).input('rt', sql.Int, responseType.recordset[0].id)
        .input('rev', sql.Bit, item.source_review ? 1 : 0)
        .query(`INSERT INTO checklist_items(template_id, section_id, item_number, activity_description, requirement_description, response_type_id, display_order, source_review)
                OUTPUT INSERTED.id VALUES (@tpl,@sec,@num,@act,@req,@rt,@num,@rev)`);
      const applicability = item.applicability || {};
      for (const ft of ['1S', '2S', '3S']) {
        const rule = applicability[ft] || {};
        const status = typeof rule === 'string' ? rule : rule.status;
        await tx.request()
          .input('item', sql.Int, inserted.recordset[0].id).input('type', sql.Int, typeId).input('ft', sql.NVarChar, ft)
          .input('st', sql.NVarChar, status).input('def', sql.NVarChar, status === 'Not Applicable' ? 'NA' : 'Blank')
          .input('attr', sql.NVarChar, typeof rule === 'string' ? null : rule.attribute || null)
          .query(`INSERT INTO applicability_rules(checklist_item_id, assessment_type_id, facility_type, applicability_status, default_response, conditional_attribute, effective_from, review_required, remarks)
                  VALUES (@item,@type,@ft,@st,@def,@attr, CAST(SYSUTCDATETIME() AS date), 1, N'Imported rule. Confirm before approving the template.')`);
      }
    }
    const batch = await tx.request().input('tpl', sql.Int, templateId).input('u', sql.Int, req.user.id).input('s', sql.NVarChar, JSON.stringify({ items: items.length, flags: flags.length }))
      .query(`INSERT INTO import_batches(template_id, file_name, status, created_by, summary) OUTPUT INSERTED.id VALUES (@tpl, N'checklist.json', N'Committed', @u, @s)`);
    for (const flag of flags) {
      await tx.request().input('b', sql.Int, batch.recordset[0].id).input('n', sql.Int, flag.itemNumber || null).input('sv', sql.NVarChar, flag.severity).input('m', sql.NVarChar, flag.message)
        .query(`INSERT INTO import_flags(batch_id, item_number, severity, message) VALUES (@b,@n,@sv,@m)`);
    }
    await writeAudit(tx, req.user.id, 'assessment_template', templateId, 'import', null, { version, items: items.length });
    await tx.commit();
    res.status(201).json({ templateId, version, flags });
  } catch (err) {
    try { await tx.rollback(); } catch { /* closed */ }
    next(err);
  }
});

function previewItems(items) {
  const flags = [];
  const seen = new Map();
  items.forEach((item, index) => {
    const num = Number(item.item_number);
    if (!item.section) flags.push({ severity: 'error', itemNumber: num, message: `Row ${index + 1} is missing a section.` });
    if (!num) flags.push({ severity: 'error', itemNumber: num, message: `Row ${index + 1} is missing an item number.` });
    if (seen.has(num)) flags.push({ severity: 'error', itemNumber: num, message: `Duplicate item number ${num}.` });
    seen.set(num, true);
    if (!String(item.activity || '').trim()) flags.push({ severity: 'error', itemNumber: num, message: `Item ${num} is missing an activity description.` });
    if (!String(item.requirement || '').trim()) flags.push({ severity: 'error', itemNumber: num, message: `Item ${num} is missing a requirement.` });
    for (const ft of ['1S', '2S', '3S']) {
      const rule = item.applicability?.[ft];
      const status = typeof rule === 'string' ? rule : rule?.status;
      if (!status) flags.push({ severity: 'error', itemNumber: num, message: `Item ${num} has no ${ft} applicability.` });
      else if (!['Applicable', 'Not Applicable', 'Conditional'].includes(status)) flags.push({ severity: 'error', itemNumber: num, message: `Item ${num} has an invalid ${ft} applicability.` });
      else if (status === 'Conditional' && !(typeof rule === 'object' && rule.attribute)) flags.push({ severity: 'warning', itemNumber: num, message: `Item ${num} is conditional for ${ft} without a facility attribute. It will stay unanswered until configured.` });
    }
    if (item.source_review) flags.push({ severity: 'warning', itemNumber: num, message: `Item ${num} is flagged for administrator review of the source wording.` });
  });
  return flags;
}

async function validateTemplate(pool, templateId) {
  const tpl = templateId
    ? { id: templateId }
    : (await pool.request().query(`SELECT TOP 1 id FROM assessment_templates WHERE status=N'Active' ORDER BY id`)).recordset[0];
  if (!tpl) return [{ severity: 'error', message: 'No template to validate.' }];
  const items = await pool.request().input('id', sql.Int, tpl.id).query(`SELECT * FROM checklist_items WHERE template_id=@id`);
  const rules = await pool.request().input('id', sql.Int, tpl.id).query(`
    SELECT r.* FROM applicability_rules r INNER JOIN checklist_items i ON i.id=r.checklist_item_id WHERE i.template_id=@id AND r.active_status=1`);
  const flags = [];
  const seen = new Set();
  for (const item of items.recordset) {
    if (seen.has(item.item_number)) flags.push({ severity: 'error', itemNumber: item.item_number, message: `Duplicate item number ${item.item_number}.` });
    seen.add(item.item_number);
    if (!String(item.activity_description || '').trim()) flags.push({ severity: 'error', itemNumber: item.item_number, message: 'Missing activity description.' });
    if (!String(item.requirement_description || '').trim()) flags.push({ severity: 'error', itemNumber: item.item_number, message: 'Missing requirement.' });
    if (item.source_review) flags.push({ severity: 'warning', itemNumber: item.item_number, message: 'Source wording is flagged for administrator confirmation.' });
    for (const ft of ['1S', '2S', '3S']) {
      const rule = rules.recordset.find((r) => r.checklist_item_id === item.id && r.facility_type === ft);
      if (!rule) flags.push({ severity: 'error', itemNumber: item.item_number, message: `Missing ${ft} applicability. This item will not be assumed NA.` });
      else if (rule.applicability_status === 'Conditional' && !rule.conditional_attribute) flags.push({ severity: 'warning', itemNumber: item.item_number, message: `Conditional ${ft} rule has no facility attribute.` });
    }
  }
  return flags;
}
