use super::*;
use crate::workflow::parse_workflow_file;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

fn planned_job(id: &str, needs: &[&str], if_condition: Option<&str>) -> PlannedJob {
    PlannedJob {
        id: id.to_owned(),
        source_job_id: id.to_owned(),
        display_name: id.to_owned(),
        runner_name: id.to_owned(),
        target: PlannedJobTarget::Linux {
            runs_on: "ubuntu-latest".to_owned(),
        },
        needs: needs.iter().map(|need| (*need).to_owned()).collect(),
        if_condition: if_condition.map(ToOwned::to_owned),
        env: BTreeMap::new(),
        inputs: BTreeMap::new(),
        outputs: BTreeMap::new(),
        workflow_call_output_defs: BTreeMap::new(),
        caller_job_id: None,
        services: Vec::new(),
        container: None,
        steps: vec![PlannedStep {
            id: None,
            name: "run".to_owned(),
            index: 1,
            run: Some("echo hi".to_owned()),
            uses: None,
            if_condition: None,
            shell: None,
            working_directory: None,
            env: BTreeMap::new(),
            with: BTreeMap::new(),
        }],
        step_count: 1,
        matrix_context: None,
    }
}

fn matrix_job(id: &str, runner_name: &str, axis: &str) -> PlannedJob {
    let mut job = planned_job(id, &[], None);
    job.runner_name = runner_name.to_owned();
    job.matrix_context = Some(BTreeMap::from([("axis".to_owned(), axis.to_owned())]));
    job
}

#[test]
fn routes_macos_runs_on_to_macos_target() {
    let job = PlannedJob {
        target: PlannedJobTarget::MacOs {
            runs_on: "macos-14".to_owned(),
        },
        ..planned_job("mac", &[], None)
    };

    assert_eq!(
        execution_route_for_job(&job, &HostCapability::Supported),
        JobExecutionRoute::MacOs
    );
    let unsupported = HostCapability::Unsupported {
        reason: "macOS VM runner requires `tart` to be installed.".to_owned(),
        hint: Some("Install with: brew install cirruslabs/cli/tart".to_owned()),
    };
    assert_eq!(
        execution_route_for_job(&job, &unsupported),
        JobExecutionRoute::Skip {
            reason: "macos-14: macOS VM runner requires `tart` to be installed. Install with: brew install cirruslabs/cli/tart".to_owned()
        }
    );
}

#[test]
fn schedule_expanded_matrix_jobs_before_dependents() {
    let mut matrix_job_1 = planned_job("test", &[], None);
    matrix_job_1.runner_name = "local-ci-1-j1-m1".to_owned();
    matrix_job_1.matrix_context = Some(BTreeMap::from([("node".to_owned(), "20".to_owned())]));
    let mut matrix_job_2 = matrix_job_1.clone();
    matrix_job_2.runner_name = "local-ci-1-j1-m2".to_owned();
    matrix_job_2.matrix_context = Some(BTreeMap::from([("node".to_owned(), "22".to_owned())]));
    let deploy = planned_job("deploy", &["test"], None);

    assert_eq!(
        schedule_job_waves(&[matrix_job_1, matrix_job_2, deploy]),
        vec![vec!["local-ci-1-j1-m1", "local-ci-1-j1-m2"], vec!["deploy"]]
    );
}

#[test]
fn cyclic_needs_return_planning_error() {
    let a = planned_job("a", &["b"], None);
    let b = planned_job("b", &["a"], None);

    let err = try_schedule_job_waves(&[a, b]).unwrap_err();

    assert!(err.contains("cyclic job dependencies"));
    assert!(err.contains("a"));
    assert!(err.contains("b"));
}

#[test]
fn aggregates_matrix_status_for_logical_needs() {
    assert_eq!(
        aggregate_matrix_status(&[JobResultStatus::Success, JobResultStatus::Success]),
        JobResultStatus::Success
    );
    assert_eq!(
        aggregate_matrix_status(&[JobResultStatus::Success, JobResultStatus::Failure]),
        JobResultStatus::Failure
    );
    assert_eq!(
        aggregate_matrix_status(&[JobResultStatus::Success, JobResultStatus::Skipped]),
        JobResultStatus::Skipped
    );
    assert_eq!(
        aggregate_matrix_status(&[JobResultStatus::Skipped, JobResultStatus::Skipped]),
        JobResultStatus::Skipped
    );
}

#[test]
fn dependent_job_skips_when_any_matrix_leg_fails() {
    let leg_1 = matrix_job("test", "local-ci-1-j1-m1", "a");
    let leg_2 = matrix_job("test", "local-ci-1-j1-m2", "b");
    let deploy = planned_job("deploy", &["test"], None);
    let jobs = vec![leg_1, leg_2, deploy.clone()];
    let results = BTreeMap::from([
        ("local-ci-1-j1-m1".to_owned(), JobResultStatus::Failure),
        ("local-ci-1-j1-m2".to_owned(), JobResultStatus::Success),
    ]);

    assert!(matches!(
        decide_job_run_with_jobs(&deploy, &jobs, &results),
        JobRunDecision::Skip { .. }
    ));
}

#[test]
fn matrix_needs_context_uses_logical_aggregate_and_schedule_keyed_outputs() {
    let leg_1 = matrix_job("test", "local-ci-1-j1-m1", "a");
    let leg_2 = matrix_job("test", "local-ci-1-j1-m2", "b");
    let deploy = planned_job("deploy", &["test"], Some("${{ always() }}"));
    let jobs = vec![leg_1, leg_2, deploy.clone()];
    let results = BTreeMap::from([
        ("local-ci-1-j1-m1".to_owned(), JobResultStatus::Success),
        ("local-ci-1-j1-m2".to_owned(), JobResultStatus::Skipped),
    ]);
    let outputs = BTreeMap::from([
        (
            "local-ci-1-j1-m1".to_owned(),
            BTreeMap::from([("leg".to_owned(), "one".to_owned())]),
        ),
        (
            "local-ci-1-j1-m2".to_owned(),
            BTreeMap::from([("other".to_owned(), "two".to_owned())]),
        ),
    ]);

    let context = needs_context_for_job_with_jobs(&deploy, &jobs, &results, &outputs);

    assert_eq!(context["test"].result, "skipped");
    assert_eq!(context["test"].outputs["leg"], "one");
    assert_eq!(context["test"].outputs["other"], "two");
}

#[test]
fn status_functions_override_default_needs_success_gate() {
    let default_job = planned_job("deploy", &["test"], None);
    let always_job = planned_job("deploy", &["test"], Some("${{ always() }}"));
    let failure_job = planned_job("deploy", &["test"], Some("${{ failure() }}"));
    let mut results = BTreeMap::new();
    results.insert("test".to_owned(), JobResultStatus::Failure);

    assert!(matches!(
        decide_job_run(&default_job, &results),
        JobRunDecision::Skip { .. }
    ));
    assert_eq!(decide_job_run(&always_job, &results), JobRunDecision::Run);
    assert_eq!(decide_job_run(&failure_job, &results), JobRunDecision::Run);
}

#[test]
fn success_status_function_can_run_after_skipped_need() {
    let job = planned_job("deploy", &["test"], Some("${{ !success() }}"));
    let mut results = BTreeMap::new();
    results.insert("test".to_owned(), JobResultStatus::Skipped);

    assert_eq!(decide_job_run(&job, &results), JobRunDecision::Run);
}

#[test]
fn fixture_plan_contracts_match_snapshots() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fixtures = manifest.join("../local-ci/fixtures");
    let plans_dir = fixtures.join("plans");
    let mut entries = fs::read_dir(&plans_dir)
        .expect("fixture plans directory should exist")
        .collect::<Result<Vec<_>, _>>()
        .expect("fixture plans should be readable");
    entries.sort_by_key(|entry| entry.path());
    assert!(entries.len() >= 10, "expected at least 10 plan fixtures");

    for entry in entries {
        let expected: serde_json::Value = serde_json::from_slice(
            &fs::read(entry.path()).expect("fixture plan should be readable"),
        )
        .expect("fixture plan should be valid JSON");
        let workflow_name = expected
            .get("workflow")
            .and_then(serde_json::Value::as_str)
            .expect("fixture plan should name workflow");
        let no_matrix = expected
            .get("args")
            .and_then(|args| args.get("noMatrix"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let workflow_path = fixtures.join("workflows").join(workflow_name);
        let workflow = parse_workflow_file(&workflow_path).expect("fixture workflow should parse");
        let plan = plan_workflow_document(&workflow, 1, no_matrix);
        let actual = plan_fixture_snapshot(&plan);
        assert_eq!(
            actual, expected["plan"],
            "fixture mismatch for {workflow_name}"
        );
    }
}

fn plan_fixture_snapshot(plan: &WorkflowRunPlan) -> serde_json::Value {
    json!({
        "jobs": plan.jobs.iter().map(|job| json!({
            "id": job.id,
            "runnerName": job.runner_name,
            "target": fixture_target(&job.target),
            "needs": job.needs,
            "if": job.if_condition,
            "matrix": job.matrix_context,
            "outputs": job.outputs.keys().cloned().collect::<Vec<_>>(),
            "services": job.services.iter().map(|service| service.id.clone()).collect::<Vec<_>>(),
            "container": job.container.as_ref().map(|container| container.image.clone()),
        })).collect::<Vec<_>>(),
        "schedule": plan.schedule,
    })
}

fn fixture_target(target: &PlannedJobTarget) -> String {
    match target {
        PlannedJobTarget::Linux { runs_on } => format!("linux:{runs_on}"),
        PlannedJobTarget::MacOs { runs_on } => format!("macos:{runs_on}"),
        PlannedJobTarget::ReusableWorkflow { uses } => format!("reusable:{uses}"),
        PlannedJobTarget::Unknown => "unknown".to_owned(),
    }
}
