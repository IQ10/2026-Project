import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { errorText } from '../core/toast.service';

interface Row {
  id: number;
  assessment_number: string;
  assessment_date: string;
  status: string;
  facility_type_snapshot: string;
  dealer_code: string;
  dealer_name: string;
  city: string;
  surveyor_name: string;
  assessment_type: string;
}

@Component({
  selector: 'app-assessments',
  imports: [FormsModule, RouterLink],
  templateUrl: './assessments.component.html'
})
export class AssessmentsComponent {
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  queue = false;
  rows = signal<Row[]>([]);
  loading = signal(true);
  failed = signal('');
  q = '';
  status = '';
  from = '';
  to = '';

  constructor() {
    this.queue = !!this.route.snapshot.data['queue'];
    if (this.queue) this.status = 'Submitted';
    this.load();
  }

  load() {
    this.loading.set(true);
    let params = new HttpParams();
    if (this.q) params = params.set('q', this.q);
    if (this.status) params = params.set('status', this.status);
    if (this.from) params = params.set('from', this.from);
    if (this.to) params = params.set('to', this.to);
    this.http.get<Row[]>('/api/assessments', { params }).subscribe({
      next: (rows) => { this.rows.set(rows); this.loading.set(false); this.failed.set(''); },
      error: (err) => { this.failed.set(errorText(err)); this.loading.set(false); }
    });
  }

  day(value: string): string { return String(value).slice(0, 10); }
}
