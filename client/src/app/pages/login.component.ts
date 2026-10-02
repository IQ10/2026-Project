import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { errorText } from '../core/toast.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  templateUrl: './login.component.html'
})
export class LoginComponent {
  private auth = inject(AuthService);
  private router = inject(Router);
  email = 'saurabh.vishwakarma@bureauveritas.demo';
  password = 'Surveyor@123';
  error = signal('');
  busy = signal(false);
  roles = [
    { role: 'Surveyor', name: 'Saurabh Kumar Vishwakarma', email: 'saurabh.vishwakarma@bureauveritas.demo', password: 'Surveyor@123' },
    { role: 'Reviewer', name: 'Pramod S. Uranakar', email: 'pramod.uranakar@bureauveritas.demo', password: 'Reviewer@123' },
    { role: 'Administrator', name: 'ESA Administrator', email: 'admin@bureauveritas.demo', password: 'Admin@123' },
    { role: 'Management', name: 'TKM Management', email: 'management@tkm.demo', password: 'Viewer@123' }
  ];

  constructor() {
    if (this.auth.token()) void this.router.navigateByUrl('/dashboard');
  }

  use(role: { email: string; password: string }) {
    this.email = role.email;
    this.password = role.password;
    this.submit();
  }

  submit() {
    this.busy.set(true);
    this.error.set('');
    this.auth.login(this.email, this.password).subscribe({
      next: () => void this.router.navigateByUrl('/dashboard'),
      error: (err) => { this.error.set(errorText(err)); this.busy.set(false); }
    });
  }
}
