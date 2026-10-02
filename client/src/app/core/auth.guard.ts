import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  if (auth.token() && auth.user()) return true;
  return inject(Router).createUrlTree(['/login']);
};

export function permGuard(permission: string): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    if (auth.has(permission)) return true;
    return inject(Router).createUrlTree(['/dashboard']);
  };
}
