import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Dealer, Facility } from '../core/models';
import { errorText, ToastService } from '../core/toast.service';

interface TypeRow { id: number; name: string; code: string; template_id: number; version: string; description: string; }

@Component({
  selector: 'app-new-assessment',
  imports: [FormsModule],
  templateUrl: './new-assessment.component.html'
})
export class NewAssessmentComponent {
  private http = inject(HttpClient);
  private router = inject(Router);
  private toast = inject(ToastService);
  types = signal<TypeRow[]>([]);
  dealers = signal<Dealer[]>([]);
  facilities = signal<Facility[]>([]);
  typeId: number | null = null;
  dealerQuery = '';
  dealerId: number | null = null;
  facilityId: number | null = null;
  assessmentDate = new Date().toISOString().slice(0, 10);
  referenceNumber = '';
  previousReference = '';
  generalRemarks = '';
  error = signal('');
  busy = signal(false);
  labels: Record<string, string> = { '1S': 'Sales', '2S': 'Service and spares', '3S': 'Sales, service and spares' };

  constructor() {
    this.http.get<{ assessmentTypes: TypeRow[] }>('/api/assessments/meta').subscribe({
      next: (meta) => {
        this.types.set(meta.assessmentTypes.filter((row) => row.template_id));
        if (this.types().length) this.typeId = this.types()[0].id;
      }
    });
  }

  searchDealers() {
    this.http.get<Dealer[]>('/api/assessments/dealers', { params: { q: this.dealerQuery } }).subscribe({
      next: (rows) => this.dealers.set(rows),
      error: (err) => this.error.set(errorText(err))
    });
  }

  chooseDealer(dealer: Dealer) {
    this.dealerId = dealer.id;
    this.facilityId = null;
    this.http.get<{ facilities: Facility[] }>(`/api/assessments/dealers/${dealer.id}`).subscribe({
      next: (data) => {
        this.facilities.set(data.facilities.filter((row) => row.status === 'Active'));
        if (this.facilities().length === 1) this.facilityId = this.facilities()[0].id;
      }
    });
  }

  selectedDealer(): Dealer | undefined {
    return this.dealers().find((row) => row.id === this.dealerId);
  }

  selectedFacility(): Facility | undefined {
    return this.facilities().find((row) => row.id === this.facilityId);
  }

  attributeList(facility: Facility): string[] {
    return Object.entries(facility.attributes).filter(([, value]) => value).map(([key]) => key.replace('has_', '').replaceAll('_', ' '));
  }

  create() {
    this.error.set('');
    if (!this.typeId || !this.dealerId || !this.facilityId || !this.assessmentDate) {
      this.error.set('Assessment type, dealer, facility and date are required.');
      return;
    }
    this.busy.set(true);
    this.http.post<{ id: number; unconfigured: number }>('/api/assessments', {
      assessmentTypeId: this.typeId,
      dealerId: this.dealerId,
      facilityId: this.facilityId,
      assessmentDate: this.assessmentDate,
      referenceNumber: this.referenceNumber,
      previousReference: this.previousReference,
      generalRemarks: this.generalRemarks
    }).subscribe({
      next: (row) => {
        if (row.unconfigured) this.toast.show(`${row.unconfigured} items have no applicability rule and were left unanswered.`, 'bad');
        else this.toast.show('Assessment created. Applicable items are blank. NA items are locked.');
        void this.router.navigate(['/assessments', row.id]);
      },
      error: (err) => { this.error.set(errorText(err)); this.busy.set(false); }
    });
  }
}
