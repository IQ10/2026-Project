using System.Globalization;

namespace Esa.Api;

public sealed record ResolvedRule(string Status, string? Response, bool Locked, bool Review, string? Reason);

public static class Applicability
{
    public static ResolvedRule Resolve(Dictionary<string, object?>? rule, IReadOnlyDictionary<string, bool> attributes)
    {
        if (rule == null || IsInactive(rule))
        {
            return new ResolvedRule("Unconfigured", null, false, true, "No active applicability rule for this checklist item and facility type.");
        }

        var status = Rows.Str(rule, "applicability_status");
        if (status == "Applicable")
        {
            return new ResolvedRule("Applicable", Blank(Rows.Str(rule, "default_response")), false, Rows.Flag(rule, "review_required"), null);
        }

        if (status == "Not Applicable")
        {
            return new ResolvedRule("Not Applicable", "NA", true, Rows.Flag(rule, "review_required"), "Not applicable for this facility type.");
        }

        if (status == "Conditional")
        {
            var attr = Rows.Str(rule, "conditional_attribute");
            if (string.IsNullOrEmpty(attr) || !attributes.ContainsKey(attr))
            {
                return new ResolvedRule("Unconfigured", null, false, true, $"Conditional rule requires facility attribute \"{attr ?? "(missing)"}\". It was not configured, so the item was left unanswered.");
            }
            if (attributes[attr] != true)
            {
                return new ResolvedRule("Not Applicable", "NA", true, Rows.Flag(rule, "review_required"), $"Facility attribute {attr} is not present, so this item defaults to NA.");
            }
            var remarks = Rows.Str(rule, "remarks");
            return new ResolvedRule("Applicable", Blank(Rows.Str(rule, "default_response")), false, Rows.Flag(rule, "review_required"), string.IsNullOrEmpty(remarks) ? $"Applicable because {attr} is present at this facility." : remarks);
        }

        return new ResolvedRule("Unconfigured", null, false, true, $"Unsupported applicability status \"{status}\".");
    }

    public static Dictionary<string, object?> Snapshot(Dictionary<string, object?>? rule, ResolvedRule resolved, string facilityType) => new()
    {
        ["facilityType"] = facilityType,
        ["ruleId"] = rule == null ? null : Rows.Int(rule, "id"),
        ["configuredStatus"] = rule == null ? null : Rows.Str(rule, "applicability_status"),
        ["conditionalAttribute"] = rule == null ? null : Rows.Str(rule, "conditional_attribute"),
        ["resolvedStatus"] = resolved.Status,
        ["locked"] = resolved.Locked,
        ["review"] = resolved.Review,
        ["reason"] = resolved.Reason
    };

    private static bool IsInactive(Dictionary<string, object?> rule) =>
        rule.TryGetValue("active_status", out var value) && value is false or 0 or (byte)0 or (short)0;

    private static string? Blank(string? value) => string.IsNullOrEmpty(value) || value == "Blank" ? null : value;
}

public static class Compliance
{
    public static Dictionary<string, object?> Summarise(IReadOnlyList<Dictionary<string, object?>> responses, bool excludeNa = true)
    {
        var summary = new Dictionary<string, object?>
        {
            ["total"] = responses.Count,
            ["applicable"] = 0,
            ["na"] = 0,
            ["unconfigured"] = 0,
            ["completedApplicable"] = 0,
            ["compliant"] = 0,
            ["nonCompliant"] = 0,
            ["partial"] = 0,
            ["notAssessed"] = 0,
            ["openFindings"] = 0,
            ["byRisk"] = new Dictionary<string, int>(),
            ["bySection"] = new Dictionary<string, Dictionary<string, int>>()
        };
        var bySection = (Dictionary<string, Dictionary<string, int>>)summary["bySection"]!;
        var byRisk = (Dictionary<string, int>)summary["byRisk"]!;

        foreach (var row in responses)
        {
            var section = Rows.Str(row, "section_name") ?? "Unsectioned";
            if (!bySection.TryGetValue(section, out var bucket))
            {
                bucket = new Dictionary<string, int> { ["applicable"] = 0, ["compliant"] = 0, ["nonCompliant"] = 0, ["partial"] = 0, ["na"] = 0, ["findings"] = 0 };
                bySection[section] = bucket;
            }

            var applicability = Rows.Str(row, "applicability_status");
            var responseCode = Rows.Str(row, "response_code");
            var isNa = applicability == "Not Applicable" || responseCode == "NA";
            if (applicability == "Unconfigured")
            {
                Add(summary, "unconfigured");
                continue;
            }
            if (isNa)
            {
                Add(summary, "na");
                bucket["na"]++;
                if (!excludeNa) Add(summary, "applicable");
                continue;
            }

            Add(summary, "applicable");
            bucket["applicable"]++;
            var counts = Rows.Str(row, "counts_as") ?? (responseCode != null ? "not_assessed" : null);
            if (responseCode == null)
            {
                Add(summary, "notAssessed");
                continue;
            }
            Add(summary, "completedApplicable");
            if (counts == "compliant") { Add(summary, "compliant"); bucket["compliant"]++; }
            else if (counts == "non_compliant") { Add(summary, "nonCompliant"); bucket["nonCompliant"]++; Add(summary, "openFindings"); bucket["findings"]++; }
            else if (counts == "partial") { Add(summary, "partial"); bucket["partial"]++; Add(summary, "openFindings"); bucket["findings"]++; }
            else if (counts == "na")
            {
                Add(summary, "na");
                Add(summary, "applicable", -1);
                bucket["applicable"]--;
                bucket["na"]++;
            }
            else Add(summary, "notAssessed");

            var risk = Rows.Str(row, "risk_code");
            if (!string.IsNullOrEmpty(risk)) byRisk[risk] = byRisk.GetValueOrDefault(risk) + 1;
        }

        var denom = (int)summary["applicable"]!;
        summary["compliancePercent"] = Percent((int)summary["compliant"]!, denom);
        var riskPercent = new Dictionary<string, decimal>();
        foreach (var pair in byRisk) riskPercent[pair.Key] = Percent(pair.Value, denom);
        summary["riskPercent"] = riskPercent;
        return summary;
    }

    private static void Add(Dictionary<string, object?> summary, string key, int delta = 1) =>
        summary[key] = (int)summary[key]! + delta;

    private static decimal Percent(int part, int denom) =>
        denom == 0 ? 0 : Math.Round(part * 10000m / denom, 0, MidpointRounding.AwayFromZero) / 100m;
}

public static class Text
{
    public static string Plain(object? value) =>
        Convert.ToString(value, CultureInfo.InvariantCulture)?.Replace('–', '-').Replace('—', '-').Replace('\u2018', '\'').Replace('\u2019', '\'').Replace('\u201C', '"').Replace('\u201D', '"') ?? "";

    public static string Day(object? value)
    {
        if (value == null) return "";
        if (value is DateTime dt) return dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var text = Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
        return text.Length >= 10 ? text[..10] : text;
    }

    public static string Facility(string? code) => code switch
    {
        "1S" => "1S sales",
        "2S" => "2S service and spares",
        "3S" => "3S sales, service and spares",
        _ => code ?? ""
    };

    public static int Year(string? date)
    {
        if (!string.IsNullOrWhiteSpace(date) && DateTime.TryParse(date, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsed))
            return parsed.Year;
        return DateTime.UtcNow.Year;
    }
}
