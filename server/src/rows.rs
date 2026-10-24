
use crate::error::ApiResult;
use serde_json::Value;

pub fn cell(row: &sqlx::sqlite::SqliteRow, i: usize) -> Value {
    use sqlx::{Row, TypeInfo, ValueRef};
    let raw = row.try_get_raw(i).expect("the index came from the row itself");
    if raw.is_null() {
        return Value::Null;
    }
    match raw.type_info().name() {
        "INTEGER" | "BOOLEAN" => row.try_get::<i64, _>(i).map(Value::from).unwrap_or(Value::Null),
        "REAL" => row.try_get::<f64, _>(i).map(Value::from).unwrap_or(Value::Null),
        _ => row.try_get::<String, _>(i).map(Value::from).unwrap_or(Value::Null),
    }
}

pub async fn all(pool: &sqlx::SqlitePool, sql: &str, bind: &str) -> ApiResult<Vec<Value>> {
    let rows = sqlx::query(sql).bind(bind).fetch_all(pool).await?;
    Ok(rows.iter().map(object).collect())
}

pub fn object(row: &sqlx::sqlite::SqliteRow) -> Value {
    use sqlx::{Column, Row};
    let mut out = serde_json::Map::new();
    for (i, column) in row.columns().iter().enumerate() {
        out.insert(column.name().to_string(), cell(row, i));
    }
    Value::Object(out)
}
