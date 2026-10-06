using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.IdentityModel.Tokens;

namespace Esa.Api;

public sealed class ApiException : Exception
{
    public int Status { get; }
    public Dictionary<string, object?> Body { get; }

    public ApiException(int status, string message, string? extraName = null, object? extra = null) : base(message)
    {
        Status = status;
        Body = new Dictionary<string, object?> { ["error"] = message };
        if (extraName != null) Body[extraName] = extra;
    }
}

public sealed class CurrentUser
{
    public int Id { get; init; }
    public string Name { get; init; } = "";
    public string Email { get; init; } = "";
    public string Role { get; init; } = "";
    public string? EmployeeId { get; init; }
    public int? SurveyorId { get; init; }
    public List<string> Permissions { get; init; } = new();
    public bool CanSeeAll => Permissions.Contains("assessments.view.all");
    public bool Has(string code) => Permissions.Contains(code);
}

public static class DotEnv
{
    public static void Load()
    {
        foreach (var path in new[]
        {
            Path.Combine(Directory.GetCurrentDirectory(), ".env"),
            Path.Combine(AppContext.BaseDirectory, ".env")
        })
        {
            if (!File.Exists(path)) continue;
            foreach (var raw in File.ReadAllLines(path))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line.StartsWith('#')) continue;
                var eq = line.IndexOf('=');
                if (eq < 1) continue;
                var key = line[..eq].Trim();
                var value = line[(eq + 1)..].Trim().Trim('"');
                if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable(key)))
                    Environment.SetEnvironmentVariable(key, value);
            }
        }
    }
}

public sealed class Database
{
    public string ConnectionString { get; }

    public Database()
    {
        DotEnv.Load();
        var server = Environment.GetEnvironmentVariable("DB_SERVER") ?? "127.0.0.1";
        var port = Environment.GetEnvironmentVariable("DB_PORT") ?? "1433";
        var user = Environment.GetEnvironmentVariable("DB_USER") ?? "sa";
        var password = Environment.GetEnvironmentVariable("DB_PASSWORD") ?? "Esa@Sql#2026!";
        var name = Environment.GetEnvironmentVariable("DB_NAME") ?? "EsaManagement";
        ConnectionString =
            $"Server={server},{port};Database={name};User ID={user};Password={password};Encrypt=True;TrustServerCertificate=True;Connect Timeout=30;";
    }

    public SqlConnection Open() => new(ConnectionString);
}

public static class Rows
{
    public static List<Dictionary<string, object?>> List(IEnumerable<dynamic> rows)
    {
        var list = new List<Dictionary<string, object?>>();
        foreach (IDictionary<string, object> row in rows.Cast<IDictionary<string, object>>())
        {
            var copy = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var pair in row) copy[pair.Key] = Box(pair.Value);
            list.Add(copy);
        }
        return list;
    }

    public static Dictionary<string, object?>? One(IEnumerable<dynamic> rows) => List(rows).FirstOrDefault();

    public static object? Box(object? value) => value switch
    {
        null or DBNull => null,
        DateTime dt => DateTime.SpecifyKind(dt, DateTimeKind.Utc),
        _ => value
    };

    public static int Int(Dictionary<string, object?> row, string key) => Convert.ToInt32(row[key], CultureInfo.InvariantCulture);

    public static string? Str(Dictionary<string, object?> row, string key) => row.TryGetValue(key, out var value) && value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : null;

    public static bool Flag(Dictionary<string, object?> row, string key) => row.TryGetValue(key, out var value) && value is true or 1 or (byte)1 or (short)1;

    public static object? JsonOrRaw(object? value)
    {
        if (value is not string text || text.Length == 0) return value;
        try { return JsonNodeOf(text); }
        catch { return value; }
    }

    public static JsonElement JsonNodeOf(string text) => JsonSerializer.Deserialize<JsonElement>(text);
}

public static class Audit
{
    public static Task Write(SqlConnection conn, SqlTransaction? tx, int? userId, string entityType, object? entityId, string action, object? oldValue, object? newValue) =>
        conn.ExecuteAsync("""
            INSERT INTO audit_logs(user_id, entity_type, entity_id, action, old_value, new_value)
            VALUES (@userId, @entityType, @entityId, @action, @oldValue, @newValue)
            """, new
        {
            userId,
            entityType,
            entityId = entityId == null ? null : Convert.ToString(entityId, CultureInfo.InvariantCulture),
            action,
            oldValue = oldValue == null ? null : JsonSerializer.Serialize(oldValue),
            newValue = newValue == null ? null : JsonSerializer.Serialize(newValue)
        }, tx);
}

public static class Tokens
{
    public static string Secret => Environment.GetEnvironmentVariable("JWT_SECRET") ?? "esa-desk-dev-secret-change-me";
    private static byte[] KeyBytes => SHA256.HashData(Encoding.UTF8.GetBytes(Secret));

    public static string Sign(CurrentUser user)
    {
        var key = new SymmetricSecurityKey(KeyBytes);
        var payload = new JwtPayload
        {
            ["id"] = user.Id,
            ["name"] = user.Name,
            ["email"] = user.Email,
            ["role"] = user.Role,
            ["employeeId"] = user.EmployeeId,
            ["surveyorId"] = user.SurveyorId,
            ["permissions"] = user.Permissions,
            ["exp"] = DateTimeOffset.UtcNow.AddHours(12).ToUnixTimeSeconds()
        };
        var token = new JwtSecurityToken(new JwtHeader(new SigningCredentials(key, SecurityAlgorithms.HmacSha256)), payload);
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    public static CurrentUser Read(string token)
    {
        var handler = new JwtSecurityTokenHandler();
        handler.ValidateToken(token, new TokenValidationParameters
        {
            ValidateIssuer = false,
            ValidateAudience = false,
            ValidateLifetime = true,
            IssuerSigningKey = new SymmetricSecurityKey(KeyBytes),
            ClockSkew = TimeSpan.FromMinutes(1),
            NameClaimType = ClaimTypes.Name
        }, out _);
        var jwt = handler.ReadJwtToken(token);
        return new CurrentUser
        {
            Id = Convert.ToInt32(jwt.Payload["id"], CultureInfo.InvariantCulture),
            Name = jwt.Payload["name"]?.ToString() ?? "",
            Email = jwt.Payload["email"]?.ToString() ?? "",
            Role = jwt.Payload["role"]?.ToString() ?? "",
            EmployeeId = jwt.Payload["employeeId"]?.ToString(),
            SurveyorId = ReadInt(jwt.Payload, "surveyorId"),
            Permissions = ReadPermissions(jwt.Payload["permissions"])
        };
    }

    private static int? ReadInt(JwtPayload payload, string name)
    {
        if (!payload.TryGetValue(name, out var value) || value == null) return null;
        if (value is JsonElement element)
        {
            if (element.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return null;
            if (element.ValueKind == JsonValueKind.Number) return element.GetInt32();
            return int.TryParse(element.ToString(), out var parsed) ? parsed : null;
        }
        return Convert.ToInt32(value, CultureInfo.InvariantCulture);
    }

    private static List<string> ReadPermissions(object? value)
    {
        if (value is JsonElement element && element.ValueKind == JsonValueKind.Array)
            return element.EnumerateArray().Select(item => item.GetString() ?? "").Where(item => item.Length > 0).ToList();
        if (value is IEnumerable<object> objects)
            return objects.Select(item => item?.ToString() ?? "").Where(item => item.Length > 0).ToList();
        if (value is string text && text.StartsWith('['))
            return JsonSerializer.Deserialize<List<string>>(text) ?? new List<string>();
        return new List<string>();
    }
}

public static class JsonBody
{
    public static bool Has(JsonElement body, string name) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Undefined;

    public static string? Str(JsonElement body, string name)
    {
        if (!Has(body, name)) return null;
        var value = body.GetProperty(name);
        if (value.ValueKind is JsonValueKind.Null) return null;
        return value.ValueKind == JsonValueKind.String ? value.GetString() : value.ToString();
    }

    public static int? Int(JsonElement body, string name)
    {
        if (!Has(body, name) || body.GetProperty(name).ValueKind is JsonValueKind.Null) return null;
        var value = body.GetProperty(name);
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)) return number;
        return int.TryParse(value.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : null;
    }

    public static bool Bool(JsonElement body, string name)
    {
        if (!Has(body, name)) return false;
        var value = body.GetProperty(name);
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Number => value.TryGetInt32(out var number) && number != 0,
            JsonValueKind.String => value.GetString() is "1" or "true" or "True",
            _ => false
        };
    }

    public static List<JsonElement> Arr(JsonElement body, string name)
    {
        if (!Has(body, name) || body.GetProperty(name).ValueKind != JsonValueKind.Array) return new List<JsonElement>();
        return body.GetProperty(name).EnumerateArray().ToList();
    }

    public static object? Sql(JsonElement value, bool emptyAsNull)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Null:
            case JsonValueKind.Undefined:
                return null;
            case JsonValueKind.String:
                var text = value.GetString();
                return emptyAsNull && string.IsNullOrEmpty(text) ? null : text;
            case JsonValueKind.True:
                return true;
            case JsonValueKind.False:
                return false;
            case JsonValueKind.Number:
                if (value.TryGetInt32(out var number)) return number;
                if (value.TryGetInt64(out var longNumber)) return longNumber;
                return value.GetDecimal();
            default:
                return value.ToString();
        }
    }

    public static decimal? Num(JsonElement row, string name)
    {
        if (row.ValueKind != JsonValueKind.Object || !row.TryGetProperty(name, out var value)) return null;
        if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return null;
        if (value.ValueKind == JsonValueKind.String && string.IsNullOrWhiteSpace(value.GetString())) return null;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out var number)) return number;
        return decimal.TryParse(value.ToString(), NumberStyles.Number, CultureInfo.InvariantCulture, out var parsed) ? parsed : null;
    }

    public static async Task<JsonElement> Read(HttpRequest request)
    {
        if (request.ContentLength is 0 or null && !request.Body.CanSeek) return default;
        try
        {
            var body = await JsonSerializer.DeserializeAsync<JsonElement>(request.Body);
            return body.ValueKind == JsonValueKind.Object ? body : default;
        }
        catch (JsonException)
        {
            throw new ApiException(400, "The request body must be JSON.");
        }
    }
}
