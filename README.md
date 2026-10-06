# ESA Desk

Electrical Safety Assessment management for automobile dealerships. Surveyors complete a checklist, facility type decides which items apply, and approved reports keep a snapshot of the dealer, template and applicability used on the day of the visit.

The first template is the electrical safety checklist from the Sunny Toyota, Agra (AG02A) 3S assessment of 23 December 2025. A second assessment type, Fire Safety Assessment, is master data so a new type does not require a new engine.

## Run locally

The API is an ASP.NET Core service in `api`. It uses the same SQL Server database and the same `/api` routes as the Angular app.

1. Install the [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0). SQL Server must already be running.

2. In SQL Server Management Studio, run these scripts in order:

1. `database/001_schema.sql` creates the empty database and tables.
2. `database/002_data.sql` fills dealers, the checklist, users, and the three sample assessments.

3. Point the API at SQL Server. Create `api\.env`:

```
DB_SERVER=localhost
DB_PORT=1433
DB_USER=sa
DB_PASSWORD=Esa@Sql#2026!
DB_NAME=EsaManagement
```

Use the TCP port for your instance. Do not put `SQLEXPRESS` in `DB_SERVER`. On Windows Command Prompt, do not use `export`.

4. Start the API:

```bat
cd api
dotnet run
```

It listens on port **4317**. Browse http://127.0.0.1:4317/api/health . A working service returns `{"ok":true,"database":"SQL Server"}`.

5. Start the Angular app:

```bat
cd client
npm install
npx ng serve --port 4318
```

Open http://127.0.0.1:4318 . The dev server proxies `/api` to port 4317.

To use another port, set `PORT` before `dotnet run`, for example `set PORT=3000`.

## Host the API in IIS

Stop any Node `npm start` window and any PM2 process that is using the API port. IIS hosts the .NET service directly.

1. Install the [.NET 8 Hosting Bundle](https://dotnet.microsoft.com/download/dotnet/8.0) and restart IIS (`iisreset`).
2. Publish the service:

```bat
cd api
dotnet publish -c Release -o C:\inetpub\esa-api
```

3. Copy `api\.env` into `C:\inetpub\esa-api` so the site can read the SQL login.
4. In IIS Manager, add an application pool named `EsaApi`. Set **.NET CLR version** to **No Managed Code**.
5. Add a website named `EsaApi`. Set the physical path to `C:\inetpub\esa-api`, the binding to the port you want (for example **3000**), and the application pool to `EsaApi`.
6. Browse `http://127.0.0.1:3000/api/health`.

The Angular IIS site stays separate. Its `web.config` forwards `/api` to this site, for example `http://192.168.1.111:3000/api/{R:1}`.

The `server` folder is the earlier Node API. It is not the service to host. `npm run seed` in that folder can still reload sample data when the `database` folder sits next to it.

## Sign-in

| Role | Email | Password |
| --- | --- | --- |
| Surveyor | saurabh.vishwakarma@bureauveritas.demo | Surveyor@123 |
| Reviewer | pramod.uranakar@bureauveritas.demo | Reviewer@123 |
| Administrator | admin@bureauveritas.demo | Admin@123 |
| Management | management@tkm.demo | Viewer@123 |

The seeded approved assessment `ESA-AG02A-2025-001` is the Sunny Toyota visit. Compliance on applicable items is 61.88 percent, matching the report risk mix (critical 6.25, major 26.25, minor 5.63, no risk 61.88) with the five not-applicable items left out of the denominator.

## What the facility type does

1S is sales, 2S is service and spares, 3S is sales, service and spares. Workshop sections are not applicable on a 1S showroom. Transformer, DG set, paint booth and similar areas are conditional on facility attributes. If a rule or a required attribute is missing, the item stays unanswered and is flagged. It is not silently marked NA.

Applicability for 1S and 2S is stored as master data and marked for administrator confirmation, because the source report is a single 3S visit and does not print a per-item matrix.

Seven checklist items are flagged where the scanned colour code and the wording do not agree. The original code is kept.

## Stack

Angular and TypeScript on the front end. A Node.js API with SQL Server. Checklist files are stored in the database. PDF and Excel reports are generated from the assessment snapshot.
