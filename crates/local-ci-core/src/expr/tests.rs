use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("local-ci-rust-expr-{name}-{nonce}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn expands_string_functions_and_json_arrays() {
    let context = ExpressionContext::default();

    assert_eq!(
        expand_expressions("${{ format('{0}-{1}', 'foo', 'bar') }}", &context),
        "foo-bar"
    );
    assert_eq!(
        expand_expressions(
            "${{ join(fromJSON('[\"a\",\"b\",\"c\"]'), ',') }}",
            &context
        ),
        "a,b,c"
    );
    assert_eq!(
        expand_expressions("${{ contains(fromJSON('[\"a\",\"b\"]'), 'b') }}", &context),
        "true"
    );
    assert_eq!(
        expand_expressions("${{ startsWith('hello-world', 'hello') }}", &context),
        "true"
    );
    assert_eq!(
        expand_expressions("${{ endsWith('hello-world', 'world') }}", &context),
        "true"
    );
}

#[test]
fn resolves_contexts_and_strategy_values() {
    let mut context = ExpressionContext::default();
    context.matrix.insert("shard".to_owned(), "2".to_owned());
    context
        .matrix
        .insert("__job_total".to_owned(), "3".to_owned());
    context.vars.insert("ENV".to_owned(), "test".to_owned());

    assert_eq!(expand_expressions("${{ matrix.shard }}", &context), "2");
    assert_eq!(
        expand_expressions("${{ strategy.job-total }}", &context),
        "3"
    );
    assert_eq!(expand_expressions("${{ vars.ENV }}", &context), "test");
    assert_eq!(expand_expressions("${{ runner.arch }}", &context), "X64");
}

#[test]
fn supports_boolean_logic_and_comparison_coercion() {
    let context = ExpressionContext::default();

    assert_eq!(
        expand_expressions("${{ true && 'yes' || 'no' }}", &context),
        "yes"
    );
    assert_eq!(expand_expressions("${{ '' == 0 }}", &context), "true");
    assert_eq!(expand_expressions("${{ null == 0 }}", &context), "true");
    assert_eq!(expand_expressions("${{ '0' == 0 }}", &context), "true");
    assert_eq!(expand_expressions("${{ 'x' == 0 }}", &context), "false");
}

#[test]
fn pretty_prints_to_json() {
    let context = ExpressionContext::default();
    let value = expand_expressions("${{ toJSON(fromJSON('{\"a\":1,\"b\":\"x\"}')) }}", &context);

    assert!(value.contains('\n'));
    assert!(value.contains("  \"a\": 1"));
}

#[test]
fn hashes_files_and_applies_negation_patterns() {
    let repo = temp_dir("hash");
    fs::create_dir_all(repo.join(".github/workflows")).unwrap();
    fs::write(repo.join(".github/workflows/a.yml"), "a").unwrap();
    fs::write(repo.join(".github/workflows/b.yml"), "b").unwrap();
    let context = ExpressionContext {
        repo_path: Some(repo.clone()),
        ..ExpressionContext::default()
    };

    let one = expand_expressions("${{ hashFiles('.github/workflows/a.yml') }}", &context);
    let all = expand_expressions("${{ hashFiles('.github/workflows/*.yml') }}", &context);
    let excluded = expand_expressions(
        "${{ hashFiles('.github/workflows/*.yml', '!.github/workflows/b.yml') }}",
        &context,
    );

    assert_eq!(one.len(), 64);
    assert_eq!(all.len(), 64);
    assert_eq!(excluded, one);
    assert_ne!(all, excluded);
}

#[test]
fn detects_status_check_functions_without_matching_strings() {
    assert!(uses_status_check_function(
        "failure() || needs.build.result == 'success'"
    ));
    assert!(uses_status_check_function(
        "contains(fromJSON('[1]'), success())"
    ));
    assert!(!uses_status_check_function(
        "contains('failure()', 'failure')"
    ));
    assert!(!uses_status_check_function(
        "steps.success.outputs.value == 'ok'"
    ));
}

#[test]
fn evaluates_smoke_job_if_condition_as_true_for_owner() {
    let context = ExpressionContext::default();
    let expression = "!github.event.pull_request.draft && (contains(fromJSON('[\"MEMBER\", \"OWNER\", \"COLLABORATOR\"]'), github.event.pull_request.author_association) || contains(github.event.pull_request.labels.*.name, 'safe-to-run'))";

    assert_eq!(evaluate_expr_value(expression, &context), "true");
}
