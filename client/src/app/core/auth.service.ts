import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { tap } from 'rxjs';
import { SessionUser } from './models';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);
  user = signal<SessionUser | null>(this.read());

  token(): string | null {
    return localStorage.getItem('esa_token');
  }

  has(permission: string): boolean {
    return !!this.user()?.permissions.includes(permission);
  }

  login(email: string, password: string) {
    return this.http.post<{ token: string; user: SessionUser }>('/api/auth/login', { email, password }).pipe(
      tap((result) => {
        localStorage.setItem('esa_token', result.token);
        localStorage.setItem('esa_user', JSON.stringify(result.user));
        this.user.set(result.user);
      })
    );
  }

  logout() {
    localStorage.removeItem('esa_token');
    localStorage.removeItem('esa_user');
    this.user.set(null);
    void this.router.navigateByUrl('/login');
  }

  private read(): SessionUser | null {
    const raw = localStorage.getItem('esa_user');
    if (!raw) return null;
    try { return JSON.parse(raw) as SessionUser; } catch { return null; }
  }
}
