/**
 * NA items are excluded from compliance unless the template says otherwise.
 * counts_as comes from the response option master.
 */
export function summarise(responses, excludeNa = true) {
  const summary = {
    total: responses.length,
    applicable: 0,
    na: 0,
    unconfigured: 0,
    completedApplicable: 0,
    compliant: 0,
    nonCompliant: 0,
    partial: 0,
    notAssessed: 0,
    openFindings: 0,
    byRisk: {},
    bySection: {}
  };

  for (const row of responses) {
    const section = row.section_name || 'Unsectioned';
    if (!summary.bySection[section]) {
      summary.bySection[section] = { applicable: 0, compliant: 0, nonCompliant: 0, partial: 0, na: 0, findings: 0 };
    }
    const bucket = summary.bySection[section];
    const applicability = row.applicability_status;
    const isNa = applicability === 'Not Applicable' || row.response_code === 'NA';
    const isUnconfigured = applicability === 'Unconfigured';

    if (isUnconfigured) {
      summary.unconfigured += 1;
      continue;
    }
    if (isNa) {
      summary.na += 1;
      bucket.na += 1;
      if (!excludeNa) summary.applicable += 1;
      continue;
    }

    summary.applicable += 1;
    bucket.applicable += 1;
    const counts = row.counts_as || (row.response_code ? 'not_assessed' : null);
    if (!row.response_code) {
      summary.notAssessed += 1;
      continue;
    }
    summary.completedApplicable += 1;
    if (counts === 'compliant') {
      summary.compliant += 1;
      bucket.compliant += 1;
    } else if (counts === 'non_compliant') {
      summary.nonCompliant += 1;
      bucket.nonCompliant += 1;
      summary.openFindings += 1;
      bucket.findings += 1;
    } else if (counts === 'partial') {
      summary.partial += 1;
      bucket.partial += 1;
      summary.openFindings += 1;
      bucket.findings += 1;
    } else if (counts === 'na') {
      summary.na += 1;
      summary.applicable -= 1;
      bucket.applicable -= 1;
      bucket.na += 1;
    } else {
      summary.notAssessed += 1;
    }

    if (row.risk_code) {
      summary.byRisk[row.risk_code] = (summary.byRisk[row.risk_code] || 0) + 1;
    }
  }

  const denom = summary.applicable || 0;
  summary.compliancePercent = denom ? round((summary.compliant / denom) * 100) : 0;
  summary.riskPercent = {};
  for (const [code, count] of Object.entries(summary.byRisk)) {
    summary.riskPercent[code] = denom ? round((count / denom) * 100) : 0;
  }
  return summary;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
