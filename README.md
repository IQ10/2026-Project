# ESA Desk

Electrical Safety Assessment management for automobile dealerships. Surveyors complete a checklist, facility type decides which items apply, and approved reports keep a snapshot of the dealer, template and applicability used on the day of the visit.

The first template is the electrical safety checklist from the Sunny Toyota, Agra (AG02A) 3S assessment of 23 December 2025. A second assessment type, Fire Safety Assessment, is master data so a new type does not require a new engine.

## Run locally

1. Start SQL Server and create the database with the script in `database/001_schema.sql`, or use the included container:

```bash
docker compose up -d
```

2. Point the API at that server. Defaults match the container:

```
DB_SERVER=127.0.0.1
DB_PORT=1433
DB_USER=sa
DB_PASSWORD=Esa@Sql#2026!
DB_NAME=EsaManagement
```

If SQL Server is already installed on your machine, set those variables to your instance and sign-in. The API does not create a login for you.

3. Load masters and the checklist.

In SQL Server Management Studio, open and run these two scripts in order:

1. `database/001_schema.sql` creates the empty database and tables.
2. `database/002_data.sql` fills dealers, the 165-item checklist, users, and the three sample assessments.

Or load the same data from the API folder:

```bash
cd server
npm install
npm run seed
npm start
```

4. Start the Angular app:

```bash
cd client
npm install
npx ng serve --port 4318 --host 0.0.0.0
```

Open http://127.0.0.1:4318 . The API listens on port 4317. The dev server proxies `/api` to it.

## Host the API in local IIS

The API is Node.js. IIS starts `node.exe` with `server/web.config`. Stop any `npm start` window first so port 4317 is free.

1. Install [Node.js](https://nodejs.org/) and, in IIS, install [HttpPlatformHandler](https://www.iis.net/downloads/microsoft/httpplatformhandler).
2. In the `server` folder run `npm install` once.
3. Edit `server/web.config` if your SQL login is not `sa` / `Esa@Sql#2026!`.
4. In IIS Manager, add an Application Pool named `EsaApi`. Set .NET CLR version to **No Managed Code**.
5. Add a Website named `EsaApi`. Set the physical path to the `server` folder, the binding to `http` and port **4317**, and the application pool to `EsaApi`.
6. Give the application pool identity permission to read the `server` folder and write to `server\logs`.
7. Browse http://127.0.0.1:4317/api/health . A working site returns `{"ok":true,"database":"SQL Server"}`.

If the health page fails, open the newest file in `server\logs`. The Angular app on port 4318 can keep using this IIS site because it still calls port 4317.

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
