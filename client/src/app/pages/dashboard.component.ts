import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { errorText, ToastService } from '../core/toast.service';

interface Dash {
  totals: { total: number; draft: number; in_progress: number; submitted: number; returned: number; approved: number };
  findings: { findings: number; critical: number; major: number };
  byFacility: { facility_type: string; total: number }[];
  byDealer: { dealer_name: string; dealer_code: string; total: number }[];
  trend: { month: string; total: number }[];
  recent: { id: number; assessment_number: string; status: string; assessment_date: string; facility_type_snapshot: string; dealer_name: string; dealer_code: string }[];
}

@Component({
  selector: 'app-dashboard',
  imports: [FormsModule, RouterLink],
  templateUrl: './dashboard.component.html'
})
export class DashboardComponent {
  private http = inject(HttpClient);
  private toast = inject(ToastService);
  data = signal<Dash | null>(null);
  loading = signal(true);
  failed = signal('');
  filters = { from: '', to: '', facilityType: '', status: '' };

  constructor() { this.load(); }

  load() {
    this.loading.set(true);
    this.failed.set('');
    let params = new HttpParams();
    Object.entries(this.filters).forEach(([key, value]) => { if (value) params = params.set(key, value); });
    this.http.get<Dash>('/api/dashboard', { params }).subscribe({
      next: (data) => { this.data.set(data); this.loading.set(false); },
      error: (err) => { this.failed.set(errorText(err)); this.loading.set(false); this.toast.show(errorText(err), 'bad'); }
    });
  }

  maxOf(rows: { total: number }[]): number {
    return Math.max(1, ...rows.map((row) => Number(row.total)));
  }

  day(value: string): string {
    return value ? String(value).slice(0, 10) : '';
  }
}
