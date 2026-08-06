use super::*;

pub(super) fn evaluate_function(name: &str, raw_args: &str, context: &ExpressionContext) -> String {
    match name {
        "contains" => eval_contains(raw_args, context),
        "startsWith" => eval_starts_with(raw_args, context),
        "endsWith" => eval_ends_with(raw_args, context),
        "fromJSON" => eval_from_json(raw_args, context),
        "toJSON" => eval_to_json(raw_args, context),
        "format" => eval_format(raw_args, context),
        "join" => eval_join(raw_args, context),
        "hashFiles" => eval_hash_files(raw_args, context),
        _ => String::new(),
    }
}

pub(super) fn eval_contains(raw_args: &str, context: &ExpressionContext) -> String {
    let args = split_function_args(raw_args);
    if args.len() < 2 {
        return "false".to_owned();
    }
    let haystack = evaluate_expr_value(&args[0], context);
    let needle = evaluate_expr_value(&args[1], context).to_lowercase();
    if let Ok(JsonValue::Array(items)) = serde_json::from_str::<JsonValue>(&haystack) {
        return items
            .iter()
            .any(|item| json_value_to_string(item).to_lowercase() == needle)
            .to_string();
    }
    haystack.to_lowercase().contains(&needle).to_string()
}

pub(super) fn eval_starts_with(raw_args: &str, context: &ExpressionContext) -> String {
    let args = split_function_args(raw_args);
    if args.len() < 2 {
        return "false".to_owned();
    }
    evaluate_expr_value(&args[0], context)
        .to_lowercase()
        .starts_with(&evaluate_expr_value(&args[1], context).to_lowercase())
        .to_string()
}

pub(super) fn eval_ends_with(raw_args: &str, context: &ExpressionContext) -> String {
    let args = split_function_args(raw_args);
    if args.len() < 2 {
        return "false".to_owned();
    }
    evaluate_expr_value(&args[0], context)
        .to_lowercase()
        .ends_with(&evaluate_expr_value(&args[1], context).to_lowercase())
        .to_string()
}

pub(super) fn eval_from_json(raw_args: &str, context: &ExpressionContext) -> String {
    let raw_value = eval_arg_or_literal(raw_args, context);
    serde_json::from_str::<JsonValue>(&raw_value).map_or_else(
        |_| String::new(),
        |parsed| match parsed {
            JsonValue::String(value) => value,
            other => serde_json::to_string(&other).unwrap_or_default(),
        },
    )
}

pub(super) fn eval_to_json(raw_args: &str, context: &ExpressionContext) -> String {
    let raw_value = eval_arg_or_literal(raw_args, context);
    serde_json::from_str::<JsonValue>(&raw_value).map_or_else(
        |_| serde_json::to_string_pretty(&raw_value).unwrap_or_default(),
        |parsed| serde_json::to_string_pretty(&parsed).unwrap_or_default(),
    )
}

pub(super) fn eval_format(raw_args: &str, context: &ExpressionContext) -> String {
    let args = split_function_args(raw_args);
    let template = args.first().map_or("", |arg| unquote(arg.trim()));
    let values = args
        .iter()
        .skip(1)
        .map(|arg| evaluate_expr_value(arg, context))
        .collect::<Vec<_>>();
    let mut output = template.to_owned();
    for (index, value) in values.iter().enumerate() {
        output = output.replace(&format!("{{{index}}}"), value);
    }
    output
}

pub(super) fn eval_join(raw_args: &str, context: &ExpressionContext) -> String {
    let args = split_function_args(raw_args);
    let value = args
        .first()
        .map_or_else(String::new, |arg| evaluate_expr_value(arg, context));
    let separator = args
        .get(1)
        .map_or_else(|| ", ".to_owned(), |arg| evaluate_expr_value(arg, context));
    if let Ok(JsonValue::Array(items)) = serde_json::from_str::<JsonValue>(&value) {
        return items
            .iter()
            .map(json_value_to_string)
            .collect::<Vec<_>>()
            .join(&separator);
    }
    value
}

pub(super) fn eval_hash_files(raw_args: &str, context: &ExpressionContext) -> String {
    let Some(repo_path) = context.repo_path.as_deref() else {
        return ZERO_SHA.to_owned();
    };
    let patterns = split_function_args(raw_args)
        .into_iter()
        .map(|arg| evaluate_expr_value(&arg, context))
        .collect::<Vec<_>>();
    hash_files(repo_path, &patterns)
}
