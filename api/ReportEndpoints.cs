using System.Text.Json;
using ClosedXML.Excel;
using Dapper;
using QuestPDF.Fluent;
using QuestPDF.Helpers;
using QuestPDF.Infrastructure;

namespace Esa.Api;

public static class ReportEndpoints
{
    public static void Map(WebApplication app, Database db)
    {
        QuestPDF.Settings.License = LicenseType.Community;
        var group = app.MapGroup("/api/reports");

        group.MapGet("/{id:int}/pdf", async (HttpContext ctx, int id) =>
        {
            var data = await AssessmentEndpoints.LoadAssessment(db, id, (CurrentUser)ctx.Items["user"]!);
            var settings = await Settings(db);
            var assessment = (Dictionary<string, object?>)data["assessment"]!;
            var number = Rows.Str(assessment, "assessment_number") ?? "assessment";
            var pdf = Document.Create(container =>
            {
                container.Page(page =>
                {
                    page.Size(PageSizes.A4);
                    page.Margin(36);
                    page.DefaultTextStyle(text => text.FontSize(10).FontColor("#111111"));
                    page.Header().Background("#0B1F33").Padding(16).Column(column =>
                    {
                        column.Item().Text(settings.GetValueOrDefault("organisation_name") ?? "Electrical Safety Assessment").FontSize(11).FontColor("#F4C95D");
                        column.Item().Text(settings.GetValueOrDefault("report_title") ?? "Electrical Safety Assessment Report").FontSize(16).FontColor("#FFFFFF");
                    });
                    page.Content().PaddingTop(12).Column(column => Draw(column, data, assessment));
                    page.Footer().AlignCenter().Text(text =>
                    {
                        text.Span($"Generated {DateTime.UtcNow:yyyy-MM-dd}   {number}   Page ");
                        text.CurrentPageNumber();
                        text.Span(" of ");
                        text.TotalPages();
                    });
                });
            }).GeneratePdf();
            return Results.File(pdf, "application/pdf", $"{number}.pdf");
        });

        group.MapGet("/{id:int}/xlsx", async (HttpContext ctx, int id) =>
        {
            var data = await AssessmentEndpoints.LoadAssessment(db, id, (CurrentUser)ctx.Items["user"]!);
            var assessment = (Dictionary<string, object?>)data["assessment"]!;
            var dealer = assessment.GetValueOrDefault("dealer_details_snapshot");
            var summary = (Dictionary<string, object?>)data["summary"]!;
            var number = Rows.Str(assessment, "assessment_number") ?? "assessment";
            using var workbook = new XLWorkbook();
            workbook.Properties.Author = "ESA Desk";
            var sheet = workbook.Worksheets.Add("Summary");
            var rows = new (string, object?)[]
            {
                ("Assessment", number),
                ("Type", Rows.Str(assessment, "assessment_type")),
                ("Template", Rows.Str(assessment, "template_version_snapshot")),
                ("Date", Text.Day(assessment.GetValueOrDefault("assessment_date"))),
                ("Status", Rows.Str(assessment, "status")),
                ("Surveyor", Rows.Str(assessment, "surveyor_name")),
                ("Dealer code", Field(dealer, "dealer_code")),
                ("Dealer", Field(dealer, "dealer_name")),
                ("Address", string.Join(", ", new[] { Field(dealer, "address"), Field(dealer, "city"), Field(dealer, "state"), Field(dealer, "postal_code") }.Where(part => !string.IsNullOrEmpty(part)))),
                ("Facility type", Rows.Str(assessment, "facility_type_snapshot")),
                ("Applicable", summary.GetValueOrDefault("applicable")),
                ("NA", summary.GetValueOrDefault("na")),
                ("Compliant", summary.GetValueOrDefault("compliant")),
                ("Non-compliant", summary.GetValueOrDefault("nonCompliant")),
                ("Partial", summary.GetValueOrDefault("partial")),
                ("Compliance %", summary.GetValueOrDefault("compliancePercent"))
            };
            for (var i = 0; i < rows.Length; i++)
            {
                sheet.Cell(i + 1, 1).Value = rows[i].Item1;
                sheet.Cell(i + 1, 2).Value = Convert.ToString(rows[i].Item2) ?? "";
            }
            var checklist = workbook.Worksheets.Add("Checklist");
            var header = checklist.Row(1);
            header.Cell(1).Value = "Section";
            header.Cell(2).Value = "Item";
            header.Cell(3).Value = "Activity";
            header.Cell(4).Value = "Requirement";
            header.Cell(5).Value = "Applicability";
            header.Cell(6).Value = "Response";
            header.Cell(7).Value = "Observation";
            header.Cell(8).Value = "Recommendation";
            header.Cell(9).Value = "Risk";
            header.Cell(10).Value = "Review flag";
            header.Style.Font.Bold = true;
            var line = 2;
            foreach (var section in (List<Dictionary<string, object?>>)data["sections"]!)
            {
                foreach (var item in (List<Dictionary<string, object?>>)section["items"]!)
                {
                    checklist.Cell(line, 1).Value = Rows.Str(section, "name");
                    checklist.Cell(line, 2).Value = Rows.Str(item, "item_number");
                    checklist.Cell(line, 3).Value = Rows.Str(item, "activity_description");
                    checklist.Cell(line, 4).Value = Rows.Str(item, "requirement_description");
                    checklist.Cell(line, 5).Value = Rows.Str(item, "applicability_status");
                    checklist.Cell(line, 6).Value = Rows.Str(item, "response_code");
                    checklist.Cell(line, 7).Value = Rows.Str(item, "observation");
                    checklist.Cell(line, 8).Value = Rows.Str(item, "recommendation");
                    checklist.Cell(line, 9).Value = Rows.Str(item, "risk_name");
                    checklist.Cell(line, 10).Value = Rows.Flag(item, "source_review") ? "Review" : "";
                    line++;
                }
            }
            checklist.Columns().AdjustToContents(1, 40);
            WriteSheet(workbook, "Thermography", ["Sl", "Area", "Equipment", "Location", "Ambient C", "Hotspot C", "Delta C", "Severity"],
                ((List<Dictionary<string, object?>>)data["thermography"]!).Select(row => new object?[] { row.GetValueOrDefault("sl_no"), row.GetValueOrDefault("area"), row.GetValueOrDefault("equipment"), row.GetValueOrDefault("location"), row.GetValueOrDefault("ambient_c"), row.GetValueOrDefault("hotspot_c"), row.GetValueOrDefault("delta_c"), row.GetValueOrDefault("severity") }));
            WriteSheet(workbook, "Load balance", ["Sl", "Area", "Equipment", "L1", "L2", "L3", "Unbalance L1", "L2", "L3", "Finding", "Recommendation"],
                ((List<Dictionary<string, object?>>)data["loadBalance"]!).Select(row => new object?[] { row.GetValueOrDefault("sl_no"), row.GetValueOrDefault("area"), row.GetValueOrDefault("equipment"), row.GetValueOrDefault("l1_a"), row.GetValueOrDefault("l2_a"), row.GetValueOrDefault("l3_a"), row.GetValueOrDefault("unbalance_l1"), row.GetValueOrDefault("unbalance_l2"), row.GetValueOrDefault("unbalance_l3"), row.GetValueOrDefault("finding"), row.GetValueOrDefault("recommendation") }));
            WriteSheet(workbook, "Neutral to earth", ["Sl", "Area", "Equipment", "Voltage V"],
                ((List<Dictionary<string, object?>>)data["neutralEarth"]!).Select(row => new object?[] { row.GetValueOrDefault("sl_no"), row.GetValueOrDefault("area"), row.GetValueOrDefault("equipment"), row.GetValueOrDefault("voltage_v") }));
            await using var stream = new MemoryStream();
            workbook.SaveAs(stream);
            return Results.File(stream.ToArray(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", $"{number}.xlsx");
        });
    }

    private static void Draw(ColumnDescriptor column, Dictionary<string, object?> data, Dictionary<string, object?> assessment)
    {
        var dealer = assessment.GetValueOrDefault("dealer_details_snapshot");
        column.Item().Text(Text.Plain(Rows.Str(assessment, "assessment_number"))).FontSize(12);
        Meta(column, "Assessment type", $"{Rows.Str(assessment, "assessment_type")}  ·  template {Rows.Str(assessment, "template_version_snapshot")}");
        Meta(column, "Date", Text.Day(assessment.GetValueOrDefault("assessment_date")));
        Meta(column, "Status", Rows.Str(assessment, "status"));
        Meta(column, "Surveyor", $"{Rows.Str(assessment, "surveyor_name")}  {Rows.Str(assessment, "surveyor_employee_id")}");
        Meta(column, "Dealer", $"{Field(dealer, "dealer_code")}  {Field(dealer, "dealer_name")}");
        Meta(column, "Address", string.Join(", ", new[] { Field(dealer, "address"), Field(dealer, "city"), Field(dealer, "state"), Field(dealer, "postal_code") }.Where(part => !string.IsNullOrEmpty(part))));
        Meta(column, "Facility type", Text.Facility(Rows.Str(assessment, "facility_type_snapshot")));
        Meta(column, "Contact", string.Join(" · ", new[] { Rows.Str(assessment, "contact_person_snapshot"), Rows.Str(assessment, "contact_number_snapshot"), Rows.Str(assessment, "contact_email_snapshot") }.Where(part => !string.IsNullOrEmpty(part))));
        if (!string.IsNullOrEmpty(Rows.Str(assessment, "reference_number"))) Meta(column, "Reference", Rows.Str(assessment, "reference_number"));
        if (!string.IsNullOrEmpty(Rows.Str(assessment, "reviewer_name"))) Meta(column, "Reviewer", Rows.Str(assessment, "reviewer_name"));
        var summary = (Dictionary<string, object?>)data["summary"]!;
        column.Item().PaddingTop(8).Text("Summary").FontSize(13).FontColor("#0B1F33");
        column.Item().Text($"Items {summary["total"]}   Applicable {summary["applicable"]}   NA {summary["na"]}   Compliant {summary["compliant"]}   Non-compliant {summary["nonCompliant"]}   Partial {summary["partial"]}   Compliance {summary["compliancePercent"]}%");
        column.Item().Text("NA items are excluded from the compliance percentage.");
        foreach (var narrative in (List<Dictionary<string, object?>>)data["narratives"]!)
        {
            column.Item().PaddingTop(8).Text(Rows.Str(narrative, "title") ?? "").FontSize(13).FontColor("#0B1F33");
            column.Item().Text(Text.Plain(Rows.Str(narrative, "body")));
        }
        column.Item().PaddingTop(8).Text("Checklist").FontSize(13).FontColor("#0B1F33");
        foreach (var section in (List<Dictionary<string, object?>>)data["sections"]!)
        {
            column.Item().PaddingTop(6).Text(Rows.Str(section, "name") ?? "").FontSize(12).FontColor("#0B1F33");
            foreach (var item in (List<Dictionary<string, object?>>)section["items"]!)
            {
                column.Item().PaddingTop(4).Text($"{Rows.Str(item, "item_number")}. {Text.Plain(Rows.Str(item, "activity_description"))}").FontColor("#0B1F33");
                column.Item().Text(Text.Plain(Rows.Str(item, "requirement_description"))).FontSize(9).FontColor("#444444");
                column.Item().Text($"Applicability: {Rows.Str(item, "applicability_status")}    Response: {Rows.Str(item, "response_code") ?? "—"}    Risk: {Rows.Str(item, "risk_name") ?? "—"}");
                if (!string.IsNullOrEmpty(Rows.Str(item, "observation"))) column.Item().Text($"Observation: {Text.Plain(Rows.Str(item, "observation"))}");
                if (!string.IsNullOrEmpty(Rows.Str(item, "recommendation"))) column.Item().Text($"Recommendation: {Text.Plain(Rows.Str(item, "recommendation"))}");
                if (Rows.Flag(item, "source_review")) column.Item().Text("Flagged for administrator confirmation of the source wording.").FontColor("#8A5A00");
            }
        }
        DrawReadings(column, "Thermography", (List<Dictionary<string, object?>>)data["thermography"]!, row =>
            $"{row.GetValueOrDefault("sl_no")}. {Text.Plain(row.GetValueOrDefault("area"))} — {Text.Plain(row.GetValueOrDefault("equipment"))} / {Text.Plain(row.GetValueOrDefault("location"))}   ambient {row.GetValueOrDefault("ambient_c")}°C   hotspot {row.GetValueOrDefault("hotspot_c")}°C   ΔT {row.GetValueOrDefault("delta_c")}°C   {row.GetValueOrDefault("severity")}");
        DrawReadings(column, "Load balance", (List<Dictionary<string, object?>>)data["loadBalance"]!, row =>
            $"{Text.Plain(row.GetValueOrDefault("area"))} {Text.Plain(row.GetValueOrDefault("equipment"))}   L1 {row.GetValueOrDefault("l1_a")} A   L2 {row.GetValueOrDefault("l2_a")} A   L3 {row.GetValueOrDefault("l3_a")} A   unbalance {row.GetValueOrDefault("unbalance_l1")}% / {row.GetValueOrDefault("unbalance_l2")}% / {row.GetValueOrDefault("unbalance_l3")}%");
        DrawReadings(column, "Neutral to earth voltage", (List<Dictionary<string, object?>>)data["neutralEarth"]!, row =>
            $"{row.GetValueOrDefault("sl_no")}. {Text.Plain(row.GetValueOrDefault("area"))} — {Text.Plain(row.GetValueOrDefault("equipment"))}   {row.GetValueOrDefault("voltage_v")} V");
    }

    private static void DrawReadings(ColumnDescriptor column, string title, List<Dictionary<string, object?>> rows, Func<Dictionary<string, object?>, string> line)
    {
        if (rows.Count == 0) return;
        column.Item().PaddingTop(8).Text(title).FontSize(13).FontColor("#0B1F33");
        foreach (var row in rows) column.Item().Text(line(row)).FontSize(9);
    }

    private static void Meta(ColumnDescriptor column, string label, string? value) =>
        column.Item().Text(text =>
        {
            text.Span(label).FontColor("#555555");
            text.Span("   " + (string.IsNullOrEmpty(value) ? "—" : Text.Plain(value)));
        });

    private static void WriteSheet(XLWorkbook workbook, string name, string[] headers, IEnumerable<object?[]> rows)
    {
        var sheet = workbook.Worksheets.Add(name);
        for (var i = 0; i < headers.Length; i++) sheet.Cell(1, i + 1).Value = headers[i];
        sheet.Row(1).Style.Font.Bold = true;
        var line = 2;
        foreach (var row in rows)
        {
            for (var i = 0; i < row.Length; i++) sheet.Cell(line, i + 1).Value = Convert.ToString(row[i]) ?? "";
            line++;
        }
    }

    private static string? Field(object? source, string key)
    {
        if (source is JsonElement element && element.ValueKind == JsonValueKind.Object && element.TryGetProperty(key, out var value))
            return value.ValueKind == JsonValueKind.Null ? null : value.ValueKind == JsonValueKind.String ? value.GetString() : value.ToString();
        if (source is Dictionary<string, object?> dealer && dealer.TryGetValue(key, out var raw) && raw != null)
            return Convert.ToString(raw);
        return null;
    }

    private static async Task<Dictionary<string, string>> Settings(Database db)
    {
        await using var conn = db.Open();
        await conn.OpenAsync();
        var rows = Rows.List(await conn.QueryAsync("SELECT setting_key, setting_value FROM system_settings"));
        return rows.ToDictionary(row => Rows.Str(row, "setting_key") ?? "", row => Rows.Str(row, "setting_value") ?? "");
    }
}
