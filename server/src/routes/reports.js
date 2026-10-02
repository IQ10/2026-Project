import { Router } from 'express';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { getPool, sql } from '../db.js';
import { loadAssessment } from './assessments.js';

export const reportRouter = Router();

reportRouter.get('/:id/pdf', async (req, res, next) => {
  try {
    const data = await loadAssessment(Number(req.params.id), req.user);
    if (data.error) return res.status(data.error).json({ error: data.message });
    const settings = await loadSettings();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${data.assessment.assessment_number}.pdf"`);
    const doc = new PDFDocument({ margin: 48, size: 'A4', bufferPages: true });
    doc.pipe(res);
    drawReport(doc, data, settings);
    doc.end();
  } catch (err) { next(err); }
});

reportRouter.get('/:id/xlsx', async (req, res, next) => {
  try {
    const data = await loadAssessment(Number(req.params.id), req.user);
    if (data.error) return res.status(data.error).json({ error: data.message });
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ESA Desk';
    const summary = workbook.addWorksheet('Summary');
    const a = data.assessment;
    const dealer = a.dealer_details_snapshot || {};
    summary.addRows([
      ['Assessment', a.assessment_number],
      ['Type', a.assessment_type],
      ['Template', a.template_version_snapshot],
      ['Date', formatDate(a.assessment_date)],
      ['Status', a.status],
      ['Surveyor', a.surveyor_name],
      ['Dealer code', dealer.dealer_code],
      ['Dealer', dealer.dealer_name],
      ['Address', [dealer.address, dealer.city, dealer.state, dealer.postal_code].filter(Boolean).join(', ')],
      ['Facility type', a.facility_type_snapshot],
      ['Applicable', data.summary.applicable],
      ['NA', data.summary.na],
      ['Compliant', data.summary.compliant],
      ['Non-compliant', data.summary.nonCompliant],
      ['Partial', data.summary.partial],
      ['Compliance %', data.summary.compliancePercent]
    ]);
    const sheet = workbook.addWorksheet('Checklist');
    sheet.addRow(['Section', 'Item', 'Activity', 'Requirement', 'Applicability', 'Response', 'Observation', 'Recommendation', 'Risk', 'Review flag']).font = { bold: true };
    for (const section of data.sections) {
      for (const item of section.items) {
        sheet.addRow([
          section.name, item.item_number, item.activity_description, item.requirement_description,
          item.applicability_status, item.response_code, item.observation, item.recommendation, item.risk_name,
          item.source_review ? 'Review' : ''
        ]);
      }
    }
    sheet.columns.forEach((col) => { col.width = 28; });
    const thermo = workbook.addWorksheet('Thermography');
    thermo.addRow(['Sl', 'Area', 'Equipment', 'Location', 'Ambient C', 'Hotspot C', 'Delta C', 'Severity']).font = { bold: true };
    data.thermography.forEach((row) => thermo.addRow([row.sl_no, row.area, row.equipment, row.location, row.ambient_c, row.hotspot_c, row.delta_c, row.severity]));
    const balance = workbook.addWorksheet('Load balance');
    balance.addRow(['Sl', 'Area', 'Equipment', 'L1', 'L2', 'L3', 'Unbalance L1', 'L2', 'L3', 'Finding', 'Recommendation']).font = { bold: true };
    data.loadBalance.forEach((row) => balance.addRow([row.sl_no, row.area, row.equipment, row.l1_a, row.l2_a, row.l3_a, row.unbalance_l1, row.unbalance_l2, row.unbalance_l3, row.finding, row.recommendation]));
    const earth = workbook.addWorksheet('Neutral to earth');
    earth.addRow(['Sl', 'Area', 'Equipment', 'Voltage V']).font = { bold: true };
    data.neutralEarth.forEach((row) => earth.addRow([row.sl_no, row.area, row.equipment, row.voltage_v]));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${a.assessment_number}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

function drawReport(doc, data, settings) {
  const a = data.assessment;
  const dealer = a.dealer_details_snapshot || {};
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.rect(0, 0, doc.page.width, 86).fill('#0B1F33');
  doc.fillColor('#F4C95D').fontSize(11).text(settings.organisation_name || 'Electrical Safety Assessment', 48, 22, { width: pageWidth });
  doc.fillColor('#FFFFFF').fontSize(18).text(settings.report_title || 'Electrical Safety Assessment Report', 48, 42, { width: pageWidth });
  doc.fillColor('#111111');
  doc.y = 104;
  doc.fontSize(12).text(plain(a.assessment_number), { continued: false });
  meta(doc, 'Assessment type', `${a.assessment_type}  ·  template ${a.template_version_snapshot}`);
  meta(doc, 'Date', formatDate(a.assessment_date));
  meta(doc, 'Status', a.status);
  meta(doc, 'Surveyor', `${a.surveyor_name}  ${a.surveyor_employee_id || ''}`);
  meta(doc, 'Dealer', `${dealer.dealer_code || ''}  ${dealer.dealer_name || ''}`);
  meta(doc, 'Address', [dealer.address, dealer.city, dealer.state, dealer.postal_code].filter(Boolean).join(', '));
  meta(doc, 'Facility type', facilityLabel(a.facility_type_snapshot));
  meta(doc, 'Contact', [a.contact_person_snapshot, a.contact_number_snapshot, a.contact_email_snapshot].filter(Boolean).join(' · '));
  if (a.reference_number) meta(doc, 'Reference', a.reference_number);
  if (a.reviewer_name) meta(doc, 'Reviewer', a.reviewer_name);
  doc.moveDown(0.6);
  doc.fontSize(13).fillColor('#0B1F33').text('Summary');
  doc.fillColor('#111111').fontSize(10);
  const s = data.summary;
  doc.text(`Items ${s.total}   Applicable ${s.applicable}   NA ${s.na}   Compliant ${s.compliant}   Non-compliant ${s.nonCompliant}   Partial ${s.partial}   Compliance ${s.compliancePercent}%`);
  doc.text('NA items are excluded from the compliance percentage.');
  doc.moveDown(0.4);
  for (const narrative of data.narratives) {
    heading(doc, narrative.title);
    doc.fontSize(10).fillColor('#222').text(plain(narrative.body || ''), { width: pageWidth });
    doc.moveDown(0.3);
  }
  heading(doc, 'Checklist');
  for (const section of data.sections) {
    ensureSpace(doc, 60);
    doc.fontSize(12).fillColor('#0B1F33').text(section.name);
    for (const item of section.items) {
      ensureSpace(doc, 72);
      doc.moveDown(0.2);
      doc.fontSize(10).fillColor('#0B1F33').text(`${item.item_number}. ${plain(item.activity_description)}`);
      doc.fontSize(9).fillColor('#444').text(plain(item.requirement_description), { width: pageWidth });
      doc.fillColor('#111').text(`Applicability: ${item.applicability_status}    Response: ${item.response_code || '—'}    Risk: ${item.risk_name || '—'}`);
      if (item.observation) doc.text(`Observation: ${plain(item.observation)}`);
      if (item.recommendation) doc.text(`Recommendation: ${plain(item.recommendation)}`);
      if (item.source_review) doc.fillColor('#8A5A00').text('Flagged for administrator confirmation of the source wording.');
      doc.fillColor('#111');
    }
    doc.moveDown(0.4);
  }
  if (data.thermography.length) {
    heading(doc, 'Thermography');
    data.thermography.forEach((row) => {
      ensureSpace(doc, 28);
      doc.fontSize(9).text(`${row.sl_no}. ${plain(row.area)} — ${plain(row.equipment)} / ${plain(row.location)}   ambient ${row.ambient_c}°C   hotspot ${row.hotspot_c}°C   ΔT ${row.delta_c}°C   ${row.severity}`);
    });
  }
  if (data.loadBalance.length) {
    heading(doc, 'Load balance');
    data.loadBalance.forEach((row) => {
      ensureSpace(doc, 48);
      doc.fontSize(9).text(`${plain(row.area)} ${plain(row.equipment)}   L1 ${row.l1_a} A   L2 ${row.l2_a} A   L3 ${row.l3_a} A   unbalance ${row.unbalance_l1}% / ${row.unbalance_l2}% / ${row.unbalance_l3}%`);
      if (row.finding) doc.text(plain(row.finding));
      if (row.recommendation) doc.text(plain(row.recommendation));
    });
  }
  if (data.neutralEarth.length) {
    heading(doc, 'Neutral to earth voltage');
    data.neutralEarth.forEach((row) => {
      ensureSpace(doc, 20);
      doc.fontSize(9).text(`${row.sl_no}. ${plain(row.area)} — ${plain(row.equipment)}   ${row.voltage_v} V`);
    });
  }
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.fontSize(8).fillColor('#666').text(
      `Generated ${new Date().toISOString().slice(0, 10)}   ${a.assessment_number}   Page ${i + 1} of ${range.count}`,
      48, doc.page.height - 36, { width: pageWidth, align: 'center' }
    );
  }
}

function heading(doc, text) {
  ensureSpace(doc, 40);
  doc.moveDown(0.5);
  doc.fontSize(13).fillColor('#0B1F33').text(text);
  doc.fillColor('#111');
}
function meta(doc, label, value) {
  doc.fontSize(10).fillColor('#555').text(label, { continued: true }).fillColor('#111').text(`   ${plain(value || '—')}`);
}
function ensureSpace(doc, needed) {
  if (doc.y > doc.page.height - doc.page.margins.bottom - needed) doc.addPage();
}
function plain(value) {
  return String(value ?? '').replace(/[–—]/g, '-').replace(/\u2018|\u2019/g, "'").replace(/\u201C|\u201D/g, '"');
}
function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}
function facilityLabel(code) {
  return { '1S': '1S sales', '2S': '2S service and spares', '3S': '3S sales, service and spares' }[code] || code;
}
async function loadSettings() {
  const pool = await getPool();
  const rows = await pool.request().query(`SELECT setting_key, setting_value FROM system_settings`);
  return Object.fromEntries(rows.recordset.map((r) => [r.setting_key, r.setting_value]));
}
