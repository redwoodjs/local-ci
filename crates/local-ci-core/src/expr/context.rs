use super::*;

pub(super) fn resolve_context_ref(trimmed: &str, context: &ExpressionContext) -> Option<String> {
    match trimmed {
        "runner.os" => return Some(context.runner.os.clone()),
        "runner.arch" => return Some(context.runner.arch.clone()),
        "strategy.job-total" => {
            return Some(
                context
                    .matrix
                    .get("__job_total")
                    .cloned()
                    .unwrap_or_else(|| "1".to_owned()),
            );
        }
        "strategy.job-index" => {
            return Some(
                context
                    .matrix
                    .get("__job_index")
                    .cloned()
                    .unwrap_or_else(|| "0".to_owned()),
            );
        }
        "github.run_id" | "github.run_number" => return Some("1".to_owned()),
        "github.sha" | "github.head_sha" => return Some(ZERO_SHA.to_owned()),
        "github.ref_name" | "github.head_ref" => return Some("main".to_owned()),
        "github.repository" => return Some("local/repo".to_owned()),
        "github.actor" => return Some("local".to_owned()),
        "github.event.pull_request.number"
        | "github.event.pull_request.title"
        | "github.event.pull_request.user.login" => return Some(String::new()),
        "github.event.pull_request.draft" => return Some("false".to_owned()),
        "github.event.pull_request.author_association" => return Some("OWNER".to_owned()),
        "github.event.pull_request.labels.*.name" => return Some("[]".to_owned()),
        _ => {}
    }

    for (prefix, values) in [
        ("matrix.", &context.matrix),
        ("secrets.", &context.secrets),
        ("vars.", &context.vars),
        ("inputs.", &context.inputs),
        ("env.", &context.env),
    ] {
        if let Some(key) = trimmed.strip_prefix(prefix) {
            return Some(values.get(key).cloned().unwrap_or_default());
        }
    }

    if trimmed.starts_with("steps.") {
        return Some(String::new());
    }
    if trimmed.starts_with("needs.") {
        return Some(resolve_needs_ref(trimmed, &context.needs));
    }
    None
}

pub(super) fn resolve_needs_ref(
    trimmed: &str,
    needs: &BTreeMap<String, BTreeMap<String, String>>,
) -> String {
    let parts = trimmed.split('.').collect::<Vec<_>>();
    let Some(job_outputs) = parts.get(1).and_then(|job| needs.get(*job)) else {
        return String::new();
    };
    match (parts.get(2), parts.get(3)) {
        (Some(&"outputs"), Some(name)) => job_outputs.get(*name).cloned().unwrap_or_default(),
        (Some(&"result"), _) => job_outputs
            .get("__result")
            .cloned()
            .unwrap_or_else(|| "success".to_owned()),
        _ => String::new(),
    }
}
