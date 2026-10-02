import { Router } from 'express';
import { getPool, sql } from '../db.js';
import { canSeeAll } from '../auth.js';

export const dashboardRouter = Router();

dashboardRouter.get('/', async (req, res, next) => {
  try {
    const pool = await getPool();
    const filter = (request) => {
      const where = ['1=1'];
      if (!canSeeAll(req.user)) {
        request.input('surveyorId', sql.Int, req.user.surveyorId || 0);
        where.push('a.surveyor_id=@surveyorId');
      }
      if (req.query.from) { request.input('from', sql.Date, req.query.from); where.push('a.assessment_date>=@from'); }
      if (req.query.to) { request.input('to', sql.Date, req.query.to); where.push('a.assessment_date<=@to'); }
      if (req.query.dealerId) { request.input('dealer', sql.Int, Number(req.query.dealerId)); where.push('a.dealer_id=@dealer'); }
      if (req.query.facilityType) { request.input('ft', sql.NVarChar, req.query.facilityType); where.push('a.facility_type_snapshot=@ft'); }
      if (req.query.assessmentTypeId) { request.input('typeId', sql.Int, Number(req.query.assessmentTypeId)); where.push('a.assessment_type_id=@typeId'); }
      if (req.query.surveyorId && canSeeAll(req.user)) { request.input('sid', sql.Int, Number(req.query.surveyorId)); where.push('a.surveyor_id=@sid'); }
      if (req.query.status) { request.input('status', sql.NVarChar, req.query.status); where.push('a.status=@status'); }
      return where.join(' AND ');
    };
    const run = async (text) => {
      const request = pool.request();
      const where = filter(request);
      return request.query(text.replaceAll('/*W*/', where));
    };
    const totals = await run(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN a.status=N'Draft' THEN 1 ELSE 0 END) AS draft,
        SUM(CASE WHEN a.status=N'In Progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN a.status=N'Submitted' THEN 1 ELSE 0 END) AS submitted,
        SUM(CASE WHEN a.status=N'Returned' THEN 1 ELSE 0 END) AS returned,
        SUM(CASE WHEN a.status=N'Approved' THEN 1 ELSE 0 END) AS approved
      FROM assessments a WHERE /*W*/`);
    const facilityRows = await run(`SELECT a.facility_type_snapshot AS facility_type, COUNT(*) AS total FROM assessments a WHERE /*W*/ GROUP BY a.facility_type_snapshot`);
    const dealerRows = await run(`SELECT TOP 8 d.dealer_name, d.dealer_code, COUNT(*) AS total FROM assessments a INNER JOIN dealers d ON d.id=a.dealer_id WHERE /*W*/ GROUP BY d.dealer_name, d.dealer_code ORDER BY total DESC`);
    const trend = await run(`SELECT FORMAT(a.assessment_date, 'yyyy-MM') AS month, COUNT(*) AS total FROM assessments a WHERE /*W*/ GROUP BY FORMAT(a.assessment_date, 'yyyy-MM') ORDER BY month`);
    const findings = await run(`SELECT
        SUM(CASE WHEN o.counts_as IN (N'non_compliant', N'partial') THEN 1 ELSE 0 END) AS findings,
        SUM(CASE WHEN rr.code=N'CRITICAL' THEN 1 ELSE 0 END) AS critical,
        SUM(CASE WHEN rr.code=N'MAJOR' THEN 1 ELSE 0 END) AS major
      FROM assessment_responses r
      INNER JOIN assessments a ON a.id=r.assessment_id
      LEFT JOIN response_options o ON o.code=r.response_code
      LEFT JOIN risk_ratings rr ON rr.id=r.risk_rating_id
      WHERE /*W*/`);
    const recent = await run(`SELECT TOP 6 a.id, a.assessment_number, a.status, a.assessment_date, a.facility_type_snapshot, d.dealer_name, d.dealer_code
      FROM assessments a INNER JOIN dealers d ON d.id=a.dealer_id WHERE /*W*/ ORDER BY a.updated_at DESC`);
    res.json({
      totals: totals.recordset[0],
      findings: findings.recordset[0],
      byFacility: facilityRows.recordset,
      byDealer: dealerRows.recordset,
      trend: trend.recordset,
      recent: recent.recordset
    });
  } catch (err) { next(err); }
});
