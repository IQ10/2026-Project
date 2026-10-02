import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { AssessmentSummary, ChecklistItem, ChecklistSection, Dealer } from '../core/models';
import { errorText, ToastService } from '../core/toast.service';

interface Detail {
  assessment: {
    id: number;
    assessment_number: string;
    assessment_type: string;
    template_version_snapshot: string;
    assessment_date: string;
    status: string;
    facility_type_snapshot: string;
    surveyor_name: string;
    surveyor_employee_id: string;
    reference_number: string | null;
    previous_reference: string | null;
    general_remarks: string | null;
    return_remarks: string | null;
    dealer_details_snapshot: Dealer;
    contact_person_snapshot: string;
    contact_number_snapshot: string;
    contact_email_snapshot: string;
  };
  summary: AssessmentSummary;
  sections: ChecklistSection[];
  narratives: { code: string; title: string; body: string }[];
  equipment: { equipment_type: string; label: string; identifier: string; rating: string }[];
  thermography: Record<string, string | number | null>[];
  loadBalance: Record<string, string | number | null>[];
  neutralEarth: Record<string, string | number | null>[];
  reviews: { action: string; remarks: string; user_name: string; created_at: string }[];
}

@Component({
  selector: 'app-workspace',
  imports: [FormsModule],
  templateUrl: './workspace.component.html'
})
export class WorkspaceComponent {
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private toast = inject(ToastService);
  auth = inject(AuthService);
  detail = signal<Detail | null>(null);
  failed = signal('');
  tab = signal('checklist');
  activeSection = signal(0);
  query = '';
  saveState = signal('Saved');
  errors = signal<{ itemNumber: number; message: string }[]>([]);
  risks = signal<{ id: number; code: string; name: string }[]>([]);
  options = signal<{ code: string; label: string; selectable_by_surveyor: boolean }[]>([]);
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor() {
    this.http.get<{ riskRatings: { id: number; code: string; name: string }[]; responseOptions: { code: string; label: string; selectable_by_surveyor: boolean }[] }>('/api/assessments/meta').subscribe({
      next: (meta) => { this.risks.set(meta.riskRatings); this.options.set(meta.responseOptions); }
    });
    this.load();
  }

  load() {
    const id = this.route.snapshot.paramMap.get('id');
    this.http.get<Detail>(`/api/assessments/${id}`).subscribe({
      next: (detail) => {
        detail.assessment.assessment_date = String(detail.assessment.assessment_date).slice(0, 10);
        this.detail.set(detail);
        this.failed.set('');
      },
      error: (err) => this.failed.set(errorText(err))
    });
  }

  editable(): boolean {
    const status = this.detail()?.assessment.status;
    return !!status && ['Draft', 'In Progress', 'Returned'].includes(status) && (this.auth.has('assessments.create') || this.auth.has('masters.manage'));
  }

  sectionProgress(section: ChecklistSection): string {
    const applicable = section.items.filter((item) => item.applicability_status === 'Applicable');
    const done = applicable.filter((item) => item.response_code).length;
    return `${done}/${applicable.length}`;
  }

  visibleItems(section: ChecklistSection): ChecklistItem[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return section.items;
    return section.items.filter((item) => `${item.item_number} ${item.activity_description} ${item.requirement_description}`.toLowerCase().includes(q));
  }

  choose(item: ChecklistItem, code: string) {
    if (!this.editable() || item.locked_na) return;
    item.response_code = code;
    this.queue(item);
  }

  queue(item: ChecklistItem) {
    this.saveState.set('Saving…');
    const existing = this.timers.get(item.id);
    if (existing) clearTimeout(existing);
    this.timers.set(item.id, setTimeout(() => this.persist(item), 500));
  }

  persist(item: ChecklistItem) {
    const id = this.detail()?.assessment.id;
    this.http.put(`/api/assessments/${id}/responses/${item.id}`, {
      response_code: item.response_code,
      observation: item.observation,
      recommendation: item.recommendation,
      risk_rating_id: item.risk_rating_id,
      remarks: item.remarks
    }).subscribe({
      next: () => this.saveState.set('Saved'),
      error: (err) => { this.saveState.set('Not saved'); this.toast.show(errorText(err), 'bad'); }
    });
  }

  saveHeader() {
    const assessment = this.detail()?.assessment;
    if (!assessment) return;
    this.http.put(`/api/assessments/${assessment.id}`, assessment).subscribe({
      next: () => this.toast.show('Header saved'),
      error: (err) => this.toast.show(errorText(err), 'bad')
    });
  }

  submit() {
    if (!confirm('Submit this assessment for review? Required answers must be complete.')) return;
    const id = this.detail()?.assessment.id;
    this.http.post(`/api/assessments/${id}/submit`, {}).subscribe({
      next: () => { this.toast.show('Submitted for review'); this.errors.set([]); this.load(); },
      error: (err) => {
        const body = (err as { error?: { errors?: { itemNumber: number; message: string }[] } }).error;
        this.errors.set(body?.errors || []);
        this.toast.show(errorText(err), 'bad');
      }
    });
  }

  review(action: 'return' | 'approve' | 'reopen') {
    const id = this.detail()?.assessment.id;
    const promptText = action === 'approve' ? 'Approval remarks (optional)' : 'Reason';
    const remarks = prompt(promptText) || '';
    if (action !== 'approve' && !remarks.trim()) return;
    const path = action === 'return' ? 'return' : action === 'approve' ? 'approve' : 'reopen';
    const payload = action === 'reopen' ? { reason: remarks } : { remarks };
    this.http.post(`/api/assessments/${id}/${path}`, payload).subscribe({
      next: () => { this.toast.show(action === 'approve' ? 'Assessment approved' : 'Assessment updated'); this.load(); },
      error: (err) => this.toast.show(errorText(err), 'bad')
    });
  }

  override(item: ChecklistItem, notApplicable: boolean) {
    const reason = prompt('Why is this applicability being overridden?');
    if (!reason) return;
    const id = this.detail()?.assessment.id;
    this.http.post(`/api/assessments/${id}/responses/${item.id}/override`, { reason, notApplicable }).subscribe({
      next: () => { this.toast.show('Applicability override recorded'); this.load(); },
      error: (err) => this.toast.show(errorText(err), 'bad')
    });
  }

  upload(item: ChecklistItem, event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const data = new FormData();
    data.append('file', file);
    data.append('checklist_item_id', String(item.checklist_item_id));
    const id = this.detail()?.assessment.id;
    this.http.post<{ id: number; file_name: string }>(`/api/assessments/${id}/attachments`, data).subscribe({
      next: (row) => { item.attachments = [...item.attachments, row]; this.toast.show('File stored with the assessment'); },
      error: (err) => this.toast.show(errorText(err), 'bad')
    });
  }

  openFile(attachmentId: number) {
    const id = this.detail()?.assessment.id;
    this.http.get(`/api/assessments/${id}/attachments/${attachmentId}`, { responseType: 'blob' }).subscribe({
      next: (blob) => window.open(URL.createObjectURL(blob), '_blank')
    });
  }

  download(kind: 'pdf' | 'xlsx') {
    const assessment = this.detail()?.assessment;
    if (!assessment) return;
    this.http.get(`/api/reports/${assessment.id}/${kind}`, { responseType: 'blob' }).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${assessment.assessment_number}.${kind === 'pdf' ? 'pdf' : 'xlsx'}`;
        link.click();
        URL.revokeObjectURL(url);
      },
      error: () => this.toast.show('Report could not be generated.', 'bad')
    });
  }

  saveNarrative(row: { code: string; title: string; body: string }) {
    const id = this.detail()?.assessment.id;
    this.http.put(`/api/assessments/${id}/narratives/${row.code}`, row).subscribe({
      next: () => this.toast.show('Narrative saved'),
      error: (err) => this.toast.show(errorText(err), 'bad')
    });
  }

  addNarrative() {
    const detail = this.detail();
    if (!detail) return;
    detail.narratives.push({ code: `note-${detail.narratives.length + 1}`, title: 'Note', body: '' });
  }

  saveMeasurements() {
    const detail = this.detail();
    if (!detail) return;
    this.http.put(`/api/assessments/${detail.assessment.id}/measurements`, {
      thermography: detail.thermography, loadBalance: detail.loadBalance, neutralEarth: detail.neutralEarth, equipment: detail.equipment
    }).subscribe({
      next: () => this.toast.show('Measurements saved'),
      error: (err) => this.toast.show(errorText(err), 'bad')
    });
  }

  addRow(kind: 'thermography' | 'loadBalance' | 'neutralEarth' | 'equipment') {
    const detail = this.detail();
    if (!detail) return;
    if (kind === 'thermography') detail.thermography.push({ area: '', equipment: '', location: '', ambient_c: null, hotspot_c: null, delta_c: null, severity: '' });
    if (kind === 'loadBalance') detail.loadBalance.push({ area: '', equipment: '', l1_a: null, l2_a: null, l3_a: null, finding: '', recommendation: '' });
    if (kind === 'neutralEarth') detail.neutralEarth.push({ area: '', equipment: '', voltage_v: null });
    if (kind === 'equipment') detail.equipment.push({ equipment_type: '', label: '', identifier: '', rating: '' });
  }

  saveReview(item: ChecklistItem) {
    const id = this.detail()?.assessment.id;
    this.http.put(`/api/assessments/${id}/responses/${item.id}/review`, { review_remarks: item.review_remarks }).subscribe({
      next: () => this.toast.show('Review remark saved'),
      error: (err) => this.toast.show(errorText(err), 'bad')
    });
  }

  jump(itemNumber: number) {
    const detail = this.detail();
    if (!detail) return;
    const index = detail.sections.findIndex((section) => section.items.some((item) => item.item_number === itemNumber));
    if (index >= 0) { this.activeSection.set(index); this.tab.set('checklist'); }
  }
}
