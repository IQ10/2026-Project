import { Routes } from '@angular/router';
import { authGuard, permGuard } from './core/auth.guard';
import { LoginComponent } from './pages/login.component';
import { ShellComponent } from './layout/shell.component';
import { DashboardComponent } from './pages/dashboard.component';
import { AssessmentsComponent } from './pages/assessments.component';
import { NewAssessmentComponent } from './pages/new-assessment.component';
import { WorkspaceComponent } from './pages/workspace.component';
import { MastersComponent } from './pages/masters.component';
import { ImportComponent } from './pages/import.component';
import { AuditComponent } from './pages/audit.component';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  {
    path: '',
    component: ShellComponent,
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'dashboard', component: DashboardComponent },
      { path: 'assessments', component: AssessmentsComponent },
      { path: 'assessments/new', component: NewAssessmentComponent },
      { path: 'assessments/:id', component: WorkspaceComponent },
      { path: 'review', component: AssessmentsComponent, data: { queue: true } },
      { path: 'masters', component: MastersComponent, canActivate: [permGuard('masters.manage')] },
      { path: 'import', component: ImportComponent, canActivate: [permGuard('masters.manage')] },
      { path: 'audit', component: AuditComponent, canActivate: [permGuard('audit.view')] }
    ]
  },
  { path: '**', redirectTo: '' }
];
