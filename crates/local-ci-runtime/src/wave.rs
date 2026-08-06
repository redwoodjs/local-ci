use std::collections::VecDeque;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const BYTES_PER_CONTAINER: u64 = 6 * 1024 * 1024 * 1024;
const DOCKER_MEMORY_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy)]
struct DockerMemoryCache {
    measured_at: Instant,
    value: Option<u64>,
}

pub enum ConcurrentWorkerEvent<R, E> {
    Worker(E),
    Finished {
        index: usize,
        outcome: Result<R, String>,
    },
}

pub fn default_max_concurrent_jobs() -> usize {
    default_max_concurrent_jobs_from(
        thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1),
        docker_available_memory_bytes(),
    )
}

pub fn default_max_concurrent_jobs_from(
    cpu_count: usize,
    docker_available_memory_bytes: Option<u64>,
) -> usize {
    let cpu_limit = (cpu_count / 2).max(1);
    let Some(available_memory) = docker_available_memory_bytes else {
        return cpu_limit;
    };
    let memory_limit =
        usize::try_from(available_memory / BYTES_PER_CONTAINER).unwrap_or(usize::MAX);
    cpu_limit.min(memory_limit).max(1)
}

fn docker_available_memory_bytes() -> Option<u64> {
    static CACHE: OnceLock<Mutex<Option<DockerMemoryCache>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let now = Instant::now();

    if let Some(cached) = cache
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .filter(|cached| now.duration_since(cached.measured_at) < DOCKER_MEMORY_CACHE_TTL)
    {
        return cached.value;
    }

    let value = docker_mem_available_from_busybox().or_else(docker_mem_available_from_info);
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(DockerMemoryCache {
            measured_at: now,
            value,
        });
    }
    value
}

fn docker_mem_available_from_busybox() -> Option<u64> {
    let output = Command::new("docker")
        .args([
            "run",
            "--rm",
            "busybox",
            "grep",
            "MemAvailable",
            "/proc/meminfo",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_mem_available_kb(&String::from_utf8_lossy(&output.stdout)).map(|kb| kb * 1024)
}

fn docker_mem_available_from_info() -> Option<u64> {
    let output = Command::new("docker")
        .args(["info", "--format", "{{.MemTotal}}"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let total = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u64>()
        .ok()?;
    Some(total.saturating_sub(BYTES_PER_CONTAINER))
}

fn parse_mem_available_kb(raw: &str) -> Option<u64> {
    raw.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("MemAvailable:")?.trim();
        rest.split_whitespace().next()?.parse::<u64>().ok()
    })
}

/// Run indexed jobs with at most `max_jobs` active workers, preserving output order.
pub fn run_concurrent_workers<T, R, E, F, H>(
    max_jobs: usize,
    jobs: Vec<(usize, T)>,
    run_job: F,
    mut handle_worker_event: H,
) -> Result<Vec<(usize, R)>, String>
where
    T: Send + 'static,
    R: Send + 'static,
    E: Send + 'static,
    F: Fn(usize, T, &std::sync::mpsc::Sender<ConcurrentWorkerEvent<R, E>>) -> Result<R, String>
        + Send
        + Sync
        + 'static,
    H: FnMut(E),
{
    let max_jobs = max_jobs.max(1);
    let total = jobs.len();
    let mut pending = jobs.into_iter().collect::<VecDeque<_>>();
    let (tx, rx) = std::sync::mpsc::channel::<ConcurrentWorkerEvent<R, E>>();
    let run_job = Arc::new(run_job);
    let mut handles = Vec::new();
    let mut active = 0_usize;
    let mut finished = 0_usize;
    let mut outcomes = Vec::new();

    while finished < total {
        while active < max_jobs && !pending.is_empty() {
            let (index, job) = pending.pop_front().expect("pending job");
            let worker_tx = tx.clone();
            let run_job = Arc::clone(&run_job);
            active += 1;
            handles.push(thread::spawn(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_job(index, job, &worker_tx)
                }))
                .unwrap_or_else(|_| Err("job worker panicked".to_owned()));
                let _ = worker_tx.send(ConcurrentWorkerEvent::Finished { index, outcome });
            }));
        }

        match rx.recv().map_err(|err| err.to_string())? {
            ConcurrentWorkerEvent::Worker(event) => handle_worker_event(event),
            ConcurrentWorkerEvent::Finished { index, outcome } => {
                active = active.saturating_sub(1);
                finished += 1;
                match outcome {
                    Ok(value) => outcomes.push((index, value)),
                    Err(err) => drop(err),
                }
            }
        }
    }

    for handle in handles {
        handle
            .join()
            .map_err(|_| "job worker panicked during join".to_owned())?;
    }

    outcomes.sort_by_key(|(index, _)| *index);
    Ok(outcomes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[test]
    fn default_job_limit_fixture_vectors_match_typescript_contract() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../local-ci/fixtures/job-limits/default-max-concurrent-jobs.json");
        let fixtures = serde_json::from_slice::<Vec<Value>>(&fs::read(path).unwrap()).unwrap();

        for fixture in fixtures {
            let cpu_count = fixture["cpuCount"].as_u64().unwrap() as usize;
            let memory = fixture["dockerAvailableMemoryBytes"].as_u64();
            let expected = fixture["expected"].as_u64().unwrap() as usize;
            assert_eq!(
                default_max_concurrent_jobs_from(cpu_count, memory),
                expected
            );
        }
    }

    #[test]
    fn parses_mem_available_from_proc_meminfo() {
        assert_eq!(
            parse_mem_available_kb("MemAvailable:    12345 kB\n"),
            Some(12345)
        );
    }

    #[test]
    fn concurrent_pool_respects_max_jobs() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let jobs = (0..6).map(|index| (index, index)).collect::<Vec<_>>();

        let outcomes = run_concurrent_workers(
            2,
            jobs,
            {
                let active = Arc::clone(&active);
                let peak = Arc::clone(&peak);
                move |_index, _job, _tx| {
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = peak.fetch_max(current, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(30));
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                }
            },
            |_: ()| {},
        )
        .expect("pool should succeed");

        assert_eq!(outcomes.len(), 6);
        assert_eq!(peak.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn concurrent_pool_keeps_successful_outcomes_when_a_worker_fails() {
        let jobs = (0..3).map(|index| (index, index)).collect::<Vec<_>>();

        let outcomes = run_concurrent_workers(
            3,
            jobs,
            |_index, job, _tx| {
                if job == 1 {
                    Err("boom".to_owned())
                } else {
                    Ok(job)
                }
            },
            |_: ()| {},
        )
        .expect("pool should not fail the whole wave for one worker error");

        assert_eq!(outcomes, vec![(0, 0), (2, 2)]);
    }

    #[test]
    fn concurrent_pool_preserves_job_order() {
        let jobs = (0..4).map(|index| (index, index)).collect::<Vec<_>>();
        let outcomes = run_concurrent_workers(
            4,
            jobs,
            |_index, job, _tx| {
                thread::sleep(Duration::from_millis(((4 - job) * 10) as u64));
                Ok(job * 10)
            },
            |_: ()| {},
        )
        .expect("pool should succeed");
        assert_eq!(outcomes, vec![(0, 0), (1, 10), (2, 20), (3, 30)]);
    }
}
