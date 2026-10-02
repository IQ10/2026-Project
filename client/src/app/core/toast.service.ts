import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ToastService {
  messages = signal<{ id: number; text: string; kind: string }[]>([]);

  show(text: string, kind = 'ok') {
    const id = Date.now() + Math.random();
    this.messages.update((rows) => [...rows, { id, text, kind }]);
    setTimeout(() => this.messages.update((rows) => rows.filter((row) => row.id !== id)), 3400);
  }
}

export function errorText(err: unknown): string {
  const body = (err as { error?: { error?: string } })?.error;
  return body?.error || 'The request could not be completed.';
}
