export interface SessionUser {
  id: number;
  name: string;
  email: string;
  role: string;
  employeeId?: string;
  surveyorId?: number | null;
  permissions: string[];
}

export interface Dealer {
  id: number;
  dealer_code: string;
  dealer_name: string;
  dealer_group?: string;
  address: string;
  city: string;
  state: string;
  region?: string;
  postal_code?: string;
  contact_person?: string;
  contact_number?: string;
  email?: string;
  status: string;
  facility_count?: number;
}

export interface Facility {
  id: number;
  dealer_id: number;
  facility_name: string;
  facility_type: string;
  address?: string;
  status: string;
  attributes: Record<string, boolean>;
}

export interface AssessmentSummary {
  total: number;
  applicable: number;
  na: number;
  unconfigured: number;
  completedApplicable: number;
  compliant: number;
  nonCompliant: number;
  partial: number;
  notAssessed: number;
  openFindings: number;
  compliancePercent: number;
  byRisk: Record<string, number>;
  riskPercent: Record<string, number>;
}

export interface ChecklistItem {
  id: number;
  checklist_item_id: number;
  item_number: number;
  activity_description: string;
  requirement_description: string;
  applicability_status: string;
  applicability_snapshot: { reason?: string; review?: boolean } | null;
  response_code: string | null;
  observation: string | null;
  recommendation: string | null;
  risk_rating_id: number | null;
  risk_name?: string;
  remarks: string | null;
  review_remarks: string | null;
  locked_na: boolean;
  source_review: boolean;
  attachments: { id: number; file_name: string; file_type?: string | null }[];
}

export interface ChecklistSection {
  id: number;
  code: string;
  name: string;
  items: ChecklistItem[];
}
