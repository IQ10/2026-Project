using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;

namespace Esa.Api;

public static class AssessmentEndpoints
{
    private static readonly HashSet<string> Editable = new(StringComparer.Ordinal) { "Draft", "In Progress", "Returned" };
    private static readonly string[] AttributeCatalogue =
    [
        "has_transformer", "Transformer",
        "has_oil_transformer", "Oil-filled transformer",
        "has_dry_transformer", "Dry-type transformer",
        "has_dp_structure", "Double pole structure",
        "has_dg_set", "DG set",
        "has_compressor", "Compressor / pump house",
        "has_paint_booth", "Paint booth",
        "has_paint_mixing", "Paint mixing area",
        "has_service", "Service area",
        "has_lifts", "Hydraulic lifts",
        "has_store", "Store",
        "has_server_room", "Server room / UPS",
        "has_portable_tools", "Portable power tools",
        "has_lead_acid_batteries", "Lead-acid batteries"
    ];

    public static void Map(WebApplication app, Database db)
    {
        var group = app.MapGroup("/api/assessments");

        group.MapGet("/dealers", async (HttpContext ctx) =>
        {
            var user = Current(ctx);
            var q = $"%{(ctx.Request.Query["q"].ToString() ?? "").Trim()}%";
            var includeInactive = ctx.Request.Query["includeInactive"] == "1" && user.CanSeeAll;
            var status = includeInactive ? "1=1" : "d.status=N'Active'";
            await using var conn = db.Open();
            await conn.OpenAsync();
            var rows = await conn.QueryAsync($"""
                SELECT d.*, (SELECT COUNT(*) FROM facilities f WHERE f.dealer_id=d.id AND f.status=N'Active') AS facility_count
                FROM dealers d
                WHERE (@q = N'%%' OR d.dealer_code LIKE @q OR d.dealer_name LIKE @q OR d.city LIKE @q)
                  AND ({status})
                ORDER BY d.dealer_name
                """, new { q });
            return Results.Json(Rows.List(rows));
        });

        group.MapGet("/dealers/{id:int}", async (int id) =>
        {
            await using var conn = db.Open();
            await conn.OpenAsync();
            var dealer = Rows.One(await conn.QueryAsync("SELECT * FROM dealers WHERE id=@id", new { id }));
            if (dealer == null) throw new ApiException(404, "Dealer not found.");
            var facilities = Rows.List(await conn.QueryAsync("""
                SELECT f.*, a.attribute_code, a.attribute_value
                FROM facilities f
                LEFT JOIN facility_attributes a ON a.facility_id=f.id
                WHERE f.dealer_id=@id
                ORDER BY f.facility_name
                """, new { id }));
            var map = new Dictionary<int, Dictionary<string, object?>>();
            foreach (var row in facilities)
            {
                var facilityId = Rows.Int(row, "id");
                if (!map.TryGetValue(facilityId, out var facility))
                {
                    facility = new Dictionary<string, object?>
                    {
                        ["id"] = facilityId,
                        ["dealer_id"] = Rows.Int(row, "dealer_id"),
                        ["facility_name"] = Rows.Str(row, "facility_name"),
                        ["facility_type"] = Rows.Str(row, "facility_type"),
                        ["address"] = Rows.Str(row, "address"),
                        ["status"] = Rows.Str(row, "status"),
                        ["effective_from"] = row.GetValueOrDefault("effective_from"),
                        ["effective_to"] = row.GetValueOrDefault("effective_to"),
                        ["attributes"] = new Dictionary<string, bool>()
                    };
                    map[facilityId] = facility;
                }
                var code = Rows.Str(row, "attribute_code");
                if (!string.IsNullOrEmpty(code))
                    ((Dictionary<string, bool>)facility["attributes"]!)[code] = row.GetValueOrDefault("attribute_value") is true;
            }
            return Results.Json(new Dictionary<string, object?> { ["dealer"] = dealer, ["facilities"] = map.Values.ToList() });
        });

        group.MapGet("/meta", async () =>
        {
            await using var conn = db.Open();
            await conn.OpenAsync();
            var types = Rows.List(await conn.QueryAsync("""
                SELECT t.*, tpl.id AS template_id, tpl.version FROM assessment_types t
                OUTER APPLY (SELECT TOP 1 id, version FROM assessment_templates WHERE assessment_type_id=t.id AND status=N'Active' AND approval_status=N'Approved' ORDER BY id DESC) tpl
                WHERE t.active_status=1 ORDER BY t.name
                """));
            var risks = Rows.List(await conn.QueryAsync("SELECT * FROM risk_ratings WHERE active_status=1 ORDER BY display_order"));
            var options = Rows.List(await conn.QueryAsync("""
                SELECT o.*, t.code AS response_type_code FROM response_options o
                INNER JOIN response_types t ON t.id=o.response_type_id WHERE o.active_status=1 ORDER BY o.display_order
                """));
            var lookups = Rows.List(await conn.QueryAsync("SELECT * FROM lookups WHERE active_status=1 ORDER BY category, display_order"));
            var settingsRows = Rows.List(await conn.QueryAsync("SELECT * FROM system_settings"));
            var settings = new Dictionary<string, object?>();
            foreach (var row in settingsRows) settings[Rows.Str(row, "setting_key") ?? ""] = Rows.Str(row, "setting_value");
            var catalogue = new List<string[]>();
            for (var i = 0; i < AttributeCatalogue.Length; i += 2) catalogue.Add([AttributeCatalogue[i], AttributeCatalogue[i + 1]]);
            return Results.Json(new Dictionary<string, object?>
            {
                ["assessmentTypes"] = types,
                ["riskRatings"] = risks,
                ["responseOptions"] = options,
                ["lookups"] = lookups,
                ["settings"] = settings,
                ["attributeCatalogue"] = catalogue
            });
        });

        group.MapGet("/", async (HttpContext ctx) =>
        {
            var user = Current(ctx);
            var p = new DynamicParameters();
            var where = new List<string>();
            if (!user.CanSeeAll)
            {
                p.Add("surveyorId", user.SurveyorId ?? 0);
                where.Add("a.surveyor_id=@surveyorId");
            }
            AddFilter(ctx, p, where, "status", "a.status=@status");
            if (!string.IsNullOrEmpty(ctx.Request.Query["q"]))
            {
                p.Add("q", $"%{ctx.Request.Query["q"]}%");
                where.Add("(a.assessment_number LIKE @q OR d.dealer_code LIKE @q OR d.dealer_name LIKE @q)");
            }
            AddFilter(ctx, p, where, "from", "a.assessment_date>=@from");
            AddFilter(ctx, p, where, "to", "a.assessment_date<=@to");
            AddFilter(ctx, p, where, "facilityType", "a.facility_type_snapshot=@ft", "ft");
            if (int.TryParse(ctx.Request.Query["assessmentTypeId"], out var typeId))
            {
                p.Add("typeId", typeId);
                where.Add("a.assessment_type_id=@typeId");
            }
            var sql = $"""
                SELECT a.id, a.assessment_number, a.assessment_date, a.status, a.facility_type_snapshot, a.reference_number,
                       a.submitted_at, a.approved_at, a.updated_at, t.name AS assessment_type, tpl.version,
                       d.dealer_code, d.dealer_name, d.city, s.name AS surveyor_name
                FROM assessments a
                INNER JOIN dealers d ON d.id=a.dealer_id
                INNER JOIN assessment_types t ON t.id=a.assessment_type_id
                INNER JOIN assessment_templates tpl ON tpl.id=a.template_id
                INNER JOIN surveyors s ON s.id=a.surveyor_id
                {(where.Count == 0 ? "" : "WHERE " + string.Join(" AND ", where))}
                ORDER BY a.updated_at DESC
                """;
            await using var conn = db.Open();
            await conn.OpenAsync();
            return Results.Json(Rows.List(await conn.QueryAsync(sql, p)));
        });

        group.MapPost("/", async (HttpContext ctx) =>
        {
            var user = Current(ctx);
            if (!user.Has("assessments.create")) throw new ApiException(403, "You do not have permission for this action.");
            var body = await JsonBody.Read(ctx.Request);
            if (JsonBody.Int(body, "assessmentTypeId") is not int assessmentTypeId) throw new ApiException(400, "Assessment type is required.");
            if (JsonBody.Int(body, "dealerId") is not int dealerId) throw new ApiException(400, "Dealer code is required.");
            if (JsonBody.Int(body, "facilityId") is not int facilityId) throw new ApiException(400, "Facility is required.");
            var assessmentDate = JsonBody.Str(body, "assessmentDate");
            if (string.IsNullOrWhiteSpace(assessmentDate)) throw new ApiException(400, "Assessment date is required.");
            if (user.SurveyorId is not int surveyorId) throw new ApiException(400, "Your user is not linked to a surveyor record.");

            await using var conn = db.Open();
            await conn.OpenAsync();
            await using var tx = (SqlTransaction)await conn.BeginTransactionAsync();
            try
            {
                var dealer = Rows.One(await conn.QueryAsync("SELECT * FROM dealers WHERE id=@id", new { id = dealerId }, tx));
                if (dealer == null) throw new ApiException(404, "Dealer not found.");
                if (Rows.Str(dealer, "status") != "Active" && !(JsonBody.Bool(body, "allowInactive") && user.Has("masters.manage")))
                    throw new ApiException(400, "This dealer is inactive. An administrator must permit the assessment.");
                var facility = Rows.One(await conn.QueryAsync("SELECT * FROM facilities WHERE id=@id AND dealer_id=@dealer", new { id = facilityId, dealer = dealerId }, tx));
                if (facility == null) throw new ApiException(400, "Select a facility that belongs to this dealer.");
                if (Rows.Str(facility, "status") != "Active" && !(JsonBody.Bool(body, "allowInactive") && user.Has("masters.manage")))
                    throw new ApiException(400, "This facility is inactive. An administrator must permit the assessment.");
                var facilityType = Rows.Str(facility, "facility_type") ?? "";
                var overrideType = JsonBody.Str(body, "facilityTypeOverride");
                if (!string.IsNullOrEmpty(overrideType) && overrideType != facilityType)
                {
                    if (!user.Has("masters.manage")) throw new ApiException(403, "Only an administrator can override the facility type.");
                    if (overrideType is not ("1S" or "2S" or "3S")) throw new ApiException(400, "Facility type must be 1S, 2S or 3S.");
                    facilityType = overrideType;
                }
                var typeInfo = Rows.One(await conn.QueryAsync("""
                    SELECT TOP 1 t.id AS type_id, tpl.id AS template_id, tpl.version
                    FROM assessment_types t
                    INNER JOIN assessment_templates tpl ON tpl.assessment_type_id=t.id
                    WHERE t.id=@id AND t.active_status=1 AND tpl.status=N'Active' AND tpl.approval_status=N'Approved'
                    ORDER BY tpl.id DESC
                    """, new { id = assessmentTypeId }, tx));
                if (typeInfo == null) throw new ApiException(400, "No approved active template exists for this assessment type.");
                var seq = await conn.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM assessments", transaction: tx) + 1;
                var prefix = await conn.ExecuteScalarAsync<string>("SELECT code FROM assessment_types WHERE id=@id", new { id = Rows.Int(typeInfo, "type_id") }, tx);
                var assessmentNumber = $"{prefix}-{Rows.Str(dealer, "dealer_code")}-{Text.Year(assessmentDate)}-{seq.ToString().PadLeft(3, '0')}";
                var snapshot = JsonSerializer.Serialize(new Dictionary<string, object?>
                {
                    ["dealer_code"] = Rows.Str(dealer, "dealer_code"),
                    ["dealer_name"] = Rows.Str(dealer, "dealer_name"),
                    ["dealer_group"] = Rows.Str(dealer, "dealer_group"),
                    ["address"] = Rows.Str(dealer, "address"),
                    ["city"] = Rows.Str(dealer, "city"),
                    ["state"] = Rows.Str(dealer, "state"),
                    ["region"] = Rows.Str(dealer, "region"),
                    ["postal_code"] = Rows.Str(dealer, "postal_code"),
                    ["contact_person"] = Rows.Str(dealer, "contact_person"),
                    ["contact_number"] = Rows.Str(dealer, "contact_number"),
                    ["email"] = Rows.Str(dealer, "email")
                });
                var assessmentId = await conn.ExecuteScalarAsync<int>("""
                    INSERT INTO assessments(assessment_number, assessment_type_id, template_id, dealer_id, facility_id, surveyor_id,
                        assessment_date, status, facility_type_snapshot, template_version_snapshot, dealer_details_snapshot,
                        reference_number, previous_reference, general_remarks, contact_person_snapshot, contact_number_snapshot,
                        contact_email_snapshot, created_by)
                    OUTPUT INSERTED.id
                    VALUES (@num,@type,@tpl,@dealer,@fac,@sur,@dt,N'Draft',@ft,@ver,@snap,@ref,@prev,@remarks,@person,@phone,@email,@by)
                    """, new
                {
                    num = assessmentNumber,
                    type = Rows.Int(typeInfo, "type_id"),
                    tpl = Rows.Int(typeInfo, "template_id"),
                    dealer = Rows.Int(dealer, "id"),
                    fac = Rows.Int(facility, "id"),
                    sur = surveyorId,
                    dt = DateTime.Parse(assessmentDate),
                    ft = facilityType,
                    ver = Rows.Str(typeInfo, "version"),
                    snap = snapshot,
                    @ref = JsonBody.Str(body, "referenceNumber"),
                    prev = JsonBody.Str(body, "previousReference"),
                    remarks = JsonBody.Str(body, "generalRemarks"),
                    person = Rows.Str(dealer, "contact_person"),
                    phone = Rows.Str(dealer, "contact_number"),
                    email = Rows.Str(dealer, "email"),
                    by = user.Id
                }, tx);
                var attrRows = Rows.List(await conn.QueryAsync("SELECT attribute_code, attribute_value FROM facility_attributes WHERE facility_id=@f", new { f = Rows.Int(facility, "id") }, tx));
                var attrMap = new Dictionary<string, bool>();
                foreach (var attr in attrRows)
                {
                    var code = Rows.Str(attr, "attribute_code");
                    if (!string.IsNullOrEmpty(code)) attrMap[code] = attr.GetValueOrDefault("attribute_value") is true;
                }
                var templateId = Rows.Int(typeInfo, "template_id");
                var items = Rows.List(await conn.QueryAsync("SELECT * FROM checklist_items WHERE template_id=@tpl AND active_status=1", new { tpl = templateId }, tx));
                var rules = Rows.List(await conn.QueryAsync("""
                    SELECT r.* FROM applicability_rules r INNER JOIN checklist_items i ON i.id=r.checklist_item_id
                    WHERE i.template_id=@tpl AND r.facility_type=@ft AND r.active_status=1
                    """, new { tpl = templateId, ft = facilityType }, tx));
                var ruleByItem = rules.ToDictionary(rule => Rows.Int(rule, "checklist_item_id"));
                var unconfigured = 0;
                foreach (var item in items)
                {
                    ruleByItem.TryGetValue(Rows.Int(item, "id"), out var rule);
                    var resolved = Applicability.Resolve(rule, attrMap);
                    if (resolved.Status == "Unconfigured") unconfigured++;
                    await conn.ExecuteAsync("""
                        INSERT INTO assessment_responses(assessment_id, checklist_item_id, response_code, applicability_status, applicability_snapshot, locked_na, source_review)
                        VALUES (@a,@i,@code,@app,@snap,@lock,@rev)
                        """, new
                    {
                        a = assessmentId,
                        i = Rows.Int(item, "id"),
                        code = resolved.Response,
                        app = resolved.Status,
                        snap = JsonSerializer.Serialize(Applicability.Snapshot(rule, resolved, facilityType)),
                        @lock = resolved.Locked,
                        rev = Rows.Flag(item, "source_review") || resolved.Review
                    }, tx);
                }
                await Audit.Write(conn, tx, user.Id, "assessment", assessmentId, "create", null, new Dictionary<string, object?> { ["assessmentNumber"] = assessmentNumber, ["facilityType"] = facilityType, ["unconfigured"] = unconfigured });
                await tx.CommitAsync();
                return Results.Json(new Dictionary<string, object?> { ["id"] = assessmentId, ["assessment_number"] = assessmentNumber, ["unconfigured"] = unconfigured }, statusCode: 201);
            }
            catch
            {
                try { await tx.RollbackAsync(); } catch { /* already closed */ }
                throw;
            }
        });

        group.MapGet("/{id:int}", async (HttpContext ctx, int id) => Results.Json(await LoadAssessment(db, id, Current(ctx))));

        group.MapPut("/{id:int}", async (HttpContext ctx, int id) =>
        {
            var user = Current(ctx);
            var body = await JsonBody.Read(ctx.Request);
            await using var conn = db.Open();
            await conn.OpenAsync();
            var current = await RequireEditable(conn, id, user);
            var date = JsonBody.Str(body, "assessment_date") ?? Text.Day(current.GetValueOrDefault("assessment_date"));
            var reference = JsonBody.Has(body, "reference_number") ? JsonBody.Str(body, "reference_number") : Rows.Str(current, "reference_number");
            var previous = JsonBody.Has(body, "previous_reference") ? JsonBody.Str(body, "previous_reference") : Rows.Str(current, "previous_reference");
            var remarks = JsonBody.Has(body, "general_remarks") ? JsonBody.Str(body, "general_remarks") : Rows.Str(current, "general_remarks");
            await conn.ExecuteAsync("UPDATE assessments SET assessment_date=@dt, reference_number=@ref, previous_reference=@prev, general_remarks=@remarks, updated_at=SYSUTCDATETIME() WHERE id=@id",
                new { id, dt = DateTime.Parse(date), @ref = reference, prev = previous, remarks });
            await Audit.Write(conn, null, user.Id, "assessment", id, "update-header", new Dictionary<string, object?>
            {
                ["assessment_date"] = current.GetValueOrDefault("assessment_date"),
                ["reference_number"] = Rows.Str(current, "reference_number"),
                ["general_remarks"] = Rows.Str(current, "general_remarks")
            }, body);
            return Results.Json(new Dictionary<string, object?> { ["ok"] = true });
        });

        group.MapPut("/{id:int}/responses/{responseId:int}", async (HttpContext ctx, int id, int responseId) =>
        {
            var user = Current(ctx);
            var body = await JsonBody.Read(ctx.Request);
            await using var conn = db.Open();
            await conn.OpenAsync();
            var current = await RequireEditable(conn, id, user);
            var row = Rows.One(await conn.QueryAsync("""
                SELECT r.*, i.risk_rating_enabled, o.requires_observation, o.requires_recommendation, o.requires_risk, o.selectable_by_surveyor
                FROM assessment_responses r
                INNER JOIN checklist_items i ON i.id=r.checklist_item_id
                LEFT JOIN response_options o ON o.code=r.response_code
                WHERE r.id=@id AND r.assessment_id=@a
                """, new { id = responseId, a = id }));
            if (row == null) throw new ApiException(404, "Checklist response not found.");
            var responseCode = JsonBody.Has(body, "response_code") ? (string.IsNullOrEmpty(JsonBody.Str(body, "response_code")) ? null : JsonBody.Str(body, "response_code")) : Rows.Str(row, "response_code");
            if (Rows.Flag(row, "locked_na")) responseCode = "NA";
            if (responseCode == "NA" && !Rows.Flag(row, "locked_na"))
                throw new ApiException(400, "NA is reserved for items the applicability rules mark as not applicable. Ask an administrator to record an override.");
            if (Rows.Str(row, "applicability_status") == "Unconfigured" && !string.IsNullOrEmpty(responseCode) && responseCode != "NA")
                throw new ApiException(400, "This item has no applicability rule. An administrator must configure it before a compliance answer is saved.");
            int? riskId = Rows.Flag(row, "locked_na") ? null : JsonBody.Has(body, "risk_rating_id") ? JsonBody.Int(body, "risk_rating_id") : (row.GetValueOrDefault("risk_rating_id") == null ? null : Rows.Int(row, "risk_rating_id"));
            if (riskId == 0) riskId = null;
            var observation = Rows.Flag(row, "locked_na") ? Rows.Str(row, "observation") : JsonBody.Has(body, "observation") ? JsonBody.Str(body, "observation") : Rows.Str(row, "observation");
            var recommendation = Rows.Flag(row, "locked_na") ? Rows.Str(row, "recommendation") : JsonBody.Has(body, "recommendation") ? JsonBody.Str(body, "recommendation") : Rows.Str(row, "recommendation");
            var remarks = JsonBody.Has(body, "remarks") ? JsonBody.Str(body, "remarks") : Rows.Str(row, "remarks");
            await conn.ExecuteAsync("UPDATE assessment_responses SET response_code=@code, observation=@obs, recommendation=@rec, risk_rating_id=@risk, remarks=@remarks, updated_at=SYSUTCDATETIME() WHERE id=@id",
                new { id = responseId, code = responseCode, obs = observation, rec = recommendation, risk = riskId, remarks });
            if (Rows.Str(current, "status") == "Draft")
                await conn.ExecuteAsync("UPDATE assessments SET status=N'In Progress', updated_at=SYSUTCDATETIME() WHERE id=@id", new { id });
            else
                await conn.ExecuteAsync("UPDATE assessments SET updated_at=SYSUTCDATETIME() WHERE id=@id", new { id });
            return Results.Json(new Dictionary<string, object?> { ["ok"] = true, ["response_code"] = responseCode });
        });

        group.MapPost("/{id:int}/responses/{responseId:int}/override", async (HttpContext ctx, int id, int responseId) =>
        {
            var user = Current(ctx);
            if (!user.Has("masters.manage")) throw new ApiException(403, "You do not have permission for this action.");
            var body = await JsonBody.Read(ctx.Request);
            var reason = (JsonBody.Str(body, "reason") ?? "").Trim();
            if (reason.Length == 0) throw new ApiException(400, "An override reason is required and is written to the audit log.");
            await using var conn = db.Open();
            await conn.OpenAsync();
            await RequireEditable(conn, id, user);
            var before = Rows.One(await conn.QueryAsync("SELECT * FROM assessment_responses WHERE id=@id AND assessment_id=@a", new { id = responseId, a = id }));
            if (before == null) throw new ApiException(404, "Checklist response not found.");
            var makeNa = JsonBody.Bool(body, "notApplicable");
            await conn.ExecuteAsync("""
                UPDATE assessment_responses SET applicability_status=@status, response_code=@code, locked_na=@lock,
                    risk_rating_id=CASE WHEN @lock=1 THEN NULL ELSE risk_rating_id END,
                    override_reason=@reason, overridden_by=@user, overridden_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME()
                WHERE id=@id
                """, new { id = responseId, status = makeNa ? "Not Applicable" : "Applicable", code = makeNa ? "NA" : null, @lock = makeNa, reason, user = user.Id });
            await Audit.Write(conn, null, user.Id, "assessment_response", responseId, "applicability-override", before, new Dictionary<string, object?> { ["makeNa"] = makeNa, ["reason"] = reason });
            return Results.Json(new Dictionary<string, object?> { ["ok"] = true });
        });

        group.MapPost("/{id:int}/submit", async (HttpContext ctx, int id) =>
        {
            var user = Current(ctx);
            var body = await JsonBody.Read(ctx.Request);
            await using var conn = db.Open();
            await conn.OpenAsync();
            var current = await RequireEditable(conn, id, user);
            var errors = await ValidateForSubmit(conn, id);
            if (errors.Count > 0) throw new ApiException(422, "Resolve the checklist before submission.", "errors", errors);
            await conn.ExecuteAsync("UPDATE assessments SET status=N'Submitted', submitted_at=SYSUTCDATETIME(), return_remarks=NULL, updated_at=SYSUTCDATETIME() WHERE id=@id", new { id });
            await conn.ExecuteAsync("INSERT INTO assessment_reviews(assessment_id, action, remarks, user_id) VALUES (@a, N'Submitted', @r, @u)", new { a = id, u = user.Id, r = JsonBody.Str(body, "remarks") });
            await Audit.Write(conn, null, user.Id, "assessment", id, "submit", new Dictionary<string, object?> { ["status"] = Rows.Str(current, "status") }, new Dictionary<string, object?> { ["status"] = "Submitted" });
            return Results.Json(new Dictionary<string, object?> { ["ok"] = true });
        });

        group.MapPut("/{id:int}/responses/{responseId:int}/review", async (HttpContext ctx, int id, int responseId) =>
        {
            var user = Current(ctx);
            if (!user.Has("assessments.review")) throw new ApiException(403, "You do not have permission for this action.");
            var body = await JsonBody.Read(ctx.Request);
            await using var conn = db.Open();
            await conn.OpenAsync();
            var current = await LoadHeader(conn, id) ?? throw new ApiException(404, "Assessment not found.");
            if (Rows.Str(current, "status") != "Submitted") throw new ApiException(400, "Review remarks are recorded while the assessment is submitted.");
            await conn.ExecuteAsync("UPDATE assessment_responses SET review_remarks=@r, updated_at=SYSUTCDATETIME() WHERE id=@id AND assessment_id=@a", new { id = responseId, a = id, r = JsonBody.Str(body, "review_remarks") });
            return Results.Json(new Dictionary<string, object?> { ["ok"] = true });
        });

        group.MapPost("/{id:int}/return", async (HttpContext ctx, int id) =>
        {
            var user = Current(ctx);
            if (!user.Has("assessments.review")) throw new ApiException(403, "You do not have permission for this action.");
            var body = await JsonBody.Read(ctx.Request);
            var remarks = (JsonBody.Str(body, "remarks") ?? "").Trim();
            if (remarks.Length == 0) throw new ApiException(400, "Tell the surveyor what to correct.");
            await using var conn = db.Open();
            await conn.OpenAsync();
            var current = await LoadHeader(conn, id) ?? throw new ApiException(404, "Assessment not found.");
            if (Rows.Str(current, "status") != "Submitted") throw new ApiException(400, "Only a submitted assessment can be returned.");
            await conn.ExecuteAsync("UPDATE assessments SET status=N'Returned', return_remarks=@r, updated_at=SYSUTCDATETIME() WHERE id=@id", new { id, r = remarks });
            await conn.ExecuteAsync("INSERT INTO assessment_reviews(assessment_id, action, remarks, user_id) VALUES (@a, N'Returned', @r, @u)", new { a = id, u = user.Id, r = remarks });
            await Audit.Write(conn, null, user.Id, "assessment", id, "return", new Dictionary<string, object?> { ["status"] = "Submitted" }, new Dictionary<string, object?> { ["status"] = "Returned", ["remarks"] = remarks });
            return Results.Json(new Dictionary<string, object?> { ["ok"] = true });
        });

        group.MapPost("/{id:int}/approve", async (HttpContext ctx, int id) =>
        {
            var user = Current(ctx);
            if (!user.Has("assessments.approve")) throw new ApiException(403, "You do not have permission for this action.");
            var body = await JsonBody.Read(ctx.Request);
            await using var conn = db.Open();
            await conn.OpenAsync();
            var current = await LoadHeader(conn, id) ?? throw new ApiException(404, "Assessment not found.");
            if (Rows.Str(current, "status") != "Submitted") throw new ApiException(400, "Only a submitted assessment can be approved.");
            var errors = await ValidateForSubmit(conn, id);
            if (errors.Count > 0) throw new ApiException(422, "This assessment still has validation errors.", "errors", errors);
            await conn.ExecuteAsync("UPDATE assessments SET status=N'Approved', approved_at=SYSUTCDATETIME(), reviewer_id=@u, updated_at=SYSUTCDATETIME() WHERE id=@id", new { id, u = user.Id });
            await conn.ExecuteAsync("INSERT INTO assessment_reviews(assessment_id, action, remarks, user_id) VALUES (@a, N'Approved', @r, @u)", new { a = id, u = user.Id, r = JsonBody.Str(body, "remarks") });
            await Audit.Write(conn, null, user.Id, "assessment", id, "approve", new Dictionary<string, object?> { ["status"] = "Submitted" }, new Dictionary<string, object?> { ["status"] = "Approved" });
            return Results.Json(new Dictionary<string, object?> { ["ok"] = true });
        });

        group.MapPost("/{id:int}/reopen", async (HttpContext ctx, int id) =>
        {
            var user = Current(ctx);
            if (!user.Has("assessments.reopen")) throw new ApiException(403, "You do not have permission for this action.");
            var body = await JsonBody.Read(ctx.Request);
            var reason = (JsonBody.Str(body, "reason") ?? "").Trim();
            if (reason.Length == 0) throw new ApiException(400, "A reopen reason is required.");
            await using var conn = db.Open();
            await conn.OpenAsync();
            var current = await LoadHeader(conn, id) ?? throw new ApiException(404, "Assessment not found.");
            if (Rows.Str(current, "status") != "Approved") throw new ApiException(400, "Only an approved assessment can be reopened.");
            await conn.ExecuteAsync("UPDATE assessments SET status=N'Returned', return_remarks=@r, approved_at=NULL, updated_at=SYSUTCDATETIME() WHERE id=@id", new { id, r = reason });
            await conn.ExecuteAsync("INSERT INTO assessment_reviews(assessment_id, action, remarks, user_id) VALUES (@a, N'Reopened', @r, @u)", new { a = id, u = user.Id, r = reason });
            await Audit.Write(conn, null, user.Id, "assessment", id, "reopen", new Dictionary<string, object?> { ["status"] = "Approved" }, new Dictionary<string, object?> { ["status"] = "Returned", ["reason"] = reason });
            return Results.Json(new Dictionary<string, object?> { ["ok"] = true });
        });

        group.MapPut("/{id:int}/narratives/{code}", async (HttpContext ctx, int id, string code) =>
        {
            var user = Current(ctx);
            var body = await JsonBody.Read(ctx.Request);
            await using var conn = db.Open();
            await conn.OpenAsync();
            await RequireEditable(conn, id, user);
            var title = JsonBody.Str(body, "title") ?? code;
            var text = JsonBody.Str(body, "body") ?? "";
            await conn.ExecuteAsync("""
                MERGE assessment_narratives AS target
                USING (SELECT @a AS assessment_id, @c AS code) AS src
                ON target.assessment_id=src.assessment_id AND target.code=src.code
                WHEN MATCHED THEN UPDATE SET title=@t, body=@b
                WHEN NOT MATCHED THEN INSERT (assessment_id, code, title, body) VALUES (@a,@c,@t,@b);
                """, new { a = id, c = code, t = title, b = text });
            return Results.Json(new Dictionary<string, object?> { ["ok"] = true });
        });

        group.MapPut("/{id:int}/measurements", async (HttpContext ctx, int id) =>
        {
            var user = Current(ctx);
            var body = await JsonBody.Read(ctx.Request);
            await using var conn = db.Open();
            await conn.OpenAsync();
            await RequireEditable(conn, id, user);
            await using var tx = (SqlTransaction)await conn.BeginTransactionAsync();
            try
            {
                await conn.ExecuteAsync("DELETE FROM thermography_readings WHERE assessment_id=@a", new { a = id }, tx);
                await conn.ExecuteAsync("DELETE FROM load_balance_readings WHERE assessment_id=@a", new { a = id }, tx);
                await conn.ExecuteAsync("DELETE FROM neutral_earth_readings WHERE assessment_id=@a", new { a = id }, tx);
                await conn.ExecuteAsync("DELETE FROM assessment_equipment WHERE assessment_id=@a", new { a = id }, tx);
                var thermo = JsonBody.Arr(body, "thermography");
                for (var i = 0; i < thermo.Count; i++)
                {
                    var row = thermo[i];
                    await conn.ExecuteAsync("""
                        INSERT INTO thermography_readings(assessment_id, sl_no, area, equipment, location, ambient_c, hotspot_c, delta_c, severity)
                        VALUES (@a,@n,@ar,@eq,@loc,@am,@hs,@d,@sv)
                        """, new { a = id, n = i + 1, ar = JsonBody.Str(row, "area"), eq = JsonBody.Str(row, "equipment"), loc = JsonBody.Str(row, "location"), am = JsonBody.Num(row, "ambient_c"), hs = JsonBody.Num(row, "hotspot_c"), d = JsonBody.Num(row, "delta_c"), sv = JsonBody.Str(row, "severity") }, tx);
                }
                var balance = JsonBody.Arr(body, "loadBalance");
                for (var i = 0; i < balance.Count; i++)
                {
                    var row = balance[i];
                    await conn.ExecuteAsync("""
                        INSERT INTO load_balance_readings(assessment_id, sl_no, area, equipment, l1_a, l2_a, l3_a, unbalance_l1, unbalance_l2, unbalance_l3, finding, recommendation)
                        VALUES (@a,@n,@ar,@eq,@l1,@l2,@l3,@u1,@u2,@u3,@f,@r)
                        """, new
                    {
                        a = id, n = i + 1, ar = JsonBody.Str(row, "area"), eq = JsonBody.Str(row, "equipment"),
                        l1 = JsonBody.Num(row, "l1_a"), l2 = JsonBody.Num(row, "l2_a"), l3 = JsonBody.Num(row, "l3_a"),
                        u1 = JsonBody.Num(row, "unbalance_l1"), u2 = JsonBody.Num(row, "unbalance_l2"), u3 = JsonBody.Num(row, "unbalance_l3"),
                        f = JsonBody.Str(row, "finding"), r = JsonBody.Str(row, "recommendation")
                    }, tx);
                }
                var earth = JsonBody.Arr(body, "neutralEarth");
                for (var i = 0; i < earth.Count; i++)
                {
                    var row = earth[i];
                    await conn.ExecuteAsync("INSERT INTO neutral_earth_readings(assessment_id, sl_no, area, equipment, voltage_v) VALUES (@a,@n,@ar,@eq,@v)",
                        new { a = id, n = i + 1, ar = JsonBody.Str(row, "area"), eq = JsonBody.Str(row, "equipment"), v = JsonBody.Num(row, "voltage_v") }, tx);
                }
                foreach (var row in JsonBody.Arr(body, "equipment"))
                {
                    var label = JsonBody.Str(row, "label");
                    var type = JsonBody.Str(row, "equipment_type");
                    if (string.IsNullOrEmpty(label) && string.IsNullOrEmpty(type)) continue;
                    await conn.ExecuteAsync("INSERT INTO assessment_equipment(assessment_id, equipment_type, label, identifier, rating) VALUES (@a,@t,@l,@i,@r)",
                        new { a = id, t = string.IsNullOrEmpty(type) ? "Equipment" : type, l = string.IsNullOrEmpty(label) ? "Item" : label, i = JsonBody.Str(row, "identifier"), r = JsonBody.Str(row, "rating") }, tx);
                }
                await Audit.Write(conn, tx, user.Id, "assessment", id, "measurements", null, new Dictionary<string, object?> { ["thermography"] = thermo.Count });
                await tx.CommitAsync();
                return Results.Json(new Dictionary<string, object?> { ["ok"] = true });
            }
            catch
            {
                try { await tx.RollbackAsync(); } catch { /* already closed */ }
                throw;
            }
        });

        group.MapPost("/{id:int}/attachments", async (HttpContext ctx, int id) =>
        {
            var user = Current(ctx);
            await using var conn = db.Open();
            await conn.OpenAsync();
            await RequireEditable(conn, id, user);
            if (!ctx.Request.HasFormContentType) throw new ApiException(400, "Choose a file to upload.");
            var form = await ctx.Request.ReadFormAsync();
            var file = form.Files["file"] ?? throw new ApiException(400, "Choose a file to upload.");
            var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "image/jpeg", "image/png", "image/webp", "application/pdf" };
            if (!allowed.Contains(file.ContentType)) throw new ApiException(400, "Upload a JPEG, PNG, WEBP or PDF file.");
            if (file.Length > 8 * 1024 * 1024) throw new ApiException(400, "Upload a JPEG, PNG, WEBP or PDF file.");
            await using var buffer = new MemoryStream();
            await file.CopyToAsync(buffer);
            int? itemId = int.TryParse(form["checklist_item_id"], out var parsed) ? parsed : null;
            var inserted = Rows.One(await conn.QueryAsync("""
                INSERT INTO assessment_attachments(assessment_id, checklist_item_id, file_name, file_type, file_data, uploaded_by)
                OUTPUT INSERTED.id, INSERTED.file_name, INSERTED.uploaded_at
                VALUES (@a,@i,@name,@type,@data,@u)
                """, new { a = id, i = itemId, name = file.FileName, type = file.ContentType, data = buffer.ToArray(), u = user.Id }));
            await Audit.Write(conn, null, user.Id, "assessment_attachment", inserted!["id"], "upload", null, new Dictionary<string, object?> { ["file"] = file.FileName, ["itemId"] = itemId });
            return Results.Json(inserted, statusCode: 201);
        });

        group.MapGet("/{id:int}/attachments/{attachmentId:int}", async (HttpContext ctx, int id, int attachmentId) =>
        {
            var user = Current(ctx);
            await using var conn = db.Open();
            await conn.OpenAsync();
            var header = await LoadHeader(conn, id) ?? throw new ApiException(404, "Assessment not found.");
            if (!user.CanSeeAll && Rows.Int(header, "surveyor_user_id") != user.Id) throw new ApiException(403, "You cannot open this file.");
            var file = Rows.One(await conn.QueryAsync("SELECT file_name, file_type, file_data FROM assessment_attachments WHERE id=@id AND assessment_id=@a", new { id = attachmentId, a = id }));
            if (file == null) throw new ApiException(404, "File not found.");
            var name = (Rows.Str(file, "file_name") ?? "file").Replace("\"", "");
            var type = Rows.Str(file, "file_type") ?? "application/octet-stream";
            ctx.Response.Headers.ContentDisposition = $"inline; filename=\"{name}\"";
            return Results.File((byte[])file["file_data"]!, type);
        });
    }

    public static async Task<Dictionary<string, object?>> LoadAssessment(Database db, int id, CurrentUser user)
    {
        await using var conn = db.Open();
        await conn.OpenAsync();
        var header = await LoadHeader(conn, id) ?? throw new ApiException(404, "Assessment not found.");
        if (!user.CanSeeAll && Rows.Int(header, "surveyor_user_id") != user.Id) throw new ApiException(403, "This assessment belongs to another surveyor.");
        var responses = Rows.List(await conn.QueryAsync("""
            SELECT r.*, i.item_number, i.activity_description, i.requirement_description, i.guidance, i.section_id,
                   i.risk_rating_enabled, i.observation_required, i.recommendation_required, i.evidence_required, i.source_review AS item_source_review,
                   s.section_code, s.section_name, s.display_order AS section_order,
                   rr.code AS risk_code, rr.name AS risk_name,
                   o.counts_as, o.requires_observation, o.requires_recommendation, o.requires_risk
            FROM assessment_responses r
            INNER JOIN checklist_items i ON i.id=r.checklist_item_id
            INNER JOIN checklist_sections s ON s.id=i.section_id
            LEFT JOIN risk_ratings rr ON rr.id=r.risk_rating_id
            LEFT JOIN response_options o ON o.code=r.response_code
            WHERE r.assessment_id=@id
            ORDER BY s.display_order, i.display_order
            """, new { id }));
        var attachments = Rows.List(await conn.QueryAsync("SELECT id, checklist_item_id, file_name, file_type, uploaded_at FROM assessment_attachments WHERE assessment_id=@id", new { id }));
        var narratives = Rows.List(await conn.QueryAsync("SELECT * FROM assessment_narratives WHERE assessment_id=@id", new { id }));
        var equipment = Rows.List(await conn.QueryAsync("SELECT * FROM assessment_equipment WHERE assessment_id=@id", new { id }));
        var thermography = Rows.List(await conn.QueryAsync("SELECT * FROM thermography_readings WHERE assessment_id=@id ORDER BY sl_no", new { id }));
        var loadBalance = Rows.List(await conn.QueryAsync("SELECT * FROM load_balance_readings WHERE assessment_id=@id ORDER BY sl_no", new { id }));
        var neutralEarth = Rows.List(await conn.QueryAsync("SELECT * FROM neutral_earth_readings WHERE assessment_id=@id ORDER BY sl_no", new { id }));
        var reviews = Rows.List(await conn.QueryAsync("""
            SELECT rv.*, u.name AS user_name FROM assessment_reviews rv INNER JOIN users u ON u.id=rv.user_id
            WHERE rv.assessment_id=@id ORDER BY rv.created_at
            """, new { id }));
        header["dealer_details_snapshot"] = Rows.JsonOrRaw(header.GetValueOrDefault("dealer_details_snapshot"));
        var sections = new List<Dictionary<string, object?>>();
        var bySection = new Dictionary<int, Dictionary<string, object?>>();
        foreach (var row in responses)
        {
            var sectionId = Rows.Int(row, "section_id");
            if (!bySection.TryGetValue(sectionId, out var section))
            {
                section = new Dictionary<string, object?>
                {
                    ["id"] = sectionId,
                    ["code"] = Rows.Str(row, "section_code"),
                    ["name"] = Rows.Str(row, "section_name"),
                    ["items"] = new List<Dictionary<string, object?>>()
                };
                bySection[sectionId] = section;
                sections.Add(section);
            }
            row["applicability_snapshot"] = Rows.JsonOrRaw(row.GetValueOrDefault("applicability_snapshot"));
            row["attachments"] = attachments.Where(file => file.GetValueOrDefault("checklist_item_id") != null && Rows.Int(file, "checklist_item_id") == Rows.Int(row, "checklist_item_id")).ToList();
            ((List<Dictionary<string, object?>>)section["items"]!).Add(row);
        }
        return new Dictionary<string, object?>
        {
            ["assessment"] = header,
            ["summary"] = Compliance.Summarise(responses, Rows.Flag(header, "exclude_na_from_compliance")),
            ["sections"] = sections,
            ["narratives"] = narratives,
            ["equipment"] = equipment,
            ["thermography"] = thermography,
            ["loadBalance"] = loadBalance,
            ["neutralEarth"] = neutralEarth,
            ["reviews"] = reviews
        };
    }

    private static async Task<Dictionary<string, object?>?> LoadHeader(SqlConnection conn, int id) =>
        Rows.One(await conn.QueryAsync("""
            SELECT a.*, s.user_id AS surveyor_user_id, s.name AS surveyor_name, s.employee_id AS surveyor_employee_id, s.email AS surveyor_email,
                   t.name AS assessment_type, t.code AS assessment_type_code, tpl.version, tpl.exclude_na_from_compliance,
                   u.name AS reviewer_name
            FROM assessments a
            INNER JOIN surveyors s ON s.id=a.surveyor_id
            INNER JOIN assessment_types t ON t.id=a.assessment_type_id
            INNER JOIN assessment_templates tpl ON tpl.id=a.template_id
            LEFT JOIN users u ON u.id=a.reviewer_id
            WHERE a.id=@id
            """, new { id }));

    private static async Task<Dictionary<string, object?>> RequireEditable(SqlConnection conn, int id, CurrentUser user)
    {
        var current = await LoadHeader(conn, id) ?? throw new ApiException(404, "Assessment not found.");
        if (!user.CanSeeAll && Rows.Int(current, "surveyor_user_id") != user.Id) throw new ApiException(403, "This assessment belongs to another surveyor.");
        if (!Editable.Contains(Rows.Str(current, "status") ?? "")) throw new ApiException(400, "Approved assessments are locked. An administrator can reopen one with a reason.");
        if (!user.Has("assessments.create") && !user.Has("masters.manage")) throw new ApiException(403, "You cannot edit assessment responses.");
        return current;
    }

    private static async Task<List<Dictionary<string, object?>>> ValidateForSubmit(SqlConnection conn, int assessmentId)
    {
        var data = Rows.List(await conn.QueryAsync("""
            SELECT r.*, i.item_number, i.evidence_required, i.activity_description, o.requires_observation, o.requires_recommendation, o.requires_risk, i.risk_rating_enabled,
                   (SELECT COUNT(*) FROM assessment_attachments att WHERE att.assessment_id=r.assessment_id AND att.checklist_item_id=r.checklist_item_id) AS files
            FROM assessment_responses r
            INNER JOIN checklist_items i ON i.id=r.checklist_item_id
            LEFT JOIN response_options o ON o.code=r.response_code
            WHERE r.assessment_id=@id
            """, new { id = assessmentId }));
        var errors = new List<Dictionary<string, object?>>();
        foreach (var row in data)
        {
            var itemNumber = Rows.Int(row, "item_number");
            if (Rows.Str(row, "applicability_status") == "Unconfigured")
            {
                errors.Add(Error(row, itemNumber, $"Item {itemNumber} has no applicability configuration."));
                continue;
            }
            if (Rows.Str(row, "applicability_status") == "Not Applicable" || Rows.Flag(row, "locked_na"))
            {
                if (Rows.Str(row, "response_code") != "NA") errors.Add(Error(row, itemNumber, $"Item {itemNumber} must stay NA."));
                continue;
            }
            if (string.IsNullOrEmpty(Rows.Str(row, "response_code")))
            {
                errors.Add(Error(row, itemNumber, $"Item {itemNumber} needs a response."));
                continue;
            }
            if (Rows.Flag(row, "requires_observation") && string.IsNullOrWhiteSpace(Rows.Str(row, "observation")))
                errors.Add(Error(row, itemNumber, $"Item {itemNumber} needs an observation."));
            if (Rows.Flag(row, "requires_recommendation") && string.IsNullOrWhiteSpace(Rows.Str(row, "recommendation")))
                errors.Add(Error(row, itemNumber, $"Item {itemNumber} needs a recommendation."));
            if ((Rows.Flag(row, "requires_risk") || Rows.Flag(row, "risk_rating_enabled")) && row.GetValueOrDefault("risk_rating_id") == null && Rows.Str(row, "response_code") != "NA")
                errors.Add(Error(row, itemNumber, $"Item {itemNumber} needs a risk rating."));
            if (Rows.Flag(row, "evidence_required") && Rows.Int(row, "files") == 0)
                errors.Add(Error(row, itemNumber, $"Item {itemNumber} needs evidence."));
        }
        return errors;
    }

    private static Dictionary<string, object?> Error(Dictionary<string, object?> row, int itemNumber, string message) => new()
    {
        ["responseId"] = Rows.Int(row, "id"),
        ["itemNumber"] = itemNumber,
        ["message"] = message
    };

    private static void AddFilter(HttpContext ctx, DynamicParameters p, List<string> where, string query, string clause, string? param = null)
    {
        var value = ctx.Request.Query[query].ToString();
        if (string.IsNullOrEmpty(value)) return;
        p.Add(param ?? query, value);
        where.Add(clause);
    }

    private static CurrentUser Current(HttpContext ctx) => (CurrentUser)ctx.Items["user"]!;
}
