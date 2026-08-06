use super::*;

pub(super) fn eval_arg_or_literal(inner: &str, context: &ExpressionContext) -> String {
    let trimmed = inner.trim();
    if is_quoted(trimmed) {
        unquote(trimmed).to_owned()
    } else {
        evaluate_expr_value(trimmed, context)
    }
}

pub(super) fn split_function_args(args: &str) -> Vec<String> {
    split_top_level(args, ",")
        .into_iter()
        .map(|part| part.trim().to_owned())
        .collect()
}

pub(super) fn split_on_operator(expression: &str, operator: &str) -> Vec<String> {
    split_top_level(expression, operator)
}

pub(super) fn split_top_level(expression: &str, operator: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut depth = 0_i32;
    let mut quote = None;
    let chars = expression.char_indices().collect::<Vec<_>>();
    let mut index = 0;

    while index < chars.len() {
        let (byte_index, ch) = chars[index];
        if let Some(active_quote) = quote {
            current.push(ch);
            if ch == active_quote {
                quote = None;
            }
            index += 1;
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            current.push(ch);
            index += 1;
            continue;
        }
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        if depth == 0 && expression[byte_index..].starts_with(operator) {
            parts.push(current);
            current = String::new();
            index += operator.chars().count();
            continue;
        }
        current.push(ch);
        index += 1;
    }
    parts.push(current);
    parts
}

pub(super) fn strip_outer_parens(trimmed: &str) -> Option<&str> {
    if !trimmed.starts_with('(') {
        return None;
    }
    let mut depth = 0_i32;
    let mut quote = None;
    for (index, ch) in trimmed.char_indices() {
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            continue;
        }
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        if depth == 0 {
            return (index == trimmed.len() - 1).then(|| &trimmed[1..trimmed.len() - 1]);
        }
    }
    None
}

pub(super) fn parse_function_call(trimmed: &str) -> Option<(&str, &str)> {
    let open = trimmed.find('(')?;
    if !trimmed.ends_with(')') {
        return None;
    }
    let name = &trimmed[..open];
    if !name
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        return None;
    }
    Some((name, &trimmed[open + 1..trimmed.len() - 1]))
}

pub(super) fn compare_values(left: &str, right: &str, operator: &str) -> bool {
    let left_number = to_number(left);
    let right_number = to_number(right);
    let both_numeric = left_number.is_some() && right_number.is_some();
    if both_numeric {
        let left = left_number.unwrap_or_default();
        let right = right_number.unwrap_or_default();
        return match operator {
            "==" => left == right,
            "!=" => left != right,
            "<" => left < right,
            ">" => left > right,
            "<=" => left <= right,
            ">=" => left >= right,
            _ => false,
        };
    }

    let left = left.to_lowercase();
    let right = right.to_lowercase();
    match operator {
        "==" => left == right,
        "!=" => left != right,
        "<" => left < right,
        ">" => left > right,
        "<=" => left <= right,
        ">=" => left >= right,
        _ => false,
    }
}

pub(super) fn to_number(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    trimmed.parse::<f64>().ok()
}

pub(super) fn is_truthy(value: &str) -> bool {
    !matches!(value, "" | "false" | "0")
}

pub(super) fn is_quoted(value: &str) -> bool {
    (value.starts_with('\'') && value.ends_with('\''))
        || (value.starts_with('"') && value.ends_with('"'))
}

pub(super) fn unquote(value: &str) -> &str {
    if is_quoted(value) {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

pub(super) fn json_value_to_string(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => String::new(),
        JsonValue::Bool(value) => value.to_string(),
        JsonValue::Number(value) => value.to_string(),
        JsonValue::String(value) => value.clone(),
        JsonValue::Array(_) | JsonValue::Object(_) => {
            serde_json::to_string(value).unwrap_or_default()
        }
    }
}
