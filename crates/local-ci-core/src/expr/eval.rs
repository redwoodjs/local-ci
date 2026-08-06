use super::*;

pub fn expand_expressions(value: &str, context: &ExpressionContext) -> String {
    let mut output = String::new();
    let mut rest = value;

    while let Some(start) = rest.find("${{") {
        output.push_str(&rest[..start]);
        let after_start = &rest[start + 3..];
        let Some(end) = after_start.find("}}") else {
            output.push_str(&rest[start..]);
            return output;
        };
        let expression = &after_start[..end];
        output.push_str(&evaluate_expr_value(expression, context));
        rest = &after_start[end + 2..];
    }

    output.push_str(rest);
    output
}

pub fn uses_status_check_function(expression: &str) -> bool {
    let trimmed = expression.trim();
    if trimmed.is_empty() || is_quoted(trimmed) {
        return false;
    }

    if let Some(stripped) = strip_outer_parens(trimmed) {
        return uses_status_check_function(stripped);
    }

    for operator in ["||", "&&", "!=", "==", "<=", ">=", "<", ">"] {
        let parts = split_on_operator(trimmed, operator);
        if parts.len() > 1 {
            return parts.iter().any(|part| uses_status_check_function(part));
        }
    }

    if let Some(inner) = trimmed.strip_prefix('!') {
        return uses_status_check_function(inner);
    }

    let Some((name, raw_args)) = parse_function_call(trimmed) else {
        return false;
    };
    if matches!(name, "success" | "failure" | "always" | "cancelled") && raw_args.trim().is_empty()
    {
        return true;
    }

    split_function_args(raw_args)
        .iter()
        .any(|arg| uses_status_check_function(arg))
}

pub fn evaluate_job_if(
    expression: &str,
    job_results: &BTreeMap<String, String>,
    needs: &BTreeMap<String, BTreeMap<String, String>>,
) -> bool {
    let mut context = ExpressionContext {
        needs: needs.clone(),
        ..ExpressionContext::default()
    };
    context.env.insert(
        "__all_success".to_owned(),
        job_results
            .values()
            .all(|result| result == "success")
            .to_string(),
    );
    context.env.insert(
        "__any_failure".to_owned(),
        job_results
            .values()
            .any(|result| result == "failure")
            .to_string(),
    );

    is_truthy(&evaluate_expr_value(expression, &context))
}

pub fn evaluate_expr_value(expression: &str, context: &ExpressionContext) -> String {
    let trimmed = expression.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if let Some(stripped) = strip_outer_parens(trimmed) {
        return evaluate_expr_value(stripped, context);
    }

    let or_parts = split_on_operator(trimmed, "||");
    if or_parts.len() > 1 {
        let mut last = String::new();
        for part in or_parts {
            last = evaluate_expr_value(part.trim(), context);
            if is_truthy(&last) {
                return last;
            }
        }
        return last;
    }

    let and_parts = split_on_operator(trimmed, "&&");
    if and_parts.len() > 1 {
        let mut last = String::new();
        for part in and_parts {
            last = evaluate_expr_value(part.trim(), context);
            if !is_truthy(&last) {
                return last;
            }
        }
        return last;
    }

    for op in ["!=", "==", "<=", ">=", "<", ">"] {
        let parts = split_on_operator(trimmed, op);
        if parts.len() == 2 {
            return compare_values(
                &evaluate_expr_value(parts[0].trim(), context),
                &evaluate_expr_value(parts[1].trim(), context),
                op,
            )
            .to_string();
        }
    }

    if let Some(inner) = trimmed.strip_prefix('!') {
        return (!is_truthy(&evaluate_expr_value(inner.trim(), context))).to_string();
    }

    if is_quoted(trimmed) {
        return unquote(trimmed).to_owned();
    }

    match trimmed {
        "true" => return "true".to_owned(),
        "false" => return "false".to_owned(),
        "null" => return String::new(),
        "success()" => {
            return context
                .env
                .get("__all_success")
                .cloned()
                .unwrap_or_else(|| "true".to_owned());
        }
        "failure()" => {
            return context
                .env
                .get("__any_failure")
                .cloned()
                .unwrap_or_else(|| "false".to_owned());
        }
        "always()" => return "true".to_owned(),
        "cancelled()" => return "false".to_owned(),
        _ => {}
    }

    if trimmed.parse::<f64>().is_ok() {
        return trimmed.to_owned();
    }

    if let Some((name, raw_args)) = parse_function_call(trimmed) {
        return evaluate_function(name, raw_args, context);
    }

    resolve_context_ref(trimmed, context).unwrap_or_default()
}
