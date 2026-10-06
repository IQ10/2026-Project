using Dapper;

namespace Esa.Api;

public static class DashboardEndpoints
{
    public static void Map(WebApplication app, Database db)
    {
        app.MapGet("/api/dashboard", async (HttpContext ctx) =>
        {
            var user = (CurrentUser)ctx.Items["user"]!;
            await using var conn = db.Open();
            await conn.OpenAsync();

            async Task<List<Dictionary<string, object?>>> Run(string text)
            {
                var p = new DynamicParameters();
                var where = new List<string> { "1=1" };
                if (!user.CanSeeAll)
                {
                    p.Add("surveyorId", user.SurveyorId ?? 0);
                    where.Add("a.surveyor_id=@surveyorId");
                }
                Add(ctx, p, where, "from", "a.assessment_date>=@from");
                Add(ctx, p, where, "to", "a.assessment_date<=@to");
                if (int.TryParse(ctx.Request.Query["dealerId"], out var dealerId))
                {
                    p.Add("dealer", dealerId);
                    where.Add("a.dealer_id=@dealer");
                }
                Add(ctx, p, where, "facilityType", "a.facility_type_snapshot=@ft", "ft");
                if (int.TryParse(ctx.Request.Query["assessmentTypeId"], out var typeId))
                {
                    p.Add("typeId", typeId);
                    where.Add("a.assessment_type_id=@typeId");
                }
                if (user.CanSeeAll && int.TryParse(ctx.Request.Query["surveyorId"], out var surveyorId))
                {
                    p.Add("sid", surveyorId);
                    where.Add("a.surveyor_id=@sid");
                }
                Add(ctx, p, where, "status", "a.status=@status");
                return Rows.List(await conn.QueryAsync(text.Replace("/*W*/", string.Join(" AND ", where)), p));
            }

            var totals = await Run("""
                SELECT COUNT(*) AS total,
                    SUM(CASE WHEN a.status=N'Draft' THEN 1 ELSE 0 END) AS draft,
                    SUM(CASE WHEN a.status=N'In Progress' THEN 1 ELSE 0 END) AS in_progress,
                    SUM(CASE WHEN a.status=N'Submitted' THEN 1 ELSE 0 END) AS submitted,
                    SUM(CASE WHEN a.status=N'Returned' THEN 1 ELSE 0 END) AS returned,
                    SUM(CASE WHEN a.status=N'Approved' THEN 1 ELSE 0 END) AS approved
                FROM assessments a WHERE /*W*/
                """);
            var facilityRows = await Run("SELECT a.facility_type_snapshot AS facility_type, COUNT(*) AS total FROM assessments a WHERE /*W*/ GROUP BY a.facility_type_snapshot");
            var dealerRows = await Run("SELECT TOP 8 d.dealer_name, d.dealer_code, COUNT(*) AS total FROM assessments a INNER JOIN dealers d ON d.id=a.dealer_id WHERE /*W*/ GROUP BY d.dealer_name, d.dealer_code ORDER BY total DESC");
            var trend = await Run("SELECT FORMAT(a.assessment_date, 'yyyy-MM') AS month, COUNT(*) AS total FROM assessments a WHERE /*W*/ GROUP BY FORMAT(a.assessment_date, 'yyyy-MM') ORDER BY month");
            var findings = await Run("""
                SELECT
                    SUM(CASE WHEN o.counts_as IN (N'non_compliant', N'partial') THEN 1 ELSE 0 END) AS findings,
                    SUM(CASE WHEN rr.code=N'CRITICAL' THEN 1 ELSE 0 END) AS critical,
                    SUM(CASE WHEN rr.code=N'MAJOR' THEN 1 ELSE 0 END) AS major
                FROM assessment_responses r
                INNER JOIN assessments a ON a.id=r.assessment_id
                LEFT JOIN response_options o ON o.code=r.response_code
                LEFT JOIN risk_ratings rr ON rr.id=r.risk_rating_id
                WHERE /*W*/
                """);
            var recent = await Run("""
                SELECT TOP 6 a.id, a.assessment_number, a.status, a.assessment_date, a.facility_type_snapshot, d.dealer_name, d.dealer_code
                FROM assessments a INNER JOIN dealers d ON d.id=a.dealer_id WHERE /*W*/ ORDER BY a.updated_at DESC
                """);
            return Results.Json(new Dictionary<string, object?>
            {
                ["totals"] = totals.FirstOrDefault(),
                ["findings"] = findings.FirstOrDefault(),
                ["byFacility"] = facilityRows,
                ["byDealer"] = dealerRows,
                ["trend"] = trend,
                ["recent"] = recent
            });
        });
    }

    private static void Add(HttpContext ctx, DynamicParameters p, List<string> where, string query, string clause, string? param = null)
    {
        var value = ctx.Request.Query[query].ToString();
        if (string.IsNullOrEmpty(value)) return;
        p.Add(param ?? query, value);
        where.Add(clause);
    }
}
