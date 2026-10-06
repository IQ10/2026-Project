using System.Text.Json;
using System.Text.Json.Serialization;
using Dapper;
using Esa.Api;

DotEnv.Load();
if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("APP_POOL_ID")))
{
    var port = Environment.GetEnvironmentVariable("PORT") ?? "4317";
    Environment.SetEnvironmentVariable("ASPNETCORE_URLS", $"http://0.0.0.0:{port}");
}

var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = null;
    options.SerializerOptions.DictionaryKeyPolicy = null;
    options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.Never;
});
builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 12 * 1024 * 1024);

var app = builder.Build();
var db = new Database();

app.UseCors();
app.Use(async (ctx, next) =>
{
    try
    {
        await next();
    }
    catch (ApiException ex)
    {
        if (ctx.Response.HasStarted) throw;
        ctx.Response.StatusCode = ex.Status;
        await ctx.Response.WriteAsJsonAsync(ex.Body);
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine(ex);
        if (ctx.Response.HasStarted) throw;
        ctx.Response.StatusCode = 500;
        await ctx.Response.WriteAsJsonAsync(new Dictionary<string, object?> { ["error"] = "The server could not complete that request." });
    }
});

app.Use(async (ctx, next) =>
{
    var path = ctx.Request.Path.Value ?? "";
    var open = path.Equals("/api/health", StringComparison.OrdinalIgnoreCase)
        || (path.Equals("/api/auth/login", StringComparison.OrdinalIgnoreCase) && HttpMethods.IsPost(ctx.Request.Method));
    if (!open && path.StartsWith("/api", StringComparison.OrdinalIgnoreCase))
    {
        var header = ctx.Request.Headers.Authorization.ToString();
        var token = header.StartsWith("Bearer ", StringComparison.Ordinal) ? header[7..] : "";
        if (token.Length == 0)
        {
            ctx.Response.StatusCode = 401;
            await ctx.Response.WriteAsJsonAsync(new Dictionary<string, object?> { ["error"] = "Sign in to continue." });
            return;
        }
        try
        {
            ctx.Items["user"] = Tokens.Read(token);
        }
        catch
        {
            ctx.Response.StatusCode = 401;
            await ctx.Response.WriteAsJsonAsync(new Dictionary<string, object?> { ["error"] = "Your session has expired. Sign in again." });
            return;
        }
    }
    await next();
});

app.MapGet("/api/health", async () =>
{
    try
    {
        await using var conn = db.Open();
        await conn.OpenAsync();
        await conn.ExecuteScalarAsync<int>("SELECT 1");
        return Results.Json(new Dictionary<string, object?> { ["ok"] = true, ["database"] = "SQL Server" });
    }
    catch (Exception ex)
    {
        return Results.Json(new Dictionary<string, object?> { ["ok"] = false, ["error"] = ex.Message }, statusCode: 500);
    }
});

app.MapPost("/api/auth/login", async (HttpContext ctx) =>
{
    var body = await JsonBody.Read(ctx.Request);
    var email = (JsonBody.Str(body, "email") ?? "").Trim().ToLowerInvariant();
    var password = JsonBody.Str(body, "password") ?? "";
    await using var conn = db.Open();
    await conn.OpenAsync();
    var user = Rows.One(await conn.QueryAsync("""
        SELECT u.*, r.name AS role_name, s.id AS surveyor_id
        FROM users u
        INNER JOIN roles r ON r.id=u.role_id
        LEFT JOIN surveyors s ON s.user_id=u.id
        WHERE LOWER(u.email)=@email
        """, new { email }));
    var hash = user == null ? null : Rows.Str(user, "password_hash");
    if (user == null || Rows.Str(user, "status") != "Active" || hash == null || !BCrypt.Net.BCrypt.Verify(password, hash))
        throw new ApiException(401, "Email or password is not recognised.");
    var permissions = (await conn.QueryAsync<string>("SELECT permission_code FROM role_permissions WHERE role_id=@role", new { role = Rows.Int(user, "role_id") })).ToList();
    var session = new CurrentUser
    {
        Id = Rows.Int(user, "id"),
        Name = Rows.Str(user, "name") ?? "",
        Email = Rows.Str(user, "email") ?? "",
        Role = Rows.Str(user, "role_name") ?? "",
        EmployeeId = Rows.Str(user, "employee_id"),
        SurveyorId = user.GetValueOrDefault("surveyor_id") == null ? null : Rows.Int(user, "surveyor_id"),
        Permissions = permissions
    };
    return Results.Json(new Dictionary<string, object?>
    {
        ["token"] = Tokens.Sign(session),
        ["user"] = new Dictionary<string, object?>
        {
            ["id"] = session.Id,
            ["name"] = session.Name,
            ["email"] = session.Email,
            ["role"] = session.Role,
            ["employeeId"] = session.EmployeeId,
            ["surveyorId"] = session.SurveyorId,
            ["permissions"] = session.Permissions
        }
    });
});

app.MapGet("/api/auth/me", (HttpContext ctx) =>
{
    var user = (CurrentUser)ctx.Items["user"]!;
    return Results.Json(new Dictionary<string, object?>
    {
        ["user"] = new Dictionary<string, object?>
        {
            ["id"] = user.Id,
            ["name"] = user.Name,
            ["email"] = user.Email,
            ["role"] = user.Role,
            ["employeeId"] = user.EmployeeId,
            ["surveyorId"] = user.SurveyorId,
            ["permissions"] = user.Permissions
        }
    });
});

app.MapGet("/api/audit", async (HttpContext ctx) =>
{
    var user = (CurrentUser)ctx.Items["user"]!;
    if (!user.Has("audit.view")) throw new ApiException(403, "You do not have permission for this action.");
    await using var conn = db.Open();
    await conn.OpenAsync();
    return Results.Json(Rows.List(await conn.QueryAsync("""
        SELECT TOP 300 a.*, u.name AS user_name
        FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
        ORDER BY a.created_at DESC
        """)));
});

AssessmentEndpoints.Map(app, db);
DashboardEndpoints.Map(app, db);
ReportEndpoints.Map(app, db);
AdminEndpoints.Map(app, db);

app.Run();
