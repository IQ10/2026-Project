import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { errorText, ToastService } from '../core/toast.service';

interface Flag { severity: string; itemNumber?: number; message: string; }

@Component({
  selector: 'app-import',
  imports: [FormsModule],
  templateUrl: './import.component.html'
})
export class ImportComponent {
  private http = inject(HttpClient);
  private toast = inject(ToastService);
  flags = signal<Flag[]>([]);
  preview = signal<{ items: number; sections: number; ready: boolean; flags: Flag[] } | null>(null);
  raw = `[
  {"section":"Means of egress","item_number":1,"activity":"Exit signs are visible","requirement":"Exit signs should be readable from the approach.","applicability":{"1S":"Applicable","2S":"Applicable","3S":"Applicable"}}
]`;
  loading = signal(false);

  validate() {
    this.loading.set(true);
    this.http.get<{ flags: Flag[] }>('/api/admin/import/validate').subscribe({
      next: (result) => { this.flags.set(result.flags); this.loading.set(false); },
      error: (err) => { this.toast.show(errorText(err), 'bad'); this.loading.set(false); }
    });
  }

  runPreview() {
    let items: unknown;
    try { items = JSON.parse(this.raw); } catch { this.toast.show('That text is not valid JSON.', 'bad'); return; }
    this.http.post<{ items: number; sections: number; ready: boolean; flags: Flag[] }>('/api/admin/import/preview', { items }).subscribe({
      next: (result) => this.preview.set(result),
      error: (err) => this.toast.show(errorText(err), 'bad')
    });
  }

  commit() {
    let items: unknown;
    try { items = JSON.parse(this.raw); } catch { return; }
    if (!confirm('Import these items as a new draft template version?')) return;
    this.http.post('/api/admin/import/commit', { items, assessmentTypeCode: 'FSA' }).subscribe({
      next: () => this.toast.show('Draft template imported. Approve it in master data before surveyors use it.'),
      error: (err) => this.toast.show(errorText(err), 'bad')
    });
  }
}
