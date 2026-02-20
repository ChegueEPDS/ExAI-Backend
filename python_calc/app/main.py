from fastapi import FastAPI, HTTPException
import ssl
import certifi
from pydantic import BaseModel
from typing import Any, Dict, List, Optional
import pandas as pd

def _create_https_context():
    return ssl.create_default_context(cafile=certifi.where())

ssl._create_default_https_context = _create_https_context

app = FastAPI()


class TableQueryRequest(BaseModel):
    files: List[Dict[str, Any]]  # [{filename, url}]
    query: Dict[str, Any]
    max_rows: Optional[int] = None


class TableProfileRequest(BaseModel):
    files: List[Dict[str, Any]]  # [{filename, url}]
    sheet: Optional[str] = None
    max_rows: Optional[int] = None
    max_cols: Optional[int] = None


class TableCompareRequest(BaseModel):
    files: List[Dict[str, Any]]  # [{filename, url}]
    left: Dict[str, Any]         # {filename, sheet?}
    right: Dict[str, Any]        # {filename, sheet?}
    key_columns: List[str]
    compare_columns: Optional[List[str]] = None
    max_rows: Optional[int] = None
    max_cols: Optional[int] = None


class TablePivotRequest(BaseModel):
    files: List[Dict[str, Any]]  # [{filename, url}]
    filename: Optional[str] = None
    sheet: Optional[str] = None
    group_by: List[str]
    values: List[str]
    agg: Optional[List[str]] = None
    filters: Optional[List[Dict[str, Any]]] = None
    sort: Optional[List[Dict[str, Any]]] = None
    limit: Optional[int] = None
    max_rows: Optional[int] = None
    max_cols: Optional[int] = None


class TimeSeriesRequest(BaseModel):
    files: List[Dict[str, Any]]  # [{filename, url}]
    filename: Optional[str] = None
    sheet: Optional[str] = None
    time_column: str
    value_columns: List[str]
    freq: Optional[str] = None
    agg: Optional[str] = None
    trend_window: Optional[int] = None
    filters: Optional[List[Dict[str, Any]]] = None
    limit: Optional[int] = None
    max_rows: Optional[int] = None
    max_cols: Optional[int] = None


class MeasurementEvalRequest(BaseModel):
    files: List[Dict[str, Any]]  # [{filename, url}]
    filename: Optional[str] = None
    sheet: Optional[str] = None
    max_tables: Optional[int] = None
    max_rows: Optional[int] = None
    max_cols: Optional[int] = None
    ext_points: Optional[List[str]] = None


def _coerce_value(v: Any):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    s = str(v).strip()
    if not s:
        return None
    try:
        s2 = s.replace(" ", "").replace(",", ".")
        return float(s2) if "." in s2 else int(s2)
    except Exception:
        return s


def _apply_filters(df: pd.DataFrame, filters: List[Dict[str, Any]]):
    if not filters:
        return df
    out = df.copy()
    for f in filters:
        col = _resolve_column(out, f.get("column"))
        if col is None:
            continue
        op = str(f.get("op") or "").lower()
        val = f.get("value")
        val2 = f.get("value2")
        if op == "contains":
            needle = str(val or "").lower()
            if needle:
                out = out[out[col].astype(str).str.lower().str.contains(needle)]
        elif op == "in":
            arr = f.get("value") or []
            if not isinstance(arr, list):
                arr = [arr]
            arr_norm = [str(x).strip().lower() for x in arr if str(x).strip()]
            if arr_norm:
                out = out[out[col].astype(str).str.lower().isin(arr_norm)]
        elif op == "between":
            a = _coerce_value(val)
            b = _coerce_value(val2)
            if a is None or b is None:
                continue
            lo, hi = (a, b) if a <= b else (b, a)
            out = out[pd.to_numeric(out[col], errors="coerce").between(lo, hi)]
        else:
            right = _coerce_value(val)
            if right is None:
                continue
            left_num = pd.to_numeric(out[col], errors="coerce")
            if op == "=":
                out = out[(out[col].astype(str).str.lower() == str(right).lower()) | (left_num == right)]
            elif op == "!=":
                out = out[(out[col].astype(str).str.lower() != str(right).lower()) & (left_num != right)]
            elif op == ">":
                out = out[left_num > right]
            elif op == ">=":
                out = out[left_num >= right]
            elif op == "<":
                out = out[left_num < right]
            elif op == "<=":
                out = out[left_num <= right]
    return out


def _excel_col_name(n: int) -> str:
    if n <= 0:
        return ""
    name = ""
    while n > 0:
        n, rem = divmod(n - 1, 26)
        name = chr(65 + rem) + name
    return name


def _cell_evidence(filename: str, sheet: Optional[str], row_idx: int, col_idx: int, value: Any):
    col = _excel_col_name(col_idx)
    return {
        "kind": "cell",
        "fileName": filename,
        "sheet": sheet or "",
        "rowIndex": int(row_idx),
        "colIndex": int(col_idx),
        "cell": f"{col}{row_idx}",
        "value": "" if value is None else str(value),
    }


def _computed_evidence(op: str, value: Any, unit: str, sources: List[Dict[str, Any]]):
    return {
        "kind": "computed",
        "op": op,
        "value": "" if value is None else str(value),
        "unit": unit or "",
        "sources": sources or [],
    }


def _token_from_label(label: str) -> str:
    import re
    m = re.search(r"\\b(T\\d{1,2})\\b", str(label or ""), re.I)
    if not m:
        return ""
    tok = m.group(1).upper()
    try:
        n = int(tok[1:])
        if n <= 0 or n > 99:
            return ""
    except Exception:
        return ""
    return tok


def _is_ambient(token: str, label: str) -> bool:
    if str(token or "").upper() == "T12":
        return True
    s = str(label or "").lower()
    return "ambient" in s or "outside" in s


def _is_temp_row(label: str, unit: str) -> bool:
    u = str(unit or "")
    if "°" in u or "C" in u.upper():
        return True
    s = str(label or "").lower()
    return ("temperature" in s) or ("hőm" in s) or ("hom" in s) or _is_ambient("", s)


def _apply_group_agg(df: pd.DataFrame, group_by: List[str], aggs: List[Dict[str, Any]]):
    if not group_by and not aggs:
        return df
    if not aggs:
        cols = [c for c in (_resolve_columns(df, group_by)) if c]
        return df[cols].drop_duplicates() if cols else df
    agg_map = {}
    rename = {}
    for a in aggs:
        op = str(a.get("op") or "").lower()
        col = _resolve_column(df, a.get("column"))
        as_name = str(a.get("as") or f"{op}_{col}" if col else op)
        if op == "count":
            agg_map[as_name] = ("__row__" if col is None else col, "count")
        elif op in ("sum", "avg", "min", "max") and col:
            fn = "mean" if op == "avg" else op
            agg_map[as_name] = (col, fn)
    if not agg_map:
        return df
    if "__row__" in df.columns:
        df = df.drop(columns=["__row__"])
    df["__row__"] = 1
    if group_by:
        gb_cols = [c for c in (_resolve_columns(df, group_by)) if c]
        grouped = df.groupby(gb_cols, dropna=False).agg(**agg_map).reset_index()
    else:
        grouped = df.agg(**agg_map).to_frame().T
    return grouped


def _apply_sort_limit(df: pd.DataFrame, sort: Optional[Dict[str, Any]], limit: Optional[int]):
    out = df
    if sort:
        by = _resolve_column(out, sort.get("by"))
    else:
        by = None
    if by and by in out.columns:
        dir_raw = str(sort.get("dir") or "desc").lower()
        ascending = dir_raw == "asc"
        out = out.sort_values(by=by, ascending=ascending)
    if isinstance(limit, int) and limit > 0:
        out = out.head(limit)
    return out


def _normalize_key(s: Any) -> str:
    return str(s or "").strip().lower()


def _simplify_key(s: Any) -> str:
    return "".join(ch for ch in _normalize_key(s) if ch.isalnum())


def _resolve_column(df: pd.DataFrame, want: Any) -> Optional[str]:
    if want is None:
        return None
    w = _normalize_key(want)
    if not w:
        return None
    cols = list(df.columns)
    direct = next((c for c in cols if _normalize_key(c) == w), None)
    if direct:
        return direct
    w2 = _simplify_key(w)
    if not w2:
        return None
    return next((c for c in cols if _simplify_key(c) == w2), None)


def _resolve_columns(df: pd.DataFrame, wants: List[Any]) -> List[Optional[str]]:
    return [_resolve_column(df, w) for w in (wants or [])]


def _is_number(x):
    try:
        if x is None:
            return False
        if isinstance(x, (int, float)):
            return True
        s = str(x).strip().replace(",", ".")
        if not s:
            return False
        float(s)
        return True
    except Exception:
        return False


def _extract_matrix_records(df: pd.DataFrame):
    records = []
    labels = []
    current_block = None
    current_headers = None  # list of (col_name, header_value)
    rows = df.copy()
    cols = list(rows.columns)

    def is_label_row(row):
        non_null = row.notna().sum()
        if non_null <= 2:
            v = row.iloc[0]
            return isinstance(v, str) and v.strip() != ''
        return False

    def is_header_row(row):
        # header row: first cell is string (e.g., Time), and multiple numeric values across remaining columns
        first = row.iloc[0]
        if not isinstance(first, str) or not first.strip():
            return False
        numeric = 0
        for c in cols[2:]:
            if _is_number(row.get(c, None)):
                numeric += 1
        return numeric >= 3

    for i in range(len(rows)):
        row = rows.iloc[i]
        if is_label_row(row):
            labels.append(str(row.iloc[0]).strip())
            if len(labels) > 4:
                labels = labels[-4:]
        if is_header_row(row):
            current_block = " | ".join(labels[-2:]) if labels else None
            current_headers = []
            for c in cols[2:]:
                hv = row.get(c, None)
                if _is_number(hv):
                    current_headers.append((c, hv))
            continue
        if current_headers:
            row_label = row.iloc[0]
            if isinstance(row_label, str) and row_label.strip():
                for col_name, header_val in current_headers:
                    val = row.get(col_name, None)
                    if val is None or (isinstance(val, float) and pd.isna(val)):
                        continue
                    records.append({
                        "block": current_block,
                        "row_label": row_label,
                        "col_header": header_val,
                        "value": val,
                    })

    return records


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/calc/table_query")
def table_query(req: TableQueryRequest):
    if not req.files:
        raise HTTPException(status_code=400, detail="files is required")
    query = req.query or {}
    want_filename = str(query.get("filename") or "").strip()
    f0 = None
    for f in req.files:
        if want_filename and str(f.get("filename") or "") == want_filename:
            f0 = f
            break
    if f0 is None:
        f0 = req.files[0]

    url = f0.get("url")
    filename = f0.get("filename") or "file"
    if not url:
        raise HTTPException(status_code=400, detail="file url missing")

    try:
        if filename.lower().endswith(".csv"):
            df = pd.read_csv(url)
            df["__sheet"] = None
            df["__rowIndex"] = list(range(1, len(df) + 1))
        else:
            sheet = str(query.get("sheet") or "").strip() or None
            if sheet:
                df = pd.read_excel(url, sheet_name=sheet)
                df["__sheet"] = sheet
                df["__rowIndex"] = list(range(1, len(df) + 1))
            else:
                all_sheets = pd.read_excel(url, sheet_name=None)
                parts = []
                for sh_name, sh_df in all_sheets.items():
                    sh_df = sh_df.copy()
                    sh_df["__sheet"] = sh_name
                    sh_df["__rowIndex"] = list(range(1, len(sh_df) + 1))
                    parts.append(sh_df)
                df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"failed to read file: {e}")

    if req.max_rows:
        df = df.head(int(req.max_rows))

    filters = query.get("filters") or []
    group_by = query.get("groupBy") or []
    aggs = query.get("aggregations") or []
    sort = query.get("sort")
    limit = query.get("limit")
    return_columns = query.get("returnColumns") or []

    # sheet + row index fields already attached above
    sheet_name = str(query.get("sheet") or "").strip() or None

    df2 = _apply_filters(df, filters)
    df3 = _apply_group_agg(df2, group_by, aggs)
    df4 = _apply_sort_limit(df3, sort, limit)

    if not aggs and not group_by:
        # Default raw row mode
        use_limit = 30 if limit is None else max(1, min(200, int(limit)))
        wanted = return_columns if return_columns else [c for c in df4.columns if not str(c).startswith("__")][:12]
        out_rows = []
        for _, r in df4.head(use_limit).iterrows():
            row = {}
            for want in wanted:
                real = _resolve_column(df4, want)
                row[str(want)] = r.get(real, None) if real else None
            row["__sheet"] = r.get("__sheet", None)
            row["__rowIndex"] = r.get("__rowIndex", None)
            out_rows.append(row)
        rows = out_rows
    else:
        rows = df4.fillna("").to_dict(orient="records")
    return {
        "ok": True,
        "result": {
            "rows": rows,
            "meta": {
                "filename": filename,
                "sheet": sheet_name,
                "rows_scanned": int(len(df)),
                "rows_matched": int(len(df2)),
                "rows_out": int(len(rows)),
                "columns": list(df4.columns),
            },
        },
    }


@app.post("/calc/table_profile")
def table_profile(req: TableProfileRequest):
    if not req.files:
        raise HTTPException(status_code=400, detail="files is required")
    f0 = req.files[0]
    url = f0.get("url")
    filename = f0.get("filename") or "file"
    if not url:
        raise HTTPException(status_code=400, detail="file url missing")

    try:
        if filename.lower().endswith(".csv"):
            df = pd.read_csv(url)
            df["__sheet"] = None
            df["__rowIndex"] = list(range(1, len(df) + 1))
        else:
            sheet = str(req.sheet or "").strip() or None
            if sheet:
                df = pd.read_excel(url, sheet_name=sheet)
                df["__sheet"] = sheet
                df["__rowIndex"] = list(range(1, len(df) + 1))
            else:
                all_sheets = pd.read_excel(url, sheet_name=None)
                parts = []
                for sh_name, sh_df in all_sheets.items():
                    sh_df = sh_df.copy()
                    sh_df["__sheet"] = sh_name
                    sh_df["__rowIndex"] = list(range(1, len(sh_df) + 1))
                    parts.append(sh_df)
                df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"failed to read file: {e}")

    if req.max_rows:
        df = df.head(int(req.max_rows))

    max_cols = int(req.max_cols) if req.max_cols else None
    cols = [c for c in df.columns if not str(c).startswith("__")]
    if max_cols:
        cols = cols[:max_cols]

    profiles = []
    total_rows = len(df)
    for c in cols:
        series = df[c]
        non_null = series.dropna()
        missing = int(total_rows - len(non_null))
        missing_pct = (missing / total_rows * 100.0) if total_rows else 0.0

        numeric = pd.to_numeric(non_null, errors="coerce")
        numeric_non_null = numeric.dropna()
        is_numeric = len(numeric_non_null) > 0

        outliers = 0
        if is_numeric and len(numeric_non_null) >= 8:
            q1 = numeric_non_null.quantile(0.25)
            q3 = numeric_non_null.quantile(0.75)
            iqr = q3 - q1
            if iqr != 0:
                lo = q1 - 1.5 * iqr
                hi = q3 + 1.5 * iqr
                outliers = int(((numeric_non_null < lo) | (numeric_non_null > hi)).sum())

        profiles.append({
            "column": str(c),
            "dtype": str(series.dtype),
            "rows": int(total_rows),
            "missing": missing,
            "missing_pct": round(missing_pct, 2),
            "unique": int(non_null.nunique()),
            "is_numeric": bool(is_numeric),
            "min": float(numeric_non_null.min()) if is_numeric else None,
            "max": float(numeric_non_null.max()) if is_numeric else None,
            "mean": float(numeric_non_null.mean()) if is_numeric else None,
            "std": float(numeric_non_null.std(ddof=0)) if is_numeric else None,
            "outliers": outliers,
        })

    return {
        "ok": True,
        "result": {
            "meta": {
                "filename": filename,
                "sheet": str(req.sheet or "").strip() or None,
                "rows_scanned": int(total_rows),
                "columns": cols,
            },
            "profiles": profiles,
        },
    }


@app.post("/calc/table_pivot")
def table_pivot(req: TablePivotRequest):
    if not req.files:
        raise HTTPException(status_code=400, detail="files is required")
    want_filename = str(req.filename or "").strip()
    f0 = None
    for f in req.files:
        if want_filename and str(f.get("filename") or "") == want_filename:
            f0 = f
            break
    if f0 is None:
        f0 = req.files[0]

    url = f0.get("url")
    filename = f0.get("filename") or "file"
    if not url:
        raise HTTPException(status_code=400, detail="file url missing")

    try:
        if filename.lower().endswith(".csv"):
            df = pd.read_csv(url)
            df["__sheet"] = None
            df["__rowIndex"] = list(range(1, len(df) + 1))
        else:
            sheet = str(req.sheet or "").strip() or None
            if sheet:
                df = pd.read_excel(url, sheet_name=sheet)
                df["__sheet"] = sheet
                df["__rowIndex"] = list(range(1, len(df) + 1))
            else:
                all_sheets = pd.read_excel(url, sheet_name=None)
                parts = []
                for sh_name, sh_df in all_sheets.items():
                    sh_df = sh_df.copy()
                    sh_df["__sheet"] = sh_name
                    sh_df["__rowIndex"] = list(range(1, len(sh_df) + 1))
                    parts.append(sh_df)
                df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"failed to read file: {e}")

    if req.max_rows:
        df = df.head(int(req.max_rows))
    if req.max_cols:
        df = df[df.columns[: int(req.max_cols)]]

    group_by = [c for c in _resolve_columns(df, req.group_by or []) if c]
    values = [c for c in _resolve_columns(df, req.values or []) if c]
    if not group_by:
        raise HTTPException(status_code=400, detail="group_by is required")
    if not values:
        raise HTTPException(status_code=400, detail="values is required")

    df2 = _apply_filters(df, req.filters or [])

    agg_list = req.agg or ["sum"]
    if isinstance(agg_list, str):
        agg_list = [agg_list]
    agg_list = [str(a).strip().lower() for a in (agg_list or []) if str(a).strip()]
    if not agg_list:
        agg_list = ["sum"]

    agg_map = {}
    if len(agg_list) == 1:
        for v in values:
            agg_map[v] = agg_list[0]
    else:
        for i, v in enumerate(values):
            agg_map[v] = agg_list[i] if i < len(agg_list) else agg_list[0]

    for v in values:
        df2[v] = pd.to_numeric(df2[v], errors="coerce")

    try:
        pivot = df2.groupby(group_by, dropna=False).agg(agg_map).reset_index()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"pivot failed: {e}")

    # Flatten column names if needed
    if isinstance(pivot.columns, pd.MultiIndex):
        pivot.columns = ["_".join([str(c) for c in tup if c]) for tup in pivot.columns.values]

    # Optional sort
    if req.sort:
        for s in req.sort:
            col = _resolve_column(pivot, s.get("column"))
            if col is None:
                continue
            direction = str(s.get("dir") or "asc").lower()
            pivot = pivot.sort_values(by=[col], ascending=(direction != "desc"))

    limit = req.limit if req.limit is not None else 200
    use_limit = max(1, min(1000, int(limit)))
    rows = pivot.head(use_limit).fillna("").to_dict(orient="records")

    return {
        "ok": True,
        "result": {
            "rows": rows,
            "meta": {
                "filename": filename,
                "sheet": str(req.sheet or "").strip() or None,
                "rows_scanned": int(len(df)),
                "rows_out": int(len(rows)),
                "group_by": group_by,
                "values": values,
                "aggregations": agg_map,
                "columns": list(pivot.columns),
            },
        },
    }


@app.post("/calc/time_series")
def time_series(req: TimeSeriesRequest):
    if not req.files:
        raise HTTPException(status_code=400, detail="files is required")
    want_filename = str(req.filename or "").strip()
    f0 = None
    for f in req.files:
        if want_filename and str(f.get("filename") or "") == want_filename:
            f0 = f
            break
    if f0 is None:
        f0 = req.files[0]

    url = f0.get("url")
    filename = f0.get("filename") or "file"
    if not url:
        raise HTTPException(status_code=400, detail="file url missing")

    try:
        if filename.lower().endswith(".csv"):
            df = pd.read_csv(url)
            df["__sheet"] = None
            df["__rowIndex"] = list(range(1, len(df) + 1))
        else:
            sheet = str(req.sheet or "").strip() or None
            if sheet:
                df = pd.read_excel(url, sheet_name=sheet)
                df["__sheet"] = sheet
                df["__rowIndex"] = list(range(1, len(df) + 1))
            else:
                all_sheets = pd.read_excel(url, sheet_name=None)
                parts = []
                for sh_name, sh_df in all_sheets.items():
                    sh_df = sh_df.copy()
                    sh_df["__sheet"] = sh_name
                    sh_df["__rowIndex"] = list(range(1, len(sh_df) + 1))
                    parts.append(sh_df)
                df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"failed to read file: {e}")

    if req.max_rows:
        df = df.head(int(req.max_rows))
    if req.max_cols:
        df = df[df.columns[: int(req.max_cols)]]

    time_col = _resolve_column(df, req.time_column)
    if not time_col:
        raise HTTPException(status_code=400, detail="time_column not found")
    value_cols = [c for c in _resolve_columns(df, req.value_columns or []) if c]
    if not value_cols:
        raise HTTPException(status_code=400, detail="value_columns not found")

    df2 = _apply_filters(df, req.filters or [])
    df2 = df2.copy()
    df2[time_col] = pd.to_datetime(df2[time_col], errors="coerce")
    df2 = df2.dropna(subset=[time_col])
    for v in value_cols:
        df2[v] = pd.to_numeric(df2[v], errors="coerce")

    freq = str(req.freq or "").strip().upper() or None
    agg = str(req.agg or "mean").strip().lower()
    if agg not in ["mean", "sum", "min", "max", "median", "count"]:
        agg = "mean"

    df2 = df2.set_index(time_col).sort_index()
    if freq:
        try:
            df3 = getattr(df2[value_cols].resample(freq), agg)()
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"resample failed: {e}")
    else:
        df3 = getattr(df2[value_cols], agg)()
        df3 = df3.to_frame().T

    if req.trend_window and int(req.trend_window) > 1:
        win = int(req.trend_window)
        trend = df3.rolling(window=win, min_periods=1).mean()
        trend.columns = [f"{c}_trend" for c in trend.columns]
        df3 = pd.concat([df3, trend], axis=1)

    df3 = df3.reset_index()

    limit = req.limit if req.limit is not None else 500
    use_limit = max(1, min(2000, int(limit)))
    rows = df3.head(use_limit).fillna("").to_dict(orient="records")

    return {
        "ok": True,
        "result": {
            "rows": rows,
            "meta": {
                "filename": filename,
                "sheet": str(req.sheet or "").strip() or None,
                "time_column": time_col,
                "value_columns": value_cols,
                "freq": freq,
                "agg": agg,
                "trend_window": int(req.trend_window) if req.trend_window else None,
                "rows_scanned": int(len(df2)),
                "rows_out": int(len(rows)),
                "columns": list(df3.columns),
            },
        },
    }


@app.post("/calc/measurement_eval")
def measurement_eval(req: MeasurementEvalRequest):
    if not req.files:
        raise HTTPException(status_code=400, detail="files is required")

    def resolve_file(name: str):
        for f in req.files:
            if str(f.get("filename") or "") == name:
                return f
        return None

    def iter_files():
        if req.filename:
            f = resolve_file(str(req.filename))
            return [f] if f else []
        return list(req.files)

    max_tables = int(req.max_tables) if req.max_tables else 30
    ext_points = [str(x).upper() for x in (req.ext_points or ["T10", "T11", "T4"]) if str(x).strip()]

    result = {
        "meta": {
            "notes": [
                "Deterministic measurement evaluation from XLSX cells (python).",
                "Use numericEvidence for audit-grade citations.",
            ],
            "external_points": ext_points,
        },
        "by_test": [],
        "worst_by_point": [],
        "ambient": None,
        "ts_rise_by_point": [],
        "numericEvidence": [],
    }

    worst = {}  # token -> {max, evidence, label, sheet, table}

    for f in iter_files():
        if not f:
            continue
        url = f.get("url")
        filename = f.get("filename") or "file"
        if not url:
            continue
        try:
            if req.sheet:
                sheets = {str(req.sheet): pd.read_excel(url, sheet_name=req.sheet, header=None)}
            else:
                sheets = pd.read_excel(url, sheet_name=None, header=None)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"failed to read file: {e}")

        for sheet_name, df in (sheets or {}).items():
            if df is None or df.empty:
                continue
            if req.max_rows:
                df = df.head(int(req.max_rows))
            if req.max_cols:
                df = df[df.columns[: int(req.max_cols)]]

            # find table markers (col 0)
            tables = []
            for i, v in df.iloc[:, 0].items():
                if isinstance(v, str):
                    import re
                    m = re.search(r"\\bTable\\s+(\\d+)\\b", v)
                    if m:
                        tables.append((int(m.group(1)), int(i)))
            tables.sort(key=lambda x: x[1])
            if not tables:
                continue

            # unique by start row
            seen = set()
            uniq = []
            for tno, start in tables:
                key = f"{tno}:{start}"
                if key in seen:
                    continue
                seen.add(key)
                uniq.append((tno, start))
            tables = uniq[:max_tables]

            for idx, (table_no, start_row) in enumerate(tables):
                end_row = tables[idx + 1][1] if idx + 1 < len(tables) else len(df)

                # find time row
                time_row = None
                for r in range(start_row + 1, min(end_row, start_row + 600)):
                    row = df.iloc[r, :].tolist()
                    if any(isinstance(x, str) and "time" in x.lower() for x in row):
                        time_row = r
                        break
                if time_row is None:
                    continue

                # time columns: numeric values in time row
                time_cols = []
                for c, val in df.iloc[time_row, :].items():
                    if isinstance(val, (int, float)) and val >= 0:
                        time_cols.append((int(c), float(val)))
                if not time_cols:
                    continue

                # last time col by time value
                last_time_col, last_time_val = max(time_cols, key=lambda x: x[1])

                points = []
                hottest = None
                external_max = None

                for r in range(time_row + 1, min(end_row, time_row + 200)):
                    label = df.iloc[r, 0] if df.shape[1] > 0 else None
                    unit = df.iloc[r, 1] if df.shape[1] > 1 else None
                    token = _token_from_label(label)
                    if not token:
                        continue
                    if not _is_temp_row(str(label or ""), str(unit or "")):
                        continue

                    # collect numeric values in time columns
                    max_val = None
                    max_col = None
                    for c, _t in time_cols:
                        v = df.iloc[r, c] if c < df.shape[1] else None
                        if isinstance(v, (int, float)):
                            if (max_val is None) or (v > max_val):
                                max_val = float(v)
                                max_col = int(c)
                    if max_val is None or max_col is None:
                        continue

                    steady_val = None
                    if last_time_col < df.shape[1]:
                        v_last = df.iloc[r, last_time_col]
                        if isinstance(v_last, (int, float)):
                            steady_val = float(v_last)

                    row_idx = int(r) + 1
                    col_idx = int(max_col) + 1
                    max_ev = _cell_evidence(filename, sheet_name, row_idx, col_idx, max_val)
                    steady_ev = None
                    if steady_val is not None:
                        steady_ev = _cell_evidence(filename, sheet_name, row_idx, int(last_time_col) + 1, steady_val)

                    item = {
                        "point": token,
                        "label": str(label or ""),
                        "max": {"value": max_val, "cell": max_ev},
                        "steady": {"value": steady_val, "cell": steady_ev} if steady_val is not None else None,
                    }
                    points.append(item)

                    if (hottest is None) or (max_val > hottest["max"]["value"]):
                        hottest = item
                    if token in ext_points:
                        if (external_max is None) or (max_val > external_max["max"]["value"]):
                            external_max = item

                    w = worst.get(token)
                    if (w is None) or (max_val > w["max"]["value"]):
                        worst[token] = {
                            "fileName": filename,
                            "label": str(label or ""),
                            "max": {"value": max_val, "cell": max_ev},
                            "sheet": sheet_name,
                            "table": table_no,
                        }

                if not hottest:
                    continue

                time_ev = _cell_evidence(filename, sheet_name, int(time_row) + 1, int(last_time_col) + 1, last_time_val)
                result["numericEvidence"].append(hottest["max"]["cell"])
                if hottest.get("steady", {}).get("cell"):
                    result["numericEvidence"].append(hottest["steady"]["cell"])
                if external_max:
                    result["numericEvidence"].append(external_max["max"]["cell"])

                result["by_test"].append({
                    "fileName": filename,
                    "sheet": sheet_name,
                    "table": table_no,
                    "time": {
                        "last_min": last_time_val,
                        "last_cell": time_ev,
                    },
                    "hottest": {"point": hottest["point"], "max_C": hottest["max"]["value"], "evidence": hottest["max"]["cell"]},
                    "external_max": {"point": external_max["point"], "max_C": external_max["max"]["value"], "evidence": external_max["max"]["cell"]} if external_max else None,
                    "points": [{"point": p["point"], "max_C": p["max"]["value"], "steady_C": p["steady"]["value"] if p.get("steady") else None} for p in points[:24]],
                })

    # worst_by_point
    for token, item in worst.items():
        result["worst_by_point"].append({
            "point": token,
            "label": item.get("label") or "",
            "max_C": item["max"]["value"],
            "fileName": item.get("fileName") or "",
            "sheet": item.get("sheet") or "",
            "table": item.get("table") or None,
            "evidence": item["max"]["cell"],
        })
        result["numericEvidence"].append(item["max"]["cell"])

    result["worst_by_point"].sort(key=lambda x: float(x.get("max_C") or 0), reverse=True)

    # ambient + ts rise
    ambient_candidates = [p for p in result["worst_by_point"] if _is_ambient(p.get("point", ""), p.get("label", ""))]
    if ambient_candidates:
        best = sorted(ambient_candidates, key=lambda x: float(x.get("max_C") or 0), reverse=True)[0]
        result["ambient"] = {
            "max_C": float(best.get("max_C") or 0),
            "evidence": best.get("evidence"),
            "source_point": best.get("point"),
            "source_label": best.get("label"),
        }
        result["numericEvidence"].append(best.get("evidence"))

    if result["ambient"] and isinstance(result["ambient"].get("max_C"), (int, float)):
        amb = float(result["ambient"]["max_C"])
        for p in result["worst_by_point"]:
            if _is_ambient(p.get("point", ""), p.get("label", "")):
                continue
            delta = float(p.get("max_C") or 0) - amb
            ev = _computed_evidence("minus", round(delta, 1), "°C", [p.get("evidence"), result["ambient"]["evidence"]])
            result["ts_rise_by_point"].append({
                "point": p.get("point"),
                "label": p.get("label"),
                "max_C": float(p.get("max_C") or 0),
                "ambient_C": amb,
                "ts_rise_C": round(delta, 1),
                "evidence": ev,
            })
            result["numericEvidence"].append(ev)

    result["numericEvidence"] = result["numericEvidence"][:250]

    return {"ok": True, "result": result}


@app.post("/calc/table_compare")
def table_compare(req: TableCompareRequest):
    if not req.files:
        raise HTTPException(status_code=400, detail="files is required")
    if not req.left or not req.right:
        raise HTTPException(status_code=400, detail="left/right is required")
    if not req.key_columns:
        raise HTTPException(status_code=400, detail="key_columns is required")

    def resolve_file(name: str):
        for f in req.files:
            if str(f.get("filename") or "") == name:
                return f
        return None

    left_file = resolve_file(str(req.left.get("filename") or ""))
    right_file = resolve_file(str(req.right.get("filename") or ""))
    if not left_file or not right_file:
        raise HTTPException(status_code=400, detail="left/right filename not found in files")

    def load_df(file_meta: Dict[str, Any], sheet: Optional[str]):
        url = file_meta.get("url")
        filename = file_meta.get("filename") or "file"
        if not url:
            raise HTTPException(status_code=400, detail="file url missing")
        if filename.lower().endswith(".csv"):
            df = pd.read_csv(url)
            df["__sheet"] = None
        else:
            if sheet:
                df = pd.read_excel(url, sheet_name=sheet)
                df["__sheet"] = sheet
            else:
                all_sheets = pd.read_excel(url, sheet_name=None)
                parts = []
                for sh_name, sh_df in all_sheets.items():
                    sh_df = sh_df.copy()
                    sh_df["__sheet"] = sh_name
                    parts.append(sh_df)
                df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
        df["__rowIndex"] = list(range(1, len(df) + 1))
        return df, filename

    left_sheet = str(req.left.get("sheet") or "").strip() or None
    right_sheet = str(req.right.get("sheet") or "").strip() or None

    left_df, left_name = load_df(left_file, left_sheet)
    right_df, right_name = load_df(right_file, right_sheet)

    if req.max_rows:
        left_df = left_df.head(int(req.max_rows))
        right_df = right_df.head(int(req.max_rows))

    max_cols = int(req.max_cols) if req.max_cols else None
    if max_cols:
        left_df = left_df[left_df.columns[: max_cols]]
        right_df = right_df[right_df.columns[: max_cols]]

    # Resolve columns with fuzzy matching
    key_cols = [c for c in _resolve_columns(left_df, req.key_columns) if c]
    if not key_cols:
        raise HTTPException(status_code=400, detail="key_columns not found in left table")

    # Align right key columns
    right_key_cols = [c for c in _resolve_columns(right_df, req.key_columns) if c]
    if not right_key_cols:
        raise HTTPException(status_code=400, detail="key_columns not found in right table")

    # Compare columns (if not provided, use intersection of non-meta columns)
    if req.compare_columns:
        left_comp = [c for c in _resolve_columns(left_df, req.compare_columns) if c]
        right_comp = [c for c in _resolve_columns(right_df, req.compare_columns) if c]
        comp_cols = [c for c in left_comp if c in right_comp]
    else:
        left_cols = [c for c in left_df.columns if not str(c).startswith("__")]
        right_cols = [c for c in right_df.columns if not str(c).startswith("__")]
        comp_cols = [c for c in left_cols if c in right_cols and c not in key_cols]

    # Merge on keys
    l = left_df.copy()
    r = right_df.copy()
    l["_key"] = l[key_cols].astype(str).agg("|".join, axis=1)
    r["_key"] = r[right_key_cols].astype(str).agg("|".join, axis=1)

    left_keys = set(l["_key"].tolist())
    right_keys = set(r["_key"].tolist())
    added_keys = list(right_keys - left_keys)
    removed_keys = list(left_keys - right_keys)
    common_keys = list(left_keys & right_keys)

    # If keys are highly duplicated (or likely parameter-style), fall back to matrix compare
    dup_left = int(l["_key"].duplicated().sum())
    dup_right = int(r["_key"].duplicated().sum())
    if dup_left > 0 or dup_right > 0 or (len(key_cols) == 1 and str(key_cols[0]).lower().startswith("param")):
        left_records = _extract_matrix_records(left_df)
        right_records = _extract_matrix_records(right_df)
        left_map = {}
        for rec in left_records:
            k = f"{rec.get('block')}|{rec.get('row_label')}|{rec.get('col_header')}"
            if k not in left_map:
                left_map[k] = rec.get("value")
        right_map = {}
        for rec in right_records:
            k = f"{rec.get('block')}|{rec.get('row_label')}|{rec.get('col_header')}"
            if k not in right_map:
                right_map[k] = rec.get("value")

        left_keys2 = set(left_map.keys())
        right_keys2 = set(right_map.keys())
        added2 = list(right_keys2 - left_keys2)
        removed2 = list(left_keys2 - right_keys2)
        common2 = list(left_keys2 & right_keys2)
        changes2 = []
        for k in common2[:500]:
            lv = left_map.get(k, None)
            rv = right_map.get(k, None)
            if pd.isna(lv) and pd.isna(rv):
                continue
            if str(lv) != str(rv):
                changes2.append({"key": k, "diffs": {"value": {"left": lv, "right": rv}}})

        return {
            "ok": True,
            "result": {
                "meta": {
                    "left": {"filename": left_name, "sheet": left_sheet},
                    "right": {"filename": right_name, "sheet": right_sheet},
                    "key_columns": ["block", "row_label", "col_header"],
                    "compare_columns": ["value"],
                    "rows_left": int(len(left_df)),
                    "rows_right": int(len(right_df)),
                    "added": len(added2),
                    "removed": len(removed2),
                    "changed": len(changes2),
                    "mode": "matrix",
                    "duplicate_keys": [{"left": dup_left, "right": dup_right}],
                },
                "added_keys": added2[:50],
                "removed_keys": removed2[:50],
                "changes": changes2[:50],
            },
        }

    # Build change summary (handle duplicate keys)
    changes = []
    common_sample = common_keys[:200]
    l_idx = l.set_index("_key")
    r_idx = r.set_index("_key")
    duplicate_keys = []
    for k in common_sample:
        row_l = l_idx.loc[k]
        row_r = r_idx.loc[k]
        left_rows = row_l if isinstance(row_l, pd.DataFrame) else row_l.to_frame().T
        right_rows = row_r if isinstance(row_r, pd.DataFrame) else row_r.to_frame().T
        if len(left_rows) > 1 or len(right_rows) > 1:
            duplicate_keys.append({"key": k, "left_count": int(len(left_rows)), "right_count": int(len(right_rows))})
        pair_limit = 20
        pairs = 0
        for li, (_, lr) in enumerate(left_rows.iterrows()):
            for ri, (_, rr) in enumerate(right_rows.iterrows()):
                diffs = {}
                for c in comp_cols:
                    lv = lr.get(c, None)
                    rv = rr.get(c, None)
                    if pd.isna(lv) and pd.isna(rv):
                        continue
                    if str(lv) != str(rv):
                        diffs[c] = {"left": lv, "right": rv}
                if diffs:
                    changes.append({"key": k, "left_index": li + 1, "right_index": ri + 1, "diffs": diffs})
                pairs += 1
                if pairs >= pair_limit:
                    break
            if pairs >= pair_limit:
                break

    return {
        "ok": True,
        "result": {
            "meta": {
                "left": {"filename": left_name, "sheet": left_sheet},
                "right": {"filename": right_name, "sheet": right_sheet},
                "key_columns": req.key_columns,
                "compare_columns": req.compare_columns or comp_cols,
                "rows_left": int(len(left_df)),
                "rows_right": int(len(right_df)),
                "added": len(added_keys),
                "removed": len(removed_keys),
                "changed": len(changes),
                "duplicate_keys": duplicate_keys[:50],
            },
            "added_keys": added_keys[:50],
            "removed_keys": removed_keys[:50],
            "changes": changes[:50],
        },
    }
