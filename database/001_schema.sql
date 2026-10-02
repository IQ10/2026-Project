/*
  Electrical Safety Assessment Management System
  SQL Server schema. Historical assessments store snapshots so later
  master-data edits do not change issued reports.
*/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF DB_ID(N'EsaManagement') IS NULL
BEGIN
  CREATE DATABASE EsaManagement;
END
GO

USE EsaManagement;
GO

IF OBJECT_ID(N'dbo.assessment_attachments', N'U') IS NOT NULL DROP TABLE dbo.assessment_attachments;
IF OBJECT_ID(N'dbo.neutral_earth_readings', N'U') IS NOT NULL DROP TABLE dbo.neutral_earth_readings;
IF OBJECT_ID(N'dbo.load_balance_readings', N'U') IS NOT NULL DROP TABLE dbo.load_balance_readings;
IF OBJECT_ID(N'dbo.thermography_readings', N'U') IS NOT NULL DROP TABLE dbo.thermography_readings;
IF OBJECT_ID(N'dbo.assessment_equipment', N'U') IS NOT NULL DROP TABLE dbo.assessment_equipment;
IF OBJECT_ID(N'dbo.assessment_narratives', N'U') IS NOT NULL DROP TABLE dbo.assessment_narratives;
IF OBJECT_ID(N'dbo.assessment_reviews', N'U') IS NOT NULL DROP TABLE dbo.assessment_reviews;
IF OBJECT_ID(N'dbo.assessment_responses', N'U') IS NOT NULL DROP TABLE dbo.assessment_responses;
IF OBJECT_ID(N'dbo.assessments', N'U') IS NOT NULL DROP TABLE dbo.assessments;
IF OBJECT_ID(N'dbo.import_flags', N'U') IS NOT NULL DROP TABLE dbo.import_flags;
IF OBJECT_ID(N'dbo.import_batches', N'U') IS NOT NULL DROP TABLE dbo.import_batches;
IF OBJECT_ID(N'dbo.applicability_rules', N'U') IS NOT NULL DROP TABLE dbo.applicability_rules;
IF OBJECT_ID(N'dbo.checklist_items', N'U') IS NOT NULL DROP TABLE dbo.checklist_items;
IF OBJECT_ID(N'dbo.checklist_sections', N'U') IS NOT NULL DROP TABLE dbo.checklist_sections;
IF OBJECT_ID(N'dbo.assessment_templates', N'U') IS NOT NULL DROP TABLE dbo.assessment_templates;
IF OBJECT_ID(N'dbo.assessment_types', N'U') IS NOT NULL DROP TABLE dbo.assessment_types;
IF OBJECT_ID(N'dbo.response_options', N'U') IS NOT NULL DROP TABLE dbo.response_options;
IF OBJECT_ID(N'dbo.response_types', N'U') IS NOT NULL DROP TABLE dbo.response_types;
IF OBJECT_ID(N'dbo.risk_ratings', N'U') IS NOT NULL DROP TABLE dbo.risk_ratings;
IF OBJECT_ID(N'dbo.facility_attributes', N'U') IS NOT NULL DROP TABLE dbo.facility_attributes;
IF OBJECT_ID(N'dbo.facilities', N'U') IS NOT NULL DROP TABLE dbo.facilities;
IF OBJECT_ID(N'dbo.dealers', N'U') IS NOT NULL DROP TABLE dbo.dealers;
IF OBJECT_ID(N'dbo.surveyors', N'U') IS NOT NULL DROP TABLE dbo.surveyors;
IF OBJECT_ID(N'dbo.audit_logs', N'U') IS NOT NULL DROP TABLE dbo.audit_logs;
IF OBJECT_ID(N'dbo.lookups', N'U') IS NOT NULL DROP TABLE dbo.lookups;
IF OBJECT_ID(N'dbo.system_settings', N'U') IS NOT NULL DROP TABLE dbo.system_settings;
IF OBJECT_ID(N'dbo.role_permissions', N'U') IS NOT NULL DROP TABLE dbo.role_permissions;
IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL DROP TABLE dbo.users;
IF OBJECT_ID(N'dbo.roles', N'U') IS NOT NULL DROP TABLE dbo.roles;
GO

CREATE TABLE dbo.roles (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  name NVARCHAR(50) NOT NULL UNIQUE,
  description NVARCHAR(300) NULL
);

CREATE TABLE dbo.role_permissions (
  role_id INT NOT NULL REFERENCES dbo.roles(id),
  permission_code NVARCHAR(80) NOT NULL,
  CONSTRAINT PK_role_permissions PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE dbo.users (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  name NVARCHAR(150) NOT NULL,
  email NVARCHAR(200) NOT NULL UNIQUE,
  password_hash NVARCHAR(200) NOT NULL,
  role_id INT NOT NULL REFERENCES dbo.roles(id),
  employee_id NVARCHAR(50) NULL,
  phone NVARCHAR(40) NULL,
  region NVARCHAR(80) NULL,
  status NVARCHAR(20) NOT NULL CONSTRAINT DF_users_status DEFAULT N'Active',
  created_at DATETIME2 NOT NULL CONSTRAINT DF_users_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT CK_users_status CHECK (status IN (N'Active', N'Inactive'))
);

CREATE TABLE dbo.surveyors (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  user_id INT NULL REFERENCES dbo.users(id),
  employee_id NVARCHAR(50) NOT NULL,
  name NVARCHAR(150) NOT NULL,
  email NVARCHAR(200) NULL,
  phone NVARCHAR(40) NULL,
  region NVARCHAR(80) NULL,
  role_name NVARCHAR(50) NULL,
  status NVARCHAR(20) NOT NULL CONSTRAINT DF_surveyors_status DEFAULT N'Active',
  CONSTRAINT UQ_surveyors_employee UNIQUE (employee_id),
  CONSTRAINT CK_surveyors_status CHECK (status IN (N'Active', N'Inactive'))
);

CREATE TABLE dbo.dealers (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  dealer_code NVARCHAR(30) NOT NULL,
  dealer_name NVARCHAR(200) NOT NULL,
  dealer_group NVARCHAR(150) NULL,
  address NVARCHAR(400) NOT NULL,
  city NVARCHAR(80) NOT NULL,
  state NVARCHAR(80) NOT NULL,
  region NVARCHAR(80) NULL,
  postal_code NVARCHAR(20) NULL,
  contact_person NVARCHAR(150) NULL,
  contact_number NVARCHAR(40) NULL,
  email NVARCHAR(200) NULL,
  status NVARCHAR(20) NOT NULL CONSTRAINT DF_dealers_status DEFAULT N'Active',
  created_at DATETIME2 NOT NULL CONSTRAINT DF_dealers_created DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL CONSTRAINT DF_dealers_updated DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_dealers_code UNIQUE (dealer_code),
  CONSTRAINT CK_dealers_status CHECK (status IN (N'Active', N'Inactive'))
);

CREATE TABLE dbo.facilities (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  dealer_id INT NOT NULL REFERENCES dbo.dealers(id),
  facility_name NVARCHAR(200) NOT NULL,
  facility_type NVARCHAR(10) NOT NULL,
  address NVARCHAR(400) NULL,
  status NVARCHAR(20) NOT NULL CONSTRAINT DF_facilities_status DEFAULT N'Active',
  effective_from DATE NULL,
  effective_to DATE NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_facilities_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT CK_facilities_type CHECK (facility_type IN (N'1S', N'2S', N'3S')),
  CONSTRAINT CK_facilities_status CHECK (status IN (N'Active', N'Inactive'))
);
CREATE INDEX IX_facilities_dealer ON dbo.facilities(dealer_id);

CREATE TABLE dbo.facility_attributes (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  facility_id INT NOT NULL REFERENCES dbo.facilities(id) ON DELETE CASCADE,
  attribute_code NVARCHAR(80) NOT NULL,
  attribute_value BIT NOT NULL,
  remarks NVARCHAR(300) NULL,
  CONSTRAINT UQ_facility_attribute UNIQUE (facility_id, attribute_code)
);

CREATE TABLE dbo.risk_ratings (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  code NVARCHAR(30) NOT NULL UNIQUE,
  name NVARCHAR(80) NOT NULL,
  description NVARCHAR(400) NULL,
  severity_level INT NOT NULL,
  display_order INT NOT NULL,
  active_status BIT NOT NULL CONSTRAINT DF_risk_active DEFAULT 1
);

CREATE TABLE dbo.response_types (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  code NVARCHAR(40) NOT NULL UNIQUE,
  name NVARCHAR(120) NOT NULL,
  description NVARCHAR(400) NULL,
  active_status BIT NOT NULL CONSTRAINT DF_rt_active DEFAULT 1
);

CREATE TABLE dbo.response_options (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  response_type_id INT NOT NULL REFERENCES dbo.response_types(id),
  code NVARCHAR(40) NOT NULL,
  label NVARCHAR(80) NOT NULL,
  counts_as NVARCHAR(30) NOT NULL,
  requires_observation BIT NOT NULL CONSTRAINT DF_ro_obs DEFAULT 0,
  requires_recommendation BIT NOT NULL CONSTRAINT DF_ro_rec DEFAULT 0,
  requires_risk BIT NOT NULL CONSTRAINT DF_ro_risk DEFAULT 0,
  selectable_by_surveyor BIT NOT NULL CONSTRAINT DF_ro_sel DEFAULT 1,
  display_order INT NOT NULL,
  active_status BIT NOT NULL CONSTRAINT DF_ro_active DEFAULT 1,
  CONSTRAINT UQ_response_option UNIQUE (response_type_id, code)
);

CREATE TABLE dbo.assessment_types (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  code NVARCHAR(40) NOT NULL UNIQUE,
  name NVARCHAR(150) NOT NULL,
  description NVARCHAR(500) NULL,
  active_status BIT NOT NULL CONSTRAINT DF_at_active DEFAULT 1,
  approval_status NVARCHAR(30) NOT NULL CONSTRAINT DF_at_appr DEFAULT N'Approved',
  effective_from DATE NULL,
  effective_to DATE NULL
);

CREATE TABLE dbo.assessment_templates (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  assessment_type_id INT NOT NULL REFERENCES dbo.assessment_types(id),
  version NVARCHAR(20) NOT NULL,
  status NVARCHAR(30) NOT NULL,
  approval_status NVARCHAR(30) NOT NULL,
  effective_from DATE NULL,
  effective_to DATE NULL,
  exclude_na_from_compliance BIT NOT NULL CONSTRAINT DF_tpl_na DEFAULT 1,
  notes NVARCHAR(500) NULL,
  CONSTRAINT UQ_template_version UNIQUE (assessment_type_id, version)
);

CREATE TABLE dbo.checklist_sections (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  template_id INT NOT NULL REFERENCES dbo.assessment_templates(id),
  section_code NVARCHAR(30) NOT NULL,
  section_name NVARCHAR(200) NOT NULL,
  section_description NVARCHAR(800) NULL,
  display_order INT NOT NULL,
  active_status BIT NOT NULL CONSTRAINT DF_sec_active DEFAULT 1,
  CONSTRAINT UQ_section_code UNIQUE (template_id, section_code)
);

CREATE TABLE dbo.checklist_items (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  template_id INT NOT NULL REFERENCES dbo.assessment_templates(id),
  section_id INT NOT NULL REFERENCES dbo.checklist_sections(id),
  item_number INT NOT NULL,
  activity_description NVARCHAR(500) NOT NULL,
  requirement_description NVARCHAR(MAX) NOT NULL,
  guidance NVARCHAR(MAX) NULL,
  response_type_id INT NOT NULL REFERENCES dbo.response_types(id),
  risk_rating_enabled BIT NOT NULL CONSTRAINT DF_item_risk DEFAULT 1,
  observation_required BIT NOT NULL CONSTRAINT DF_item_obs DEFAULT 1,
  recommendation_required BIT NOT NULL CONSTRAINT DF_item_rec DEFAULT 1,
  evidence_required BIT NOT NULL CONSTRAINT DF_item_ev DEFAULT 0,
  display_order INT NOT NULL,
  active_status BIT NOT NULL CONSTRAINT DF_item_active DEFAULT 1,
  version_number INT NOT NULL CONSTRAINT DF_item_ver DEFAULT 1,
  source_review BIT NOT NULL CONSTRAINT DF_item_review DEFAULT 0,
  CONSTRAINT UQ_item_number UNIQUE (template_id, item_number)
);
CREATE INDEX IX_items_section ON dbo.checklist_items(section_id);

CREATE TABLE dbo.applicability_rules (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  checklist_item_id INT NOT NULL REFERENCES dbo.checklist_items(id),
  assessment_type_id INT NOT NULL REFERENCES dbo.assessment_types(id),
  facility_type NVARCHAR(10) NOT NULL,
  applicability_status NVARCHAR(30) NOT NULL,
  default_response NVARCHAR(40) NULL,
  conditional_attribute NVARCHAR(80) NULL,
  allow_override BIT NOT NULL CONSTRAINT DF_rule_override DEFAULT 0,
  effective_from DATE NULL,
  effective_to DATE NULL,
  active_status BIT NOT NULL CONSTRAINT DF_rule_active DEFAULT 1,
  review_required BIT NOT NULL CONSTRAINT DF_rule_review DEFAULT 0,
  remarks NVARCHAR(600) NULL,
  CONSTRAINT CK_rule_facility CHECK (facility_type IN (N'1S', N'2S', N'3S')),
  CONSTRAINT CK_rule_status CHECK (applicability_status IN (N'Applicable', N'Not Applicable', N'Conditional'))
);
CREATE INDEX IX_rules_item ON dbo.applicability_rules(checklist_item_id, facility_type, active_status);

CREATE TABLE dbo.assessments (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  assessment_number NVARCHAR(40) NOT NULL UNIQUE,
  assessment_type_id INT NOT NULL REFERENCES dbo.assessment_types(id),
  template_id INT NOT NULL REFERENCES dbo.assessment_templates(id),
  dealer_id INT NOT NULL REFERENCES dbo.dealers(id),
  facility_id INT NOT NULL REFERENCES dbo.facilities(id),
  surveyor_id INT NOT NULL REFERENCES dbo.surveyors(id),
  reviewer_id INT NULL REFERENCES dbo.users(id),
  assessment_date DATE NOT NULL,
  status NVARCHAR(30) NOT NULL,
  facility_type_snapshot NVARCHAR(10) NOT NULL,
  template_version_snapshot NVARCHAR(20) NOT NULL,
  dealer_details_snapshot NVARCHAR(MAX) NOT NULL,
  reference_number NVARCHAR(80) NULL,
  previous_reference NVARCHAR(80) NULL,
  general_remarks NVARCHAR(MAX) NULL,
  contact_person_snapshot NVARCHAR(150) NULL,
  contact_number_snapshot NVARCHAR(40) NULL,
  contact_email_snapshot NVARCHAR(200) NULL,
  return_remarks NVARCHAR(MAX) NULL,
  created_by INT NOT NULL REFERENCES dbo.users(id),
  created_at DATETIME2 NOT NULL CONSTRAINT DF_asmt_created DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL CONSTRAINT DF_asmt_updated DEFAULT SYSUTCDATETIME(),
  submitted_at DATETIME2 NULL,
  approved_at DATETIME2 NULL,
  CONSTRAINT CK_asmt_status CHECK (status IN (N'Draft', N'In Progress', N'Submitted', N'Returned', N'Approved'))
);
CREATE INDEX IX_asmt_status ON dbo.assessments(status, assessment_date);
CREATE INDEX IX_asmt_surveyor ON dbo.assessments(surveyor_id);
CREATE INDEX IX_asmt_dealer ON dbo.assessments(dealer_id);

CREATE TABLE dbo.assessment_responses (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  assessment_id INT NOT NULL REFERENCES dbo.assessments(id) ON DELETE CASCADE,
  checklist_item_id INT NOT NULL REFERENCES dbo.checklist_items(id),
  response_code NVARCHAR(40) NULL,
  observation NVARCHAR(MAX) NULL,
  recommendation NVARCHAR(MAX) NULL,
  risk_rating_id INT NULL REFERENCES dbo.risk_ratings(id),
  remarks NVARCHAR(MAX) NULL,
  review_remarks NVARCHAR(MAX) NULL,
  applicability_status NVARCHAR(30) NOT NULL,
  applicability_snapshot NVARCHAR(MAX) NOT NULL,
  locked_na BIT NOT NULL CONSTRAINT DF_resp_locked DEFAULT 0,
  override_reason NVARCHAR(400) NULL,
  overridden_by INT NULL REFERENCES dbo.users(id),
  overridden_at DATETIME2 NULL,
  source_review BIT NOT NULL CONSTRAINT DF_resp_review DEFAULT 0,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_resp_created DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL CONSTRAINT DF_resp_updated DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_response_item UNIQUE (assessment_id, checklist_item_id)
);
CREATE INDEX IX_resp_assessment ON dbo.assessment_responses(assessment_id);

CREATE TABLE dbo.assessment_attachments (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  assessment_id INT NOT NULL REFERENCES dbo.assessments(id) ON DELETE CASCADE,
  checklist_item_id INT NULL REFERENCES dbo.checklist_items(id),
  file_name NVARCHAR(260) NOT NULL,
  file_type NVARCHAR(120) NULL,
  file_data VARBINARY(MAX) NOT NULL,
  uploaded_by INT NOT NULL REFERENCES dbo.users(id),
  uploaded_at DATETIME2 NOT NULL CONSTRAINT DF_att_uploaded DEFAULT SYSUTCDATETIME()
);

CREATE TABLE dbo.assessment_reviews (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  assessment_id INT NOT NULL REFERENCES dbo.assessments(id) ON DELETE CASCADE,
  action NVARCHAR(40) NOT NULL,
  remarks NVARCHAR(MAX) NULL,
  user_id INT NOT NULL REFERENCES dbo.users(id),
  created_at DATETIME2 NOT NULL CONSTRAINT DF_rev_created DEFAULT SYSUTCDATETIME()
);

CREATE TABLE dbo.assessment_narratives (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  assessment_id INT NOT NULL REFERENCES dbo.assessments(id) ON DELETE CASCADE,
  code NVARCHAR(40) NOT NULL,
  title NVARCHAR(150) NOT NULL,
  body NVARCHAR(MAX) NULL,
  CONSTRAINT UQ_narrative UNIQUE (assessment_id, code)
);

CREATE TABLE dbo.assessment_equipment (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  assessment_id INT NOT NULL REFERENCES dbo.assessments(id) ON DELETE CASCADE,
  equipment_type NVARCHAR(80) NOT NULL,
  label NVARCHAR(120) NOT NULL,
  identifier NVARCHAR(120) NULL,
  rating NVARCHAR(80) NULL
);

CREATE TABLE dbo.thermography_readings (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  assessment_id INT NOT NULL REFERENCES dbo.assessments(id) ON DELETE CASCADE,
  sl_no INT NOT NULL,
  area NVARCHAR(120) NULL,
  equipment NVARCHAR(200) NULL,
  location NVARCHAR(200) NULL,
  ambient_c DECIMAL(6,1) NULL,
  hotspot_c DECIMAL(6,1) NULL,
  delta_c DECIMAL(6,1) NULL,
  severity NVARCHAR(30) NULL
);

CREATE TABLE dbo.load_balance_readings (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  assessment_id INT NOT NULL REFERENCES dbo.assessments(id) ON DELETE CASCADE,
  sl_no INT NOT NULL,
  area NVARCHAR(120) NULL,
  equipment NVARCHAR(120) NULL,
  l1_a DECIMAL(8,2) NULL,
  l2_a DECIMAL(8,2) NULL,
  l3_a DECIMAL(8,2) NULL,
  unbalance_l1 DECIMAL(8,2) NULL,
  unbalance_l2 DECIMAL(8,2) NULL,
  unbalance_l3 DECIMAL(8,2) NULL,
  finding NVARCHAR(MAX) NULL,
  recommendation NVARCHAR(MAX) NULL
);

CREATE TABLE dbo.neutral_earth_readings (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  assessment_id INT NOT NULL REFERENCES dbo.assessments(id) ON DELETE CASCADE,
  sl_no INT NOT NULL,
  area NVARCHAR(120) NULL,
  equipment NVARCHAR(160) NULL,
  voltage_v DECIMAL(8,2) NULL
);

CREATE TABLE dbo.audit_logs (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  user_id INT NULL,
  entity_type NVARCHAR(80) NOT NULL,
  entity_id NVARCHAR(40) NULL,
  action NVARCHAR(80) NOT NULL,
  old_value NVARCHAR(MAX) NULL,
  new_value NVARCHAR(MAX) NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_audit_created DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_audit_entity ON dbo.audit_logs(entity_type, entity_id, created_at);

CREATE TABLE dbo.lookups (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  category NVARCHAR(60) NOT NULL,
  code NVARCHAR(60) NOT NULL,
  name NVARCHAR(150) NOT NULL,
  display_order INT NOT NULL CONSTRAINT DF_lookup_order DEFAULT 0,
  active_status BIT NOT NULL CONSTRAINT DF_lookup_active DEFAULT 1,
  CONSTRAINT UQ_lookup UNIQUE (category, code)
);

CREATE TABLE dbo.system_settings (
  setting_key NVARCHAR(80) NOT NULL PRIMARY KEY,
  setting_value NVARCHAR(MAX) NULL
);

CREATE TABLE dbo.import_batches (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  template_id INT NULL REFERENCES dbo.assessment_templates(id),
  file_name NVARCHAR(200) NULL,
  status NVARCHAR(30) NOT NULL,
  created_by INT NULL REFERENCES dbo.users(id),
  created_at DATETIME2 NOT NULL CONSTRAINT DF_imp_created DEFAULT SYSUTCDATETIME(),
  summary NVARCHAR(MAX) NULL
);

CREATE TABLE dbo.import_flags (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  batch_id INT NOT NULL REFERENCES dbo.import_batches(id) ON DELETE CASCADE,
  item_number INT NULL,
  severity NVARCHAR(20) NOT NULL,
  message NVARCHAR(400) NOT NULL
);
GO
