import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { errorText, ToastService } from '../core/toast.service';

@Component({
  selector: 'app-masters',
  imports: [FormsModule],
  templateUrl: './masters.component.html'
})
export class MastersComponent {
  private http = inject(HttpClient);
  private toast = inject(ToastService);
  panel = signal('dealers');
  dealers = signal<Record<string, string | number>[]>([]);
  facilities = signal<Record<string, unknown>[]>([]);
  items = signal<Record<string, string | number | boolean>[]>([]);
  rules = signal<Record<string, string | number | boolean>[]>([]);
  risks = signal<Record<string, string | number | boolean>[]>([]);
  users = signal<Record<string, string | number>[]>([]);
  roles = signal<{ id: number; name: string }[]>([]);
  types = signal<Record<string, string | number | boolean>[]>([]);
  query = '';
  facilityType = '3S';
  editing = signal<Record<string, unknown> | null>(null);
  attributes = [
    ['has_transformer', 'Transformer'], ['has_oil_transformer', 'Oil-filled transformer'], ['has_dry_transformer', 'Dry-type transformer'],
    ['has_dp_structure', 'Double pole structure'], ['has_dg_set', 'DG set'], ['has_compressor', 'Compressor'],
    ['has_paint_booth', 'Paint booth'], ['has_paint_mixing', 'Paint mixing'], ['has_service', 'Service'],
    ['has_lifts', 'Hydraulic lifts'], ['has_store', 'Store'], ['has_server_room', 'Server room'],
    ['has_portable_tools', 'Portable tools'], ['has_lead_acid_batteries', 'Lead-acid batteries']
  ];

  constructor() { this.reload(); }

  reload() {
    this.http.get<Record<string, string | number>[]>('/api/admin/dealers').subscribe({ next: (rows) => this.dealers.set(rows) });
    this.http.get<Record<string, unknown>[]>('/api/admin/facilities').subscribe({ next: (rows) => this.facilities.set(rows) });
    this.http.get<Record<string, string | number | boolean>[]>('/api/admin/items').subscribe({ next: (rows) => this.items.set(rows) });
    this.http.get<Record<string, string | number | boolean>[]>('/api/admin/applicability').subscribe({ next: (rows) => this.rules.set(rows) });
    this.http.get<Record<string, string | number | boolean>[]>('/api/admin/risk-ratings').subscribe({ next: (rows) => this.risks.set(rows) });
    this.http.get<Record<string, string | number>[]>('/api/admin/users').subscribe({ next: (rows) => this.users.set(rows) });
    this.http.get<{ id: number; name: string }[]>('/api/admin/roles').subscribe({ next: (rows) => this.roles.set(rows) });
    this.http.get<Record<string, string | number | boolean>[]>('/api/admin/assessment-types').subscribe({ next: (rows) => this.types.set(rows) });
  }

  filteredItems() {
    const q = this.query.trim().toLowerCase();
    return this.items().filter((row) => !q || `${row['item_number']} ${row['activity_description']}`.toLowerCase().includes(q)).slice(0, 40);
  }

  filteredRules() {
    return this.rules().filter((row) => row['facility_type'] === this.facilityType).slice(0, 40);
  }

  newDealer() {
    this.editing.set({ kind: 'dealer', status: 'Active', dealer_code: '', dealer_name: '', address: '', city: '', state: '', region: 'North' });
  }

  newFacility() {
    this.editing.set({ kind: 'facility', status: 'Active', facility_type: '3S', facility_name: '', dealer_id: this.dealers()[0]?.['id'] || null, attributes: {} });
  }

  newUser() {
    this.editing.set({ kind: 'user', status: 'Active', role_id: this.roles()[0]?.id || null, name: '', email: '', password: '' });
  }

  newType() {
    this.editing.set({ kind: 'type', code: '', name: '', description: '', active_status: true, approval_status: 'Draft' });
  }

  editDealer(row: Record<string, string | number>) { this.editing.set({ kind: 'dealer', ...row }); }
  editItem(row: Record<string, string | number | boolean>) { this.editing.set({ kind: 'item', ...row }); }

  attrOn(code: string): boolean {
    const attrs = (this.editing()?.['attributes'] || {}) as Record<string, boolean>;
    return !!attrs[code];
  }

  toggleAttr(code: string, checked: boolean) {
    const editing = this.editing();
    if (!editing) return;
    const attrs = { ...((editing['attributes'] as Record<string, boolean>) || {}), [code]: checked };
    this.editing.set({ ...editing, attributes: attrs });
  }

  save() {
    const row = this.editing();
    if (!row) return;
    const kind = String(row['kind']);
    const id = row['id'];
    let url = '/api/admin/dealers';
    if (kind === 'facility') url = '/api/admin/facilities';
    if (kind === 'user') url = '/api/admin/users';
    if (kind === 'type') url = '/api/admin/assessment-types';
    if (kind === 'item') url = '/api/admin/items';
    const request = id
      ? this.http.put(`${url}/${id}`, row)
      : this.http.post(url, row);
    request.subscribe({
      next: () => { this.toast.show('Master record saved'); this.editing.set(null); this.reload(); },
      error: (err) => this.toast.show(errorText(err), 'bad')
    });
  }

  saveRule(row: Record<string, string | number | boolean>) {
    this.http.put(`/api/admin/applicability/${row['id']}`, row).subscribe({
      next: () => this.toast.show('Applicability updated. New assessments use this rule. Issued assessments keep their snapshot.'),
      error: (err) => this.toast.show(errorText(err), 'bad')
    });
  }

  text(row: Record<string, unknown> | null, key: string): string {
    return String(row?.[key] ?? '');
  }

  setText(key: string, value: string | number) {
    const editing = this.editing();
    if (!editing) return;
    this.editing.set({ ...editing, [key]: value });
  }
}
