import { Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { errorText } from '../core/toast.service';

interface AuditRow { id: number; created_at: string; user_name: string; entity_type: string; entity_id: string; action: string; new_value: string; }

@Component({
  selector: 'app-audit',
  templateUrl: './audit.component.html'
})
export class AuditComponent {
  private http = inject(HttpClient);
  rows = signal<AuditRow[]>([]);
  failed = signal('');
  constructor() {
    this.http.get<AuditRow[]>('/api/audit').subscribe({
      next: (rows) => this.rows.set(rows),
      error: (err) => this.failed.set(errorText(err))
    });
  }
}
