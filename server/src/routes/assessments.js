import { Router } from 'express';
import multer from 'multer';
import { getPool, sql } from '../db.js';
import { canSeeAll, requirePerm } from '../auth.js';
import { writeAudit } from '../audit.js';
import { resolveApplicability, snapshotOf } from '../applicability.js';
import { summarise } from '../compliance.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
export const assessmentRouter = Router();

const editable = new Set(['Draft', 'In Progress', 'Returned']);

assessmentRouter.get('/dealers', async (req, res, next) => {
  try {
    const pool = await getPool();
    const q = `%${(req.query.q || '').trim()}%`;
    const includeInactive = req.query.includeInactive === '1' && canSeeAll(req.user);
    const rows = await pool.request().input('q', sql.NVarChar, q).query(`
      SELECT d.*, (SELECT COUNT(*) FROM facilities f WHERE f.dealer_id=d.id AND f.status=N'Active') AS facility_count
      FROM dealers d
      WHERE (@q = N'%%' OR d.dealer_code LIKE @q OR d.dealer_name LIKE @q OR d.city LIKE @q)
        AND (${includeInactive ? '1=1' : "d.status=N'Active'"})
      ORDER BY d.dealer_name`);
    res.json(rows.recordset);
  } catch (err) { next(err); }
});

assessmentRouter.get('/dealers/:id', async (req, res, next) => {
  try {
    const pool = await getPool();
    const dealer = await pool.request().input('id', sql.Int, Number(req.params.id)).query(`SELECT * FROM dealers WHERE id=@id`);
    if (!dealer.recordset[0]) return res.status(404).json({ error: 'Dealer not found.' });
    const facilities = await pool.request().input('id', sql.Int, Number(req.params.id)).query(`
      SELECT f.*, a.attribute_code, a.attribute_value
      FROM facilities f
      LEFT JOIN facility_attributes a ON a.facility_id=f.id
      WHERE f.dealer_id=@id
      ORDER BY f.facility_name`);
    const map = new Map();
    for (const row of facilities.recordset) {
      if (!map.has(row.id)) {
        map.set(row.id, {
          id: row.id, dealer_id: row.dealer_id, facility_name: row.facility_name, facility_type: row.facility_type,
          address: row.address, status: row.status, effective_from: row.effective_from, effective_to: row.effective_to,
          attributes: {}
        });
      }
      if (row.attribute_code) map.get(row.id).attributes[row.attribute_code] = !!row.attribute_value;
    }
    res.json({ dealer: dealer.recordset[0], facilities: [...map.values()] });
  } catch (err) { next(err); }
});

assessmentRouter.get('/meta', async (req, res, next) => {
  try {
    const pool = await getPool();
    const [types, risks, options, lookups, settings] = await Promise.all([
      pool.request().query(`SELECT t.*, tpl.id AS template_id, tpl.version FROM assessment_types t
        OUTER APPLY (SELECT TOP 1 id, version FROM assessment_templates WHERE assessment_type_id=t.id AND status=N'Active' AND approval_status=N'Approved' ORDER BY id DESC) tpl
        WHERE t.active_status=1 ORDER BY t.name`),
      pool.request().query(`SELECT * FROM risk_ratings WHERE active_status=1 ORDER BY display_order`),
      pool.request().query(`SELECT o.*, t.code AS response_type_code FROM response_options o INNER JOIN response_types t ON t.id=o.response_type_id WHERE o.active_status=1 ORDER BY o.display_order`),
      pool.request().query(`SELECT * FROM lookups WHERE active_status=1 ORDER BY category, display_order`),
      pool.request().query(`SELECT * FROM system_settings`)
    ]);
    res.json({
      assessmentTypes: types.recordset,
      riskRatings: risks.recordset,
      responseOptions: options.recordset,
      lookups: lookups.recordset,
      settings: Object.fromEntries(settings.recordset.map((s) => [s.setting_key, s.setting_value])),
      attributeCatalogue: [
        ['has_transformer', 'Transformer'],
        ['has_oil_transformer', 'Oil-filled transformer'],
        ['has_dry_transformer', 'Dry-type transformer'],
        ['has_dp_structure', 'Double pole structure'],
        ['has_dg_set', 'DG set'],
        ['has_compressor', 'Compressor / pump house'],
        ['has_paint_booth', 'Paint booth'],
        ['has_paint_mixing', 'Paint mixing area'],
        ['has_service', 'Service area'],
        ['has_lifts', 'Hydraulic lifts'],
        ['has_store', 'Store'],
        ['has_server_room', 'Server room / UPS'],
        ['has_portable_tools', 'Portable power tools'],
        ['has_lead_acid_batteries', 'Lead-acid batteries']
      ]
    });
  } catch (err) { next(err); }
});

assessmentRouter.get('/', async (req, res, next) => {
  try {
    const pool = await getPool();
    const request = pool.request();
    const where = [];
    if (!canSeeAll(req.user)) {
      request.input('surveyorId', sql.Int, req.user.surveyorId || 0);
      where.push('a.surveyor_id=@surveyorId');
    }
    if (req.query.status) {
      request.input('status', sql.NVarChar, req.query.status);
      where.push('a.status=@status');
    }
    if (req.query.q) {
      request.input('q', sql.NVarChar, `%${req.query.q}%`);
      where.push('(a.assessment_number LIKE @q OR d.dealer_code LIKE @q OR d.dealer_name LIKE @q)');
    }
    if (req.query.from) {
      request.input('from', sql.Date, req.query.from);
      where.push('a.assessment_date>=@from');
    }
    if (req.query.to) {
      request.input('to', sql.Date, req.query.to);
      where.push('a.assessment_date<=@to');
    }
    if (req.query.facilityType) {
      request.input('ft', sql.NVarChar, req.query.facilityType);
      where.push('a.facility_type_snapshot=@ft');
    }
    if (req.query.assessmentTypeId) {
      request.input('typeId', sql.Int, Number(req.query.assessmentTypeId));
      where.push('a.assessment_type_id=@typeId');
    }
    const sqlText = `
      SELECT a.id, a.assessment_number, a.assessment_date, a.status, a.facility_type_snapshot, a.reference_number,
             a.submitted_at, a.approved_at, a.updated_at, t.name AS assessment_type, tpl.version,
             d.dealer_code, d.dealer_name, d.city, s.name AS surveyor_name
      FROM assessments a
      INNER JOIN dealers d ON d.id=a.dealer_id
      INNER JOIN assessment_types t ON t.id=a.assessment_type_id
      INNER JOIN assessment_templates tpl ON tpl.id=a.template_id
      INNER JOIN surveyors s ON s.id=a.surveyor_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.updated_at DESC`;
    const rows = await request.query(sqlText);
    res.json(rows.recordset);
  } catch (err) { next(err); }
});

assessmentRouter.post('/', requirePerm('assessments.create'), async (req, res, next) => {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  try {
    const body = req.body || {};
    if (!body.assessmentTypeId) return res.status(400).json({ error: 'Assessment type is required.' });
    if (!body.dealerId) return res.status(400).json({ error: 'Dealer code is required.' });
    if (!body.facilityId) return res.status(400).json({ error: 'Facility is required.' });
    if (!body.assessmentDate) return res.status(400).json({ error: 'Assessment date is required.' });
    if (!req.user.surveyorId) return res.status(400).json({ error: 'Your user is not linked to a surveyor record.' });

    await tx.begin();
    const dealer = await tx.request().input('id', sql.Int, body.dealerId).query(`SELECT * FROM dealers WHERE id=@id`);
    const d = dealer.recordset[0];
    if (!d) {
      await tx.rollback();
      return res.status(404).json({ error: 'Dealer not found.' });
    }
    if (d.status !== 'Active' && !(body.allowInactive && req.user.permissions.includes('masters.manage'))) {
      await tx.rollback();
      return res.status(400).json({ error: 'This dealer is inactive. An administrator must permit the assessment.' });
    }
    const facility = await tx.request().input('id', sql.Int, body.facilityId).input('dealer', sql.Int, body.dealerId)
      .query(`SELECT * FROM facilities WHERE id=@id AND dealer_id=@dealer`);
    const f = facility.recordset[0];
    if (!f) {
      await tx.rollback();
      return res.status(400).json({ error: 'Select a facility that belongs to this dealer.' });
    }
    if (f.status !== 'Active' && !(body.allowInactive && req.user.permissions.includes('masters.manage'))) {
      await tx.rollback();
      return res.status(400).json({ error: 'This facility is inactive. An administrator must permit the assessment.' });
    }
    let facilityType = f.facility_type;
    if (body.facilityTypeOverride && body.facilityTypeOverride !== facilityType) {
      if (!req.user.permissions.includes('masters.manage')) {
        await tx.rollback();
        return res.status(403).json({ error: 'Only an administrator can override the facility type.' });
      }
      if (!['1S', '2S', '3S'].includes(body.facilityTypeOverride)) {
        await tx.rollback();
        return res.status(400).json({ error: 'Facility type must be 1S, 2S or 3S.' });
      }
      facilityType = body.facilityTypeOverride;
    }
    const typeRow = await tx.request().input('id', sql.Int, body.assessmentTypeId)
      .query(`SELECT TOP 1 t.id AS type_id, tpl.id AS template_id, tpl.version
              FROM assessment_types t
              INNER JOIN assessment_templates tpl ON tpl.assessment_type_id=t.id
              WHERE t.id=@id AND t.active_status=1 AND tpl.status=N'Active' AND tpl.approval_status=N'Approved'
              ORDER BY tpl.id DESC`);
    const typeInfo = typeRow.recordset[0];
    if (!typeInfo) {
      await tx.rollback();
      return res.status(400).json({ error: 'No approved active template exists for this assessment type.' });
    }
    const countRow = await tx.request().query(`SELECT COUNT(*) AS n FROM assessments`);
    const seq = countRow.recordset[0].n + 1;
    const number = `${typeInfo.version ? 'ESA' : 'ASM'}-${d.dealer_code}-${String(new Date(body.assessmentDate).getFullYear())}-${String(seq).padStart(3, '0')}`;
    const prefix = (await tx.request().input('id', sql.Int, typeInfo.type_id).query(`SELECT code FROM assessment_types WHERE id=@id`)).recordset[0].code;
    const assessmentNumber = `${prefix}-${d.dealer_code}-${String(new Date(body.assessmentDate).getFullYear())}-${String(seq).padStart(3, '0')}`;
    const snapshot = JSON.stringify({
      dealer_code: d.dealer_code, dealer_name: d.dealer_name, dealer_group: d.dealer_group,
      address: d.address, city: d.city, state: d.state, region: d.region, postal_code: d.postal_code,
      contact_person: d.contact_person, contact_number: d.contact_number, email: d.email
    });
    const inserted = await tx.request()
      .input('num', sql.NVarChar, assessmentNumber)
      .input('type', sql.Int, typeInfo.type_id)
      .input('tpl', sql.Int, typeInfo.template_id)
      .input('dealer', sql.Int, d.id)
      .input('fac', sql.Int, f.id)
      .input('sur', sql.Int, req.user.surveyorId)
      .input('dt', sql.Date, body.assessmentDate)
      .input('ft', sql.NVarChar, facilityType)
      .input('ver', sql.NVarChar, typeInfo.version)
      .input('snap', sql.NVarChar, snapshot)
      .input('ref', sql.NVarChar, body.referenceNumber || null)
      .input('prev', sql.NVarChar, body.previousReference || null)
      .input('remarks', sql.NVarChar, body.generalRemarks || null)
      .input('person', sql.NVarChar, d.contact_person)
      .input('phone', sql.NVarChar, d.contact_number)
      .input('email', sql.NVarChar, d.email)
      .input('by', sql.Int, req.user.id)
      .query(`INSERT INTO assessments(assessment_number, assessment_type_id, template_id, dealer_id, facility_id, surveyor_id,
              assessment_date, status, facility_type_snapshot, template_version_snapshot, dealer_details_snapshot,
              reference_number, previous_reference, general_remarks, contact_person_snapshot, contact_number_snapshot,
              contact_email_snapshot, created_by)
              OUTPUT INSERTED.id
              VALUES (@num,@type,@tpl,@dealer,@fac,@sur,@dt,N'Draft',@ft,@ver,@snap,@ref,@prev,@remarks,@person,@phone,@email,@by)`);
    const assessmentId = inserted.recordset[0].id;
    const attrs = await tx.request().input('f', sql.Int, f.id).query(`SELECT attribute_code, attribute_value FROM facility_attributes WHERE facility_id=@f`);
    const attrMap = {};
    for (const a of attrs.recordset) attrMap[a.attribute_code] = !!a.attribute_value;
    const items = await tx.request().input('tpl', sql.Int, typeInfo.template_id)
      .query(`SELECT * FROM checklist_items WHERE template_id=@tpl AND active_status=1`);
    const rules = await tx.request().input('tpl', sql.Int, typeInfo.template_id).input('ft', sql.NVarChar, facilityType)
      .query(`SELECT r.* FROM applicability_rules r INNER JOIN checklist_items i ON i.id=r.checklist_item_id
              WHERE i.template_id=@tpl AND r.facility_type=@ft AND r.active_status=1`);
    const ruleByItem = new Map(rules.recordset.map((r) => [r.checklist_item_id, r]));
    let unconfigured = 0;
    for (const item of items.recordset) {
      const rule = ruleByItem.get(item.id) || null;
      const resolved = resolveApplicability(rule, attrMap);
      if (resolved.status === 'Unconfigured') unconfigured += 1;
      await tx.request()
        .input('a', sql.Int, assessmentId).input('i', sql.Int, item.id)
        .input('code', sql.NVarChar, resolved.response)
        .input('app', sql.NVarChar, resolved.status)
        .input('snap', sql.NVarChar, JSON.stringify(snapshotOf(rule, resolved, facilityType)))
        .input('lock', sql.Bit, resolved.locked ? 1 : 0)
        .input('rev', sql.Bit, item.source_review || resolved.review ? 1 : 0)
        .query(`INSERT INTO assessment_responses(assessment_id, checklist_item_id, response_code, applicability_status, applicability_snapshot, locked_na, source_review)
                VALUES (@a,@i,@code,@app,@snap,@lock,@rev)`);
    }
    await writeAudit(tx, req.user.id, 'assessment', assessmentId, 'create', null, { assessmentNumber, facilityType, unconfigured });
    await tx.commit();
    res.status(201).json({ id: assessmentId, assessment_number: assessmentNumber, unconfigured });
  } catch (err) {
    try { await tx.rollback(); } catch { /* already closed */ }
    next(err);
  }
});

assessmentRouter.get('/:id', async (req, res, next) => {
  try {
    const data = await loadAssessment(Number(req.params.id), req.user);
    if (data.error) return res.status(data.error).json({ error: data.message });
    res.json(data);
  } catch (err) { next(err); }
});

assessmentRouter.put('/:id', async (req, res, next) => {
  try {
    const pool = await getPool();
    const current = await assertEditable(pool, Number(req.params.id), req.user);
    if (current.error) return res.status(current.error).json({ error: current.message });
    const body = req.body || {};
    await pool.request()
      .input('id', sql.Int, current.id)
      .input('dt', sql.Date, body.assessment_date || current.assessment_date)
      .input('ref', sql.NVarChar, body.reference_number ?? current.reference_number)
      .input('prev', sql.NVarChar, body.previous_reference ?? current.previous_reference)
      .input('remarks', sql.NVarChar, body.general_remarks ?? current.general_remarks)
      .query(`UPDATE assessments SET assessment_date=@dt, reference_number=@ref, previous_reference=@prev, general_remarks=@remarks, updated_at=SYSUTCDATETIME() WHERE id=@id`);
    await writeAudit(pool, req.user.id, 'assessment', current.id, 'update-header', {
      assessment_date: current.assessment_date, reference_number: current.reference_number, general_remarks: current.general_remarks
    }, body);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

assessmentRouter.put('/:id/responses/:responseId', async (req, res, next) => {
  try {
    const pool = await getPool();
    const current = await assertEditable(pool, Number(req.params.id), req.user);
    if (current.error) return res.status(current.error).json({ error: current.message });
    const existing = await pool.request().input('id', sql.Int, Number(req.params.responseId)).input('a', sql.Int, current.id)
      .query(`SELECT r.*, i.risk_rating_enabled, o.requires_observation, o.requires_recommendation, o.requires_risk, o.selectable_by_surveyor
              FROM assessment_responses r
              INNER JOIN checklist_items i ON i.id=r.checklist_item_id
              LEFT JOIN response_options o ON o.code=r.response_code
              WHERE r.id=@id AND r.assessment_id=@a`);
    const row = existing.recordset[0];
    if (!row) return res.status(404).json({ error: 'Checklist response not found.' });
    const body = req.body || {};
    let responseCode = body.response_code === undefined ? row.response_code : (body.response_code || null);
    if (row.locked_na) responseCode = 'NA';
    if (responseCode === 'NA' && !row.locked_na) {
      return res.status(400).json({ error: 'NA is reserved for items the applicability rules mark as not applicable. Ask an administrator to record an override.' });
    }
    if (row.applicability_status === 'Unconfigured' && responseCode && responseCode !== 'NA') {
      return res.status(400).json({ error: 'This item has no applicability rule. An administrator must configure it before a compliance answer is saved.' });
    }
    const riskId = row.locked_na ? null : (body.risk_rating_id === undefined ? row.risk_rating_id : body.risk_rating_id || null);
    await pool.request()
      .input('id', sql.Int, row.id)
      .input('code', sql.NVarChar, responseCode)
      .input('obs', sql.NVarChar, row.locked_na ? row.observation : (body.observation ?? row.observation))
      .input('rec', sql.NVarChar, row.locked_na ? row.recommendation : (body.recommendation ?? row.recommendation))
      .input('risk', sql.Int, riskId)
      .input('remarks', sql.NVarChar, body.remarks === undefined ? row.remarks : body.remarks)
      .query(`UPDATE assessment_responses SET response_code=@code, observation=@obs, recommendation=@rec, risk_rating_id=@risk, remarks=@remarks, updated_at=SYSUTCDATETIME() WHERE id=@id`);
    if (current.status === 'Draft') {
      await pool.request().input('id', sql.Int, current.id).query(`UPDATE assessments SET status=N'In Progress', updated_at=SYSUTCDATETIME() WHERE id=@id`);
    } else {
      await pool.request().input('id', sql.Int, current.id).query(`UPDATE assessments SET updated_at=SYSUTCDATETIME() WHERE id=@id`);
    }
    res.json({ ok: true, response_code: responseCode });
  } catch (err) { next(err); }
});

assessmentRouter.post('/:id/responses/:responseId/override', requirePerm('masters.manage'), async (req, res, next) => {
  try {
    const pool = await getPool();
    const current = await assertEditable(pool, Number(req.params.id), req.user);
    if (current.error) return res.status(current.error).json({ error: current.message });
    const reason = (req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'An override reason is required and is written to the audit log.' });
    const makeNa = !!req.body?.notApplicable;
    const row = await pool.request().input('id', sql.Int, Number(req.params.responseId)).input('a', sql.Int, current.id)
      .query(`SELECT * FROM assessment_responses WHERE id=@id AND assessment_id=@a`);
    if (!row.recordset[0]) return res.status(404).json({ error: 'Checklist response not found.' });
    const before = row.recordset[0];
    await pool.request()
      .input('id', sql.Int, before.id)
      .input('status', sql.NVarChar, makeNa ? 'Not Applicable' : 'Applicable')
      .input('code', sql.NVarChar, makeNa ? 'NA' : null)
      .input('lock', sql.Bit, makeNa ? 1 : 0)
      .input('reason', sql.NVarChar, reason)
      .input('user', sql.Int, req.user.id)
      .query(`UPDATE assessment_responses SET applicability_status=@status, response_code=@code, locked_na=@lock,
              observation=CASE WHEN @lock=1 THEN observation ELSE observation END,
              risk_rating_id=CASE WHEN @lock=1 THEN NULL ELSE risk_rating_id END,
              override_reason=@reason, overridden_by=@user, overridden_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME()
              WHERE id=@id`);
    await writeAudit(pool, req.user.id, 'assessment_response', before.id, 'applicability-override', before, { makeNa, reason });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

assessmentRouter.post('/:id/submit', async (req, res, next) => {
  try {
    const pool = await getPool();
    const current = await assertEditable(pool, Number(req.params.id), req.user);
    if (current.error) return res.status(current.error).json({ error: current.message });
    const errors = await validateForSubmit(pool, current.id);
    if (errors.length) return res.status(422).json({ error: 'Resolve the checklist before submission.', errors });
    await pool.request().input('id', sql.Int, current.id).query(`UPDATE assessments SET status=N'Submitted', submitted_at=SYSUTCDATETIME(), return_remarks=NULL, updated_at=SYSUTCDATETIME() WHERE id=@id`);
    await pool.request().input('a', sql.Int, current.id).input('u', sql.Int, req.user.id).input('r', sql.NVarChar, req.body?.remarks || null)
      .query(`INSERT INTO assessment_reviews(assessment_id, action, remarks, user_id) VALUES (@a, N'Submitted', @r, @u)`);
    await writeAudit(pool, req.user.id, 'assessment', current.id, 'submit', { status: current.status }, { status: 'Submitted' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

assessmentRouter.put('/:id/responses/:responseId/review', requirePerm('assessments.review'), async (req, res, next) => {
  try {
    const pool = await getPool();
    const current = await loadHeader(pool, Number(req.params.id));
    if (!current) return res.status(404).json({ error: 'Assessment not found.' });
    if (current.status !== 'Submitted') return res.status(400).json({ error: 'Review remarks are recorded while the assessment is submitted.' });
    await pool.request().input('id', sql.Int, Number(req.params.responseId)).input('a', sql.Int, current.id).input('r', sql.NVarChar, req.body?.review_remarks || null)
      .query(`UPDATE assessment_responses SET review_remarks=@r, updated_at=SYSUTCDATETIME() WHERE id=@id AND assessment_id=@a`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

assessmentRouter.post('/:id/return', requirePerm('assessments.review'), async (req, res, next) => {
  try {
    const pool = await getPool();
    const current = await loadHeader(pool, Number(req.params.id));
    if (!current) return res.status(404).json({ error: 'Assessment not found.' });
    if (current.status !== 'Submitted') return res.status(400).json({ error: 'Only a submitted assessment can be returned.' });
    const remarks = (req.body?.remarks || '').trim();
    if (!remarks) return res.status(400).json({ error: 'Tell the surveyor what to correct.' });
    await pool.request().input('id', sql.Int, current.id).input('r', sql.NVarChar, remarks)
      .query(`UPDATE assessments SET status=N'Returned', return_remarks=@r, updated_at=SYSUTCDATETIME() WHERE id=@id`);
    await pool.request().input('a', sql.Int, current.id).input('u', sql.Int, req.user.id).input('r', sql.NVarChar, remarks)
      .query(`INSERT INTO assessment_reviews(assessment_id, action, remarks, user_id) VALUES (@a, N'Returned', @r, @u)`);
    await writeAudit(pool, req.user.id, 'assessment', current.id, 'return', { status: 'Submitted' }, { status: 'Returned', remarks });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

assessmentRouter.post('/:id/approve', requirePerm('assessments.approve'), async (req, res, next) => {
  try {
    const pool = await getPool();
    const current = await loadHeader(pool, Number(req.params.id));
    if (!current) return res.status(404).json({ error: 'Assessment not found.' });
    if (current.status !== 'Submitted') return res.status(400).json({ error: 'Only a submitted assessment can be approved.' });
    const errors = await validateForSubmit(pool, current.id);
    if (errors.length) return res.status(422).json({ error: 'This assessment still has validation errors.', errors });
    await pool.request().input('id', sql.Int, current.id).input('u', sql.Int, req.user.id)
      .query(`UPDATE assessments SET status=N'Approved', approved_at=SYSUTCDATETIME(), reviewer_id=@u, updated_at=SYSUTCDATETIME() WHERE id=@id`);
    await pool.request().input('a', sql.Int, current.id).input('u', sql.Int, req.user.id).input('r', sql.NVarChar, req.body?.remarks || null)
      .query(`INSERT INTO assessment_reviews(assessment_id, action, remarks, user_id) VALUES (@a, N'Approved', @r, @u)`);
    await writeAudit(pool, req.user.id, 'assessment', current.id, 'approve', { status: 'Submitted' }, { status: 'Approved' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

assessmentRouter.post('/:id/reopen', requirePerm('assessments.reopen'), async (req, res, next) => {
  try {
    const pool = await getPool();
    const current = await loadHeader(pool, Number(req.params.id));
    if (!current) return res.status(404).json({ error: 'Assessment not found.' });
    if (current.status !== 'Approved') return res.status(400).json({ error: 'Only an approved assessment can be reopened.' });
    const reason = (req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reopen reason is required.' });
    await pool.request().input('id', sql.Int, current.id).input('r', sql.NVarChar, reason)
      .query(`UPDATE assessments SET status=N'Returned', return_remarks=@r, approved_at=NULL, updated_at=SYSUTCDATETIME() WHERE id=@id`);
    await pool.request().input('a', sql.Int, current.id).input('u', sql.Int, req.user.id).input('r', sql.NVarChar, reason)
      .query(`INSERT INTO assessment_reviews(assessment_id, action, remarks, user_id) VALUES (@a, N'Reopened', @r, @u)`);
    await writeAudit(pool, req.user.id, 'assessment', current.id, 'reopen', { status: 'Approved' }, { status: 'Returned', reason });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

assessmentRouter.put('/:id/narratives/:code', async (req, res, next) => {
  try {
    const pool = await getPool();
    const current = await assertEditable(pool, Number(req.params.id), req.user);
    if (current.error) return res.status(current.error).json({ error: current.message });
    const code = req.params.code;
    const title = req.body?.title || code;
    const body = req.body?.body || '';
    await pool.request().input('a', sql.Int, current.id).input('c', sql.NVarChar, code).input('t', sql.NVarChar, title).input('b', sql.NVarChar, body)
      .query(`MERGE assessment_narratives AS target
              USING (SELECT @a AS assessment_id, @c AS code) AS src
              ON target.assessment_id=src.assessment_id AND target.code=src.code
              WHEN MATCHED THEN UPDATE SET title=@t, body=@b
              WHEN NOT MATCHED THEN INSERT (assessment_id, code, title, body) VALUES (@a,@c,@t,@b);`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

assessmentRouter.put('/:id/measurements', async (req, res, next) => {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  try {
    const current = await assertEditable(pool, Number(req.params.id), req.user);
    if (current.error) return res.status(current.error).json({ error: current.message });
    const body = req.body || {};
    await tx.begin();
    await tx.request().input('a', sql.Int, current.id).query(`DELETE FROM thermography_readings WHERE assessment_id=@a`);
    await tx.request().input('a', sql.Int, current.id).query(`DELETE FROM load_balance_readings WHERE assessment_id=@a`);
    await tx.request().input('a', sql.Int, current.id).query(`DELETE FROM neutral_earth_readings WHERE assessment_id=@a`);
    await tx.request().input('a', sql.Int, current.id).query(`DELETE FROM assessment_equipment WHERE assessment_id=@a`);
    for (const [index, row] of (body.thermography || []).entries()) {
      await tx.request()
        .input('a', sql.Int, current.id).input('n', sql.Int, index + 1)
        .input('ar', sql.NVarChar, row.area || null).input('eq', sql.NVarChar, row.equipment || null)
        .input('loc', sql.NVarChar, row.location || null)
        .input('am', sql.Decimal(6, 1), numOrNull(row.ambient_c)).input('hs', sql.Decimal(6, 1), numOrNull(row.hotspot_c))
        .input('d', sql.Decimal(6, 1), numOrNull(row.delta_c)).input('sv', sql.NVarChar, row.severity || null)
        .query(`INSERT INTO thermography_readings(assessment_id, sl_no, area, equipment, location, ambient_c, hotspot_c, delta_c, severity)
                VALUES (@a,@n,@ar,@eq,@loc,@am,@hs,@d,@sv)`);
    }
    for (const [index, row] of (body.loadBalance || []).entries()) {
      await tx.request()
        .input('a', sql.Int, current.id).input('n', sql.Int, index + 1)
        .input('ar', sql.NVarChar, row.area || null).input('eq', sql.NVarChar, row.equipment || null)
        .input('l1', sql.Decimal(8, 2), numOrNull(row.l1_a)).input('l2', sql.Decimal(8, 2), numOrNull(row.l2_a)).input('l3', sql.Decimal(8, 2), numOrNull(row.l3_a))
        .input('u1', sql.Decimal(8, 2), numOrNull(row.unbalance_l1)).input('u2', sql.Decimal(8, 2), numOrNull(row.unbalance_l2)).input('u3', sql.Decimal(8, 2), numOrNull(row.unbalance_l3))
        .input('f', sql.NVarChar, row.finding || null).input('r', sql.NVarChar, row.recommendation || null)
        .query(`INSERT INTO load_balance_readings(assessment_id, sl_no, area, equipment, l1_a, l2_a, l3_a, unbalance_l1, unbalance_l2, unbalance_l3, finding, recommendation)
                VALUES (@a,@n,@ar,@eq,@l1,@l2,@l3,@u1,@u2,@u3,@f,@r)`);
    }
    for (const [index, row] of (body.neutralEarth || []).entries()) {
      await tx.request()
        .input('a', sql.Int, current.id).input('n', sql.Int, index + 1)
        .input('ar', sql.NVarChar, row.area || null).input('eq', sql.NVarChar, row.equipment || null)
        .input('v', sql.Decimal(8, 2), numOrNull(row.voltage_v))
        .query(`INSERT INTO neutral_earth_readings(assessment_id, sl_no, area, equipment, voltage_v) VALUES (@a,@n,@ar,@eq,@v)`);
    }
    for (const row of body.equipment || []) {
      if (!row.label && !row.equipment_type) continue;
      await tx.request()
        .input('a', sql.Int, current.id).input('t', sql.NVarChar, row.equipment_type || 'Equipment')
        .input('l', sql.NVarChar, row.label || 'Item').input('i', sql.NVarChar, row.identifier || null).input('r', sql.NVarChar, row.rating || null)
        .query(`INSERT INTO assessment_equipment(assessment_id, equipment_type, label, identifier, rating) VALUES (@a,@t,@l,@i,@r)`);
    }
    await writeAudit(tx, req.user.id, 'assessment', current.id, 'measurements', null, { thermography: (body.thermography || []).length });
    await tx.commit();
    res.json({ ok: true });
  } catch (err) {
    try { await tx.rollback(); } catch { /* closed */ }
    next(err);
  }
});

assessmentRouter.post('/:id/attachments', upload.single('file'), async (req, res, next) => {
  try {
    const pool = await getPool();
    const current = await assertEditable(pool, Number(req.params.id), req.user);
    if (current.error) return res.status(current.error).json({ error: current.message });
    if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(req.file.mimetype)) return res.status(400).json({ error: 'Upload a JPEG, PNG, WEBP or PDF file.' });
    const itemId = req.body.checklist_item_id ? Number(req.body.checklist_item_id) : null;
    const inserted = await pool.request()
      .input('a', sql.Int, current.id)
      .input('i', sql.Int, itemId)
      .input('name', sql.NVarChar, req.file.originalname)
      .input('type', sql.NVarChar, req.file.mimetype)
      .input('data', sql.VarBinary(sql.MAX), req.file.buffer)
      .input('u', sql.Int, req.user.id)
      .query(`INSERT INTO assessment_attachments(assessment_id, checklist_item_id, file_name, file_type, file_data, uploaded_by)
              OUTPUT INSERTED.id, INSERTED.file_name, INSERTED.uploaded_at VALUES (@a,@i,@name,@type,@data,@u)`);
    await writeAudit(pool, req.user.id, 'assessment_attachment', inserted.recordset[0].id, 'upload', null, { file: req.file.originalname, itemId });
    res.status(201).json(inserted.recordset[0]);
  } catch (err) { next(err); }
});

assessmentRouter.get('/:id/attachments/:attachmentId', async (req, res, next) => {
  try {
    const pool = await getPool();
    const header = await loadHeader(pool, Number(req.params.id));
    if (!header) return res.status(404).json({ error: 'Assessment not found.' });
    if (!canSeeAll(req.user) && header.surveyor_user_id !== req.user.id) return res.status(403).json({ error: 'You cannot open this file.' });
    const file = await pool.request().input('id', sql.Int, Number(req.params.attachmentId)).input('a', sql.Int, header.id)
      .query(`SELECT file_name, file_type, file_data FROM assessment_attachments WHERE id=@id AND assessment_id=@a`);
    const row = file.recordset[0];
    if (!row) return res.status(404).json({ error: 'File not found.' });
    res.setHeader('Content-Type', row.file_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${row.file_name.replace(/"/g, '')}"`);
    res.send(row.file_data);
  } catch (err) { next(err); }
});

async function loadHeader(pool, id) {
  const row = await pool.request().input('id', sql.Int, id).query(`
    SELECT a.*, s.user_id AS surveyor_user_id, s.name AS surveyor_name, s.employee_id AS surveyor_employee_id, s.email AS surveyor_email,
           t.name AS assessment_type, t.code AS assessment_type_code, tpl.version, tpl.exclude_na_from_compliance,
           u.name AS reviewer_name
    FROM assessments a
    INNER JOIN surveyors s ON s.id=a.surveyor_id
    INNER JOIN assessment_types t ON t.id=a.assessment_type_id
    INNER JOIN assessment_templates tpl ON tpl.id=a.template_id
    LEFT JOIN users u ON u.id=a.reviewer_id
    WHERE a.id=@id`);
  return row.recordset[0] || null;
}

async function assertEditable(pool, id, user) {
  const current = await loadHeader(pool, id);
  if (!current) return { error: 404, message: 'Assessment not found.' };
  if (!canSeeAll(user) && current.surveyor_user_id !== user.id) return { error: 403, message: 'This assessment belongs to another surveyor.' };
  if (!editable.has(current.status)) return { error: 400, message: 'Approved assessments are locked. An administrator can reopen one with a reason.' };
  if (!user.permissions.includes('assessments.create') && !user.permissions.includes('masters.manage')) {
    return { error: 403, message: 'You cannot edit assessment responses.' };
  }
  return current;
}

export async function loadAssessment(id, user) {
  const pool = await getPool();
  const header = await loadHeader(pool, id);
  if (!header) return { error: 404, message: 'Assessment not found.' };
  if (!canSeeAll(user) && header.surveyor_user_id !== user.id) return { error: 403, message: 'This assessment belongs to another surveyor.' };
  const responses = await pool.request().input('id', sql.Int, id).query(`
    SELECT r.*, i.item_number, i.activity_description, i.requirement_description, i.guidance, i.section_id,
           i.risk_rating_enabled, i.observation_required, i.recommendation_required, i.evidence_required, i.source_review AS item_source_review,
           s.section_code, s.section_name, s.display_order AS section_order,
           rr.code AS risk_code, rr.name AS risk_name,
           o.counts_as, o.requires_observation, o.requires_recommendation, o.requires_risk
    FROM assessment_responses r
    INNER JOIN checklist_items i ON i.id=r.checklist_item_id
    INNER JOIN checklist_sections s ON s.id=i.section_id
    LEFT JOIN risk_ratings rr ON rr.id=r.risk_rating_id
    LEFT JOIN response_options o ON o.code=r.response_code
    WHERE r.assessment_id=@id
    ORDER BY s.display_order, i.display_order`);
  const attachments = await pool.request().input('id', sql.Int, id).query(`
    SELECT id, checklist_item_id, file_name, file_type, uploaded_at FROM assessment_attachments WHERE assessment_id=@id`);
  const narratives = await pool.request().input('id', sql.Int, id).query(`SELECT * FROM assessment_narratives WHERE assessment_id=@id`);
  const equipment = await pool.request().input('id', sql.Int, id).query(`SELECT * FROM assessment_equipment WHERE assessment_id=@id`);
  const thermography = await pool.request().input('id', sql.Int, id).query(`SELECT * FROM thermography_readings WHERE assessment_id=@id ORDER BY sl_no`);
  const loadBalance = await pool.request().input('id', sql.Int, id).query(`SELECT * FROM load_balance_readings WHERE assessment_id=@id ORDER BY sl_no`);
  const neutralEarth = await pool.request().input('id', sql.Int, id).query(`SELECT * FROM neutral_earth_readings WHERE assessment_id=@id ORDER BY sl_no`);
  const reviews = await pool.request().input('id', sql.Int, id).query(`
    SELECT rv.*, u.name AS user_name FROM assessment_reviews rv INNER JOIN users u ON u.id=rv.user_id WHERE rv.assessment_id=@id ORDER BY rv.created_at`);
  const summary = summarise(responses.recordset, !!header.exclude_na_from_compliance);
  const sections = [];
  const bySection = new Map();
  for (const row of responses.recordset) {
    if (!bySection.has(row.section_id)) {
      const section = { id: row.section_id, code: row.section_code, name: row.section_name, items: [] };
      bySection.set(row.section_id, section);
      sections.push(section);
    }
    bySection.get(row.section_id).items.push({
      ...row,
      applicability_snapshot: safeJson(row.applicability_snapshot),
      attachments: attachments.recordset.filter((a) => a.checklist_item_id === row.checklist_item_id)
    });
  }
  return {
    assessment: { ...header, dealer_details_snapshot: safeJson(header.dealer_details_snapshot) },
    summary,
    sections,
    narratives: narratives.recordset,
    equipment: equipment.recordset,
    thermography: thermography.recordset,
    loadBalance: loadBalance.recordset,
    neutralEarth: neutralEarth.recordset,
    reviews: reviews.recordset
  };
}

async function validateForSubmit(pool, assessmentId) {
  const data = await pool.request().input('id', sql.Int, assessmentId).query(`
    SELECT r.*, i.item_number, i.evidence_required, i.activity_description, o.requires_observation, o.requires_recommendation, o.requires_risk, i.risk_rating_enabled,
           (SELECT COUNT(*) FROM assessment_attachments att WHERE att.assessment_id=r.assessment_id AND att.checklist_item_id=r.checklist_item_id) AS files
    FROM assessment_responses r
    INNER JOIN checklist_items i ON i.id=r.checklist_item_id
    LEFT JOIN response_options o ON o.code=r.response_code
    WHERE r.assessment_id=@id`);
  const errors = [];
  for (const row of data.recordset) {
    if (row.applicability_status === 'Unconfigured') {
      errors.push({ responseId: row.id, itemNumber: row.item_number, message: `Item ${row.item_number} has no applicability configuration.` });
      continue;
    }
    if (row.applicability_status === 'Not Applicable' || row.locked_na) {
      if (row.response_code !== 'NA') errors.push({ responseId: row.id, itemNumber: row.item_number, message: `Item ${row.item_number} must stay NA.` });
      continue;
    }
    if (!row.response_code) {
      errors.push({ responseId: row.id, itemNumber: row.item_number, message: `Item ${row.item_number} needs a response.` });
      continue;
    }
    if (row.requires_observation && !String(row.observation || '').trim()) {
      errors.push({ responseId: row.id, itemNumber: row.item_number, message: `Item ${row.item_number} needs an observation.` });
    }
    if (row.requires_recommendation && !String(row.recommendation || '').trim()) {
      errors.push({ responseId: row.id, itemNumber: row.item_number, message: `Item ${row.item_number} needs a recommendation.` });
    }
    if ((row.requires_risk || row.risk_rating_enabled) && !row.risk_rating_id && row.response_code !== 'NA') {
      errors.push({ responseId: row.id, itemNumber: row.item_number, message: `Item ${row.item_number} needs a risk rating.` });
    }
    if (row.evidence_required && !row.files) {
      errors.push({ responseId: row.id, itemNumber: row.item_number, message: `Item ${row.item_number} needs evidence.` });
    }
  }
  return errors;
}

function numOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return value; }
}

export { loadHeader };
