import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import sql from 'mssql';
import { dbConfig, resetPool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

const RULE_NOTE =
  'Initial 1S/2S/3S mapping is held for administrator confirmation. The reference report is a 3S visit and does not print a per-item facility matrix. 1S is sales, 2S is service and spares, 3S is sales, service and spares. Conditional rules follow equipment present at the facility. Do not treat a missing rule as NA.';

const SECTION_RULES = {
  'Earthing system': all('Applicable'),
  'Dealership Transformer Area': all('Conditional', 'has_transformer'),
  'Metering Panel in Transformer area': all('Conditional', 'has_transformer'),
  'Double Pole Structure in Transformer area': all('Conditional', 'has_dp_structure'),
  'Oil Filled Transformer': all('Conditional', 'has_oil_transformer'),
  'Dry-Type Transformer': all('Conditional', 'has_dry_transformer'),
  'DG Set': all('Conditional', 'has_dg_set'),
  'Electrical Room': all('Applicable'),
  'Power Distribution Boards (PDB)': all('Applicable'),
  'Lighting Distribution Boards (LDB)': all('Applicable'),
  'Cable Network': all('Applicable'),
  'Signboard': all('Applicable'),
  'Compressor / pump house': typed({ '1S': 'Not Applicable', '2S': 'Conditional', '3S': 'Conditional' }, 'has_compressor'),
  'Service area': typed({ '1S': 'Not Applicable', '2S': 'Applicable', '3S': 'Applicable' }),
  'Paint Booth': typed({ '1S': 'Not Applicable', '2S': 'Conditional', '3S': 'Conditional' }, 'has_paint_booth'),
  'Paint mixing area': typed({ '1S': 'Not Applicable', '2S': 'Conditional', '3S': 'Conditional' }, 'has_paint_mixing'),
  'Hydraulic Lifts': typed({ '1S': 'Not Applicable', '2S': 'Applicable', '3S': 'Applicable' }),
  'Store': typed({ '1S': 'Not Applicable', '2S': 'Applicable', '3S': 'Applicable' }),
  'Server Room (UPS & Batteries)': all('Conditional', 'has_server_room'),
  'Portable Power Tools': typed({ '1S': 'Not Applicable', '2S': 'Applicable', '3S': 'Applicable' }),
  'Lightning arrestor (LA)': all('Applicable'),
  'Fire Protection System': all('Applicable'),
  'Other electrical safety aspects': all('Applicable'),
  'Document review': all('Applicable')
};

const EYE_WASHER_ITEM = 125;

function all(status, attr = null) {
  return {
    '1S': { status, attr },
    '2S': { status, attr },
    '3S': { status, attr }
  };
}
function typed(map, attr = null) {
  const out = {};
  for (const ft of ['1S', '2S', '3S']) {
    out[ft] = { status: map[ft], attr: map[ft] === 'Conditional' ? attr : null };
  }
  return out;
}

const RISK_BY_CODE = { GGG: 'NO_RISK', OOO: 'MAJOR', RRR: 'CRITICAL', YYY: 'MINOR', TTT: null };
const RESPONSE_BY_CODE = { GGG: 'COMPLIANT', OOO: 'NON_COMPLIANT', RRR: 'NON_COMPLIANT', YYY: 'PARTIAL', TTT: 'NA' };

async function connectMaster() {
  const pool = new sql.ConnectionPool({ ...dbConfig, database: 'master', pool: { max: 1, min: 1 } });
  await pool.connect();
  return pool;
}

async function runSchema(pool) {
  const text = fs.readFileSync(path.join(root, 'database/001_schema.sql'), 'utf8');
  const batches = text.split(/^\s*GO\s*$/gim).map((b) => b.trim()).filter(Boolean);
  for (const batch of batches) {
    await pool.request().query(batch);
  }
}

async function main() {
  console.log('Applying schema to SQL Server...');
  const master = await connectMaster();
  await runSchema(master);
  await master.close();
  resetPool();

  const pool = new sql.ConnectionPool(dbConfig);
  await pool.connect();
  const checklist = JSON.parse(fs.readFileSync(path.join(root, 'database/checklist.json'), 'utf8'));

  const roleIds = {};
  for (const role of [
    ['Administrator', 'Manages masters, templates, applicability and users'],
    ['Surveyor', 'Creates and completes assessments'],
    ['Reviewer', 'Reviews, returns and approves assessments'],
    ['Management', 'Views dashboards and exports reports']
  ]) {
    const r = await pool.request().input('n', sql.NVarChar, role[0]).input('d', sql.NVarChar, role[1])
      .query(`INSERT INTO roles(name, description) OUTPUT INSERTED.id VALUES (@n, @d)`);
    roleIds[role[0]] = r.recordset[0].id;
  }

  const perms = {
    Administrator: ['masters.manage', 'assessments.create', 'assessments.view.all', 'assessments.review', 'assessments.approve', 'assessments.reopen', 'reports.export', 'audit.view', 'import.manage'],
    Surveyor: ['assessments.create', 'assessments.view.own', 'reports.export'],
    Reviewer: ['assessments.view.all', 'assessments.review', 'assessments.approve', 'reports.export', 'audit.view'],
    Management: ['assessments.view.all', 'reports.export']
  };
  for (const [role, codes] of Object.entries(perms)) {
    for (const code of codes) {
      await pool.request().input('r', sql.Int, roleIds[role]).input('c', sql.NVarChar, code)
        .query(`INSERT INTO role_permissions(role_id, permission_code) VALUES (@r, @c)`);
    }
  }

  async function addUser(name, email, password, role, employeeId, phone, region) {
    const hash = bcrypt.hashSync(password, 10);
    const r = await pool.request()
      .input('name', sql.NVarChar, name)
      .input('email', sql.NVarChar, email)
      .input('hash', sql.NVarChar, hash)
      .input('role', sql.Int, roleIds[role])
      .input('emp', sql.NVarChar, employeeId)
      .input('phone', sql.NVarChar, phone)
      .input('region', sql.NVarChar, region)
      .query(`INSERT INTO users(name, email, password_hash, role_id, employee_id, phone, region)
              OUTPUT INSERTED.id VALUES (@name, @email, @hash, @role, @emp, @phone, @region)`);
    return r.recordset[0].id;
  }

  const adminId = await addUser('ESA Administrator', 'admin@bureauveritas.demo', 'Admin@123', 'Administrator', 'BV-ADM-001', '+91 22 6274 2000', 'West');
  const saurabhUser = await addUser('Saurabh Kumar Vishwakarma', 'saurabh.vishwakarma@bureauveritas.demo', 'Surveyor@123', 'Surveyor', 'BV-ESA-118', '+91 9795061488', 'North');
  const pramodUser = await addUser('Pramod S. Uranakar', 'pramod.uranakar@bureauveritas.demo', 'Reviewer@123', 'Reviewer', 'BV-REV-042', '+91 22 6274 2000', 'West');
  await addUser('TKM Management', 'management@tkm.demo', 'Viewer@123', 'Management', 'TKM-MGT-001', null, 'All');

  const surveyor = await pool.request()
    .input('uid', sql.Int, saurabhUser)
    .query(`INSERT INTO surveyors(user_id, employee_id, name, email, phone, region, role_name)
            OUTPUT INSERTED.id
            VALUES (@uid, N'BV-ESA-118', N'Saurabh Kumar Vishwakarma', N'saurabh.vishwakarma@bureauveritas.demo', N'+91 9795061488', N'North', N'Surveyor')`);
  const surveyorId = surveyor.recordset[0].id;

  const riskIds = {};
  const risks = [
    ['CRITICAL', 'Critical Risk', 'Death or critical injury is credible, or likelihood and severity multiply to 6 or 9 on the assessment matrix.', 3, 1],
    ['MAJOR', 'Major Risk', 'Major injury or a risk score of 3 or 4 on the assessment matrix.', 2, 2],
    ['MINOR', 'Minor Risk', 'First-aid injury or a risk score of 1 or 2 on the assessment matrix.', 1, 3],
    ['NO_RISK', 'No Risk', 'Full compliance. Risk score 0.', 0, 4]
  ];
  for (const row of risks) {
    const r = await pool.request()
      .input('c', sql.NVarChar, row[0]).input('n', sql.NVarChar, row[1]).input('d', sql.NVarChar, row[2])
      .input('s', sql.Int, row[3]).input('o', sql.Int, row[4])
      .query(`INSERT INTO risk_ratings(code, name, description, severity_level, display_order) OUTPUT INSERTED.id VALUES (@c,@n,@d,@s,@o)`);
    riskIds[row[0]] = r.recordset[0].id;
  }

  const rt = await pool.request().query(`INSERT INTO response_types(code, name, description) OUTPUT INSERTED.id
    VALUES (N'COMPLIANCE', N'Safety compliance', N'Compliant, non-compliant, partially compliant. NA is system-assigned.')`);
  const responseTypeId = rt.recordset[0].id;
  const options = [
    ['COMPLIANT', 'Compliant', 'compliant', 0, 0, 1, 1, 1],
    ['NON_COMPLIANT', 'Non-compliant', 'non_compliant', 1, 1, 1, 1, 2],
    ['PARTIAL', 'Partially compliant', 'partial', 1, 1, 1, 1, 3],
    ['NA', 'NA', 'na', 0, 0, 0, 0, 4]
  ];
  for (const o of options) {
    await pool.request()
      .input('rt', sql.Int, responseTypeId)
      .input('c', sql.NVarChar, o[0]).input('l', sql.NVarChar, o[1]).input('a', sql.NVarChar, o[2])
      .input('ob', sql.Bit, o[3]).input('rc', sql.Bit, o[4]).input('rk', sql.Bit, o[5]).input('sel', sql.Bit, o[6]).input('ord', sql.Int, o[7])
      .query(`INSERT INTO response_options(response_type_id, code, label, counts_as, requires_observation, requires_recommendation, requires_risk, selectable_by_surveyor, display_order)
              VALUES (@rt,@c,@l,@a,@ob,@rc,@rk,@sel,@ord)`);
  }

  const esaType = await pool.request().query(`INSERT INTO assessment_types(code, name, description, approval_status, effective_from)
    OUTPUT INSERTED.id VALUES (N'ESA', N'Electrical Safety Assessment',
    N'Dealership electrical safety assessment covering installations, documents and measurements.', N'Approved', '2025-01-01')`);
  const esaTypeId = esaType.recordset[0].id;
  const fireType = await pool.request().query(`INSERT INTO assessment_types(code, name, description, approval_status, effective_from)
    OUTPUT INSERTED.id VALUES (N'FSA', N'Fire Safety Assessment',
    N'Second assessment type. Sections and items are master data, not engine code.', N'Approved', '2025-01-01')`);
  const fireTypeId = fireType.recordset[0].id;

  const tpl = await pool.request().input('t', sql.Int, esaTypeId).query(`INSERT INTO assessment_templates(assessment_type_id, version, status, approval_status, effective_from, exclude_na_from_compliance, notes)
    OUTPUT INSERTED.id VALUES (@t, N'1.0', N'Active', N'Approved', '2025-01-01', 1,
    N'Digitised from the Sunny Toyota Agra assessment report dated 23 December 2025. Items flagged source_review need administrator confirmation where the scan split or colour code is inconsistent.')`);
  const templateId = tpl.recordset[0].id;

  const sectionIds = {};
  const sectionOrder = [];
  for (const item of checklist) {
    if (!sectionIds[item.section]) {
      sectionOrder.push(item.section);
      const code = `ES${String(sectionOrder.length).padStart(2, '0')}`;
      const notes = (item.equipment_notes || []).join('; ');
      const r = await pool.request()
        .input('tpl', sql.Int, templateId)
        .input('code', sql.NVarChar, code)
        .input('name', sql.NVarChar, item.section)
        .input('desc', sql.NVarChar, notes ? `Reference visit equipment: ${notes}` : null)
        .input('ord', sql.Int, sectionOrder.length)
        .query(`INSERT INTO checklist_sections(template_id, section_code, section_name, section_description, display_order)
                OUTPUT INSERTED.id VALUES (@tpl,@code,@name,@desc,@ord)`);
      sectionIds[item.section] = r.recordset[0].id;
    }
  }

  const itemIds = {};
  for (const item of checklist) {
    const r = await pool.request()
      .input('tpl', sql.Int, templateId)
      .input('sec', sql.Int, sectionIds[item.section])
      .input('num', sql.Int, item.item_number)
      .input('act', sql.NVarChar, item.activity)
      .input('req', sql.NVarChar, item.requirement)
      .input('rt', sql.Int, responseTypeId)
      .input('rev', sql.Bit, item.source_review ? 1 : 0)
      .query(`INSERT INTO checklist_items(template_id, section_id, item_number, activity_description, requirement_description, response_type_id, display_order, source_review)
              OUTPUT INSERTED.id VALUES (@tpl,@sec,@num,@act,@req,@rt,@num,@rev)`);
    itemIds[item.item_number] = r.recordset[0].id;

    for (const ft of ['1S', '2S', '3S']) {
      let rule = SECTION_RULES[item.section][ft];
      if (item.item_number === EYE_WASHER_ITEM) {
        rule = { status: 'Conditional', attr: 'has_lead_acid_batteries' };
      }
      const review = rule.status !== 'Applicable' || item.item_number === EYE_WASHER_ITEM;
      await pool.request()
        .input('item', sql.Int, itemIds[item.item_number])
        .input('type', sql.Int, esaTypeId)
        .input('ft', sql.NVarChar, ft)
        .input('st', sql.NVarChar, rule.status)
        .input('def', sql.NVarChar, rule.status === 'Not Applicable' ? 'NA' : 'Blank')
        .input('attr', sql.NVarChar, rule.attr)
        .input('rev', sql.Bit, review ? 1 : 0)
        .input('remarks', sql.NVarChar, RULE_NOTE)
        .query(`INSERT INTO applicability_rules(checklist_item_id, assessment_type_id, facility_type, applicability_status, default_response, conditional_attribute, allow_override, effective_from, review_required, remarks)
                VALUES (@item,@type,@ft,@st,@def,@attr,0,'2025-01-01',@rev,@remarks)`);
    }
  }

  const fireTpl = await pool.request().input('t', sql.Int, fireTypeId).query(`INSERT INTO assessment_templates(assessment_type_id, version, status, approval_status, effective_from, exclude_na_from_compliance, notes)
    OUTPUT INSERTED.id VALUES (@t, N'1.0', N'Active', N'Approved', '2025-01-01', 1, N'Starter template so a second assessment type can be used without code changes.')`);
  const fireTplId = fireTpl.recordset[0].id;
  const fireSections = [
    ['FS01', 'Means of egress', 1],
    ['FS02', 'Portable extinguishers', 2],
    ['FS03', 'Hot work', 3]
  ];
  const fireSec = {};
  for (const s of fireSections) {
    const r = await pool.request().input('tpl', sql.Int, fireTplId).input('c', sql.NVarChar, s[0]).input('n', sql.NVarChar, s[1]).input('o', sql.Int, s[2])
      .query(`INSERT INTO checklist_sections(template_id, section_code, section_name, display_order) OUTPUT INSERTED.id VALUES (@tpl,@c,@n,@o)`);
    fireSec[s[0]] = r.recordset[0].id;
  }
  const fireItems = [
    [1, 'FS01', 'Exit routes are marked and unobstructed.', 'Escape routes and exit signs should be visible in normal lighting and kept clear.', 'Applicable'],
    [2, 'FS01', 'Emergency lighting on escape routes.', 'Critical emergency lighting should be available on exit paths.', 'Applicable'],
    [3, 'FS02', 'Extinguisher type and mounting.', 'CO2 extinguishers for electrical equipment and ABC/DCP elsewhere, mounted about 1 metre above the floor.', 'Applicable'],
    [4, 'FS02', 'Extinguisher inspection records.', 'Extinguishers should be inspected at least quarterly and records retained.', 'Applicable'],
    [5, 'FS03', 'Hot work control in the workshop.', 'Hot work should have a permit and a fire watch where cutting or welding is done.', { '1S': 'Not Applicable', '2S': 'Applicable', '3S': 'Applicable' }],
    [6, 'FS03', 'Flammable storage separation from ignition sources.', 'Fuel, paint and waste should be segregated from ignition sources.', { '1S': 'Not Applicable', '2S': 'Applicable', '3S': 'Applicable' }]
  ];
  for (const fi of fireItems) {
    const r = await pool.request()
      .input('tpl', sql.Int, fireTplId).input('sec', sql.Int, fireSec[fi[1]]).input('num', sql.Int, fi[0])
      .input('act', sql.NVarChar, fi[2]).input('req', sql.NVarChar, fi[3]).input('rt', sql.Int, responseTypeId)
      .query(`INSERT INTO checklist_items(template_id, section_id, item_number, activity_description, requirement_description, response_type_id, display_order)
              OUTPUT INSERTED.id VALUES (@tpl,@sec,@num,@act,@req,@rt,@num)`);
    const id = r.recordset[0].id;
    for (const ft of ['1S', '2S', '3S']) {
      const st = typeof fi[4] === 'string' ? fi[4] : fi[4][ft];
      await pool.request()
        .input('item', sql.Int, id).input('type', sql.Int, fireTypeId).input('ft', sql.NVarChar, ft)
        .input('st', sql.NVarChar, st).input('def', sql.NVarChar, st === 'Not Applicable' ? 'NA' : 'Blank')
        .query(`INSERT INTO applicability_rules(checklist_item_id, assessment_type_id, facility_type, applicability_status, default_response, effective_from, remarks)
                VALUES (@item,@type,@ft,@st,@def,'2025-01-01', N'Fire safety starter rules. Confirm before production use.')`);
    }
  }

  async function addDealer(row) {
    const r = await pool.request()
      .input('code', sql.NVarChar, row.code).input('name', sql.NVarChar, row.name).input('grp', sql.NVarChar, row.group || null)
      .input('addr', sql.NVarChar, row.address).input('city', sql.NVarChar, row.city).input('state', sql.NVarChar, row.state)
      .input('region', sql.NVarChar, row.region).input('pin', sql.NVarChar, row.pin).input('person', sql.NVarChar, row.person)
      .input('phone', sql.NVarChar, row.phone).input('email', sql.NVarChar, row.email).input('status', sql.NVarChar, row.status || 'Active')
      .query(`INSERT INTO dealers(dealer_code, dealer_name, dealer_group, address, city, state, region, postal_code, contact_person, contact_number, email, status)
              OUTPUT INSERTED.id VALUES (@code,@name,@grp,@addr,@city,@state,@region,@pin,@person,@phone,@email,@status)`);
    return r.recordset[0].id;
  }
  async function addFacility(dealerId, name, type, address, attrs) {
    const r = await pool.request()
      .input('d', sql.Int, dealerId).input('n', sql.NVarChar, name).input('t', sql.NVarChar, type).input('a', sql.NVarChar, address)
      .query(`INSERT INTO facilities(dealer_id, facility_name, facility_type, address, effective_from) OUTPUT INSERTED.id VALUES (@d,@n,@t,@a,'2024-01-01')`);
    const id = r.recordset[0].id;
    for (const [code, value] of Object.entries(attrs)) {
      await pool.request().input('f', sql.Int, id).input('c', sql.NVarChar, code).input('v', sql.Bit, value ? 1 : 0)
        .query(`INSERT INTO facility_attributes(facility_id, attribute_code, attribute_value) VALUES (@f,@c,@v)`);
    }
    return id;
  }

  const sunnyAttrs = {
    has_transformer: 1, has_oil_transformer: 1, has_dry_transformer: 0, has_dp_structure: 0, has_dg_set: 1,
    has_compressor: 1, has_paint_booth: 1, has_paint_mixing: 1, has_service: 1, has_lifts: 1, has_store: 1,
    has_server_room: 1, has_portable_tools: 1, has_lead_acid_batteries: 0
  };
  const showroomAttrs = {
    has_transformer: 0, has_oil_transformer: 0, has_dry_transformer: 0, has_dp_structure: 0, has_dg_set: 0,
    has_compressor: 0, has_paint_booth: 0, has_paint_mixing: 0, has_service: 0, has_lifts: 0, has_store: 0,
    has_server_room: 1, has_portable_tools: 0, has_lead_acid_batteries: 0
  };
  const twoSAttrs = {
    has_transformer: 1, has_oil_transformer: 1, has_dry_transformer: 0, has_dp_structure: 0, has_dg_set: 1,
    has_compressor: 1, has_paint_booth: 0, has_paint_mixing: 0, has_service: 1, has_lifts: 1, has_store: 1,
    has_server_room: 1, has_portable_tools: 1, has_lead_acid_batteries: 0
  };

  const sunnyId = await addDealer({
    code: 'AG02A', name: 'Sunny Toyota', group: 'Sunny Toyota',
    address: '632, Artoni, Agra Mathura Road', city: 'Agra', state: 'Uttar Pradesh', region: 'North',
    pin: '282007', person: 'Bikash K Tiwari', phone: '+91 9918101409', email: 'ag02a_cs@sunnytoyota.co.in'
  });
  const sunnyFac = await addFacility(sunnyId, 'Sunny Toyota Agra 3S', '3S', '632, Artoni, Agra Mathura Road, Agra, Uttar Pradesh, 282007', sunnyAttrs);

  const galaxyId = await addDealer({
    code: 'LK03C', name: 'Galaxy Toyota', group: 'Galaxy',
    address: '12 Faizabad Road', city: 'Lucknow', state: 'Uttar Pradesh', region: 'North',
    pin: '226016', person: 'Neha Srivastava', phone: '+91 522 400 1100', email: 'lk03c_cs@galaxytoyota.example'
  });
  const galaxyFac = await addFacility(galaxyId, 'Galaxy Toyota Showroom', '1S', '12 Faizabad Road, Lucknow', showroomAttrs);

  const highwayId = await addDealer({
    code: 'KN08B', name: 'Highway Toyota', group: 'Highway',
    address: 'Plot 4, Kalpi Road', city: 'Kanpur', state: 'Uttar Pradesh', region: 'North',
    pin: '208012', person: 'Rakesh Verma', phone: '+91 512 250 4400', email: 'kn08b_cs@highwaytoyota.example'
  });
  const highwayFac = await addFacility(highwayId, 'Highway Toyota Workshop', '2S', 'Plot 4, Kalpi Road, Kanpur', twoSAttrs);

  await addDealer({
    code: 'MH00X', name: 'Closed Motors', group: null,
    address: 'Old Pune Highway', city: 'Pune', state: 'Maharashtra', region: 'West',
    pin: '411001', person: null, phone: null, email: null, status: 'Inactive'
  });

  const lookups = {
    State: ['Uttar Pradesh', 'Maharashtra', 'Karnataka', 'Delhi', 'Rajasthan'],
    Region: ['North', 'South', 'East', 'West', 'Central'],
    AssessmentStatus: ['Draft', 'In Progress', 'Submitted', 'Returned', 'Approved'],
    FacilityType: ['1S', '2S', '3S'],
    FindingCategory: ['Earthing', 'Protection device', 'Housekeeping', 'Documentation', 'Fire', 'Thermography'],
    RecommendationCategory: ['Engineering', 'Procedural', 'Training', 'Documentation'],
    AttachmentType: ['Photograph', 'Test report', 'Drawing', 'Other'],
    ApprovalStatus: ['Draft', 'Approved', 'Retired']
  };
  let order = 1;
  for (const [category, names] of Object.entries(lookups)) {
    order = 1;
    for (const name of names) {
      const code = name.replace(/\s+/g, '_').toUpperCase();
      await pool.request().input('cat', sql.NVarChar, category).input('code', sql.NVarChar, code).input('name', sql.NVarChar, name).input('o', sql.Int, order)
        .query(`INSERT INTO lookups(category, code, name, display_order) VALUES (@cat,@code,@name,@o)`);
      order += 1;
    }
  }

  const settings = {
    organisation_name: 'Bureau Veritas Industrial Services (I) Pvt. Ltd.',
    organisation_unit: 'Health, Safety and Environmental Services',
    organisation_address: '72 Business Park, 8th Floor, Opp. Seepz Gate no. 02, Marol Industrial Area, MIDC Cross Road C, Andheri (East), Mumbai 400 093',
    organisation_phone: '+91 22 6274 2000',
    organisation_email: 'hse.mumbai@in.bureauveritas.com',
    client_name: 'Toyota Kirloskar Motor Pvt. Ltd.',
    client_address: 'Plot no.1, Bidadi industrial area, Bidadi, Ramanagar Dist, Bangalore - 562109',
    report_title: 'Electrical Safety Assessment Report',
    risk_matrix_note: 'Likelihood (most likely, likely, unlikely) times severity (death or critical injury, major injury, minor injury). Full compliance is no risk.'
  };
  for (const [k, v] of Object.entries(settings)) {
    await pool.request().input('k', sql.NVarChar, k).input('v', sql.NVarChar, v)
      .query(`INSERT INTO system_settings(setting_key, setting_value) VALUES (@k,@v)`);
  }

  async function createAssessment({ number, typeId, template, dealerId, facilityId, facilityType, date, status, reference, remarks, submitted, approved }) {
    const dealer = await pool.request().input('id', sql.Int, dealerId).query(`SELECT * FROM dealers WHERE id=@id`);
    const d = dealer.recordset[0];
    const snapshot = JSON.stringify({
      dealer_code: d.dealer_code, dealer_name: d.dealer_name, dealer_group: d.dealer_group,
      address: d.address, city: d.city, state: d.state, region: d.region, postal_code: d.postal_code,
      contact_person: d.contact_person, contact_number: d.contact_number, email: d.email
    });
    const ins = await pool.request()
      .input('num', sql.NVarChar, number).input('type', sql.Int, typeId).input('tpl', sql.Int, template)
      .input('dealer', sql.Int, dealerId).input('fac', sql.Int, facilityId).input('sur', sql.Int, surveyorId)
      .input('rev', sql.Int, status === 'Approved' ? pramodUser : null)
      .input('dt', sql.Date, date).input('status', sql.NVarChar, status)
      .input('ft', sql.NVarChar, facilityType).input('ver', sql.NVarChar, '1.0')
      .input('snap', sql.NVarChar, snapshot).input('ref', sql.NVarChar, reference).input('remarks', sql.NVarChar, remarks)
      .input('person', sql.NVarChar, d.contact_person).input('phone', sql.NVarChar, d.contact_number).input('email', sql.NVarChar, d.email)
      .input('by', sql.Int, saurabhUser)
      .input('sub', sql.DateTime2, submitted).input('app', sql.DateTime2, approved)
      .query(`INSERT INTO assessments(assessment_number, assessment_type_id, template_id, dealer_id, facility_id, surveyor_id, reviewer_id,
              assessment_date, status, facility_type_snapshot, template_version_snapshot, dealer_details_snapshot, reference_number,
              general_remarks, contact_person_snapshot, contact_number_snapshot, contact_email_snapshot, created_by, submitted_at, approved_at)
              OUTPUT INSERTED.id
              VALUES (@num,@type,@tpl,@dealer,@fac,@sur,@rev,@dt,@status,@ft,@ver,@snap,@ref,@remarks,@person,@phone,@email,@by,@sub,@app)`);
    const assessmentId = ins.recordset[0].id;
    const attrs = await pool.request().input('f', sql.Int, facilityId).query(`SELECT attribute_code, attribute_value FROM facility_attributes WHERE facility_id=@f`);
    const attrMap = {};
    for (const a of attrs.recordset) attrMap[a.attribute_code] = !!a.attribute_value;
    const items = await pool.request().input('tpl', sql.Int, template).query(`SELECT id, item_number, source_review FROM checklist_items WHERE template_id=@tpl`);
    const rules = await pool.request().input('tpl', sql.Int, template).input('ft', sql.NVarChar, facilityType)
      .query(`SELECT r.* FROM applicability_rules r INNER JOIN checklist_items i ON i.id=r.checklist_item_id
              WHERE i.template_id=@tpl AND r.facility_type=@ft AND r.active_status=1`);
    const ruleByItem = new Map(rules.recordset.map((r) => [r.checklist_item_id, r]));
    const { resolveApplicability, snapshotOf } = await import('./applicability.js');
    for (const item of items.recordset) {
      const rule = ruleByItem.get(item.id);
      const resolved = resolveApplicability(rule, attrMap);
      const snap = JSON.stringify(snapshotOf(rule, resolved, facilityType));
      await pool.request()
        .input('a', sql.Int, assessmentId).input('i', sql.Int, item.id)
        .input('code', sql.NVarChar, resolved.response)
        .input('app', sql.NVarChar, resolved.status)
        .input('snap', sql.NVarChar, snap)
        .input('lock', sql.Bit, resolved.locked ? 1 : 0)
        .input('rev', sql.Bit, item.source_review || resolved.review ? 1 : 0)
        .query(`INSERT INTO assessment_responses(assessment_id, checklist_item_id, response_code, applicability_status, applicability_snapshot, locked_na, source_review)
                VALUES (@a,@i,@code,@app,@snap,@lock,@rev)`);
    }
    return assessmentId;
  }

  const sunny = await createAssessment({
    number: 'ESA-AG02A-2025-001', typeId: esaTypeId, template: templateId, dealerId: sunnyId, facilityId: sunnyFac,
    facilityType: '3S', date: '2025-12-23', status: 'Approved', reference: 'ESA/AG02A/00',
    remarks: 'Dealership visit 23 December 2025. Opening meeting about 09:35. Close-out meeting about 18:20. Report issue date recorded as 13 May 2026 in the source document.',
    submitted: new Date('2025-12-24T12:00:00Z'), approved: new Date('2026-05-13T06:30:00Z')
  });

  for (const item of checklist) {
    const response = RESPONSE_BY_CODE[item.risk_code];
    const risk = RISK_BY_CODE[item.risk_code];
    await pool.request()
      .input('a', sql.Int, sunny).input('n', sql.Int, item.item_number)
      .input('code', sql.NVarChar, response)
      .input('obs', sql.NVarChar, item.observation || null)
      .input('rec', sql.NVarChar, item.recommendation || null)
      .input('risk', sql.Int, risk ? riskIds[risk] : null)
      .input('rev', sql.Bit, item.source_review ? 1 : 0)
      .query(`UPDATE r SET response_code=@code, observation=@obs, recommendation=@rec, risk_rating_id=@risk,
              source_review=@rev, updated_at=SYSUTCDATETIME()
              FROM assessment_responses r INNER JOIN checklist_items i ON i.id=r.checklist_item_id
              WHERE r.assessment_id=@a AND i.item_number=@n`);
  }

  await pool.request().input('a', sql.Int, sunny).input('u', sql.Int, pramodUser)
    .query(`INSERT INTO assessment_reviews(assessment_id, action, remarks, user_id) VALUES
            (@a, N'Submitted', N'Submitted from the 23 December 2025 visit.', ${saurabhUser}),
            (@a, N'Approved', N'Reviewed by Pramod S. Uranakar. Source colour codes that disagree with the wording are flagged for confirmation and were not silently corrected.', @u)`);

  const narratives = [
    ['preamble', 'Introduction', 'Toyota Kirloskar Motor Pvt. Ltd. engaged Bureau Veritas to carry out an Electrical Safety Assessment of Sunny Toyota, Agra (AG02A), 632, Artoni, Agra Mathura Road, Agra, Uttar Pradesh, 282007. The visit was on 23 December 2025. Findings are based on document review, inspection of electrical installations and discussions with dealership personnel. Recommendations apply to the conditions seen at this location.'],
    ['objectives', 'Objectives', 'Identify hazards in the operation and maintenance of electrical equipment. Review procedures, statutory compliance and opportunities to improve electrical safety performance.'],
    ['scope', 'Scope', 'Visual inspection and document review of electrical installations, PPE, earthing checks, training, maintenance and LOTO records, incident records and change management. Thermography, load balance at the main incomer and neutral-to-earth voltage were in scope. Other performance tests were not.'],
    ['strengths', 'Key strengths and good safety practices', [
      'Earth pit identification is completed with clear markings.',
      'Emergency telephone numbers are displayed in the electrical room.',
      'Phase indication lamps and the multifunction meter are working.',
      'Antistatic discharge is available at the paint booth and paint mixing entry.',
      'Hydraulic lift limit operation was satisfactory at maximum level.',
      'UPS supply is provided to the fire detection and alarm system.',
      '440V insulated rubber hand gloves are available.',
      'Non-flammable material is used for the false ceiling.',
      'A lightning arrestor is installed with the down conductor fixed on insulators.',
      'An annual maintenance contract for the paint booth is available.'
    ].join('\n')],
    ['opportunities', 'Additional opportunities', [
      'Provide a gland plate on the PDB and standard cable glands.',
      'Fit battery terminal caps on battery terminals.',
      'Restore the DG set internal light.',
      'Install an earth leakage relay on the main panel.',
      'Provide a LOTO kit and adopt the procedure.',
      'Use FRLS or FRLSH cables on future installations.',
      'Provide 30mA RCCB protection on the LDB.',
      'Identify cables and feeders on the PDB and LDB.',
      'Provide double earthing on three-phase equipment.',
      'Keep at least three metres between the diesel tank and the burner, or fit a rated partition.',
      'Earth the store metallic racks.',
      'Issue an updated single line diagram, earthing layout and schematic.'
    ].join('\n')],
    ['disclaimer', 'Disclaimer', 'This report records the electrical safety assessment of the named dealership. It is issued within the contract with Toyota Kirloskar Motor Pvt. Ltd. and does not by itself determine statutory compliance or legal liability.']
  ];
  for (const n of narratives) {
    await pool.request().input('a', sql.Int, sunny).input('c', sql.NVarChar, n[0]).input('t', sql.NVarChar, n[1]).input('b', sql.NVarChar, n[2])
      .query(`INSERT INTO assessment_narratives(assessment_id, code, title, body) VALUES (@a,@c,@t,@b)`);
  }

  const equipment = [
    ['Transformer', 'Transformer-1', 'SVT/TR/938/1', '100 kVA'],
    ['DG Set', 'DG Set-1', '01 1007 1842', '82.5 kVA'],
    ['UPS', 'UPS-1', '013021098', '10 kVA'],
    ['Thermal camera', 'HIKMICRO Eco-V', 'EA2984991', 'Calibrated 10.11.2025, due 09.11.2026'],
    ['Clamp meter', 'MECO DTT 2250-Hz AUTO', '2250-24070680', 'Calibrated 07.11.2025, due 06.11.2026']
  ];
  for (const e of equipment) {
    await pool.request().input('a', sql.Int, sunny).input('t', sql.NVarChar, e[0]).input('l', sql.NVarChar, e[1]).input('i', sql.NVarChar, e[2]).input('r', sql.NVarChar, e[3])
      .query(`INSERT INTO assessment_equipment(assessment_id, equipment_type, label, identifier, rating) VALUES (@a,@t,@l,@i,@r)`);
  }

  const thermo = [
    [1, 'Electrical Room', 'PDB I/C MCCB', 'I/C MCCB', 9.9, 22.9, 13.0, 'Medium'],
    [2, 'Electrical Room', 'PDB incomer cables', 'Incomer bus bar', 9.8, 23.3, 13.5, 'Medium'],
    [3, 'Electrical Room', 'PDB I/C MCCB bus bar', 'MCCB bus bar', 10.1, 23.5, 13.4, 'Medium'],
    [4, 'Electrical Room', 'PDB load', 'Load MCBs', 17.6, 29.3, 11.7, 'Medium'],
    [5, 'Electrical room', 'PDB Busbar Panel', 'Busbar', 22.2, 81.2, 59.0, 'Critical'],
    [6, 'Electrical room', 'Changeover switch', 'Change over', 25.7, 71.1, 46.4, 'Critical'],
    [7, 'Body shop', 'Fuse box', 'Fuse', 22.2, 30.2, 8.0, 'Low'],
    [8, 'Workshop', 'Fuse box', 'Fuse', 16.2, 25.4, 9.2, 'Low'],
    [9, 'Showroom', 'Showroom panel MCB', 'MCBs', 19.2, 25.3, 6.1, 'Low'],
    [10, 'Workshop', 'Output MCBs for load', 'MCBs', 21.1, 43.3, 22.2, 'High'],
    [11, 'DG Set', 'DG control panel', 'Control panel', 19.9, 26.6, 6.7, 'Low'],
    [12, 'PDB', 'Busbar panel', 'Busbar', 15.1, 22.4, 7.3, 'Low'],
    [13, 'DG Set', 'Battery terminal', 'Battery terminal', 17.4, 33.4, 16.0, 'Medium'],
    [14, 'Paint booth area', 'Paint booth control panel', 'Control panel', 23.1, 46.0, 22.9, 'High']
  ];
  for (const t of thermo) {
    await pool.request()
      .input('a', sql.Int, sunny).input('n', sql.Int, t[0]).input('ar', sql.NVarChar, t[1]).input('eq', sql.NVarChar, t[2])
      .input('loc', sql.NVarChar, t[3]).input('am', sql.Decimal(6, 1), t[4]).input('hs', sql.Decimal(6, 1), t[5])
      .input('d', sql.Decimal(6, 1), t[6]).input('sv', sql.NVarChar, t[7])
      .query(`INSERT INTO thermography_readings(assessment_id, sl_no, area, equipment, location, ambient_c, hotspot_c, delta_c, severity)
              VALUES (@a,@n,@ar,@eq,@loc,@am,@hs,@d,@sv)`);
  }
  await pool.request().input('a', sql.Int, sunny).query(`INSERT INTO load_balance_readings(assessment_id, sl_no, area, equipment, l1_a, l2_a, l3_a, unbalance_l1, unbalance_l2, unbalance_l3, finding, recommendation)
    VALUES (@a, 1, N'Electrical Room', N'PDB', 68.5, 86.3, 77.1, -11.38, 11.64, -0.26,
    N'The unbalanced current on all three phases is beyond the acceptable limit. Load imbalance should not be more than 10%.',
    N'Redistribute loads across the phases and monitor phase current balance.')`);
  const ne = [
    [1, 'Electrical Room', 'PDB', 1.19], [2, 'Workshop', 'LDB', 1.30], [3, 'Bodyshop', 'LDB', 2.26],
    [4, 'Office', 'LDB', 0.85], [5, 'Workshop', 'Industrial sockets', 1.20], [6, 'Bodyshop', 'Industrial sockets', 0.86],
    [7, 'Service area', 'Vehicle washing switchboard', 0.75], [8, 'Paint booth', 'Control panel', 0.95],
    [9, 'Paint mixing area', 'Switchboard', 0.80], [10, 'Store', 'Switchboard', 0.75],
    [11, 'Office', 'Switchboard', 0.80], [12, 'Office (Showroom)', 'Switchboard near TV', 1.35],
    [13, 'Security Room', 'Switchboard', 0.56], [14, 'Entrance Gate', 'Switchboard', 0.45]
  ];
  for (const n of ne) {
    await pool.request().input('a', sql.Int, sunny).input('s', sql.Int, n[0]).input('ar', sql.NVarChar, n[1]).input('eq', sql.NVarChar, n[2]).input('v', sql.Decimal(8, 2), n[3])
      .query(`INSERT INTO neutral_earth_readings(assessment_id, sl_no, area, equipment, voltage_v) VALUES (@a,@s,@ar,@eq,@v)`);
  }

  await createAssessment({
    number: 'ESA-LK03C-2026-001', typeId: esaTypeId, template: templateId, dealerId: galaxyId, facilityId: galaxyFac,
    facilityType: '1S', date: '2026-03-18', status: 'Draft', reference: null,
    remarks: 'Showroom assessment started. Workshop sections are NA from the facility master.'
  });

  const highway = await createAssessment({
    number: 'ESA-KN08B-2026-002', typeId: esaTypeId, template: templateId, dealerId: highwayId, facilityId: highwayFac,
    facilityType: '2S', date: '2026-02-11', status: 'Submitted', reference: 'ESA/KN08B/01',
    remarks: 'Submitted for review. Paint booth and paint mixing are NA because this 2S site has no booth.',
    submitted: new Date('2026-02-11T15:10:00Z')
  });
  await pool.request().input('a', sql.Int, highway).input('risk', sql.Int, riskIds.NO_RISK).query(`
    UPDATE assessment_responses SET response_code=N'COMPLIANT', risk_rating_id=@risk, observation=N'Checked during the visit. No adverse condition recorded.', updated_at=SYSUTCDATETIME()
    WHERE assessment_id=@a AND applicability_status=N'Applicable' AND response_code IS NULL`);
  await pool.request().input('a', sql.Int, highway).input('risk', sql.Int, riskIds.MAJOR).query(`
    UPDATE r SET response_code=N'NON_COMPLIANT', risk_rating_id=@risk,
      observation=N'Earth pit layout was not available at the workshop.',
      recommendation=N'Issue an updated earth pit layout showing pit numbers, locations and equipment connections.',
      updated_at=SYSUTCDATETIME()
    FROM assessment_responses r INNER JOIN checklist_items i ON i.id=r.checklist_item_id
    WHERE r.assessment_id=@a AND i.item_number=3`);
  await pool.request().input('a', sql.Int, highway).input('risk', sql.Int, riskIds.CRITICAL).query(`
    UPDATE r SET response_code=N'NON_COMPLIANT', risk_rating_id=@risk,
      observation=N'ELR is not installed on the main incomer.',
      recommendation=N'Install an earth leakage relay rated for the incomer and test the trip function.',
      updated_at=SYSUTCDATETIME()
    FROM assessment_responses r INNER JOIN checklist_items i ON i.id=r.checklist_item_id
    WHERE r.assessment_id=@a AND i.item_number=47`);
  await pool.request().input('a', sql.Int, highway).input('u', sql.Int, saurabhUser)
    .query(`INSERT INTO assessment_reviews(assessment_id, action, remarks, user_id) VALUES (@a, N'Submitted', N'Ready for reviewer.', @u)`);

  await pool.request().input('u', sql.Int, adminId).query(`INSERT INTO audit_logs(user_id, entity_type, entity_id, action, new_value)
    VALUES (@u, N'system', N'seed', N'Seed', N'Initial masters, ESA template 1.0 and three sample assessments loaded.')`);

  const counts = await pool.request().query(`SELECT
    (SELECT COUNT(*) FROM checklist_items WHERE template_id=${templateId}) AS items,
    (SELECT COUNT(*) FROM applicability_rules) AS rules,
    (SELECT COUNT(*) FROM assessment_responses WHERE assessment_id=${sunny} AND response_code=N'NA') AS sunny_na,
    (SELECT COUNT(*) FROM assessment_responses WHERE assessment_id=${sunny} AND response_code=N'COMPLIANT') AS sunny_ok`);
  console.log('Seed complete', counts.recordset[0]);
  await pool.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
