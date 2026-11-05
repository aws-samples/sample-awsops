"""
AWS CloudWatch MCP Lambda - Metrics, Alarms, Logs, Log Insights
AWS CloudWatch MCP 람다 - 지표, 알람, 로그, 로그 인사이트
"""
import json
import math
import time
from datetime import datetime, timedelta, timezone
from cross_account import cap_list, get_client, get_role_arn, resolve_tool_name


METRIC_STATISTICS = {"Average", "Minimum", "Maximum", "Sum", "SampleCount", "p50", "p90", "p95", "p99"}
METRIC_UNITS = {
    "Seconds", "Microseconds", "Milliseconds", "Bytes", "Kilobytes", "Megabytes",
    "Gigabytes", "Terabytes", "Bits", "Kilobits", "Megabits", "Gigabits", "Terabits",
    "Percent", "Count", "Bytes/Second", "Kilobytes/Second", "Megabytes/Second",
    "Gigabytes/Second", "Terabytes/Second", "Bits/Second", "Kilobits/Second",
    "Megabits/Second", "Gigabits/Second", "Terabits/Second", "Count/Second", "None",
}


def _metric_text(value, limit=255):
    return (isinstance(value, str) and bool(value.strip()) and len(value) <= limit
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def _metric_dimensions(value):
    if isinstance(value, dict):
        dimensions = [{"Name": key, "Value": item} for key, item in value.items()]
    elif isinstance(value, list):
        dimensions = value
    else:
        raise ValueError("Invalid metric dimensions")
    if len(dimensions) > 30 or any(
            not isinstance(item, dict) or set(item) != {"Name", "Value"}
            or not _metric_text(item["Name"]) or not _metric_text(item["Value"], 1024)
            for item in dimensions):
        raise ValueError("Invalid metric dimensions")
    if len({item["Name"] for item in dimensions}) != len(dimensions):
        raise ValueError("Duplicate metric dimensions")
    return dimensions


def _metric_request(args, metadata=False):
    namespace = args.get("namespace", "AWS/EC2")
    if not _metric_text(namespace):
        raise ValueError("Invalid metric namespace")
    request = {"Namespace": namespace}
    metric_name = args.get("metric_name", "" if metadata else "CPUUtilization")
    if not metadata or metric_name not in (None, ""):
        if not _metric_text(metric_name):
            raise ValueError("Invalid metric name")
        request["MetricName"] = metric_name
    dimensions = _metric_dimensions(args.get("dimensions", {}))
    if not metadata or dimensions:
        request["Dimensions"] = dimensions
    if metadata:
        return request
    stat, minutes, period = args.get("statistic", "Average"), args.get("minutes", 60), args.get("period", 300)
    if not isinstance(stat, str) or stat not in METRIC_STATISTICS:
        raise ValueError("Unsupported metric statistic")
    if type(minutes) is not int or not 1 <= minutes <= 20160:
        raise ValueError("Metric minutes must be an integer from 1 to 20160")
    if type(period) is not int or not 60 <= period <= 2147483647 or period % 60:
        raise ValueError("Metric period must be a positive multiple of 60 seconds")
    if math.ceil(minutes * 60 / period) > 1440:
        raise ValueError("Metric window exceeds 1440 datapoints; increase period")
    unit = args.get("unit")
    if unit is not None:
        if not isinstance(unit, str) or unit not in METRIC_UNITS:
            raise ValueError("Unsupported metric unit")
        request["Unit"] = unit
    end = datetime.now(timezone.utc)
    request.update(StartTime=end - timedelta(minutes=minutes), EndTime=end, Period=period)
    request["ExtendedStatistics" if stat.startswith("p") else "Statistics"] = [stat]
    return request


def lambda_handler(event, context):
    # Parse event and route to appropriate tool handler / 이벤트 파싱 후 적절한 도구 핸들러로 라우팅
    params = event if isinstance(event, dict) else json.loads(event)
    t = resolve_tool_name(params, context)
    args = params.get("arguments", params)
    target_account_id = args.pop('target_account_id', None)
    role_arn = get_role_arn(target_account_id) if target_account_id else None
    region = args.get("region", "ap-northeast-2")

    # Auto-detect tool from parameters if not specified / tool_name 미지정 시 파라미터로 도구 자동 감지
    if not t:
        if "query" in params and "log_group" in params: t = "execute_log_insights_query"
        elif "query_id" in params: t = "get_logs_insight_query_results"
        elif "alarm_name" in params: t = "get_alarm_history"
        elif "metric_name" in params and "analyze" in str(params).lower(): t = "analyze_metric"
        elif "metric_name" in params: t = "get_metric_data"
        elif "log_group" in params: t = "analyze_log_group"
        elif "alarm" in str(params).lower(): t = "get_active_alarms"
        else: t = "describe_log_groups"
        args = params

    try:
        metric_request = None
        if t in ("get_metric_data", "get_metric_metadata"):
            try:
                metric_request = _metric_request(args, metadata=t == "get_metric_metadata")
            except ValueError as invalid:
                return err(str(invalid))
        cw = get_client('cloudwatch', region, role_arn)
        logs = get_client('logs', region, role_arn)

        # ========== Metrics / 지표 ==========
        # Get metric statistics for a given time range / 지정 시간 범위의 지표 통계 조회
        if t == "get_metric_data":
            stat = args.get("statistic", "Average")
            # Retrieve metric statistics from CloudWatch / CloudWatch에서 지표 통계 조회
            resp = cw.get_metric_statistics(**metric_request)
            datapoints = sorted(resp.get("Datapoints", []), key=lambda x: x.get("Timestamp", ""))
            # Keep the LATEST 30 points and say when older ones were dropped.
            latest, meta = cap_list(list(reversed(datapoints)), 30)
            latest.reverse()
            def metric_value(point):
                value = point.get("ExtendedStatistics", {}).get(stat) if stat.startswith("p") else point.get(stat)
                return round(value, 4) if type(value) in (int, float) and math.isfinite(value) else None
            return ok({**meta, "kept": "latest", "region": region, "namespace": metric_request["Namespace"],
                "metricName": metric_request["MetricName"], "statistic": stat, "period": metric_request["Period"],
                "windowStart": metric_request["StartTime"].isoformat(), "windowEnd": metric_request["EndTime"].isoformat(),
                "datapoints": [{"timestamp": str(d["Timestamp"]), "value": metric_value(d)} for d in latest]})

        # Get metric metadata (available dimensions) / 지표 메타데이터 (사용 가능한 차원) 조회
        elif t == "get_metric_metadata":
            resp = cw.list_metrics(**metric_request)
            metrics, meta = cap_list(resp.get("Metrics", []), 20, bool(resp.get("NextToken")))
            return ok({**meta, "region": region, "namespace": metric_request["Namespace"], "metrics": [
                {"name": m["MetricName"], "dimensions": {d["Name"]: d["Value"] for d in m.get("Dimensions", [])}}
                for m in metrics]})

        # Analyze 24h metric trend (avg/max/min) / 24시간 지표 추세 분석 (평균/최대/최소)
        elif t == "analyze_metric":
            namespace = args.get("namespace", "AWS/EC2")
            metric_name = args.get("metric_name", "CPUUtilization")
            dimensions = args.get("dimensions", {})
            dim_list = [{"Name": k, "Value": v} for k, v in dimensions.items()] if isinstance(dimensions, dict) else dimensions
            end = datetime.utcnow()
            start = end - timedelta(hours=24)

            # Fetch 24h metric data with hourly granularity / 1시간 간격으로 24시간 지표 데이터 조회
            resp = cw.get_metric_statistics(
                Namespace=namespace, MetricName=metric_name,
                Dimensions=dim_list, StartTime=start, EndTime=end,
                Period=3600, Statistics=["Average", "Maximum", "Minimum"])
            dps = sorted(resp.get("Datapoints", []), key=lambda x: x.get("Timestamp", ""))

            if dps:
                avgs = [d.get("Average", 0) for d in dps]
                maxs = [d.get("Maximum", 0) for d in dps]
                avg_val = sum(avgs) / len(avgs)
                max_val = max(maxs)
                min_val = min(d.get("Minimum", 0) for d in dps)
                trend = "increasing" if len(avgs) > 1 and avgs[-1] > avgs[0] * 1.1 else "decreasing" if len(avgs) > 1 and avgs[-1] < avgs[0] * 0.9 else "stable"
                return ok({"metric": metric_name, "namespace": namespace, "period": "24h",
                    "average": round(avg_val, 2), "max": round(max_val, 2), "min": round(min_val, 2),
                    "trend": trend, "datapoints": len(dps)})
            return ok({"metric": metric_name, "message": "No datapoints found"})

        # Get recommended alarm thresholds for common metrics / 주요 지표의 권장 알람 임계값 조회
        elif t == "get_recommended_metric_alarms":
            namespace = args.get("namespace", "AWS/EC2")
            metric_name = args.get("metric_name", "CPUUtilization")
            recommendations = {
                "CPUUtilization": {"threshold": 80, "comparison": "GreaterThanThreshold", "period": 300, "evaluationPeriods": 3},
                "MemoryUtilization": {"threshold": 85, "comparison": "GreaterThanThreshold", "period": 300, "evaluationPeriods": 3},
                "StatusCheckFailed": {"threshold": 0, "comparison": "GreaterThanThreshold", "period": 60, "evaluationPeriods": 2},
                "NetworkIn": {"threshold": 1000000000, "comparison": "GreaterThanThreshold", "period": 300, "evaluationPeriods": 3},
                "DiskReadOps": {"threshold": 10000, "comparison": "GreaterThanThreshold", "period": 300, "evaluationPeriods": 3},
            }
            rec = recommendations.get(metric_name, {"threshold": "auto", "comparison": "GreaterThanThreshold", "period": 300, "evaluationPeriods": 3})
            return ok({"metric": metric_name, "namespace": namespace, "recommendation": rec,
                "note": "Adjust threshold based on your baseline workload"})

        # ========== Alarms / 알람 ==========
        # Get all currently active (ALARM state) alarms / 현재 활성(ALARM 상태) 알람 전체 조회
        elif t == "get_active_alarms":
            # Describe alarms in ALARM state / ALARM 상태의 알람 조회
            # AlarmTypes: without it only metric alarms come back, so composite-only incidents read as none.
            resp = cw.describe_alarms(StateValue="ALARM", AlarmTypes=["CompositeAlarm", "MetricAlarm"])
            firing = ([dict(a, _type="metric") for a in resp.get("MetricAlarms", [])]
                      + [dict(a, _type="composite") for a in resp.get("CompositeAlarms", [])])
            composite = [a for a in firing if a["_type"] == "composite"]
            metric = [a for a in firing if a["_type"] == "metric"]
            # Composite alarms first; metric alarms fill the remaining slots (within this one API page).
            kept = composite[:20]
            kept += metric[:20 - len(kept)]
            # Metadata reflects what was shown.
            _, meta = cap_list(firing, len(kept), bool(resp.get("NextToken")))
            alarms = [{"name": a["AlarmName"], "type": a["_type"], "metric": a.get("MetricName", ""),
                "namespace": a.get("Namespace", ""), "state": a["StateValue"],
                "reason": a.get("StateReason", "")[:150],
                "threshold": a.get("Threshold"), "comparison": a.get("ComparisonOperator", ""),
                "rule": (a.get("AlarmRule") or "")[:200] if a["_type"] == "composite" else None,
                "updatedAt": str(a.get("StateUpdatedTimestamp", ""))}
                for a in kept]
            return ok({**meta, "region": region, "activeAlarms": alarms, "count": len(alarms)})

        # Get alarm state change history / 알람 상태 변경 이력 조회
        elif t == "get_alarm_history":
            alarm_name = args.get("alarm_name", "")
            days = args.get("days", 7)
            end = datetime.utcnow()
            start = end - timedelta(days=days)
            resp = cw.describe_alarm_history(
                AlarmName=alarm_name, StartDate=start, EndDate=end,
                HistoryItemType="StateUpdate", MaxRecords=20)
            items, meta = cap_list(resp.get("AlarmHistoryItems", []), 20, bool(resp.get("NextToken")))
            history = [{"timestamp": str(h.get("Timestamp", "")),
                "summary": h.get("HistorySummary", ""), "type": h.get("HistoryItemType", "")}
                for h in items]
            return ok({**meta, "region": region, "alarmName": alarm_name, "history": history})

        # ========== Logs / 로그 ==========
        # List CloudWatch log groups / CloudWatch 로그 그룹 목록 조회
        elif t == "describe_log_groups":
            prefix = args.get("prefix", "")
            kwargs = {"limit": 20}
            if prefix: kwargs["logGroupNamePrefix"] = prefix
            resp = logs.describe_log_groups(**kwargs)
            # The cap is API-side (limit=20), so only nextToken can say more groups exist.
            kept, meta = cap_list(resp.get("logGroups", []), 20, bool(resp.get("nextToken")))
            groups = [{"name": g["logGroupName"], "storedBytes": g.get("storedBytes", 0),
                "retentionDays": g.get("retentionInDays", "Never expires"),
                "createdAt": str(datetime.fromtimestamp(g.get("creationTime", 0) / 1000))}
                for g in kept]
            return ok({**meta, "region": region, "logGroups": groups, "count": len(groups)})

        # Filter and analyze log events by pattern / 패턴으로 로그 이벤트 필터링 및 분석
        elif t == "analyze_log_group":
            log_group = args.get("log_group", "")
            minutes = args.get("minutes", 30)
            start_time = int((time.time() - minutes * 60) * 1000)
            filter_pattern = args.get("filter_pattern", "ERROR")

            # Filter log events by pattern and time range / 패턴과 시간 범위로 로그 이벤트 필터링
            resp = logs.filter_log_events(
                logGroupName=log_group, startTime=start_time,
                filterPattern=filter_pattern, limit=50)
            kept, meta = cap_list(resp.get("events", []), 50, bool(resp.get("nextToken")))
            events = [{"timestamp": str(datetime.fromtimestamp(e.get("timestamp", 0) / 1000)),
                "message": e.get("message", "")[:300]}
                for e in kept]
            return ok({**meta, "region": region, "logGroup": log_group, "filterPattern": filter_pattern,
                "timeRange": "{} minutes".format(minutes),
                "matchingEvents": len(events), "events": events})

        # Start a CloudWatch Logs Insights query / CloudWatch 로그 인사이트 쿼리 시작
        elif t == "execute_log_insights_query":
            log_group = args.get("log_group", "")
            query = args.get("query", "fields @timestamp, @message | sort @timestamp desc | limit 20")
            minutes = args.get("minutes", 60)
            end_time = int(time.time())
            start_time = end_time - minutes * 60

            log_groups = [log_group] if isinstance(log_group, str) else log_group
            # Start Logs Insights query / 로그 인사이트 쿼리 시작
            resp = logs.start_query(
                logGroupNames=log_groups, startTime=start_time,
                endTime=end_time, queryString=query)
            query_id = resp.get("queryId", "")
            return ok({"queryId": query_id, "status": "STARTED",
                "note": "Use get_logs_insight_query_results with this queryId to get results"})

        # Get results of a Logs Insights query / 로그 인사이트 쿼리 결과 조회
        elif t == "get_logs_insight_query_results":
            query_id = args.get("query_id", "")
            resp = logs.get_query_results(queryId=query_id)
            status = resp.get("status", "")
            rows, meta = cap_list(resp.get("results", []), 50)
            if status != "Complete":
                # Not pagination: Running/Scheduled are interim; Failed/Cancelled/Timeout have no remainder.
                # Never certify either as complete or empty; name the status.
                meta.update(truncated=True, complete=False, query_status=status or "Unknown")
                if status in ("Failed", "Cancelled", "Timeout"):
                    meta["query_failed"] = True
            results = [{f["field"]: f["value"] for f in row} for row in rows]
            return ok({**meta, "region": region, "queryId": query_id, "status": status,
                "results": results, "count": len(results),
                "stats": resp.get("statistics", {})})

        # Cancel a running Logs Insights query / 실행 중인 로그 인사이트 쿼리 취소
        elif t == "cancel_logs_insight_query":
            query_id = args.get("query_id", "")
            logs.stop_query(queryId=query_id)
            return ok({"queryId": query_id, "status": "CANCELLED"})

        return err("Unknown tool: " + t)

    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}


# Return success response / 성공 응답 반환
def ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str)}

# Return error response / 오류 응답 반환
def err(msg):
    return {"statusCode": 400, "body": json.dumps({"error": msg})}
