using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;

namespace Esa.Api;

public static class AdminEndpoints
{
    private static readonly Dictionary<string, (string Table, string[] Fields, string[] Required)> Catalogues = new()
    {
        ["dealers"] = ("dealers", ["dealer_code", "dealer_name", "dealer_group", "address", "city", "state", "region", "postal_code", "contact_person", "contact_number", "email", "status"], ["dealer_code", "dealer_name", "address", "city", "state"]),
        ["surveyors"] = ("surveyors", ["employee_id", "name", "email", "phone", "region", "role_name", "status", "user_id"], ["employee_id", "name"]),
        ["assessment-types"] = ("assessment_types", ["code", "name", "description", "active_status", "approval_status", "effective_from", "effective_to"], ["code", "name"]),
        ["templates"] = ("assessment_templates", ["assessment_type_id", "version", "status", "approval_status", "effective_from", "effective_to", "exclude_na_from_compliance", "notes"], ["assessment_type_id", "version", "status", "approval_status"]),
        ["sections"] = ("checklist_sections", ["template_id", "section_code", "section_name", "section_description", "display_order", "active_status"], ["template_id", "section_code", "section_name", "display_order"]),
        ["items"] = ("checklist_items", ["template_id", "section_id", "item_number", "activity_description", "requirement_description", "guidance", "response_type_id", "risk_rating_enabled", "observation_required", "recommendation_required", "evidence_required", "display_order", "active_status", "version_number", "source_review"], ["template_id", "section_id", "item_number", "activity_description", "requirement_description", "response_type_id", "display_order"]),
        ["applicability"] = ("applicability_rules", ["checklist_item_id", "assessment_type_id", "facility_type", "applicability_status", "default_response", "conditional_attribute", "allow_override", "effective_from", "effective_to", "active_status", "review_required", "remarks"], ["checklist_item_id", "assessment_type_id", "facility_type", "applicability_status"]),
        ["risk-ratings"] = ("risk_ratings", ["code", "name", "description", "severity_level", "display_order", "active_status"], ["code", "name", "severity_level", "display_order"]),
        ["response-types"] = ("response_types", ["code", "name", "description", "active_status"], ["code", "name"]),
        ["response-options"] = ("response_options", ["response_type_id", "code", "label", "counts_as", "requires_observation", "requires_recommendation", "requires_risk", "selectable_by_surveyor", "display_order", "active_status"], ["response_type_id", "code", "label", "counts_as", "display_order"]),
        ["lookups"] = ("lookups", ["category", "code", "name", "display_order", "active_status"], ["category", "code", "name"])
    };

    public static void Map(WebApplication app, Database db)
    {
        var group = app.MapGroup("/api/admin");
        group.AddEndpointFilter(async (ctx, next) =>
        {
            var user = (CurrentUser)ctx.HttpContext.Items["user"]!;
            if (!user.Has("masters.manage"))
                return Results.Json(new Dictionary<string, object?> { ["error"] = "You do not have permission for this action." }, statusCode: 403);
            return await next(ctx);
        });

        group.MapGet("/audit", async (HttpContext ctx) =>
        {
            await using var conn = db.Open();
            await conn.OpenAsync();
            var entity = string.IsNullOrEmpty(ctx.Request.Query["entity"]) ? null : ctx.Request.Query["entity"].ToString();
            return Results.Json(Rows.List(await conn.QueryAsync("""
                SELECT TOP 300 a.*, u.name AS user_name
                FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
                WHERE (@entity IS NULL OR a.entity_type=@entity)
                ORDER BY a.created_at DESC
                """, new { entity })));
        });

        group.MapGet("/users", async () =>
        {
            await using var conn = db.Open();
            await conn.OpenAsync();
            return Results.Json(Rows.List(await conn.QueryAsync("""
                SELECT u.id, u.name, u.email, u.employee_id, u.phone, u.region, u.status, u.created_at, r.name AS role_name, r.id AS role_id
                FROM users u INNER JOIN roles r ON r.id=u.role_id ORDER BY u.name
                """)));
        });

        group.MapPost("/users", async (HttpContext ctx) =>
        {
            var body = await JsonBody.Read(ctx.Request);
            var name = JsonBody.Str(body, "name");
            var email = JsonBody.Str(body, "email");
            var password = JsonBody.Str(body, "password");
            var roleId = JsonBody.Int(body, "role_id");
            if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(password) || roleId == null)
                throw new ApiException(400, "Name, email, password and role are required.");
            await using var conn = db.Open();
            await conn.OpenAsync();
            var id = await conn.ExecuteScalarAsync<int>("""
                INSERT INTO users(name, email, password_hash, role_id, employee_id, phone, region, status)
                OUTPUT INSERTED.id VALUES (@name,@email,@hash,@role,@emp,@phone,@region,@status)
                """, new
            {
                name, email, hash = BCrypt.Net.BCrypt.HashPassword(password, 10), role = roleId,
                emp = JsonBody.Str(body, "employee_id"), phone = JsonBody.Str(body, "phone"),
                region = JsonBody.Str(body, "region"), status = JsonBody.Str(body, "status") ?? "Active"
            });
            await Audit.Write(conn, null, User(ctx).Id, "user", id, "create", null, new Dictionary<string, object?> { ["email"] = email, ["role_id"] = roleId });
            return Results.Json(new Dictionary<string, object?> { ["id"] = id }, statusCode: 201);
        });

        group.MapPut("/users/{id:int}", async (HttpContext ctx, int id) =>
        {
            var body = await JsonBody.Read(ctx.Request);
            await using var conn = db.Open();
            await conn.OpenAsync();
            var before = Rows.One(await conn.QueryAsync("SELECT id, name, email, role_id, status FROM users WHERE id=@id", new { id }));
            if (before == null) throw new ApiException(404, "User not found.");
            var password = JsonBody.Str(body, "password");
            var sql = string.IsNullOrEmpty(password)
                ? "UPDATE users SET name=@name, role_id=@role, status=@status, employee_id=@emp, phone=@phone, region=@region WHERE id=@id"
                : "UPDATE users SET name=@name, role_id=@role, status=@status, employee_id=@emp, phone=@phone, region=@region, password_hash=@hash WHERE id=@id";
            await conn.ExecuteAsync(sql, new
            {
                id, name = JsonBody.Str(body, "name"), role = JsonBody.Int(body, "role_id"), status = JsonBody.Str(body, "status"),
                emp = JsonBody.Str(body, "employee_id"), phone = JsonBody.Str(body, "phone"), region = JsonBody.Str(body, "region"),
                hash = string.IsNullOrEmpty(password) ? null : BCrypt.Net.BCrypt.HashPassword(password, 10)
            });
            await Audit.Write(conn, null, User(ctx).Id, "user", id, "update", before, new Dictionary<string, object?>
            {
                ["name"] = JsonBody.Str(body, "name"),
                ["role_id"] = JsonBody.Int(body, "role_id"),
                ["status"] = JsonBody.Str(body, "status"),
                ["password"] = string.IsNullOrEmpty(password) ? null : "changed"
            });
            return Results.Json(new Dictionary<string, object?> { ["ok"] = true });
        });

        group.MapGet("/roles", async () =>
        {
            await using var conn = db.Open();
            await conn.OpenAsync();
            return Results.Json(Rows.List(await conn.QueryAsync("SELECT * FROM roles ORDER BY name")));
        });

        group.MapGet("/facilities", async () =>
        {
            await using var conn = db.Open();
            await conn.OpenAsync();
            var facilities = Rows.List(await conn.QueryAsync("""
                SELECT f.*, d.dealer_code, d.dealer_name
                FROM facilities f INNER JOIN dealers d ON d.id=f.dealer_id
                ORDER BY d.dealer_name, f.facility_name
                """));
            var attrs = Rows.List(await conn.QueryAsync("SELECT * FROM facility_attributes"));
            foreach (var facility in facilities)
            {
                facility["attributes"] = attrs.Where(attr => Rows.Int(attr, "facility_id") == Rows.Int(facility, "id"))
                    .ToDictionary(attr => Rows.Str(attr, "attribute_code") ?? "", attr => attr.GetValueOrDefault("attribute_value") is true);
            }
            return Results.Json(facilities);
        });

        group.MapPost("/facilities", async (HttpContext ctx) =>
        {
            var id = await SaveFacility(db, ctx, null);
            return Results.Json(new Dictionary<string, object?> { ["id"] = id }, statusCode: 201);
        });

        group.MapPut("/facilities/{id:int}", async (HttpContext ctx, int id) =>
        {
            await SaveFacility(db, ctx, id);
            return Results.Json(new Dictionary<string, object?> { ["ok"] = true });
        });

        group.MapGet("/import/validate", async (HttpContext ctx) =>
        {
            int? templateId = int.TryParse(ctx.Request.Query["templateId"], out var parsed) ? parsed : null;
            await using var conn = db.Open();
            await conn.OpenAsync();
            var flags = await ValidateTemplate(conn, templateId);
            return Results.Json(new Dictionary<string, object?> { ["flags"] = flags, ["count"] = flags.Count });
        });

        group.MapPost("/import/preview", async (HttpContext ctx) =>
        {
            var body = await JsonBody.Read(ctx.Request);
            var items = JsonBody.Arr(body, "items");
            var flags = PreviewItems(items);
            var sections = items.Select(item => JsonBody.Str(item, "section")).Where(section => !string.IsNullOrEmpty(section)).Distinct().Count();
            return Results.Json(new Dictionary<string, object?>
            {
                ["items"] = items.Count,
                ["sections"] = sections,
                ["flags"] = flags,
                ["ready"] = flags.All(flag => Rows.Str(flag, "severity") != "error")
            });
        });

        group.MapPost("/import/commit", async (HttpContext ctx) =>
        {
            var user = User(ctx);
            var body = await JsonBody.Read(ctx.Request);
            var items = JsonBody.Arr(body, "items");
            var flags = PreviewItems(items);
            if (items.Count == 0 || flags.Any(flag => Rows.Str(flag, "severity") == "error"))
                throw new ApiException(422, "Fix preview errors before import.", "flags", flags);
            var typeCode = JsonBody.Str(body, "assessmentTypeCode") ?? "ESA";
            await using var conn = db.Open();
            await conn.OpenAsync();
            await using var tx = (SqlTransaction)await conn.BeginTransactionAsync();
            try
            {
                var typeId = await conn.ExecuteScalarAsync<int?>("SELECT id FROM assessment_types WHERE code=@code", new { code = typeCode }, tx);
                if (typeId == null) throw new ApiException(400, "Assessment type code was not found. Create the type in master data first.");
                var version = "1." + await conn.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM assessment_templates WHERE assessment_type_id=@t", new { t = typeId }, tx);
                var responseTypeId = await conn.ExecuteScalarAsync<int?>("SELECT TOP 1 id FROM response_types WHERE code=N'COMPLIANCE'", transaction: tx)
                    ?? throw new ApiException(400, "The compliance response type is missing.");
                var templateId = await conn.ExecuteScalarAsync<int>("""
                    INSERT INTO assessment_templates(assessment_type_id, version, status, approval_status, effective_from, exclude_na_from_compliance, notes)
                    OUTPUT INSERTED.id VALUES (@t, @v, N'Draft', N'Draft', CAST(SYSUTCDATETIME() AS date), 1, N'Imported by administrator. Approve the template before surveyors use it.')
                    """, new { t = typeId, v = version }, tx);
                var sectionIds = new Dictionary<string, int>();
                var sectionOrder = 1;
                foreach (var item in items)
                {
                    var section = JsonBody.Str(item, "section") ?? "";
                    if (!sectionIds.TryGetValue(section, out var sectionId))
                    {
                        var code = "IMP" + sectionOrder.ToString().PadLeft(2, '0');
                        sectionId = await conn.ExecuteScalarAsync<int>("""
                            INSERT INTO checklist_sections(template_id, section_code, section_name, display_order)
                            OUTPUT INSERTED.id VALUES (@tpl,@c,@n,@o)
                            """, new { tpl = templateId, c = code, n = section, o = sectionOrder }, tx);
                        sectionIds[section] = sectionId;
                        sectionOrder++;
                    }
                    var itemId = await conn.ExecuteScalarAsync<int>("""
                        INSERT INTO checklist_items(template_id, section_id, item_number, activity_description, requirement_description, response_type_id, display_order, source_review)
                        OUTPUT INSERTED.id VALUES (@tpl,@sec,@num,@act,@req,@rt,@num,@rev)
                        """, new
                    {
                        tpl = templateId, sec = sectionId, num = JsonBody.Int(item, "item_number") ?? 0,
                        act = JsonBody.Str(item, "activity"), req = JsonBody.Str(item, "requirement"),
                        rt = responseTypeId, rev = JsonBody.Bool(item, "source_review")
                    }, tx);
                    foreach (var facilityType in new[] { "1S", "2S", "3S" })
                    {
                        var (status, attribute) = RuleOf(item, facilityType);
                        await conn.ExecuteAsync("""
                            INSERT INTO applicability_rules(checklist_item_id, assessment_type_id, facility_type, applicability_status, default_response, conditional_attribute, effective_from, review_required, remarks)
                            VALUES (@item,@type,@ft,@st,@def,@attr, CAST(SYSUTCDATETIME() AS date), 1, N'Imported rule. Confirm before approving the template.')
                            """, new { item = itemId, type = typeId, ft = facilityType, st = status, def = status == "Not Applicable" ? "NA" : "Blank", attr = attribute }, tx);
                    }
                }
                var batchId = await conn.ExecuteScalarAsync<int>("""
                    INSERT INTO import_batches(template_id, file_name, status, created_by, summary)
                    OUTPUT INSERTED.id VALUES (@tpl, N'checklist.json', N'Committed', @u, @s)
                    """, new { tpl = templateId, u = user.Id, s = JsonSerializer.Serialize(new { items = items.Count, flags = flags.Count }) }, tx);
                foreach (var flag in flags)
                {
                    await conn.ExecuteAsync("INSERT INTO import_flags(batch_id, item_number, severity, message) VALUES (@b,@n,@sv,@m)",
                        new { b = batchId, n = flag.GetValueOrDefault("itemNumber"), sv = Rows.Str(flag, "severity"), m = Rows.Str(flag, "message") }, tx);
                }
                await Audit.Write(conn, tx, user.Id, "assessment_template", templateId, "import", null, new Dictionary<string, object?> { ["version"] = version, ["items"] = items.Count });
                await tx.CommitAsync();
                return Results.Json(new Dictionary<string, object?> { ["templateId"] = templateId, ["version"] = version, ["flags"] = flags }, statusCode: 201);
            }
            catch
            {
                try { await tx.RollbackAsync(); } catch { /* already closed */ }
                throw;
            }
        });

        foreach (var entry in Catalogues)
        {
            var name = entry.Key;
            var config = entry.Value;
            group.MapGet("/" + name, async () =>
            {
                await using var conn = db.Open();
                await conn.OpenAsync();
                return Results.Json(Rows.List(await conn.QueryAsync($"SELECT * FROM {config.Table} ORDER BY id DESC")));
            });
            group.MapPost("/" + name, async (HttpContext ctx) =>
            {
                var body = await JsonBody.Read(ctx.Request);
                var missing = config.Required.Where(field => !JsonBody.Has(body, field) || string.IsNullOrEmpty(JsonBody.Str(body, field))).ToList();
                if (missing.Count > 0) throw new ApiException(400, $"Missing {string.Join(", ", missing)}.");
                await using var conn = db.Open();
                await conn.OpenAsync();
                var inserted = await InsertRow(conn, config.Table, config.Fields, body);
                await Audit.Write(conn, null, User(ctx).Id, config.Table, inserted["id"], "create", null, body);
                return Results.Json(inserted, statusCode: 201);
            });
            group.MapPut("/" + name + "/{id:int}", async (HttpContext ctx, int id) =>
            {
                var body = await JsonBody.Read(ctx.Request);
                await using var conn = db.Open();
                await conn.OpenAsync();
                var before = Rows.One(await conn.QueryAsync($"SELECT * FROM {config.Table} WHERE id=@id", new { id }));
                if (before == null) throw new ApiException(404, "Record not found.");
                await UpdateRow(conn, config.Table, config.Fields, id, body);
                await Audit.Write(conn, null, User(ctx).Id, config.Table, id, "update", before, body);
                return Results.Json(new Dictionary<string, object?> { ["ok"] = true });
            });
        }
    }

    private static async Task<int> SaveFacility(Database db, HttpContext ctx, int? id)
    {
        var body = await JsonBody.Read(ctx.Request);
        var dealerId = JsonBody.Int(body, "dealer_id");
        var name = JsonBody.Str(body, "facility_name");
        var type = JsonBody.Str(body, "facility_type");
        if (dealerId == null || string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(type))
            throw new ApiException(400, "Dealer, facility name and facility type are required.");
        if (type is not ("1S" or "2S" or "3S")) throw new ApiException(400, "Facility type must be 1S, 2S or 3S.");
        await using var conn = db.Open();
        await conn.OpenAsync();
        var facilityId = id;
        if (id == null)
        {
            facilityId = await conn.ExecuteScalarAsync<int>("""
                INSERT INTO facilities(dealer_id, facility_name, facility_type, address, status, effective_from, effective_to)
                OUTPUT INSERTED.id VALUES (@d,@n,@t,@a,@s,@from,@to)
                """, new { d = dealerId, n = name, t = type, a = JsonBody.Str(body, "address"), s = JsonBody.Str(body, "status") ?? "Active", from = JsonBody.Str(body, "effective_from"), to = JsonBody.Str(body, "effective_to") });
            await Audit.Write(conn, null, User(ctx).Id, "facility", facilityId, "create", null, body);
        }
        else
        {
            var before = Rows.One(await conn.QueryAsync("SELECT * FROM facilities WHERE id=@id", new { id }));
            await conn.ExecuteAsync("""
                UPDATE facilities SET dealer_id=@d, facility_name=@n, facility_type=@t, address=@a, status=@s, effective_from=@from, effective_to=@to WHERE id=@id
                """, new { id, d = dealerId, n = name, t = type, a = JsonBody.Str(body, "address"), s = JsonBody.Str(body, "status") ?? "Active", from = JsonBody.Str(body, "effective_from"), to = JsonBody.Str(body, "effective_to") });
            await Audit.Write(conn, null, User(ctx).Id, "facility", id, "update", before, body);
        }
        if (JsonBody.Has(body, "attributes") && body.GetProperty("attributes").ValueKind == JsonValueKind.Object)
        {
            await conn.ExecuteAsync("DELETE FROM facility_attributes WHERE facility_id=@id", new { id = facilityId });
            foreach (var attr in body.GetProperty("attributes").EnumerateObject())
            {
                if (attr.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) continue;
                if (attr.Value.ValueKind == JsonValueKind.String && string.IsNullOrEmpty(attr.Value.GetString())) continue;
                var present = attr.Value.ValueKind switch
                {
                    JsonValueKind.True => true,
                    JsonValueKind.False => false,
                    JsonValueKind.Number => attr.Value.TryGetInt32(out var number) && number != 0,
                    _ => attr.Value.ToString() is not ("0" or "false" or "")
                };
                await conn.ExecuteAsync("INSERT INTO facility_attributes(facility_id, attribute_code, attribute_value) VALUES (@f,@c,@v)", new { f = facilityId, c = attr.Name, v = present });
            }
        }
        return facilityId!.Value;
    }

    private static async Task<Dictionary<string, object?>> InsertRow(SqlConnection conn, string table, string[] fields, JsonElement body)
    {
        var p = new DynamicParameters();
        var cols = new List<string>();
        var vals = new List<string>();
        for (var i = 0; i < fields.Length; i++)
        {
            if (!JsonBody.Has(body, fields[i])) continue;
            p.Add("p" + i, JsonBody.Sql(body.GetProperty(fields[i]), false));
            cols.Add(fields[i]);
            vals.Add("@p" + i);
        }
        var id = await conn.ExecuteScalarAsync<int>($"INSERT INTO {table}({string.Join(",", cols)}) OUTPUT INSERTED.id VALUES ({string.Join(",", vals)})", p);
        return new Dictionary<string, object?> { ["id"] = id };
    }

    private static async Task UpdateRow(SqlConnection conn, string table, string[] fields, int id, JsonElement body)
    {
        var p = new DynamicParameters();
        p.Add("id", id);
        var sets = new List<string>();
        for (var i = 0; i < fields.Length; i++)
        {
            if (!JsonBody.Has(body, fields[i])) continue;
            p.Add("p" + i, JsonBody.Sql(body.GetProperty(fields[i]), true));
            sets.Add($"{fields[i]}=@p{i}");
        }
        if (sets.Count == 0) return;
        await conn.ExecuteAsync($"UPDATE {table} SET {string.Join(", ", sets)} WHERE id=@id", p);
    }

    private static List<Dictionary<string, object?>> PreviewItems(List<JsonElement> items)
    {
        var flags = new List<Dictionary<string, object?>>();
        var seen = new HashSet<int>();
        for (var index = 0; index < items.Count; index++)
        {
            var item = items[index];
            var num = JsonBody.Int(item, "item_number") ?? 0;
            if (string.IsNullOrEmpty(JsonBody.Str(item, "section"))) flags.Add(Flag("error", num, $"Row {index + 1} is missing a section."));
            if (num == 0) flags.Add(Flag("error", num, $"Row {index + 1} is missing an item number."));
            if (!seen.Add(num)) flags.Add(Flag("error", num, $"Duplicate item number {num}."));
            if (string.IsNullOrWhiteSpace(JsonBody.Str(item, "activity"))) flags.Add(Flag("error", num, $"Item {num} is missing an activity description."));
            if (string.IsNullOrWhiteSpace(JsonBody.Str(item, "requirement"))) flags.Add(Flag("error", num, $"Item {num} is missing a requirement."));
            foreach (var facilityType in new[] { "1S", "2S", "3S" })
            {
                var (status, attribute) = RuleOf(item, facilityType);
                if (string.IsNullOrEmpty(status)) flags.Add(Flag("error", num, $"Item {num} has no {facilityType} applicability."));
                else if (status is not ("Applicable" or "Not Applicable" or "Conditional")) flags.Add(Flag("error", num, $"Item {num} has an invalid {facilityType} applicability."));
                else if (status == "Conditional" && string.IsNullOrEmpty(attribute)) flags.Add(Flag("warning", num, $"Item {num} is conditional for {facilityType} without a facility attribute. It will stay unanswered until configured."));
            }
            if (JsonBody.Bool(item, "source_review")) flags.Add(Flag("warning", num, $"Item {num} is flagged for administrator review of the source wording."));
        }
        return flags;
    }

    private static async Task<List<Dictionary<string, object?>>> ValidateTemplate(SqlConnection conn, int? templateId)
    {
        var id = templateId ?? await conn.ExecuteScalarAsync<int?>("SELECT TOP 1 id FROM assessment_templates WHERE status=N'Active' ORDER BY id");
        if (id == null) return [Flag("error", null, "No template to validate.")];
        var items = Rows.List(await conn.QueryAsync("SELECT * FROM checklist_items WHERE template_id=@id", new { id }));
        var rules = Rows.List(await conn.QueryAsync("""
            SELECT r.* FROM applicability_rules r INNER JOIN checklist_items i ON i.id=r.checklist_item_id
            WHERE i.template_id=@id AND r.active_status=1
            """, new { id }));
        var flags = new List<Dictionary<string, object?>>();
        var seen = new HashSet<int>();
        foreach (var item in items)
        {
            var num = Rows.Int(item, "item_number");
            if (!seen.Add(num)) flags.Add(Flag("error", num, $"Duplicate item number {num}."));
            if (string.IsNullOrWhiteSpace(Rows.Str(item, "activity_description"))) flags.Add(Flag("error", num, "Missing activity description."));
            if (string.IsNullOrWhiteSpace(Rows.Str(item, "requirement_description"))) flags.Add(Flag("error", num, "Missing requirement."));
            if (Rows.Flag(item, "source_review")) flags.Add(Flag("warning", num, "Source wording is flagged for administrator confirmation."));
            foreach (var facilityType in new[] { "1S", "2S", "3S" })
            {
                var rule = rules.FirstOrDefault(candidate => Rows.Int(candidate, "checklist_item_id") == Rows.Int(item, "id") && Rows.Str(candidate, "facility_type") == facilityType);
                if (rule == null) flags.Add(Flag("error", num, $"Missing {facilityType} applicability. This item will not be assumed NA."));
                else if (Rows.Str(rule, "applicability_status") == "Conditional" && string.IsNullOrEmpty(Rows.Str(rule, "conditional_attribute")))
                    flags.Add(Flag("warning", num, $"Conditional {facilityType} rule has no facility attribute."));
            }
        }
        return flags;
    }

    private static (string? Status, string? Attribute) RuleOf(JsonElement item, string facilityType)
    {
        if (!JsonBody.Has(item, "applicability") || item.GetProperty("applicability").ValueKind != JsonValueKind.Object) return (null, null);
        var map = item.GetProperty("applicability");
        if (!map.TryGetProperty(facilityType, out var rule)) return (null, null);
        if (rule.ValueKind == JsonValueKind.String) return (rule.GetString(), null);
        if (rule.ValueKind == JsonValueKind.Object)
            return (JsonBody.Str(rule, "status"), JsonBody.Str(rule, "attribute"));
        return (null, null);
    }

    private static Dictionary<string, object?> Flag(string severity, int? itemNumber, string message) => new()
    {
        ["severity"] = severity,
        ["itemNumber"] = itemNumber,
        ["message"] = message
    };

    private static CurrentUser User(HttpContext ctx) => (CurrentUser)ctx.Items["user"]!;
}
