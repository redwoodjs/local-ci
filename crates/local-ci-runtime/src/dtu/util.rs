use super::*;

pub(super) fn base_url(request: &Request) -> String {
    let host = request
        .headers
        .get("host")
        .map(String::as_str)
        .unwrap_or("localhost");
    let protocol = request
        .headers
        .get("x-forwarded-proto")
        .map(String::as_str)
        .unwrap_or("http");
    format!("{protocol}://{host}")
}

pub(super) fn value_to_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(value).unwrap_or_default(),
    }
}

pub(super) fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}

pub(super) fn iso_now() -> String {
    iso_from_millis(now_ms() as u64)
}

pub(super) fn iso_now_plus_hour() -> String {
    iso_from_millis(now_ms() as u64 + 60 * 60 * 1000)
}

pub(super) fn iso_now_plus_minute() -> String {
    iso_from_millis(now_ms() as u64 + 60 * 1000)
}

pub(super) fn iso_from_millis(millis: u64) -> String {
    let seconds = millis / 1000;
    let (year, month, day, hour, minute, second) = unix_seconds_to_utc(seconds);
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z",
        ms = millis % 1000
    )
}

pub(super) fn unix_seconds_to_utc(seconds: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = (seconds_of_day / 3_600) as u32;
    let minute = ((seconds_of_day % 3_600) / 60) as u32;
    let second = (seconds_of_day % 60) as u32;
    (year, month, day, hour, minute, second)
}

pub(super) fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year as i32, month as u32, day as u32)
}
